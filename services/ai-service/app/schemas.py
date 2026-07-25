from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class LinkedEvidence(BaseModel):
    """Maps a generated sentence back to the audio that produced it."""

    sentence: str
    audio_offset_ms: int = Field(ge=0)
    confidence: float = Field(ge=0.0, le=1.0)


class SuggestedCode(BaseModel):
    system: Literal["ICD-10", "ICD-11", "CPT", "SNOMED"]
    code: str
    display: str
    confidence: float = Field(ge=0.0, le=1.0)
    rationale: str | None = None


class ScribeStartRequest(BaseModel):
    patient_id: str
    encounter_id: str | None = None
    language: str = "en"
    consent_obtained: bool = False


class ScribeStartResponse(BaseModel):
    session_id: str
    websocket_url: str
    sample_rate: int = 16000
    encoding: Literal["pcm_s16le"] = "pcm_s16le"
    expires_at: datetime


class SoapSections(BaseModel):
    subjective: str = ""
    objective: str = ""
    assessment: str = ""
    plan: str = ""


class ScribeFinaliseRequest(BaseModel):
    session_id: str
    language: str = "en"


class ScribeFinaliseResponse(BaseModel):
    session_id: str
    transcript: str
    soap: SoapSections
    linked_evidence: list[LinkedEvidence]
    suggested_codes: list[SuggestedCode]
    confidence_score: float = Field(ge=0.0, le=1.0)
    low_confidence: bool
    model_version: str
    provider: str
    audio_duration_ms: int
    # Never negotiable: an ambient draft is a proposal, never a signed note.
    requires_approval: Literal[True] = True


class CodingSuggestRequest(BaseModel):
    note_text: str = Field(min_length=10, max_length=50_000)
    encounter_type: str | None = None
    patient_age: int | None = None
    patient_gender: str | None = None
    code_systems: list[Literal["ICD-10", "ICD-11", "CPT", "SNOMED"]] = ["ICD-10", "CPT"]


class CodingSuggestResponse(BaseModel):
    codes: list[SuggestedCode]
    primary_diagnosis: SuggestedCode | None = None
    confidence_score: float
    low_confidence: bool
    model_version: str
    requires_approval: Literal[True] = True


class DenialPredictRequest(BaseModel):
    payer_code: str
    country_pack: str
    claimed_minor: int = Field(ge=0)
    currency: str = Field(min_length=3, max_length=3)
    diagnosis_codes: list[str]
    procedure_codes: list[str] = []
    has_pre_authorization: bool = False
    days_since_service: int = Field(ge=0, default=0)
    prior_denials_for_payer: int = Field(ge=0, default=0)
    documentation_complete: bool = True


class RiskFactor(BaseModel):
    factor: str
    weight: float
    detail: str


class DenialPredictResponse(BaseModel):
    denial_risk: float = Field(ge=0.0, le=1.0)
    risk_level: Literal["low", "medium", "high"]
    top_risk_factors: list[RiskFactor]
    recommended_actions: list[str]
    model_version: str


class SearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=1000)
    patient_id: str | None = None
    resource_types: list[str] = []
    limit: int = Field(default=10, ge=1, le=50)


class SearchHit(BaseModel):
    resource_type: str
    resource_id: str
    excerpt: str
    similarity: float
    recorded_at: datetime | None = None


class SearchResponse(BaseModel):
    hits: list[SearchHit]
    query_embedding_model: str
    total: int


class VoiceAgentSessionRequest(BaseModel):
    caller_number: str
    language: str = "en"
    tenant_slug: str
    intent_hint: Literal["booking", "reschedule", "faq", "symptoms", "unknown"] = "unknown"


class VoiceAgentSessionResponse(BaseModel):
    session_id: str
    websocket_url: str
    greeting: str
    supported_intents: list[str]
    # Any clinical uncertainty routes to a human; the agent never triages alone.
    escalation_number: str | None = None


class VoiceAgentTurnRequest(BaseModel):
    session_id: str
    utterance: str


class VoiceAgentTurnResponse(BaseModel):
    reply: str
    intent: str
    slots: dict[str, str]
    requires_human: bool
    escalation_reason: str | None = None
    complete: bool = False


class NoShowRiskRequest(BaseModel):
    patient_id: str
    appointment_start: datetime
    lead_time_days: float = Field(ge=0)
    prior_appointments: int = Field(ge=0)
    prior_no_shows: int = Field(ge=0)
    distance_km: float | None = None
    is_first_visit: bool = False
    has_insurance: bool = True
    channel: str = "online"


class NoShowRiskResponse(BaseModel):
    probability: float = Field(ge=0.0, le=1.0)
    risk_level: Literal["low", "medium", "high"]
    contributing_factors: list[RiskFactor]
    recommended_interventions: list[str]
    model_version: str
