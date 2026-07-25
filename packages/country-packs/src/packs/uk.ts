import type { ICountryPack } from '../types.js';
import { baseRequiredFields, digitsOnly, fail, fhirClaim, ok, renderInvoice } from '../shared.js';

/** NHS number modulus-11 check digit. */
function nhsValid(v: string): boolean {
  if (v.length !== 10) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(v[i]) * (10 - i);
  const remainder = 11 - (sum % 11);
  const check = remainder === 11 ? 0 : remainder;
  return check !== 10 && check === Number(v[9]);
}

/** United Kingdom — NHS number, NHS Spine, PAS/SUS, healthcare VAT-exempt. */
export const ukPack: ICountryPack = {
  code: 'uk',
  displayName: 'United Kingdom',
  isoCountries: ['GB'],
  currency: 'GBP',
  currencyMinorUnits: 2,
  defaultLocale: 'en-GB',
  taxLabel: 'VAT',
  taxRateBp: 0,
  idTypes: ['nhs-number', 'chi-number', 'ni-number', 'passport', 'mrn'],
  hieName: 'NHS Spine',

  validatePatientId(type, value) {
    const v = digitsOnly(value);
    switch (type) {
      case 'nhs-number':
        return nhsValid(v)
          ? ok(type, `${v.slice(0, 3)} ${v.slice(3, 6)} ${v.slice(6)}`)
          : fail(type, 'NHS number failed the modulus-11 check');
      case 'chi-number':
        // Scottish CHI: DDMMYY + 4 digits, mod-11 checked.
        if (v.length !== 10) return fail(type, 'CHI number must be 10 digits');
        return Number(v.slice(0, 2)) >= 1 && Number(v.slice(0, 2)) <= 31
          ? ok(type, v)
          : fail(type, 'CHI number contains an invalid date of birth prefix');
      case 'ni-number':
        return /^[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]$/i.test(value.replace(/\s/g, ''))
          ? ok(type, value.replace(/\s/g, '').toUpperCase())
          : fail(type, 'National Insurance number format is invalid');
      case 'passport':
        return /^\d{9}$/.test(v)
          ? ok(type, v)
          : fail(type, 'UK passport number must be 9 digits');
      case 'mrn':
        return value.trim() ? ok(type, value.trim().toUpperCase()) : fail(type, 'MRN is required');
      default:
        return fail(type, `Unsupported identifier type for UK: ${type}`);
    }
  },

  formatInvoice(invoice) {
    return renderInvoice(invoice, {
      documentTitle: 'INVOICE',
      locale: 'en-GB',
      // Most medical care by a registered practitioner is VAT-exempt in the UK.
      taxLabel: 'VAT (exempt — medical care, VATA 1994 Sch 9 Grp 7)',
      taxRateBp: 0,
      regulatoryFields: {
        'Invoice No': invoice.invoice_number,
        'VAT Registration': invoice.tax_registration_number ?? 'N/A (exempt supply)',
        'CQC Provider ID': invoice.regulatory_fields.cqc_provider_id ?? '',
        'ODS Code': invoice.regulatory_fields.ods_code ?? '',
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
        meta: { profile: ['https://fhir.hl7.org.uk/StructureDefinition/UKCore-Claim'] },
        extension: [
          {
            url: 'https://fhir.nhs.uk/StructureDefinition/Extension-ODSOrganisationCode',
            valueString: ctx.providerLicense ?? '',
          },
        ],
      },
    };
  },

  getInsuranceRules() {
    return {
      requiresPreAuthAbove: 100_000,
      preAuthTurnaroundHours: 48,
      claimSubmissionDeadlineDays: 180,
      resubmissionWindowDays: 90,
      mandatoryDiagnosisSystem: 'ICD-10',
      mandatoryProcedureSystem: 'OPCS-4',
      copayAppliesTo: ['pharmacy'],
      eligibilityCheckRequired: false,
      supportsRealtimeAdjudication: false,
    };
  },

  getRequiredFields(entity) {
    const base = baseRequiredFields[entity] ?? [];
    if (entity === 'patient')
      return [
        ...base,
        { field: 'identifiers.nhs-number', label: 'NHS number', required: true, pattern: '^\\d{10}$' },
        { field: 'regulatory_fields.gp_practice_ods', label: 'Registered GP practice (ODS)', required: false },
      ];
    if (entity === 'invoice')
      return [...base, { field: 'regulatory_fields.ods_code', label: 'ODS organisation code', required: true }];
    return [...base, { field: 'payload.ods_code', label: 'ODS organisation code', required: true }];
  },
};
