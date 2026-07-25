import json

import pytest

from app.config import Settings
from app.gateway import InMemoryAuditSink, Message, ModelGateway, ProviderError, hash_text, redact_phi


class TestRedactPhi:
    def test_masks_email_and_phone(self) -> None:
        out = redact_phi("Contact ahmed@example.com or +971 50 123 4567 today")
        assert "ahmed@example.com" not in out
        assert "[EMAIL]" in out
        assert "[PHONE]" in out

    def test_masks_mrn_and_national_id(self) -> None:
        out = redact_phi("Patient MRN26000001 with Emirates ID 784199012345671")
        assert "MRN26000001" not in out
        assert "784199012345671" not in out

    def test_preserves_clinical_content(self) -> None:
        text = "Patient reports crushing chest pain radiating to the left arm."
        assert redact_phi(text) == text

    def test_is_idempotent(self) -> None:
        once = redact_phi("mail me at a@b.com")
        assert redact_phi(once) == once


class TestHashText:
    def test_is_stable_and_distinct(self) -> None:
        assert hash_text("abc") == hash_text("abc")
        assert hash_text("abc") != hash_text("abd")
        assert len(hash_text("abc")) == 64


class TestParseJson:
    def test_parses_plain_json(self) -> None:
        assert ModelGateway.parse_json('{"a": 1}') == {"a": 1}

    def test_strips_markdown_fences(self) -> None:
        assert ModelGateway.parse_json('```json\n{"a": 1}\n```') == {"a": 1}
        assert ModelGateway.parse_json('```\n{"a": 1}\n```') == {"a": 1}

    def test_extracts_an_object_from_surrounding_prose(self) -> None:
        assert ModelGateway.parse_json('Here you go: {"a": 1} — hope that helps') == {"a": 1}

    def test_rejects_a_non_object(self) -> None:
        with pytest.raises(ValueError):
            ModelGateway.parse_json("[1, 2, 3]")

    def test_raises_on_unparseable_text(self) -> None:
        with pytest.raises(json.JSONDecodeError):
            ModelGateway.parse_json("not json at all")


class TestConfidenceScoring:
    def _gateway(self, threshold: float = 0.70) -> ModelGateway:
        return ModelGateway(
            Settings(ai_confidence_threshold=threshold, openai_api_key="test"),
            InMemoryAuditSink(),
        )

    def test_averages_token_probabilities_when_available(self) -> None:
        import math

        gateway = self._gateway()
        # exp(-0.1) ≈ 0.905, exp(-0.2) ≈ 0.819 → mean ≈ 0.862
        score = gateway._score_confidence("hello", {"token_logprobs": [-0.1, -0.2]})
        assert score == pytest.approx((math.exp(-0.1) + math.exp(-0.2)) / 2, abs=1e-3)

    def test_truncated_output_scores_below_threshold(self) -> None:
        gateway = self._gateway()
        assert gateway._score_confidence("partial", {"finish_reason": "length"}) == 0.5

    def test_provider_without_logprobs_gets_a_conservative_default(self) -> None:
        gateway = self._gateway()
        assert gateway._score_confidence("some answer", {}) == 0.75

    def test_empty_output_scores_zero(self) -> None:
        gateway = self._gateway()
        assert gateway._score_confidence("   ", {}) == 0.0


class TestGatewayContract:
    @pytest.mark.asyncio
    async def test_provider_failure_is_audited_then_raised(self) -> None:
        audit = InMemoryAuditSink()
        # No API key configured for the selected provider, so dispatch must fail.
        gateway = ModelGateway(Settings(ai_model_gateway="openai", openai_api_key=None), audit)

        with pytest.raises(ProviderError):
            await gateway.complete([Message(role="user", content="hi")], operation="test.op")

        assert len(audit.entries) == 1
        entry = audit.entries[0]
        assert entry["operation"] == "test.op"
        assert entry["error"] is not None
        assert entry["low_confidence"] is True
        assert entry["confidence_score"] == 0.0

    @pytest.mark.asyncio
    async def test_audit_stores_hashes_not_prompt_text(self) -> None:
        audit = InMemoryAuditSink()
        gateway = ModelGateway(Settings(ai_model_gateway="openai", openai_api_key=None), audit)

        with pytest.raises(ProviderError):
            await gateway.complete(
                [Message(role="user", content="Patient MRN26000001 has chest pain")],
                operation="test.op",
            )

        entry = audit.entries[0]
        assert "MRN26000001" not in json.dumps(entry)
        assert len(entry["prompt_hash"]) == 64

    @pytest.mark.asyncio
    async def test_unsupported_provider_is_rejected(self) -> None:
        gateway = ModelGateway(Settings(ai_model_gateway="openai"), InMemoryAuditSink())
        gateway.settings.ai_model_gateway = "not_a_provider"  # type: ignore[assignment]
        with pytest.raises(ProviderError):
            await gateway.complete([Message(role="user", content="x")], operation="test.op")

    def test_model_name_tracks_the_selected_provider(self) -> None:
        assert ModelGateway(Settings(ai_model_gateway="openai", openai_model="gpt-4o"))._model_name() == "gpt-4o"
        assert (
            ModelGateway(Settings(ai_model_gateway="anthropic", anthropic_model="claude-sonnet-5"))._model_name()
            == "claude-sonnet-5"
        )
        assert ModelGateway(Settings(ai_model_gateway="local", local_model="llama3.1:8b"))._model_name() == "llama3.1:8b"
