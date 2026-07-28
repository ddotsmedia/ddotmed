/**
 * Shapes what the AI service returns into the contract the clinical clients read.
 *
 * Kept free of Nest and Prisma so the rules that matter clinically — a draft is
 * never presented as approved, a missing confidence is never optimistic, an
 * unattributed draft is never anonymous — are unit-testable on their own.
 */

export interface LinkedEvidence {
  sentence: string;
  audio_offset_ms: number;
  confidence: number;
}

export interface SoapDraft {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export interface SuggestedCode {
  system: string;
  code: string;
  display: string;
  confidence: number;
}

export interface ScribeDraft {
  session_id: string;
  transcript: string;
  draft: SoapDraft;
  linked_evidence: LinkedEvidence[];
  suggested_codes: SuggestedCode[];
  confidence_score: number;
  low_confidence: boolean;
  /** Always true. An ambient draft is a proposal, never a signed note. */
  requires_approval: true;
  model_version: string;
  audio_duration_ms: number;
}

/** Below this a draft is flagged for careful review regardless of what the provider claims. */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const clamp01 = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function toScribeDraft(raw: unknown, fallbackModel: string): ScribeDraft {
  const body = record(raw);
  const soap = record(body.soap ?? body.draft);
  const confidence = clamp01(body.confidence_score);

  return {
    session_id: str(body.session_id),
    transcript: str(body.transcript),
    draft: {
      subjective: str(soap.subjective ?? soap.S),
      objective: str(soap.objective ?? soap.O),
      assessment: str(soap.assessment ?? soap.A),
      plan: str(soap.plan ?? soap.P),
    },
    linked_evidence: array(body.linked_evidence).map((entry) => {
      const e = record(entry);
      const offset = Number(e.audio_offset_ms);
      return {
        sentence: str(e.sentence),
        audio_offset_ms: Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0,
        confidence: clamp01(e.confidence),
      };
    }),
    suggested_codes: array(body.suggested_codes).map((entry) => {
      const c = record(entry);
      return {
        system: str(c.system) || 'ICD-10',
        code: str(c.code),
        display: str(c.display),
        confidence: clamp01(c.confidence),
      };
    }),
    confidence_score: confidence,
    // The provider's own flag is honoured, but a low score always wins: a service
    // that forgets the flag must not silently downgrade a warning the clinician needs.
    low_confidence: body.low_confidence === true || confidence < LOW_CONFIDENCE_THRESHOLD,
    requires_approval: true,
    model_version: str(body.model_version) || fallbackModel,
    audio_duration_ms: Math.max(0, Math.trunc(Number(body.audio_duration_ms) || 0)),
  };
}

/** True when the draft carries nothing worth putting in front of a clinician. */
export function isEmptyDraft(draft: SoapDraft): boolean {
  return !draft.subjective.trim() && !draft.objective.trim() && !draft.assessment.trim() && !draft.plan.trim();
}

/**
 * Rewrites the streaming URL the AI service advertises onto a host the browser
 * can actually reach. Inside the compose network the service names itself
 * `ai-service:8000`, which resolves nowhere from a clinician's laptop.
 */
export function publicStreamUrl(sessionId: string, publicBase: string): string {
  const base = publicBase.replace(/\/+$/, '').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  return `${base}/scribe/stream/${sessionId}`;
}
