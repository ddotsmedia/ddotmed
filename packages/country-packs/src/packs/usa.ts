import type { ICountryPack } from '../types.js';
import { baseRequiredFields, digitsOnly, fail, luhn, ok, renderInvoice } from '../shared.js';

/** NPI check digit: Luhn over the number prefixed with the 80840 issuer identifier. */
function npiValid(v: string): boolean {
  return v.length === 10 && luhn(`80840${v}`);
}

/** United States — SSN/NPI/MBI, no VAT, X12 837P claims, HIPAA. */
export const usaPack: ICountryPack = {
  code: 'usa',
  displayName: 'United States',
  isoCountries: ['US'],
  currency: 'USD',
  currencyMinorUnits: 2,
  defaultLocale: 'en-US',
  taxLabel: 'Sales Tax',
  taxRateBp: 0,
  idTypes: ['ssn', 'mbi', 'npi', 'drivers-license', 'passport', 'mrn'],
  hieName: 'Carequality / TEFCA',

  validatePatientId(type, value) {
    const v = digitsOnly(value);
    switch (type) {
      case 'ssn':
        if (v.length !== 9) return fail(type, 'SSN must be 9 digits');
        if (/^(000|666|9\d\d)/.test(v)) return fail(type, 'SSN area number is invalid');
        if (v.slice(3, 5) === '00' || v.slice(5) === '0000')
          return fail(type, 'SSN group or serial number is invalid');
        return ok(type, `${v.slice(0, 3)}-${v.slice(3, 5)}-${v.slice(5)}`);
      case 'mbi':
        // Medicare Beneficiary Identifier: C A AN N A AN N A A N N
        return /^[1-9][ACDEFGHJKMNPQRTUVWXY][ACDEFGHJKMNPQRTUVWXY0-9]\d[ACDEFGHJKMNPQRTUVWXY][ACDEFGHJKMNPQRTUVWXY0-9]\d[ACDEFGHJKMNPQRTUVWXY]{2}\d{2}$/.test(
          value.replace(/[-\s]/g, '').toUpperCase(),
        )
          ? ok(type, value.replace(/[-\s]/g, '').toUpperCase())
          : fail(type, 'MBI format is invalid');
      case 'npi':
        return npiValid(v) ? ok(type, v) : fail(type, 'NPI check digit failed');
      case 'drivers-license':
        return /^[A-Z0-9]{4,20}$/i.test(value.trim())
          ? ok(type, value.trim().toUpperCase())
          : fail(type, "Driver's licence must be 4-20 alphanumeric characters");
      case 'passport':
        return /^[A-Z0-9]{6,9}$/i.test(value.trim())
          ? ok(type, value.trim().toUpperCase())
          : fail(type, 'Passport number must be 6-9 alphanumeric characters');
      case 'mrn':
        return value.trim() ? ok(type, value.trim().toUpperCase()) : fail(type, 'MRN is required');
      default:
        return fail(type, `Unsupported identifier type for USA: ${type}`);
    }
  },

  formatInvoice(invoice) {
    return renderInvoice(invoice, {
      documentTitle: 'STATEMENT OF CHARGES',
      locale: 'en-US',
      taxLabel: 'Sales Tax',
      taxRateBp: invoice.line_items[0]?.tax_rate_bp ?? 0,
      regulatoryFields: {
        'Statement No': invoice.invoice_number,
        'Facility NPI': invoice.regulatory_fields.facility_npi ?? '',
        'Good Faith Estimate': invoice.regulatory_fields.gfe_reference ?? 'N/A',
        ...invoice.regulatory_fields,
      },
    });
  },

  buildClaimPayload(claim, ctx = {}) {
    const dollars = (m: number) => (m / 100).toFixed(2);
    const seg: string[] = [
      'ISA*00*          *00*          *ZZ*MEDICORE       *ZZ*PAYER          *~',
      'GS*HC*MEDICORE*PAYER*~',
      'ST*837*0001*005010X222A1~',
      `BHT*0019*00*${claim.claim_number}*~`,
      `NM1*85*2*${ctx.providerName ?? 'PROVIDER'}*****XX*${ctx.providerLicense ?? ''}~`,
      `NM1*IL*1*PATIENT*****MI*${ctx.memberId ?? ''}~`,
      `CLM*${claim.claim_number}*${dollars(claim.claimed_minor)}***11:B:1*Y*A*Y*Y~`,
      ...claim.diagnosis_codes.map((d, i) => `HI*${i === 0 ? 'ABK' : 'ABF'}:${d.code}~`),
      ...claim.procedure_codes.map((p, i) => `SV1*HC:${p.code}*${dollars(claim.claimed_minor)}*UN*1***${i + 1}~`),
      'SE*0*0001~',
      'GE*1*1~',
      'IEA*1*000000001~',
    ];
    return {
      format: 'x12-837p',
      contentType: 'application/edi-x12',
      endpointHint: '/clearinghouse/837p',
      body: { edi: seg.join('\n'), segments: seg.length, control_number: claim.claim_number },
    };
  },

  getInsuranceRules() {
    return {
      requiresPreAuthAbove: 500_000,
      preAuthTurnaroundHours: 72,
      claimSubmissionDeadlineDays: 365,
      resubmissionWindowDays: 180,
      mandatoryDiagnosisSystem: 'ICD-10-CM',
      mandatoryProcedureSystem: 'CPT',
      copayAppliesTo: ['consultation', 'pharmacy', 'lab', 'imaging', 'inpatient'],
      eligibilityCheckRequired: true,
      supportsRealtimeAdjudication: true,
    };
  },

  getRequiredFields(entity) {
    const base = baseRequiredFields[entity] ?? [];
    if (entity === 'patient')
      return [
        ...base,
        { field: 'address.state', label: 'State', required: true },
        { field: 'address.postal_code', label: 'ZIP code', required: true, pattern: '^\\d{5}(-\\d{4})?$' },
        { field: 'identifiers.ssn', label: 'SSN', required: false, note: 'Optional under HIPAA minimum necessary' },
      ];
    if (entity === 'invoice')
      return [
        ...base,
        { field: 'regulatory_fields.facility_npi', label: 'Facility NPI', required: true },
        { field: 'regulatory_fields.gfe_reference', label: 'Good Faith Estimate ref', required: false, note: 'No Surprises Act' },
      ];
    return [
      ...base,
      { field: 'payload.rendering_npi', label: 'Rendering provider NPI', required: true },
      { field: 'payload.place_of_service', label: 'Place of service code', required: true },
    ];
  },
};
