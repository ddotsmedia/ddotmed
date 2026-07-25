import type { ICountryPack } from '../types.js';
import { baseRequiredFields, digitsOnly, fail, fhirClaim, ok, renderInvoice } from '../shared.js';

const VAT_PREFIX = /^(AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)/;

/** European Union — EHIC, national IDs, VAT, EESSI cross-border, GDPR, MyHealth@EU. */
export const euPack: ICountryPack = {
  code: 'eu',
  displayName: 'European Union',
  isoCountries: [
    'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
    'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
  ],
  currency: 'EUR',
  currencyMinorUnits: 2,
  defaultLocale: 'en-IE',
  taxLabel: 'VAT',
  taxRateBp: 2100,
  idTypes: ['ehic', 'national-id', 'vat-number', 'passport', 'mrn'],
  hieName: 'MyHealth@EU',

  validatePatientId(type, value) {
    const raw = value.replace(/[\s-]/g, '').toUpperCase();
    switch (type) {
      case 'ehic':
        // 20 digits: 5 issuer + 10 personal + 5 card serial.
        return digitsOnly(raw).length === 20
          ? ok(type, digitsOnly(raw))
          : fail(type, 'EHIC number must be 20 digits');
      case 'national-id':
        return /^[A-Z0-9]{6,20}$/.test(raw)
          ? ok(type, raw)
          : fail(type, 'National ID must be 6-20 alphanumeric characters');
      case 'vat-number':
        return VAT_PREFIX.test(raw) && raw.length >= 8 && raw.length <= 14
          ? ok(type, raw)
          : fail(type, 'VAT number must start with a valid EU country prefix');
      case 'passport':
        return /^[A-Z0-9]{6,12}$/.test(raw)
          ? ok(type, raw)
          : fail(type, 'Passport number must be 6-12 alphanumeric characters');
      case 'mrn':
        return value.trim() ? ok(type, value.trim().toUpperCase()) : fail(type, 'MRN is required');
      default:
        return fail(type, `Unsupported identifier type for EU: ${type}`);
    }
  },

  formatInvoice(invoice) {
    const rate = invoice.line_items[0]?.tax_rate_bp ?? 2100;
    return renderInvoice(invoice, {
      documentTitle: 'INVOICE / FACTURE / RECHNUNG',
      locale: invoice.regulatory_fields.locale ?? 'en-IE',
      taxLabel: `VAT (${(rate / 100).toFixed(0)}%)`,
      taxRateBp: rate,
      regulatoryFields: {
        'VAT ID': invoice.tax_registration_number ?? 'VAT-NOT-SET',
        'Invoice No': invoice.invoice_number,
        'EN 16931 Profile': invoice.regulatory_fields.en16931_profile ?? 'urn:cen.eu:en16931:2017',
        'Data Controller': invoice.regulatory_fields.gdpr_controller ?? '',
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
        meta: { profile: ['http://hl7.eu/fhir/StructureDefinition/Claim-eu'] },
        extension: [
          {
            url: 'http://ec.europa.eu/eessi/StructureDefinition/ehic',
            valueString: ctx.memberId ?? '',
          },
        ],
      },
    };
  },

  getInsuranceRules() {
    return {
      requiresPreAuthAbove: 200_000,
      preAuthTurnaroundHours: 120,
      claimSubmissionDeadlineDays: 180,
      resubmissionWindowDays: 60,
      mandatoryDiagnosisSystem: 'ICD-10',
      mandatoryProcedureSystem: 'CCAM',
      copayAppliesTo: ['consultation', 'pharmacy'],
      eligibilityCheckRequired: true,
      supportsRealtimeAdjudication: false,
    };
  },

  getRequiredFields(entity) {
    const base = baseRequiredFields[entity] ?? [];
    if (entity === 'patient')
      return [
        ...base,
        { field: 'address.country', label: 'Country of residence', required: true },
        { field: 'regulatory_fields.gdpr_consent', label: 'GDPR processing consent', required: true, note: 'GDPR Art. 9 explicit consent' },
      ];
    if (entity === 'invoice')
      return [
        ...base,
        { field: 'tax_registration_number', label: 'VAT identification number', required: true },
        { field: 'regulatory_fields.en16931_profile', label: 'EN 16931 profile', required: true },
      ];
    return [...base, { field: 'payload.ehic_number', label: 'EHIC number', required: false }];
  },
};
