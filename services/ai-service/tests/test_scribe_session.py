"""Ambient scribe session lifecycle: start → stream → finalise."""

import json

import pytest

from app.config import Settings
from app.gateway import CompletionResult, Message, ModelGateway
from app.scribe import SAMPLE_RATE, ScribeService, SessionStore, TranscriptSegment

TRANSCRIPT = [
    TranscriptSegment(text="I have had a cough for three days.", start_ms=0, end_ms=3000),
    TranscriptSegment(text="Chest is clear on auscultation.", start_ms=3000, end_ms=6000),
]

DRAFT = {
    "subjective": "I have had a cough for three days.",
    "objective": "Chest is clear on auscultation.",
    "assessment": "Likely viral upper respiratory tract infection.",
    "plan": "Supportive care and review in one week.",
    "suggested_codes": [
        {
            "system": "ICD-10",
            "code": "J06.9",
            "display": "Acute URTI, unspecified",
            "confidence": 0.81,
        }
    ],
}


class StubGateway(ModelGateway):
    """Answers with a canned SOAP payload so no network call is made."""

    def __init__(self) -> None:
        super().__init__(settings=Settings(ai_model_gateway="anthropic"))
        self.calls: list[list[Message]] = []

    async def complete(self, messages: list[Message], **_: object) -> CompletionResult:
        self.calls.append(messages)
        return CompletionResult(
            text=json.dumps(DRAFT),
            model_version=self.model_version,
            provider="anthropic",
            prompt_tokens=100,
            completion_tokens=50,
            latency_ms=120,
            confidence_score=0.86,
            low_confidence=False,
            request_id="req-1",
        )


class StubScribe(ScribeService):
    """Substitutes Whisper, which is far too heavy to load in a unit test."""

    segments = TRANSCRIPT

    async def transcribe(self, session, audio=None):  # type: ignore[no-untyped-def]
        buffer = session.audio if audio is None else audio
        return list(self.segments) if buffer else []


def pcm(seconds: float) -> bytes:
    return b"\x00\x01" * int(SAMPLE_RATE * seconds)


@pytest.fixture
def service() -> StubScribe:
    return StubScribe(gateway=StubGateway(), store=SessionStore())


async def start(service: StubScribe):  # type: ignore[no-untyped-def]
    return await service.start(
        patient_id="p1",
        encounter_id="e1",
        language="en",
        consent_obtained=True,
        user_id="u1",
        base_url="wss://example.test/ai",
    )


class TestSessionLifecycle:
    @pytest.mark.asyncio
    async def test_start_returns_a_stream_url_carrying_the_session_id(
        self, service: StubScribe
    ) -> None:
        session = await start(service)
        assert session.websocket_url == f"wss://example.test/ai/scribe/stream/{session.session_id}"
        assert session.sample_rate == SAMPLE_RATE
        assert session.expires_at > session.expires_at.replace(year=2000)

    @pytest.mark.asyncio
    async def test_streamed_audio_accumulates_duration(self, service: StubScribe) -> None:
        session = await start(service)
        assert await service.append_audio(session.session_id, pcm(1.0)) == 1000
        assert await service.append_audio(session.session_id, pcm(0.5)) == 1500

    @pytest.mark.asyncio
    async def test_unknown_session_is_rejected_rather_than_silently_created(
        self, service: StubScribe
    ) -> None:
        with pytest.raises(KeyError):
            await service.append_audio("not-a-session", pcm(0.1))

    @pytest.mark.asyncio
    async def test_finalise_drafts_soap_and_links_evidence(self, service: StubScribe) -> None:
        session = await start(service)
        await service.append_audio(session.session_id, pcm(2.0))

        result = await service.finalise(session.session_id)

        assert result.soap.subjective == DRAFT["subjective"]
        assert result.soap.plan == DRAFT["plan"]
        assert result.requires_approval is True
        assert result.model_version == "claude-haiku-4-5"
        assert result.audio_duration_ms == 2000
        assert [e.audio_offset_ms for e in result.linked_evidence[:2]] == [0, 3000]
        assert result.suggested_codes[0].code == "J06.9"

    @pytest.mark.asyncio
    async def test_audio_cannot_be_appended_after_finalise(self, service: StubScribe) -> None:
        session = await start(service)
        await service.append_audio(session.session_id, pcm(1.0))
        await service.finalise(session.session_id)

        with pytest.raises(ValueError, match="already finalised"):
            await service.append_audio(session.session_id, pcm(1.0))

    @pytest.mark.asyncio
    async def test_silent_session_returns_an_empty_draft_not_an_invented_one(
        self, service: StubScribe
    ) -> None:
        session = await start(service)
        result = await service.finalise(session.session_id)

        assert result.transcript == ""
        assert result.soap.subjective == ""
        assert result.linked_evidence == []
        assert result.low_confidence is True
        # Still attributed to the configured model, so the audit trail is complete.
        assert result.model_version == "claude-haiku-4-5"

    @pytest.mark.asyncio
    async def test_finalising_an_unknown_session_raises(self, service: StubScribe) -> None:
        with pytest.raises(KeyError):
            await service.finalise("not-a-session")


class TestLiveTranscript:
    @pytest.mark.asyncio
    async def test_interim_holds_back_until_enough_audio_has_arrived(
        self, service: StubScribe
    ) -> None:
        session = await start(service)
        await service.append_audio(session.session_id, pcm(2.0))
        assert await service.interim(session.session_id) is None

    @pytest.mark.asyncio
    async def test_interim_returns_the_transcript_so_far(self, service: StubScribe) -> None:
        session = await start(service)
        await service.append_audio(session.session_id, pcm(6.0))

        text = await service.interim(session.session_id)
        assert text == " ".join(s.text for s in TRANSCRIPT)

    @pytest.mark.asyncio
    async def test_interim_does_not_rerun_until_the_next_interval(
        self, service: StubScribe
    ) -> None:
        session = await start(service)
        await service.append_audio(session.session_id, pcm(6.0))
        assert await service.interim(session.session_id) is not None

        # Nothing new worth transcribing yet.
        await service.append_audio(session.session_id, pcm(1.0))
        assert await service.interim(session.session_id) is None

        await service.append_audio(session.session_id, pcm(5.0))
        assert await service.interim(session.session_id) is not None

    @pytest.mark.asyncio
    async def test_a_failing_asr_pass_does_not_break_the_recording(
        self, service: StubScribe
    ) -> None:
        session = await start(service)
        await service.append_audio(session.session_id, pcm(6.0))

        async def boom(*_: object, **__: object) -> list[TranscriptSegment]:
            raise RuntimeError("whisper fell over")

        service.transcribe = boom  # type: ignore[method-assign]
        assert await service.interim(session.session_id) is None
        # The socket keeps accepting audio regardless.
        assert await service.append_audio(session.session_id, pcm(1.0)) == 7000

    @pytest.mark.asyncio
    async def test_interim_stops_once_the_session_is_finalised(self, service: StubScribe) -> None:
        session = await start(service)
        await service.append_audio(session.session_id, pcm(6.0))
        await service.finalise(session.session_id)

        assert await service.interim(session.session_id) is None

    @pytest.mark.asyncio
    async def test_interim_on_an_unknown_session_raises(self, service: StubScribe) -> None:
        with pytest.raises(KeyError):
            await service.interim("not-a-session")


class TestDefaultModel:
    def test_haiku_is_the_default_clinical_model(self) -> None:
        gateway = ModelGateway(settings=Settings())
        assert gateway.provider == "anthropic"
        assert gateway.model_version == "claude-haiku-4-5"
