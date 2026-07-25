"""24/7 voice front-desk agent.

Handles booking, rescheduling, FAQ and structured symptom collection. It does not
triage: any red-flag symptom or clinical question escalates to a human immediately.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import structlog

from .gateway import Message, ModelGateway
from .schemas import VoiceAgentSessionResponse, VoiceAgentTurnResponse

log = structlog.get_logger(__name__)

GREETINGS: dict[str, str] = {
    "en": "Thank you for calling. I can help you book, change or cancel an appointment. How can I help?",
    "ar": "شكراً لاتصالك. يمكنني مساعدتك في حجز موعد أو تغييره أو إلغائه. كيف يمكنني المساعدة؟",
    "hi": "कॉल करने के लिए धन्यवाद। मैं अपॉइंटमेंट बुक, बदल या रद्द करने में मदद कर सकता हूँ। मैं कैसे मदद करूँ?",
    "fr": "Merci de votre appel. Je peux vous aider à prendre, modifier ou annuler un rendez-vous. Comment puis-je vous aider ?",
    "es": "Gracias por llamar. Puedo ayudarle a reservar, cambiar o cancelar una cita. ¿En qué puedo ayudarle?",
    "zh": "感谢来电。我可以帮您预约、改期或取消预约。请问需要什么帮助？",
}

SUPPORTED_INTENTS = ["booking", "reschedule", "cancel", "faq", "symptoms", "escalate"]

# Any of these ends the automated conversation and routes the caller to a human
# (or to emergency services). The agent must never attempt to assess them.
# Patterns tolerate natural speech ("face IS drooping", "throat IS closing"), because a
# caller in distress does not phrase symptoms in clinical shorthand. Over-matching here
# costs a needless transfer; under-matching costs an unescalated emergency.
_GAP = r"(?:\s+\w+){0,3}\s+"

RED_FLAGS: list[tuple[str, re.Pattern[str]]] = [
    ("chest pain", re.compile(rf"\bchest{_GAP}?(pain|pressure|tightness|tight|hurt)", re.I)),
    (
        "breathing difficulty",
        re.compile(
            r"\b(can'?t\s+breathe|cannot\s+breathe|short(ness)?\s+of\s+breath|"
            r"struggling\s+to\s+breathe|difficulty\s+breathing|gasping)",
            re.I,
        ),
    ),
    (
        "stroke symptoms",
        re.compile(
            rf"\b(face{_GAP}?droop|droop\w*{_GAP}?face|slurred{_GAP}?speech|speech{_GAP}?slurred|"
            rf"sudden{_GAP}?weakness|numbness{_GAP}?one\s+side|one\s+side{_GAP}?numb)",
            re.I,
        ),
    ),
    (
        "severe bleeding",
        re.compile(r"\b(bleeding\s+heavily|heavy\s+bleeding|won'?t\s+stop\s+bleeding|haemorrhag|hemorrhag)", re.I),
    ),
    (
        "loss of consciousness",
        re.compile(r"\b(unconscious|passed\s+out|fainted|unresponsive|collapsed|won'?t\s+wake)", re.I),
    ),
    ("suicidal ideation", re.compile(r"\b(kill\s+myself|end\s+my\s+life|suicid|harm\s+myself)", re.I)),
    (
        "anaphylaxis",
        re.compile(
            rf"\b(anaphyla|throat{_GAP}?clos|throat{_GAP}?swell|swell\w*{_GAP}?(face|tongue|throat)|"
            rf"(face|tongue|throat){_GAP}?swell)",
            re.I,
        ),
    ),
    ("severe abdominal pain", re.compile(r"\bsevere\s+(abdominal|stomach|belly)\s+pain", re.I)),
    (
        "pregnancy emergency",
        re.compile(r"\b(bleeding.{0,30}pregnan|pregnan.{0,30}bleeding|contractions|water\s+broke)", re.I),
    ),
]


def detect_red_flag(utterance: str) -> str | None:
    for label, pattern in RED_FLAGS:
        if pattern.search(utterance):
            return label
    return None


@dataclass(slots=True)
class VoiceSession:
    session_id: str
    caller_number: str
    tenant_slug: str
    language: str
    created_at: datetime
    intent: str = "unknown"
    slots: dict[str, str] = field(default_factory=dict)
    turns: list[dict[str, str]] = field(default_factory=list)
    escalated: bool = False
    complete: bool = False


AGENT_PROMPT = """You are a hospital front-desk voice agent. You handle appointment booking,
rescheduling, cancellation and general facility questions.

