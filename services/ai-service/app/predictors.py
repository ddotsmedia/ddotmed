"""Deterministic risk models.

These are calibrated logistic scorers, not LLM calls: a denial or no-show score
must be reproducible and explainable to a billing or scheduling team, and must
still work when the model provider is unreachable.
"""

from __future__ import annotations

import math

from .schemas import (
    DenialPredictRequest,
    DenialPredictResponse,
    NoShowRiskRequest,
    NoShowRiskResponse,
    RiskFactor,
)

MODEL_VERSION = "medicore-risk-v1.0.0"


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _level(p: float) -> str:
    return "high" if p >= 0.6 else "medium" if p >= 0.3 else "low"


# Payers with materially different baseline denial behaviour; the default applies
# to anything not listed.
_PAYER_BASELINE: dict[str, float] = {
    "medicare": -0.4,
    "medicaid": 0.1,
    "nphies": -0.2,
    "malaffi": -0.3,
    "nhif": 0.3,
    "nhis": 0.4,
}


def predict_denial(req: DenialPredictRequest) -> DenialPredictResponse:
    factors: list[RiskFactor] = []
    # Intercept chosen so a clean, pre-authorised, well-documented claim lands ~8%.
    score = -2.4

    payer_adjustment = _PAYER_BASELINE.get(req.payer_code.lower(), 0.0)
    if payer_adjustment:
        score += payer_adjustment
        factors.append(
            RiskFactor(
                factor="payer_baseline",
                weight=payer_adjustment,
                detail=f"{req.payer_code} historical denial behaviour",
            )
        )

    if not req.has_pre_authorization and req.claimed_minor > 100_000:
        score += 1.4
        factors.append(
            RiskFactor(
                factor="missing_pre_authorization",
                weight=1.4,
                detail="High-value claim submitted without pre-authorisation",
            )
        )

    if not req.documentation_complete:
        score += 1.2
        factors.append(
            RiskFactor(
                factor="incomplete_documentation",
                weight=1.2,
                detail="Supporting clinical documentation is incomplete",
            )
        )

    if not req.diagnosis_codes:
        score += 1.6
        factors.append(
            RiskFactor(
                factor="no_diagnosis_code",
                weight=1.6,
                detail="No diagnosis code attached to the claim",
            )
        )
    elif req.procedure_codes and len(req.diagnosis_codes) < 1:
        score += 0.5
        factors.append(
            RiskFactor(
                factor="unlinked_procedure",
                weight=0.5,
                detail="Procedures billed without a supporting diagnosis",
            )
        )

    # Unspecified ICD codes (trailing .9 / .Z) draw scrutiny from most payers.
    unspecified = [c for c in req.diagnosis_codes if c.endswith((".9", ".Z", "9"))]
    if unspecified:
        weight = 0.3 * min(len(unspecified), 3)
        score += weight
        factors.append(
            RiskFactor(
                factor="unspecified_diagnosis",
                weight=weight,
                detail=f"Unspecified diagnosis codes: {', '.join(unspecified[:3])}",
            )
        )

    if req.days_since_service > 60:
        weight = 0.8 if req.days_since_service > 90 else 0.4
        score += weight
        factors.append(
            RiskFactor(
                factor="late_submission",
                weight=weight,
                detail=f"{req.days_since_service} days since the service date",
            )
        )

    if req.prior_denials_for_payer > 0:
        weight = min(0.25 * req.prior_denials_for_payer, 1.0)
        score += weight
        factors.append(
            RiskFactor(
                factor="prior_denials",
                weight=weight,
                detail=f"{req.prior_denials_for_payer} prior denials with this payer",
            )
        )

    if req.claimed_minor > 1_000_000:
        score += 0.5
        factors.append(
            RiskFactor(
                factor="high_value_claim",
                weight=0.5,
                detail="Claim value invites additional payer review",
            )
        )

    probability = round(_sigmoid(score), 4)
    level = _level(probability)

    actions: list[str] = []
    by_factor = {f.factor for f in factors}
    if "missing_pre_authorization" in by_factor:
        actions.append("Obtain retrospective authorisation before submitting")
    if "incomplete_documentation" in by_factor:
        actions.append("Attach the clinical notes and supporting investigations")
    if "unspecified_diagnosis" in by_factor:
        actions.append("Replace unspecified codes with the most specific available")
    if "late_submission" in by_factor:
        actions.append("Submit immediately — the payer filing window is closing")
    if "no_diagnosis_code" in by_factor:
        actions.append("Add at least one diagnosis code")
    if not actions and level != "low":
        actions.append("Review against payer-specific policy before submission")

    return DenialPredictResponse(
        denial_risk=probability,
        risk_level=level,  # type: ignore[arg-type]
        top_risk_factors=sorted(factors, key=lambda f: f.weight, reverse=True)[:5],
        recommended_actions=actions,
        model_version=MODEL_VERSION,
    )


