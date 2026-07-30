"""Ambient clinical scribe.

Audio arrives over a WebSocket as raw PCM, is transcribed with Whisper, then
structured into SOAP sections by the model gateway. Every generated sentence is
mapped back to the audio offset that produced it, so a clinician can play back
the evidence for any statement before approving the note.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from difflib import SequenceMatcher
from typing import Any

import structlog

from .config import get_settings
from .gateway import Message, ModelGateway
from .schemas import (
    LinkedEvidence,
    ScribeFinaliseResponse,
    ScribeStartResponse,
    SoapSections,
    SuggestedCode,
)

log = structlog.get_logger(__name__)

SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2
SESSION_TTL_MINUTES = 240

# How much new audio must arrive before the live transcript is refreshed. Whisper
# re-reads the whole buffer each pass, so refreshing on every socket frame would
# spend the entire consultation transcribing the first few seconds over and over.
INTERIM_INTERVAL_MS = 5_000


@dataclass(slots=True)
class TranscriptSegment:
    text: str
    start_ms: int
    end_ms: int


@dataclass(slots=True)
class ScribeSession:
    session_id: str
    patient_id: str
    encounter_id: str | None
    user_id: str | None
    language: str
    consent_obtained: bool
    created_at: datetime
    audio: bytearray = field(default_factory=bytearray)
    segments: list[TranscriptSegment] = field(default_factory=list)
    closed: bool = False
    # Live-transcript bookkeeping. `interim_running` keeps a slow Whisper pass from
    # being started again while the previous one is still on a worker thread.
    interim_text: str = ""
    interim_at_ms: int = 0
    interim_running: bool = False

    @property
    def duration_ms(self) -> int:
        return int(len(self.audio) / (SAMPLE_RATE * BYTES_PER_SAMPLE) * 1000)

    @property
    def expired(self) -> bool:
        return datetime.now(UTC) - self.created_at > timedelta(minutes=SESSION_TTL_MINUTES)


class SessionStore:
    """In-process session registry. A multi-replica deployment swaps this for Redis."""

    def __init__(self) -> None:
        self._sessions: dict[str, ScribeSession] = {}
        self._lock = asyncio.Lock()

    async def create(self, **kwargs: Any) -> ScribeSession:
        session = ScribeSession(session_id=str(uuid.uuid4()), created_at=datetime.now(UTC), **kwargs)
        async with self._lock:
            self._sessions[session.session_id] = session
            self._sweep()
        return session

    async def get(self, session_id: str) -> ScribeSession | None:
        async with self._lock:
            session = self._sessions.get(session_id)
            if session and session.expired:
                del self._sessions[session_id]
                return None
            return session

    async def drop(self, session_id: str) -> None:
        async with self._lock:
            self._sessions.pop(session_id, None)

    def _sweep(self) -> None:
        for key in [k for k, v in self._sessions.items() if v.expired]:
            del self._sessions[key]


SOAP_PROMPT = """You are a clinical documentation assistant supporting a licensed clinician.

Structure the consultation transcript below into a SOAP note.

Rules you must follow:
- Use ONLY information present in the transcript. Never infer, complete or embellish.
- If a section has no supporting content, return an empty string for it.
- Preserve clinical negatives ("denies chest pain") — they are diagnostically significant.
- Do not include patient identifiers in the note body.
- Write each section as complete sentences a clinician would recognise.

Return strict JSON with exactly these keys:
{"subjective": "...", "objective": "...", "assessment": "...", "plan": "...",
 "suggested_codes": [{"system": "ICD-10", "code": "...", "display": "...", "confidence": 0.0, "rationale": "..."}]}

