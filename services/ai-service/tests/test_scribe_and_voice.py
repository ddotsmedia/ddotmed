import pytest

from app.schemas import SoapSections
from app.scribe import TranscriptSegment, link_evidence, split_sentences
from app.voice_agent import detect_red_flag


class TestSplitSentences:
    def test_splits_on_terminal_punctuation(self) -> None:
        assert split_sentences("One. Two! Three?") == ["One.", "Two!", "Three?"]

    def test_ignores_empty_input(self) -> None:
        assert split_sentences("") == []
        assert split_sentences("   ") == []


class TestLinkEvidence:
    segments = [
        TranscriptSegment(text="I have had a cough for three days.", start_ms=0, end_ms=3000),
        TranscriptSegment(text="Chest is clear on auscultation.", start_ms=3000, end_ms=6000),
        TranscriptSegment(text="We will start amoxicillin.", start_ms=6000, end_ms=9000),
    ]

    def test_maps_each_sentence_to_its_source_offset(self) -> None:
        soap = SoapSections(
            subjective="I have had a cough for three days.",
            objective="Chest is clear on auscultation.",
            plan="We will start amoxicillin.",
        )
        evidence = link_evidence(soap, self.segments)
        assert len(evidence) == 3
        assert evidence[0].audio_offset_ms == 0
        assert evidence[1].audio_offset_ms == 3000
        assert evidence[2].audio_offset_ms == 6000
        assert all(e.confidence > 0.9 for e in evidence)

    def test_paraphrased_text_gets_low_confidence_not_a_wrong_claim(self) -> None:
        soap = SoapSections(assessment="Something entirely unrelated to the recording.")
        evidence = link_evidence(soap, self.segments)
        assert len(evidence) == 1
        assert evidence[0].confidence < 0.6

    def test_returns_nothing_without_a_transcript(self) -> None:
        assert link_evidence(SoapSections(subjective="Anything"), []) == []

    def test_skips_empty_sections(self) -> None:
        evidence = link_evidence(SoapSections(subjective="I have had a cough for three days."), self.segments)
        assert len(evidence) == 1

    def test_offsets_are_never_negative(self) -> None:
        soap = SoapSections(subjective="A. B. C.", plan="D. E.")
        for e in link_evidence(soap, self.segments):
            assert e.audio_offset_ms >= 0


class TestRedFlagDetection:
    @pytest.mark.parametrize(
        "utterance,expected",
        [
            ("I have really bad chest pain", "chest pain"),
            ("My father can't breathe properly", "breathing difficulty"),
            ("Her face is drooping and speech is slurred", "stroke symptoms"),
            ("The wound won't stop bleeding", "severe bleeding"),
            ("He passed out in the kitchen", "loss of consciousness"),
            ("I want to kill myself", "suicidal ideation"),
            ("My throat is closing up", "anaphylaxis"),
            ("I have severe abdominal pain", "severe abdominal pain"),
        ],
    )
    def test_detects_emergencies(self, utterance: str, expected: str) -> None:
        assert detect_red_flag(utterance) == expected

    def test_is_case_insensitive(self) -> None:
        assert detect_red_flag("CHEST PRESSURE is unbearable") == "chest pain"

    @pytest.mark.parametrize(
        "utterance",
        [
            "I would like to book an appointment with a dermatologist",
            "Can I reschedule to next Tuesday?",
            "What are your visiting hours?",
            "I need a copy of my invoice",
        ],
    )
    def test_does_not_fire_on_routine_calls(self, utterance: str) -> None:
        assert detect_red_flag(utterance) is None
