from datetime import UTC, datetime

from app.predictors import predict_denial, predict_no_show
from app.schemas import DenialPredictRequest, NoShowRiskRequest


def denial(**over: object) -> DenialPredictRequest:
    base: dict[str, object] = {
        "payer_code": "GENERIC",
        "country_pack": "uae",
        "claimed_minor": 50_000,
        "currency": "AED",
        "diagnosis_codes": ["J06.0"],
        "procedure_codes": ["99213"],
        "has_pre_authorization": True,
        "days_since_service": 3,
        "prior_denials_for_payer": 0,
        "documentation_complete": True,
    }
    base.update(over)
    return DenialPredictRequest(**base)  # type: ignore[arg-type]


class TestDenialPrediction:
    def test_clean_claim_is_low_risk(self) -> None:
        result = predict_denial(denial())
        assert result.risk_level == "low"
        assert 0.0 <= result.denial_risk <= 0.2

    def test_probability_is_always_bounded(self) -> None:
        worst = predict_denial(
            denial(
                diagnosis_codes=[],
                has_pre_authorization=False,
                claimed_minor=5_000_000,
                documentation_complete=False,
                days_since_service=400,
                prior_denials_for_payer=20,
                payer_code="nhis",
            )
        )
        assert 0.0 <= worst.denial_risk <= 1.0
        assert worst.risk_level == "high"

    def test_missing_pre_auth_on_high_value_raises_risk(self) -> None:
        low = predict_denial(denial(claimed_minor=500_000, has_pre_authorization=True))
        high = predict_denial(denial(claimed_minor=500_000, has_pre_authorization=False))
        assert high.denial_risk > low.denial_risk
        assert any(f.factor == "missing_pre_authorization" for f in high.top_risk_factors)
        assert "Obtain retrospective authorisation before submitting" in high.recommended_actions

    def test_missing_diagnosis_is_the_strongest_single_factor(self) -> None:
        result = predict_denial(denial(diagnosis_codes=[]))
        assert result.top_risk_factors[0].factor == "no_diagnosis_code"
        assert "Add at least one diagnosis code" in result.recommended_actions

    def test_unspecified_codes_raise_risk(self) -> None:
        specific = predict_denial(denial(diagnosis_codes=["J06.0"]))
        unspecified = predict_denial(denial(diagnosis_codes=["J06.9", "R51.9"]))
        assert unspecified.denial_risk > specific.denial_risk

    def test_late_submission_escalates_with_age(self) -> None:
        fresh = predict_denial(denial(days_since_service=10))
        late = predict_denial(denial(days_since_service=70))
        very_late = predict_denial(denial(days_since_service=120))
        assert fresh.denial_risk < late.denial_risk < very_late.denial_risk

    def test_payer_baseline_shifts_risk(self) -> None:
        favourable = predict_denial(denial(payer_code="medicare"))
        unfavourable = predict_denial(denial(payer_code="nhis"))
        assert unfavourable.denial_risk > favourable.denial_risk

    def test_prior_denials_contribution_is_capped(self) -> None:
        many = predict_denial(denial(prior_denials_for_payer=50))
        factor = next(f for f in many.top_risk_factors if f.factor == "prior_denials")
        assert factor.weight <= 1.0

    def test_factors_are_ordered_by_weight(self) -> None:
        result = predict_denial(
            denial(diagnosis_codes=[], has_pre_authorization=False, documentation_complete=False)
        )
        weights = [f.weight for f in result.top_risk_factors]
        assert weights == sorted(weights, reverse=True)

    def test_is_deterministic(self) -> None:
        assert predict_denial(denial()).denial_risk == predict_denial(denial()).denial_risk


def noshow(**over: object) -> NoShowRiskRequest:
    base: dict[str, object] = {
        "patient_id": "p1",
        "appointment_start": datetime(2026, 7, 29, 10, 0, tzinfo=UTC),
        "lead_time_days": 3,
        "prior_appointments": 10,
        "prior_no_shows": 0,
        "distance_km": 5.0,
        "is_first_visit": False,
        "has_insurance": True,
        "channel": "online",
    }
    base.update(over)
    return NoShowRiskRequest(**base)  # type: ignore[arg-type]


class TestNoShowPrediction:
    def test_reliable_attender_is_low_risk(self) -> None:
        result = predict_no_show(noshow())
        assert result.risk_level == "low"
        assert result.recommended_interventions == ["Standard reminder schedule"]

    def test_history_of_no_shows_dominates(self) -> None:
        reliable = predict_no_show(noshow(prior_appointments=10, prior_no_shows=0))
        unreliable = predict_no_show(noshow(prior_appointments=10, prior_no_shows=7))
        assert unreliable.probability > reliable.probability
        assert unreliable.risk_level == "high"
        assert any(f.factor == "no_show_history" for f in unreliable.contributing_factors)

    def test_probability_is_bounded(self) -> None:
        extreme = predict_no_show(
            noshow(
                prior_appointments=10,
                prior_no_shows=10,
                lead_time_days=120,
                distance_km=500,
                has_insurance=False,
                appointment_start=datetime(2026, 7, 27, 7, 0, tzinfo=UTC),
            )
        )
        assert 0.0 <= extreme.probability <= 1.0

    def test_long_lead_time_raises_risk(self) -> None:
        soon = predict_no_show(noshow(lead_time_days=2))
        far = predict_no_show(noshow(lead_time_days=45))
        assert far.probability > soon.probability

    def test_first_visit_carries_a_penalty(self) -> None:
        known = predict_no_show(noshow(prior_appointments=5, prior_no_shows=0, is_first_visit=False))
        first = predict_no_show(noshow(prior_appointments=0, prior_no_shows=0, is_first_visit=True))
        assert first.probability > known.probability

    def test_assisted_booking_lowers_risk(self) -> None:
        online = predict_no_show(noshow(channel="online"))
        phone = predict_no_show(noshow(channel="phone"))
        assert phone.probability < online.probability

    def test_high_risk_gets_escalated_interventions(self) -> None:
        result = predict_no_show(noshow(prior_appointments=10, prior_no_shows=8, lead_time_days=60))
        assert result.risk_level == "high"
        assert len(result.recommended_interventions) >= 3
        assert any("WhatsApp" in i for i in result.recommended_interventions)

    def test_no_division_by_zero_without_history(self) -> None:
        result = predict_no_show(noshow(prior_appointments=0, prior_no_shows=0))
        assert 0.0 <= result.probability <= 1.0
