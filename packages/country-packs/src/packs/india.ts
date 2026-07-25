import type { ICountryPack } from '../types.js';
import {
  baseRequiredFields,
  digitsOnly,
  fail,
  fhirClaim,
  ok,
  renderInvoice,
  verhoeff,
} from '../shared.js';

/** India — Aadhaar (Verhoeff), ABHA, GST, ABDM HIE, NHCX claims exchange. */
export const indiaPack: ICountryPack = {
  code: 'india',
  displayName: 'India',
  isoCountries: ['IN'],
  currency: 'INR',
  currencyMinorUnits: 2,
  defaultLocale: 'en-IN',
  taxLabel: 'GST',
  taxRateBp: 1800,
  idTypes: ['aadhaar', 'abha', 'abha-address', 'pan', 'passport', 'mrn'],
  hieName: 'ABDM',

  validatePatientId(type, value) {
    const v = digitsOnly(value);
    switch (type) {
      case 'aadhaar':
        if (v.length !== 12) return fail(type, 'Aadhaar must be 12 digits');
        if (v.startsWith('0') || v.startsWith('1'))
          return fail(type, 'Aadhaar cannot start with 0 or 1');
        return verhoeff(v)
          ? ok(type, `${v.slice(0, 4)} ${v.slice(4, 8)} ${v.slice(8)}`)
          : fail(type, 'Aadhaar Verhoeff checksum failed');
      case 'abha':
        return v.length === 14
          ? ok(type, `${v.slice(0, 2)}-${v.slice(2, 6)}-${v.slice(6, 10)}-${v.slice(10)}`)
          : fail(type, 'ABHA number must be 14 digits');
      case 'abha-address':
        return /^[a-z0-9._]{3,}@(abdm|sbx)$/i.test(value.trim())
          ? ok(type, value.trim().toLowerCase())
          : fail(type, 'ABHA address must look like name@abdm');
      case 'pan':
        return /^[A-Z]{5}\d{4}[A-Z]$/i.test(value.trim())
          ? ok(type, value.trim().toUpperCase())
          : fail(type, 'PAN must match AAAAA9999A');
      case 'passport':
        return /^[A-Z]\d{7}$/i.test(value.trim())
          ? ok(type, value.trim().toUpperCase())
          : fail(type, 'Indian passport must be 1 letter followed by 7 digits');
      case 'mrn':
        return value.trim() ? ok(type, value.trim().toUpperCase()) : fail(type, 'MRN is required');
      default:
        return fail(type, `Unsupported identifier type for India: ${type}`);
    }
  },

  formatInvoice(invoice) {
    const intra = invoice.regulatory_fields.place_of_supply === invoice.regulatory_fields.supplier_state;
    return renderInvoice(invoice, {
      documentTitle: 'TAX INVOICE',
      locale: 'en-IN',
      taxLabel: intra ? 'CGST + SGST (9% + 9%)' : 'IGST (18%)',
      taxRateBp: 1800,
      includeWords: true,
      regulatoryFields: {
        GSTIN: invoice.tax_registration_number ?? 'GSTIN-NOT-SET',
        'Place of Supply': invoice.regulatory_fields.place_of_supply ?? '',
        'HSN/SAC': invoice.regulatory_fields.hsn_sac ?? '9993',
        'Invoice No': invoice.invoice_number,
        ...invoice.regulatory_fields,
      },
    });
  },

  buildClaimPayload(claim, ctx = {}) {
    return {
      format: 'nhcx-fhir',
      contentType: 'application/fhir+json',
      endpointHint: '/hcx/v1/claim/submit',
      body: {
        resourceType: 'Bundle',
        type: 'collection',
        meta: { profile: ['https://nrces.in/ndhm/fhir/r4/StructureDefinition/ClaimBundle'] },
        entry: [
          {
            resource: {
              ...fhirClaim(claim, ctx),
              subType: {
                coding: [{ system: 'https://nhcx.gov.in/CodeSystem/claim-subtype', code: 'OPD' }],
              },
            },
          },
        ],
        // NHCX routes on participant codes carried in the protocol headers.
        _nhcx: {
          'x-hcx-sender_code': ctx.providerLicense ?? '',
          'x-hcx-recipient_code': ctx.payerLicense ?? '',
          'x-hcx-correlation_id': claim.id,
        },
      },
    };
  },

  getInsuranceRules() {
    return {
      requiresPreAuthAbove: 2_500_000,
      preAuthTurnaroundHours: 6,
      claimSubmissionDeadlineDays: 30,
      resubmissionWindowDays: 15,
      mandatoryDiagnosisSystem: 'ICD-10',
      mandatoryProcedureSystem: 'CPT',
      copayAppliesTo: ['inpatient', 'pharmacy'],
      eligibilityCheckRequired: true,
      supportsRealtimeAdjudication: false,
    };
  },

  getRequiredFields(entity) {
    const base = baseRequiredFields[entity] ?? [];
    if (entity === 'patient')
      return [
        ...base,
        { field: 'identifiers.abha', label: 'ABHA number', required: false, note: 'Required for ABDM linking' },
        { field: 'address.state', label: 'State', required: true },
      ];
    if (entity === 'invoice')
      return [
        ...base,
        { field: 'tax_registration_number', label: 'GSTIN', required: true, pattern: '^\\d{2}[A-Z]{5}\\d{4}[A-Z]{1}[A-Z\\d]{3}$' },
        { field: 'regulatory_fields.place_of_supply', label: 'Place of supply', required: true },
      ];
    return [...base, { field: 'payload.nhcx_sender_code', label: 'NHCX participant code', required: true }];
  },
};
