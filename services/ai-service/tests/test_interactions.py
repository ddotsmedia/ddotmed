"""The model writes the wording for an interaction; it never decides the severity."""

import pytest

from app.config import Settings
from app.gateway import CompletionResult, Message, ModelGateway
from app.interactions import EXPLAIN_PROMPT, InteractionExplainer, fallback_explanation
from app.schemas import InteractionExplainRequest

REQUEST = InteractionExplainRequest(
    drug_a="Warfarin",
    drug_b="Clarithromycin",
    severity="major",
    clinical_effect="A sharp rise in INR with bleeding risk",
    mechanism="CYP3A4 and CYP2C9 inhibition reduces warfarin clearance",
    management="Check INR at 3-5 days and reduce the warfarin dose.",
)


class StubGateway(ModelGateway):
    def __init__(self, text: str) -> None:
        super().__init__(settings=Settings(ai_model_gateway="anthropic"))
        self.text = text
        self.calls: list[list[Message]] = []
        self.kwargs: dict[str, object] = {}

    async def complete(self, messages: list[Message], **kwargs: object) -> CompletionResult:
        self.calls.append(messages)
        self.kwargs = kwargs
        return CompletionResult(
            text=self.text,
            model_version=self.model_version,
            provider="anthropic",
            prompt_tokens=80,
            completion_tokens=40,
            latency_ms=90,
            confidence_score=0.9,
            low_confidence=False,
            request_id="req-1",
        )


class TestExplain:
    @pytest.mark.asyncio
    async def test_returns_the_models_wording_on_haiku(self) -> None:
        gateway = StubGateway("Warfarin levels rise sharply. Check the INR within three days.")
        result = await InteractionExplainer(gateway).explain(REQUEST)

        assert result.explanation == (
            "Warfarin levels rise sharply. Check the INR within three days."
        )
        assert result.model_version == "claude-haiku-4-5"
        assert result.severity == "major"

    @pytest.mark.asyncio
    async def test_severity_is_passed_through_untouched(self) -> None:
        gateway = StubGateway("Anything at all.")
        for severity in ("contraindicated", "major", "moderate", "minor"):
            req = REQUEST.model_copy(update={"severity": severity})
            result = await InteractionExplainer(gateway).explain(req)
            assert result.severity == severity

    @pytest.mark.asyncio
    async def test_prompt_carries_the_facts_and_forbids_inventing_more(self) -> None:
        gateway = StubGateway("ok")
        await InteractionExplainer(gateway).explain(REQUEST)

        prompt = gateway.calls[0][1].content
        assert "Warfarin" in prompt
        assert "Clarithromycin" in prompt
        assert "CYP3A4" in prompt
        assert "Use ONLY the facts supplied" in prompt
        assert "Do not soften or escalate" in prompt

    @pytest.mark.asyncio
    async def test_runs_at_zero_temperature_so_the_wording_is_stable(self) -> None:
        gateway = StubGateway("ok")
        await InteractionExplainer(gateway).explain(REQUEST)
        assert gateway.kwargs["temperature"] == 0.0

    @pytest.mark.asyncio
    async def test_collapses_stray_whitespace_and_newlines(self) -> None:
        gateway = StubGateway("  Line one.\n\n  Line two.\t ")
        result = await InteractionExplainer(gateway).explain(REQUEST)
        assert result.explanation == "Line one. Line two."

    @pytest.mark.asyncio
    async def test_an_empty_answer_falls_back_rather_than_erasing_the_warning(self) -> None:
        gateway = StubGateway("   \n  ")
        result = await InteractionExplainer(gateway).explain(REQUEST)
        assert result.explanation == fallback_explanation(REQUEST)
        assert "Warfarin" in result.explanation
        assert "Clarithromycin" in result.explanation

    @pytest.mark.asyncio
    async def test_missing_mechanism_and_management_are_stated_as_such(self) -> None:
        gateway = StubGateway("ok")
        bare = REQUEST.model_copy(update={"mechanism": None, "management": None})
        await InteractionExplainer(gateway).explain(bare)

        prompt = gateway.calls[0][1].content
        assert "Mechanism: not stated" in prompt
        assert "Management: not stated" in prompt


class TestFallback:
    def test_reads_as_a_sentence(self) -> None:
        assert fallback_explanation(REQUEST) == (
            "Taking Warfarin with Clarithromycin can cause a sharp rise in inr with bleeding risk. "
            "Check INR at 3-5 days and reduce the warfarin dose."
        )

    def test_is_never_blank_without_management_advice(self) -> None:
        bare = REQUEST.model_copy(update={"management": None})
        text = fallback_explanation(bare)
        assert text.endswith(".")
        assert len(text) > 20


class TestPromptTemplate:
    def test_template_has_a_slot_for_every_fact(self) -> None:
        for field in ("severity", "drug_a", "drug_b", "clinical_effect", "mechanism", "management"):
            assert "{" + field + "}" in EXPLAIN_PROMPT
