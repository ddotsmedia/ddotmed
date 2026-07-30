"""Plain-English wording for a drug-drug interaction.

The severity and the clinical facts come from a curated reference; the model's
only job is to say them in a sentence a prescriber can read at a glance while a
patient is in front of them. It is never asked what the interaction is, so it has
nothing to invent — and the caller caches the result, so each pair costs one call.
"""

from __future__ import annotations

import structlog

from .gateway import Message, ModelGateway
from .schemas import InteractionExplainRequest, InteractionExplainResponse

log = structlog.get_logger(__name__)

EXPLAIN_PROMPT = """You write drug interaction warnings for prescribers.

Rewrite the interaction below as 2-3 short sentences:
1. What happens to the patient, in concrete clinical terms.
2. Why it happens, only if the mechanism is given.
3. What the prescriber should do.

Rules you must follow:
- Use ONLY the facts supplied. Do not add doses, timings, monitoring intervals,
  alternative drugs or severities that are not stated here.
- Do not soften or escalate the given severity.
- Write for a clinician: no hedging, no "consult a healthcare professional".
- Plain prose. No headings, no bullet points, no markdown.

Severity: {severity}
Drug A: {drug_a}
Drug B: {drug_b}
Clinical effect: {clinical_effect}
Mechanism: {mechanism}
Management: {management}
"""

# Long enough for three sentences, short enough that a stuck model cannot ramble.
MAX_TOKENS = 300


class InteractionExplainer:
    def __init__(self, gateway: ModelGateway | None = None) -> None:
        self.gateway = gateway or ModelGateway()

    async def explain(self, req: InteractionExplainRequest) -> InteractionExplainResponse:
        completion = await self.gateway.complete(
            [
                Message(
                    role="system",
                    content="You restate curated drug safety facts precisely and briefly.",
                ),
                Message(
                    role="user",
                    content=EXPLAIN_PROMPT.format(
                        severity=req.severity,
                        drug_a=req.drug_a,
                        drug_b=req.drug_b,
                        clinical_effect=req.clinical_effect,
                        mechanism=req.mechanism or "not stated",
                        management=req.management or "not stated",
                    ),
                ),
            ],
            operation="interaction.explain",
            temperature=0.0,
            max_tokens=MAX_TOKENS,
        )

        explanation = " ".join(completion.text.split()).strip()
        if not explanation:
            # An empty answer must not erase a warning the prescriber needs.
            explanation = fallback_explanation(req)
            log.warning("interaction.explain.empty", drug_a=req.drug_a, drug_b=req.drug_b)

        return InteractionExplainResponse(
            drug_a=req.drug_a,
            drug_b=req.drug_b,
            severity=req.severity,
            explanation=explanation,
            model_version=completion.model_version,
            provider=completion.provider,
        )


def fallback_explanation(req: InteractionExplainRequest) -> str:
    """Deterministic wording used when the model returns nothing usable."""
    lead = f"Taking {req.drug_a} with {req.drug_b} can cause {req.clinical_effect.lower()}."
    return f"{lead} {req.management}" if req.management else lead
