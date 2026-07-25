import type { ICountryPack } from '../types.js';
import { baseRequiredFields, digitsOnly, fail, fhirClaim, ok, renderInvoice } from '../shared.js';

/** South African ID number: YYMMDD SSSS C A Z, Luhn-checked. */
function saIdValid(v: string): boolean {
  if (v.length !== 13) return false;
  let sum = 0;
  let alt = false;
  for (let i = 11; i >= 0; i--) {
    let n = Number(v[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return (10 - (sum % 10)) % 10 === Number(v[12]);
}

/**
 * Pan-African pack covering NHIF (Kenya), NHIS (Nigeria/Ghana), SA medical schemes.
 * Mobile-money is a first-class payment rail, so telecom is a mandatory patient field.
 */
export const africaPack: ICountryPack = {
  code: 'africa',
  displayName: 'Africa (Pan-Regional)',
  isoCountries: ['ZA', 'KE', 'NG', 'GH', 'TZ', 'UG', 'RW', 'ET', 'EG', 'MA', 'SN', 'CI', 'ZM'],
  currency: 'USD',
  currencyMinorUnits: 2,
  defaultLocale: 'en-KE',
  taxLabel: 'VAT',
  taxRateBp: 1600,
  idTypes: ['national-id', 'sa-id', 'nhif-number', 'nhis-number', 'passport', 'mrn'],
  hieName: null,

  validatePatientId(type, value) {
    const v = digitsOnly(value);
    switch (type) {
      case 'sa-id':
        return saIdValid(v) ? ok(type, v) : fail(type, 'South African ID checksum failed');
      case 'national-id':
        return v.length >= 6 && v.length <= 16
          ? ok(type, v)
          : fail(type, 'National ID must be 6-16 digits');
      case 'nhif-number':
        return v.length >= 6 && v.length <= 12
          ? ok(type, v)
          : fail(type, 'NHIF number must be 6-12 digits');
      case 'nhis-number':
        return /^[A-Z0-9]{6,15}$/i.test(value.trim())
          ? ok(type, value.trim().toUpperCase())
          : fail(type, 'NHIS number must be 6-15 alphanumeric characters');
      case 'passport':
        return /^[A-Z0-9]{6,12}$/i.test(value.trim())
          ? ok(type, value.trim().toUpperCase())
          : fail(type, 'Passport number must be 6-12 alphanumeric characters');
      case 'mrn':
        return value.trim() ? ok(type, value.trim().toUpperCase()) : fail(type, 'MRN is required');
      default:
        return fail(type, `Unsupported identifier type for Africa pack: ${type}`);
    }
  },

  formatInvoice(invoice) {
    const rate = invoice.line_items[0]?.tax_rate_bp ?? 1600;
    return renderInvoice(invoice, {
      documentTitle: 'TAX INVOICE',
      locale: invoice.regulatory_fields.locale ?? 'en-KE',
      taxLabel: `VAT (${(rate / 100).toFixed(0)}%)`,
      taxRateBp: rate,
      includeWords: true,
      regulatoryFields: {
        'Invoice No': invoice.invoice_number,
        'Tax PIN': invoice.tax_registration_number ?? 'PIN-NOT-SET',
        'Scheme / Fund': invoice.regulatory_fields.scheme ?? '',
        'Mobile Money Ref': invoice.regulatory_fields.mobile_money_ref ?? '',
        ...invoice.regulatory_fields,
      },
    });
  },

  buildClaimPayload(claim, ctx = {}) {
    return {
      format: 'fhir-r4',
      contentType: 'application/fhir+json',
      endpointHint: '/Claim',
      body: {
        ...fhirClaim(claim, ctx),
        extension: [
          { url: 'urn:medicore:africa:scheme-member-id', valueString: ctx.memberId ?? '' },
          { url: 'urn:medicore:africa:facility-code', valueString: ctx.providerLicense ?? '' },
        ],
      },
    };
  },

  getInsuranceRules() {
    return {
      requiresPreAuthAbove: 50_000,
      preAuthTurnaroundHours: 48,
      claimSubmissionDeadlineDays: 60,
      resubmissionWindowDays: 30,
      mandatoryDiagnosisSystem: 'ICD-10',
      mandatoryProcedureSystem: 'CPT',
      copayAppliesTo: ['consultation', 'pharmacy', 'inpatient'],
      eligibilityCheckRequired: true,
      supportsRealtimeAdjudication: false,
    };
  },

  getRequiredFields(entity) {
    const base = baseRequiredFields[entity] ?? [];
    if (entity === 'patient')
      return [
        ...base,
        { field: 'telecom', label: 'Mobile number', required: true, note: 'Used for mobile-money billing and SMS reminders' },
        { field: 'address.district', label: 'District / County', required: true },
      ];
    if (entity === 'invoice')
      return [...base, { field: 'tax_registration_number', label: 'Tax PIN', required: true }];
    return [...base, { field: 'payload.facility_code', label: 'Facility code', required: true }];
  },
};
