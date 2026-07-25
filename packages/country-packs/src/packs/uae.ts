import type { ICountryPack } from '../types.js';
import { baseRequiredFields, digitsOnly, fail, fhirClaim, ok, renderInvoice } from '../shared.js';

/** United Arab Emirates — Emirates ID, 5% VAT, Malaffi HIE, Shafafiya/Riayati claims. */
export const uaePack: ICountryPack = {
  code: 'uae',
  displayName: 'United Arab Emirates',
  isoCountries: ['AE'],
  currency: 'AED',
  currencyMinorUnits: 2,
  defaultLocale: 'ar-AE',
  taxLabel: 'VAT',
  taxRateBp: 500,
  idTypes: ['emirates-id', 'passport', 'visa-number', 'mrn'],
  hieName: 'Malaffi',

  validatePatientId(type, value) {
    const v = digitsOnly(value);
    switch (type) {
      case 'emirates-id':
        // 784-YYYY-NNNNNNN-C
        if (v.length !== 15) return fail(type, 'Emirates ID must be 15 digits');
        if (!v.startsWith('784')) return fail(type, 'Emirates ID must start with 784');
        return ok(type, `${v.slice(0, 3)}-${v.slice(3, 7)}-${v.slice(7, 14)}-${v.slice(14)}`);
      case 'passport':
        return /^[A-Z0-9]{6,12}$/i.test(value.trim())
          ? ok(type, value.trim().toUpperCase())
          : fail(type, 'Passport number must be 6-12 alphanumeric characters');
      case 'visa-number':
        return v.length >= 9 && v.length <= 15
          ? ok(type, v)
          : fail(type, 'Visa number must be 9-15 digits');
      case 'mrn':
        return value.trim() ? ok(type, value.trim().toUpperCase()) : fail(type, 'MRN is required');
      default:
        return fail(type, `Unsupported identifier type for UAE: ${type}`);
    }
  },

  formatInvoice(invoice) {
    return renderInvoice(invoice, {
      documentTitle: 'TAX INVOICE / فاتورة ضريبية',
      locale: 'ar-AE',
      taxLabel: 'VAT (5%)',
      taxRateBp: 500,
      includeWords: true,
      regulatoryFields: {
        TRN: invoice.tax_registration_number ?? 'TRN-NOT-SET',
        'Place of Supply': invoice.regulatory_fields.emirate ?? 'Abu Dhabi',
        'Invoice No': invoice.invoice_number,
        ...invoice.regulatory_fields,
      },
    });
  },

  buildClaimPayload(claim, ctx = {}) {
    return {
      format: 'malaffi-fhir',
      contentType: 'application/fhir+json',
      endpointHint: '/Claim/$submit',
      body: {
        resourceType: 'Bundle',
        type: 'message',
        meta: { profile: ['http://malaffi.ae/fhir/StructureDefinition/claim-submission'] },
        entry: [
          {
            resource: {
              ...fhirClaim(claim, ctx),
              subType: { coding: [{ system: 'http://shafafiya.org/encounter-type', code: 'OP' }] },
              extension: [
                {
                  url: 'http://shafafiya.org/StructureDefinition/provider-license',
                  valueString: ctx.providerLicense ?? '',
                },
              ],
            },
          },
        ],
      },
    };
  },

  getInsuranceRules() {
    return {
      requiresPreAuthAbove: 100_000,
      preAuthTurnaroundHours: 24,
      claimSubmissionDeadlineDays: 90,
      resubmissionWindowDays: 30,
      mandatoryDiagnosisSystem: 'ICD-10',
      mandatoryProcedureSystem: 'CPT',
      copayAppliesTo: ['consultation', 'pharmacy', 'lab', 'imaging'],
      eligibilityCheckRequired: true,
      supportsRealtimeAdjudication: true,
    };
  },

  getRequiredFields(entity) {
    const base = baseRequiredFields[entity] ?? [];
    if (entity === 'patient')
      return [
        ...base,
        { field: 'identifiers.emirates-id', label: 'Emirates ID', required: true, pattern: '^784\\d{12}$' },
        { field: 'nationality', label: 'Nationality', required: true },
      ];
    if (entity === 'invoice')
      return [...base, { field: 'tax_registration_number', label: 'TRN', required: true }];
    return [
      ...base,
      { field: 'payload.provider_license', label: 'DOH/DHA provider licence', required: true },
    ];
  },
};
