"""ICD / CPT coding assistant.

Suggestions are always advisory: every response carries requires_approval=True and
a coder must accept a code before it reaches a claim.
"""

from __future__ import annotations

from typing import Any

from .gateway import Message, ModelGateway
from .schemas import CodingSuggestRequest, CodingSuggestResponse, SuggestedCode

CODING_PROMPT = """You are a certified clinical coding assistant.

Read the clinical note and propose diagnosis and procedure codes.

Rules:
- Propose a code ONLY when the note explicitly documents the condition or procedure.
- Never code a "rule out", "suspected" or "history of" statement as an active diagnosis.
- Prefer the most specific code the documentation supports; do not guess laterality,
  severity or episode when the note does not state it.
- Give the primary diagnosis first: the condition chiefly responsible for the encounter.
- Set confidence honestly. Below 0.7 means the documentation is insufficient.

Return strict JSON:
{"codes": [{"system": "ICD-10", "code": "...", "display": "...", "confidence": 0.0, "rationale": "quote the supporting text"}],
 "primary_index": 0}

Requested code systems: {systems}
{demographics}

Clinical note:
"""


class CodingService:
    def __init__(self, gateway: ModelGateway | None = None) -> None:
        self.gateway = gateway or ModelGateway()

    async def suggest(
        self,
        req: CodingSuggestRequest,
        *,
        patient_id: str | None = None,
        user_id: str | None = None,
    ) -> CodingSuggestResponse:
        demographics_parts: list[str] = []
        if req.patient_age is not None:
            demographics_parts.append(f"Patient age: {req.patient_age}")
        if req.patient_gender:
            demographics_parts.append(f"Patient gender: {req.patient_gender}")
        if req.encounter_type:
            demographics_parts.append(f"Encounter type: {req.encounter_type}")
        demographics = "\n".join(demographics_parts)

        prompt = (
            CODING_PROMPT.replace("{systems}", ", ".join(req.code_systems)).replace(
                "{demographics}", demographics
            )
            + req.note_text
        )

        completion = await self.gateway.complete(
            [
                Message(role="system", content="You are a certified clinical coding assistant."),
                Message(role="user", content=prompt),
            ],
            operation="coding.suggest",
            json_mode=True,
            temperature=0.0,
            max_tokens=2000,
            patient_id=patient_id,
            user_id=user_id,
        )

        parsed: dict[str, Any] = self.gateway.parse_json(completion.text)
        raw_codes = parsed.get("codes") or []

        codes: list[SuggestedCode] = []
        for c in raw_codes:
            if not c.get("code"):
                continue
            system = c.get("system", "ICD-10")
            if system not in req.code_systems:
                continue
            codes.append(
                SuggestedCode(
                    system=system,
                    code=str(c["code"]).strip().upper(),
                    display=str(c.get("display", "")).strip(),
                    confidence=max(0.0, min(1.0, float(c.get("confidence", 0.0)))),
                    rationale=c.get("rationale"),
                )
            )

        primary_index = parsed.get("primary_index")
        primary: SuggestedCode | None = None
        if isinstance(primary_index, int) and 0 <= primary_index < len(codes):
            primary = codes[primary_index]
        elif codes:
            diagnoses = [c for c in codes if c.system.startswith("ICD")]
            primary = max(diagnoses, key=lambda c: c.confidence) if diagnoses else None

        # The response confidence is the weaker of the model's own confidence and the
        # lowest per-code confidence — one shaky code makes the whole set reviewable.
        per_code_min = min((c.confidence for c in codes), default=0.0)
        overall = round(min(completion.confidence_score, per_code_min or completion.confidence_score), 4)

        return CodingSuggestResponse(
            codes=codes,
            primary_diagnosis=primary,
            confidence_score=overall,
            low_confidence=overall < self.gateway.settings.confidence_threshold,
            model_version=completion.model_version,
        )
