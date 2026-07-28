/**
 * NEWS2 scoring lives in @medicore/shared-types so the bedside entry form and the
 * server that stores the observation can never disagree about a patient's risk.
 * Re-exported here because every call site in this service already imports it
 * from ./ews.
 */
export {
  calculateBmi,
  calculateEws,
  detectCriticalVitals,
  type CriticalVital,
  type EwsInput,
  type EwsResult,
  type EwsRisk,
} from '@medicore/shared-types';
