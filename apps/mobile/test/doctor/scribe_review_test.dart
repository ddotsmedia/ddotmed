/// Per-section review of an AI-drafted note.
///
/// The invariant under test throughout: nothing a model wrote reaches the record
/// unless a clinician said yes to that specific section. Not reviewing is not
/// approving, discarding removes the text rather than filing it blank, and the
/// note cannot be filed while anything is outstanding.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:medicore_mobile/apps/doctor/scribe_bloc.dart';

void main() {
  const draft = SoapDraft(
    subjective: 'Reports three days of cough.',
    objective: 'Chest clear. Temperature 37.2.',
    assessment: 'Likely viral upper respiratory infection.',
    plan: 'Fluids and rest. Review if worse.',
  );

  const evidence = [
    LinkedEvidence(sentence: 'Reports three days of cough.', audioOffsetMs: 4200, confidence: 0.93),
    LinkedEvidence(
        sentence: 'Chest clear. Temperature 37.2.', audioOffsetMs: 31000, confidence: 0.88),
  ];

  ScribeReview review({
    SoapDraft body = draft,
    Set<SoapSection> approved = const {},
    Set<SoapSection> discarded = const {},
  }) =>
      ScribeReview(
        sessionId: 's1',
        draft: body,
        evidence: evidence,
        confidence: 0.9,
        lowConfidence: false,
        modelVersion: 'claude-haiku-4-5',
        approved: approved,
        discarded: discarded,
      );

  group('what is outstanding', () {
    test('every populated section starts unreviewed', () {
      expect(review().outstanding, SoapSection.values);
    });

    test('approving one removes it from the outstanding list', () {
      final state = review(approved: {SoapSection.subjective});
      expect(state.outstanding, isNot(contains(SoapSection.subjective)));
      expect(state.outstanding.length, 3);
    });

    test('discarding also counts as reviewed', () {
      final state = review(discarded: {SoapSection.plan});
      expect(state.outstanding, isNot(contains(SoapSection.plan)));
    });

    test('an empty section is not outstanding — there is nothing to review', () {
      final state = review(
        body: const SoapDraft(subjective: 'Something', objective: '', assessment: '', plan: ''),
      );
      expect(state.outstanding, [SoapSection.subjective]);
    });
  });

  group('filing', () {
    test('is refused while anything is outstanding', () {
      expect(review().canFile, isFalse);
      expect(review(approved: {SoapSection.subjective}).canFile, isFalse);
    });

    test('is allowed once every section has been decided', () {
      final state = review(
        approved: {SoapSection.subjective, SoapSection.objective},
        discarded: {SoapSection.assessment, SoapSection.plan},
      );
      expect(state.canFile, isTrue);
    });

    test('is refused when every section was discarded — that is not a note', () {
      final state = review(discarded: SoapSection.values.toSet());
      expect(state.outstanding, isEmpty);
      expect(state.canFile, isFalse);
    });
  });

  group('what actually gets filed', () {
    test('carries only the approved sections', () {
      final state = review(
        approved: {SoapSection.subjective, SoapSection.plan},
        discarded: {SoapSection.objective, SoapSection.assessment},
      );

      final filed = state.approvedDraft;
      expect(filed.subjective, draft.subjective);
      expect(filed.plan, draft.plan);
      // Discarded text is absent, not filed empty-but-present.
      expect(filed.objective, '');
      expect(filed.assessment, '');
    });

    test('files nothing at all when nothing was approved', () {
      final filed = review().approvedDraft;
      expect(filed.subjective, '');
      expect(filed.objective, '');
      expect(filed.assessment, '');
      expect(filed.plan, '');
    });

    test('keeps only the evidence belonging to a kept section', () {
      final state = review(
        approved: {SoapSection.subjective},
        discarded: {SoapSection.objective, SoapSection.assessment, SoapSection.plan},
      );

      final kept = state.approvedEvidence;
      expect(kept.length, 1);
      expect(kept.single.sentence, 'Reports three days of cough.');
      expect(kept.single.audioOffsetMs, 4200);
    });

    test('carries no evidence when nothing was kept', () {
      expect(review().approvedEvidence, isEmpty);
    });
  });

  group('reading a section', () {
    test('returns the text for each part', () {
      final state = review();
      expect(state.textFor(SoapSection.subjective), draft.subjective);
      expect(state.textFor(SoapSection.objective), draft.objective);
      expect(state.textFor(SoapSection.assessment), draft.assessment);
      expect(state.textFor(SoapSection.plan), draft.plan);
    });

    test('labels each section for the UI', () {
      expect(SoapSection.subjective.label, 'Subjective');
      expect(SoapSection.objective.label, 'Objective');
      expect(SoapSection.assessment.label, 'Assessment');
      expect(SoapSection.plan.label, 'Plan');
    });
  });

  group('copyWith', () {
    test('replaces approvals without disturbing the draft', () {
      final updated = review().copyWith(approved: {SoapSection.plan});
      expect(updated.approved, {SoapSection.plan});
      expect(updated.draft, draft);
    });

    test('clears the evidence selection on request', () {
      final selected = review().copyWith(selectedEvidence: evidence.first);
      expect(selected.selectedEvidence, isNotNull);
      expect(selected.copyWith(clearSelection: true).selectedEvidence, isNull);
    });
  });

  group('the model that produced the draft', () {
    test('is recorded so the note says what wrote it', () {
      expect(review().modelVersion, 'claude-haiku-4-5');
    });
  });
}