def predict_no_show(req: NoShowRiskRequest) -> NoShowRiskResponse:
    factors: list[RiskFactor] = []
    score = -1.9

    if req.prior_appointments > 0:
        rate = req.prior_no_shows / req.prior_appointments
        # Attendance history is by far the strongest predictor; weighted so that a
        # patient missing most of their appointments lands in the high band on its own.
        weight = round(4.0 * rate, 4)
        score += weight
        if rate > 0:
            factors.append(
                RiskFactor(
                    factor="no_show_history",
                    weight=weight,
                    detail=f"{req.prior_no_shows} of {req.prior_appointments} prior appointments missed",
                )
            )
    elif req.is_first_visit:
        score += 0.5
        factors.append(
            RiskFactor(
                factor="first_visit",
                weight=0.5,
                detail="No attendance history for this patient",
            )
        )

    if req.lead_time_days > 30:
        score += 0.7
        factors.append(
            RiskFactor(factor="long_lead_time", weight=0.7, detail=f"Booked {req.lead_time_days:.0f} days ahead")
        )
    elif req.lead_time_days > 14:
        score += 0.35
        factors.append(
            RiskFactor(factor="long_lead_time", weight=0.35, detail=f"Booked {req.lead_time_days:.0f} days ahead")
        )

    hour = req.appointment_start.hour
    if hour < 9 or hour >= 17:
        score += 0.3
        factors.append(
            RiskFactor(factor="out_of_hours_slot", weight=0.3, detail=f"Slot at {hour:02d}:00")
        )

    if req.appointment_start.weekday() == 0:
        score += 0.2
        factors.append(RiskFactor(factor="monday_slot", weight=0.2, detail="Monday appointments are missed more often"))

    if req.distance_km is not None and req.distance_km > 50:
        weight = 0.5 if req.distance_km > 100 else 0.25
        score += weight
        factors.append(
            RiskFactor(factor="travel_distance", weight=weight, detail=f"{req.distance_km:.0f} km from the facility")
        )

    if not req.has_insurance:
        score += 0.4
        factors.append(
            RiskFactor(factor="self_pay", weight=0.4, detail="Self-paying patients cancel more often")
        )

    if req.channel in {"walk-in", "phone"}:
        score -= 0.2
        factors.append(
            RiskFactor(factor="assisted_booking", weight=-0.2, detail=f"Booked via {req.channel}")
        )

    probability = round(_sigmoid(score), 4)
    level = _level(probability)

    interventions: list[str] = []
    if level == "high":
        interventions += [
            "Send an SMS and WhatsApp reminder 48h and 2h before",
            "Telephone the patient to confirm attendance",
            "Offer a telehealth alternative",
            "Consider double-booking the slot",
        ]
    elif level == "medium":
        interventions += ["Send an SMS reminder 24h before", "Enable one-tap confirmation"]
    else:
        interventions.append("Standard reminder schedule")

    return NoShowRiskResponse(
        probability=probability,
        risk_level=level,  # type: ignore[arg-type]
        contributing_factors=sorted(factors, key=lambda f: abs(f.weight), reverse=True)[:5],
        recommended_interventions=interventions,
        model_version=MODEL_VERSION,
    )
