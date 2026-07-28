import {
  LOW_CONFIDENCE_THRESHOLD,
  isEmptyDraft,
  publicStreamUrl,
  toScribeDraft,
} from './scribe-draft';

const response = {
  session_id: 'sess-1',
  transcript: 'I have had a cough for three days. Chest is clear.',
  soap: {
    subjective: 'Cough for three days.',
    objective: 'Chest clear on auscultation.',
    assessment: 'Viral upper respiratory tract infection.',
    plan: 'Supportive care, review in one week.',
  },
  linked_evidence: [{ sentence: 'Cough for three days.', audio_offset_ms: 0, confidence: 0.94 }],
  suggested_codes: [{ system: 'ICD-10', code: 'J06.9', display: 'Acute URTI', confidence: 0.81 }],
  confidence_score: 0.86,
  low_confidence: false,
  model_version: 'claude-haiku-4-5',
  audio_duration_ms: 184_000,
};

describe('toScribeDraft', () => {
  it('maps the SOAP sections onto the draft the editor renders', () => {
    const draft = toScribeDraft(response, 'claude-haiku-4-5');
    expect(draft.draft).toEqual({
      subjective: 'Cough for three days.',
      objective: 'Chest clear on auscultation.',
      assessment: 'Viral upper respiratory tract infection.',
      plan: 'Supportive care, review in one week.',
    });
    expect(draft.session_id).toBe('sess-1');
    expect(draft.audio_duration_ms).toBe(184_000);
  });

  it('accepts the abbreviated S/O/A/P shape as well', () => {
    const draft = toScribeDraft(
      { draft: { S: 'subj', O: 'obj', A: 'assess', P: 'plan' } },
      'claude-haiku-4-5',
    );
    expect(draft.draft.subjective).toBe('subj');
    expect(draft.draft.plan).toBe('plan');
  });

  it('always demands approval, whatever the service said', () => {
    expect(toScribeDraft({ ...response, requires_approval: false }, 'm').requires_approval).toBe(true);
    expect(toScribeDraft({}, 'm').requires_approval).toBe(true);
  });

  it('flags low confidence on the score even when the service forgot the flag', () => {
    const draft = toScribeDraft(
      { ...response, confidence_score: LOW_CONFIDENCE_THRESHOLD - 0.01, low_confidence: false },
      'm',
    );
    expect(draft.low_confidence).toBe(true);
  });

  it('keeps a service-raised low-confidence flag on a high score', () => {
    expect(toScribeDraft({ ...response, low_confidence: true }, 'm').low_confidence).toBe(true);
  });

  it('treats a missing or unusable confidence as zero, not as certainty', () => {
    expect(toScribeDraft({ ...response, confidence_score: undefined }, 'm').confidence_score).toBe(0);
    expect(toScribeDraft({ ...response, confidence_score: 'high' }, 'm').confidence_score).toBe(0);
    expect(toScribeDraft({ ...response, confidence_score: undefined }, 'm').low_confidence).toBe(true);
  });

  it('clamps out-of-range confidences rather than passing them through', () => {
    expect(toScribeDraft({ ...response, confidence_score: 1.4 }, 'm').confidence_score).toBe(1);
    expect(toScribeDraft({ ...response, confidence_score: -2 }, 'm').confidence_score).toBe(0);
  });

  it('attributes an unlabelled draft to the configured model', () => {
    expect(toScribeDraft({ ...response, model_version: '' }, 'claude-haiku-4-5').model_version).toBe(
      'claude-haiku-4-5',
    );
  });

  it('normalises evidence offsets and drops nothing silently', () => {
    const draft = toScribeDraft(
      {
        ...response,
        linked_evidence: [
          { sentence: 'a', audio_offset_ms: -5, confidence: 0.5 },
          { sentence: 'b', audio_offset_ms: '1200', confidence: 2 },
          { sentence: 'c' },
        ],
      },
      'm',
    );
    expect(draft.linked_evidence).toEqual([
      { sentence: 'a', audio_offset_ms: 0, confidence: 0.5 },
      { sentence: 'b', audio_offset_ms: 1200, confidence: 1 },
      { sentence: 'c', audio_offset_ms: 0, confidence: 0 },
    ]);
  });

  it('defaults a code system so a suggestion is never uninterpretable', () => {
    const draft = toScribeDraft({ ...response, suggested_codes: [{ code: 'I10' }] }, 'm');
    expect(draft.suggested_codes[0]).toEqual({
      system: 'ICD-10',
      code: 'I10',
      display: '',
      confidence: 0,
    });
  });

  it('survives a malformed response instead of throwing at the clinician', () => {
    const draft = toScribeDraft(null, 'claude-haiku-4-5');
    expect(draft.draft).toEqual({ subjective: '', objective: '', assessment: '', plan: '' });
    expect(draft.linked_evidence).toEqual([]);
    expect(draft.low_confidence).toBe(true);
    expect(draft.model_version).toBe('claude-haiku-4-5');
  });
});

describe('isEmptyDraft', () => {
  it('treats whitespace-only sections as empty', () => {
    expect(isEmptyDraft({ subjective: ' ', objective: '', assessment: '\n', plan: '' })).toBe(true);
  });

  it('is not empty once any section carries content', () => {
    expect(isEmptyDraft({ subjective: '', objective: '', assessment: '', plan: 'Review' })).toBe(false);
  });
});

describe('publicStreamUrl', () => {
  it('upgrades http to ws and https to wss', () => {
    expect(publicStreamUrl('s1', 'http://localhost:8000/ai')).toBe('ws://localhost:8000/ai/scribe/stream/s1');
    expect(publicStreamUrl('s1', 'https://hospital.example/ai')).toBe(
      'wss://hospital.example/ai/scribe/stream/s1',
    );
  });

  it('tolerates a trailing slash on the configured base', () => {
    expect(publicStreamUrl('s1', 'https://hospital.example/ai//')).toBe(
      'wss://hospital.example/ai/scribe/stream/s1',
    );
  });
});