Transcript:
"""


class ScribeService:
    def __init__(self, gateway: ModelGateway | None = None, store: SessionStore | None = None) -> None:
        self.gateway = gateway or ModelGateway()
        self.store = store or SessionStore()
        self.settings = get_settings()
        self._whisper: Any | None = None

    async def start(
        self,
        patient_id: str,
        encounter_id: str | None,
        language: str,
        consent_obtained: bool,
        user_id: str | None,
        base_url: str,
    ) -> ScribeStartResponse:
        session = await self.store.create(
            patient_id=patient_id,
            encounter_id=encounter_id,
            user_id=user_id,
            language=language,
            consent_obtained=consent_obtained,
        )
        return ScribeStartResponse(
            session_id=session.session_id,
            websocket_url=f"{base_url}/scribe/stream/{session.session_id}",
            sample_rate=SAMPLE_RATE,
            expires_at=session.created_at + timedelta(minutes=SESSION_TTL_MINUTES),
        )

    async def append_audio(self, session_id: str, chunk: bytes) -> int:
        session = await self.store.get(session_id)
        if session is None:
            raise KeyError(f"Unknown or expired scribe session {session_id}")
        if session.closed:
            raise ValueError("Session is already finalised")
        session.audio.extend(chunk)
        return session.duration_ms

    def _load_whisper(self) -> Any:
        if self._whisper is None:
            import whisper

            self._whisper = whisper.load_model(self.settings.whisper_model)
        return self._whisper

    async def transcribe(
        self, session: ScribeSession, audio: bytes | None = None
    ) -> list[TranscriptSegment]:
        """Runs Whisper ASR. Blocking inference is pushed to a worker thread.

        `audio` lets a caller pass a snapshot taken on the event loop; the live
        transcript needs one because the buffer keeps growing underneath it.
        """
        buffer = bytes(session.audio) if audio is None else audio
        if not buffer:
            return []

        def _run() -> list[TranscriptSegment]:
            import numpy as np

            model = self._load_whisper()
            samples = np.frombuffer(buffer, dtype=np.int16).astype(np.float32) / 32768.0
            result = model.transcribe(
                samples, language=session.language, word_timestamps=False, fp16=False
            )
            return [
                TranscriptSegment(
                    text=str(s["text"]).strip(),
                    start_ms=int(float(s["start"]) * 1000),
                    end_ms=int(float(s["end"]) * 1000),
                )
                for s in result.get("segments", [])
                if str(s["text"]).strip()
            ]

        return await asyncio.to_thread(_run)

    async def interim(self, session_id: str) -> str | None:
        """Best-effort live transcript of what has been captured so far.

        Returns None when nothing new is due, which is the common case — the caller
        is expected to poll this on every audio frame and forward only real updates.
        A failure here is deliberately swallowed: losing the on-screen transcript
        must never take down the recording it is transcribing.
        """
        session = await self.store.get(session_id)
        if session is None:
            raise KeyError(f"Unknown or expired scribe session {session_id}")
        if session.closed or session.interim_running:
            return None
        if session.duration_ms - session.interim_at_ms < INTERIM_INTERVAL_MS:
            return None

        session.interim_running = True
        snapshot = bytes(session.audio)
        captured_ms = session.duration_ms
        try:
            segments = await self.transcribe(session, snapshot)
        except Exception as exc:  # noqa: BLE001 — see docstring
            log.warning("scribe.interim.failed", session_id=session_id, error=str(exc))
            return None
        finally:
            session.interim_running = False
            session.interim_at_ms = captured_ms

        session.interim_text = " ".join(s.text for s in segments).strip()
        return session.interim_text

    async def finalise(self, session_id: str, language: str | None = None) -> ScribeFinaliseResponse:
        session = await self.store.get(session_id)
        if session is None:
            raise KeyError(f"Unknown or expired scribe session {session_id}")
        if language:
            session.language = language

        session.segments = await self.transcribe(session)
        transcript = " ".join(s.text for s in session.segments).strip()

        if not transcript:
            session.closed = True
            return ScribeFinaliseResponse(
                session_id=session_id,
                transcript="",
                soap=SoapSections(),
                linked_evidence=[],
                suggested_codes=[],
                confidence_score=0.0,
                low_confidence=True,
                model_version=self.gateway.model_version,
                provider=self.gateway.provider,
                audio_duration_ms=session.duration_ms,
            )

        completion = await self.gateway.complete(
            [
                Message(role="system", content="You produce structured clinical documentation drafts."),
                Message(role="user", content=SOAP_PROMPT + transcript),
            ],
            operation="scribe.finalise",
            json_mode=True,
            temperature=0.1,
            max_tokens=3000,
            patient_id=session.patient_id,
            user_id=session.user_id,
            session_id=session_id,
        )

        parsed = self.gateway.parse_json(completion.text)
        soap = SoapSections(
            subjective=str(parsed.get("subjective", "")),
            objective=str(parsed.get("objective", "")),
            assessment=str(parsed.get("assessment", "")),
            plan=str(parsed.get("plan", "")),
        )
        codes = [
            SuggestedCode(
                system=c.get("system", "ICD-10"),
                code=str(c.get("code", "")),
                display=str(c.get("display", "")),
                confidence=float(c.get("confidence", 0.0)),
                rationale=c.get("rationale"),
            )
            for c in parsed.get("suggested_codes", [])
            if c.get("code")
        ]

        evidence = link_evidence(soap, session.segments)
        session.closed = True

        return ScribeFinaliseResponse(
            session_id=session_id,
            transcript=transcript,
            soap=soap,
            linked_evidence=evidence,
            suggested_codes=codes,
            confidence_score=completion.confidence_score,
            low_confidence=completion.low_confidence,
            model_version=completion.model_version,
            provider=completion.provider,
            audio_duration_ms=session.duration_ms,
        )


_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_SPLIT.split(text) if s.strip()]


def link_evidence(soap: SoapSections, segments: list[TranscriptSegment]) -> list[LinkedEvidence]:
    """Maps each generated sentence to the transcript segment it most resembles.

    Similarity is lexical, so it degrades gracefully when the model paraphrases:
    a weak match yields a low confidence rather than a wrong offset presented as fact.
    """
    if not segments:
        return []

    evidence: list[LinkedEvidence] = []
    for section in (soap.subjective, soap.objective, soap.assessment, soap.plan):
        for sentence in split_sentences(section):
            best_ratio = 0.0
            best_offset = segments[0].start_ms
            lowered = sentence.lower()
            for segment in segments:
                ratio = SequenceMatcher(None, lowered, segment.text.lower()).ratio()
                if ratio > best_ratio:
                    best_ratio = ratio
                    best_offset = segment.start_ms
            evidence.append(
                LinkedEvidence(
                    sentence=sentence,
                    audio_offset_ms=best_offset,
                    confidence=round(best_ratio, 4),
                )
            )
    return evidence
