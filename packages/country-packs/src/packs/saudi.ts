import type { ICountryPack } from '../types.js';
import { baseRequiredFields, digitsOnly, fail, fhirClaim, ok, renderInvoice } from '../shared.js';

/** Saudi National ID / Iqama checksum: Luhn over all 10 digits, doubling at even indices. */
function saudiIdChecksum(v: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const digit = Number(v[i]);
    if (Number.isNaN(digit)) return false;
    if (i % 2 === 0) {
      const doubled = digit * 2;
      sum += doubled > 9 ? Math.floor(doubled / 10) + (doubled % 10) : doubled;
    } else {
      sum += digit;
    }
  }
  return sum % 10 === 0;
}

/** Kingdom of Saudi Arabia — 15% VAT, ZATCA e-invoicing, Nphies claims. */
export const saudiPack: ICountryPack = {
  code: 'saudi',
  displayName: 'Saudi Arabia',
  isoCountries: ['SA'],
  currency: 'SAR',
  currencyMinorUnits: 2,
  defaultLocale: 'ar-SA',
  taxLabel: 'VAT',
  taxRateBp: 1500,
  idTypes: ['national-id', 'iqama', 'passport', 'border-number', 'mrn'],
  hieName: 'Nphies',

  validatePatientId(type, value) {
    const v = digitsOnly(value);
    switch (type) {
      case 'national-id':
        if (v.length !== 10) return fail(type, 'National ID must be 10 digits');
        if (!v.startsWith('1')) return fail(type, 'Saudi national ID must start with 1');
        return saudiIdChecksum(v) ? ok(type, v) : fail(type, 'National ID checksum failed');
      case 'iqama':
        if (v.length !== 10) return fail(type, 'Iqama must be 10 digits');
        if (!v.startsWith('2')) return fail(type, 'Iqama must start with 2');
        return saudiIdChecksum(v) ? ok(type, v) : fail(type, 'Iqama checksum failed');
      case 'border-number':
        return v.length === 10 ? ok(type, v) : fail(type, 'Border number must be 10 digits');
      case 'passport':
        return /^[A-Z0-9]{6,12}$/i.test(value.trim())
          ? ok(type, value.trim().toUpperCase())
          : fail(type, 'Passport number must be 6-12 alphanumeric characters');
      case 'mrn':
        return value.trim() ? ok(type, value.trim().toUpperCase()) : fail(type, 'MRN is required');
      default:
        return fail(type, `Unsupported identifier type for Saudi Arabia: ${type}`);
    }
  },

  formatInvoice(invoice) {
    return renderInvoice(invoice, {
      documentTitle: 'TAX INVOICE / فاتورة ضريبية',
      locale: 'ar-SA',
      taxLabel: 'VAT (15%)',
      taxRateBp: 1500,
      includeWords: true,
      regulatoryFields: {
        'VAT Number': invoice.tax_registration_number ?? 'VAT-NOT-SET',
        'ZATCA UUID': invoice.regulatory_fields.zatca_uuid ?? invoice.id,
        'Invoice Type': invoice.regulatory_fields.zatca_invoice_type ?? '0100000',
        'Invoice No': invoice.invoice_number,
        ...invoice.regulatory_fields,
      },
    });
  },

  buildClaimPayload(claim, ctx = {}) {
    return {
      format: 'nphies-fhir',
      contentType: 'application/fhir+json',
      endpointHint: '/$process-message',
      body: {
        resourceType: 'Bundle',
        type: 'message',
        meta: { profile: ['http://nphies.sa/fhir/ksa/nphies-fs/StructureDefinition/bundle|1.0.0'] },
        entry: [
          {
            resource: {
              resourceType: 'MessageHeader',
              eventCoding: {
                system: 'http://nphies.sa/terminology/CodeSystem/ksa-message-events',
                code: 'claim-request',
              },
              destination: [{ endpoint: `http://nphies.sa/license/payer-license/${ctx.payerLicense ?? ''}` }],
              sender: { reference: `Organization/${claim.tenant_id}` },
            },
          },
          {
            resource: {
              ...fhirClaim(claim, ctx),
              subType: {
                coding: [{ system: 'http://nphies.sa/terminology/CodeSystem/claim-subtype', code: 'ip' }],
              },
            },
          },
        ],
      },
    };
  },

  getInsuranceRules() {
    return {
      requiresPreAuthAbove: 50_000,
      preAuthTurnaroundHours: 24,
      claimSubmissionDeadlineDays: 60,
      resubmissionWindowDays: 30,
      mandatoryDiagnosisSystem: 'ICD-10-AM',
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
        { field: 'identifiers.national-id', label: 'National ID / Iqama', required: true, pattern: '^[12]\\d{9}$' },
        { field: 'nationality', label: 'Nationality', required: true },
      ];
    if (entity === 'invoice')
      return [
        ...base,
        { field: 'tax_registration_number', label: 'VAT registration number', required: true },
        { field: 'regulatory_fields.zatca_uuid', label: 'ZATCA UUID', required: true },
      ];
    return [
      ...base,
      { field: 'payload.payer_license', label: 'Nphies payer licence', required: true },
      { field: 'payload.provider_license', label: 'Nphies provider licence', required: true },
    ];
  },
};