Hard rules:
- You are NOT a clinician. Never diagnose, never advise on treatment, never assess urgency.
- If the caller describes any symptom, collect it verbatim and escalate to a human.
- Never state or confirm medical record details back to the caller.
- Keep replies under 40 words; this is spoken aloud.

Return strict JSON:
{"reply": "...", "intent": "booking|reschedule|cancel|faq|symptoms|escalate",
 "slots": {"specialty": "", "preferred_date": "", "preferred_time": "", "patient_name": "", "reason": ""},
 "requires_human": false, "complete": false}

Conversation so far:
"""


class VoiceAgentService:
    def __init__(self, gateway: ModelGateway | None = None) -> None:
        self.gateway = gateway or ModelGateway()
        self._sessions: dict[str, VoiceSession] = {}

    def start(
        self,
        caller_number: str,
        tenant_slug: str,
        language: str,
        base_url: str,
        escalation_number: str | None = None,
    ) -> VoiceAgentSessionResponse:
        session = VoiceSession(
            session_id=str(uuid.uuid4()),
            caller_number=caller_number,
            tenant_slug=tenant_slug,
            language=language,
            created_at=datetime.now(UTC),
        )
        self._sessions[session.session_id] = session
        return VoiceAgentSessionResponse(
            session_id=session.session_id,
            websocket_url=f"{base_url}/voice-agent/stream?session_id={session.session_id}",
            greeting=GREETINGS.get(language, GREETINGS["en"]),
            supported_intents=SUPPORTED_INTENTS,
            escalation_number=escalation_number,
        )

    def get(self, session_id: str) -> VoiceSession | None:
        return self._sessions.get(session_id)

    async def turn(self, session_id: str, utterance: str) -> VoiceAgentTurnResponse:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"Unknown voice session {session_id}")

        session.turns.append({"role": "caller", "text": utterance})

        # Red-flag detection runs before the model, so an emergency is never delayed
        # by a completion round-trip or masked by a model that misreads the utterance.
        red_flag = detect_red_flag(utterance)
        if red_flag:
            session.escalated = True
            session.intent = "escalate"
            reply = (
                "I'm transferring you to a clinician right now. "
                "If this is a medical emergency, please hang up and call your local emergency number."
            )
            session.turns.append({"role": "agent", "text": reply})
            return VoiceAgentTurnResponse(
                reply=reply,
                intent="escalate",
                slots=session.slots,
                requires_human=True,
                escalation_reason=f"Red-flag symptom detected: {red_flag}",
                complete=False,
            )

        history = "\n".join(f"{t['role']}: {t['text']}" for t in session.turns[-10:])
        completion = await self.gateway.complete(
            [
                Message(role="system", content="You are a hospital front-desk voice agent."),
                Message(role="user", content=AGENT_PROMPT + history),
            ],
            operation="voice-agent.turn",
            json_mode=True,
            temperature=0.3,
            max_tokens=400,
            session_id=session_id,
        )

        parsed: dict[str, Any] = self.gateway.parse_json(completion.text)
        reply = str(parsed.get("reply", "")).strip() or "Could you repeat that, please?"
        intent = str(parsed.get("intent", "unknown"))
        slots = {k: str(v) for k, v in (parsed.get("slots") or {}).items() if v}

        session.intent = intent
        session.slots.update(slots)
        session.turns.append({"role": "agent", "text": reply})

        # A low-confidence turn on a live call is handed to a human rather than guessed at.
        requires_human = bool(parsed.get("requires_human")) or intent == "symptoms" or completion.low_confidence
        if requires_human:
            session.escalated = True

        session.complete = bool(parsed.get("complete"))

        return VoiceAgentTurnResponse(
            reply=reply,
            intent=intent,
            slots=session.slots,
            requires_human=requires_human,
            escalation_reason=(
                "Symptom description requires a clinician"
                if intent == "symptoms"
                else "Low model confidence on a live call"
                if completion.low_confidence
                else None
            ),
            complete=session.complete,
        )
