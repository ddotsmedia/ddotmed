import type { CountryCode, Invoice, InsuranceClaim, Patient } from '@medicore/shared-types';

export interface IdValidationResult {
  valid: boolean;
  type: string;
  normalized?: string;
  error?: string;
}

export interface FormattedInvoice {
  /** Regulator-facing document title, already localised where the regulator mandates it. */
  documentTitle: string;
  currency: string;
  locale: string;
  /** Tax label as it must appear on the printed invoice (VAT / GST / Sales Tax…). */
  taxLabel: string;
  taxRateBp: number;
  /** Field name → rendered value; rendered verbatim in the invoice header block. */
  regulatoryFields: Record<string, string>;
  lines: Array<{ description: string; qty: number; unit: string; tax: string; total: string }>;
  subtotal: string;
  tax: string;
  discount: string;
  total: string;
  amountInWords?: string;
}

export interface ClaimPayload {
  format: 'nphies-fhir' | 'malaffi-fhir' | 'x12-837p' | 'nhcx-fhir' | 'edifact' | 'fhir-r4';
  contentType: string;
  endpointHint: string;
  body: Record<string, unknown>;
}

export interface InsuranceRules {
  requiresPreAuthAbove: number | null;
  preAuthTurnaroundHours: number;
  claimSubmissionDeadlineDays: number;
  resubmissionWindowDays: number;
  mandatoryDiagnosisSystem: 'ICD-10' | 'ICD-10-CM' | 'ICD-10-AM' | 'ICD-11';
  mandatoryProcedureSystem: 'CPT' | 'HCPCS' | 'OPCS-4' | 'CCAM' | 'ACHI';
  copayAppliesTo: Array<'consultation' | 'pharmacy' | 'lab' | 'imaging' | 'inpatient'>;
  eligibilityCheckRequired: boolean;
  supportsRealtimeAdjudication: boolean;
}

export interface FieldRequirement {
  field: string;
  label: string;
  required: boolean;
  pattern?: string;
  note?: string;
}

export interface ICountryPack {
  readonly code: CountryCode;
  readonly displayName: string;
  readonly isoCountries: string[];
  readonly currency: string;
  readonly currencyMinorUnits: number;
  readonly defaultLocale: string;
  readonly taxLabel: string;
  readonly taxRateBp: number;
  readonly idTypes: string[];
  readonly hieName: string | null;

  validatePatientId(type: string, value: string): IdValidationResult;
  formatInvoice(invoice: Invoice, patient?: Pick<Patient, 'name' | 'mrn'>): FormattedInvoice;
  buildClaimPayload(claim: InsuranceClaim, ctx?: ClaimBuildContext): ClaimPayload;
  getInsuranceRules(): InsuranceRules;
  getRequiredFields(entity: 'patient' | 'invoice' | 'claim'): FieldRequirement[];
}

export interface ClaimBuildContext {
  providerLicense?: string;
  providerName?: string;
  payerLicense?: string;
  memberId?: string;
  patientMrn?: string;
}
