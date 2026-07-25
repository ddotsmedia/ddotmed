import { describe, expect, it } from 'vitest';
import { COUNTRY_PACKS, getCountryPack, packForCountry } from '../index.js';
import type { Invoice, InsuranceClaim } from '@medicore/shared-types';

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: '0193c3f0-0000-7000-8000-000000000001',
  fhir_id: null,
  tenant_id: '0193c3f0-0000-7000-8000-0000000000ff',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  deleted_at: null,
  invoice_number: 'INV-0001',
  patient_id: '0193c3f0-0000-7000-8000-000000000002',
  encounter_id: null,
  status: 'issued',
  currency: 'AED',
  country_pack: 'uae',
  subtotal_minor: 100_000,
  discount_minor: 0,
  tax_minor: 5_000,
  total_minor: 105_000,
  paid_minor: 0,
  balance_minor: 105_000,
  payer_share_minor: 0,
  patient_share_minor: 105_000,
  line_items: [
    {
      id: '0193c3f0-0000-7000-8000-000000000003',
      charge_code: 'CONS-01',
      description: 'Specialist consultation',
      quantity: 1,
      unit_price_minor: 100_000,
      discount_minor: 0,
      tax_rate_bp: 500,
      tax_minor: 5_000,
      total_minor: 105_000,
      payer_share_minor: 0,
      patient_share_minor: 105_000,
      service_date: '2026-01-01T00:00:00.000Z',
    },
  ],
  regulatory_fields: {},
  ...over,
});

const claim: InsuranceClaim = {
  id: '0193c3f0-0000-7000-8000-000000000010',
  fhir_id: null,
  tenant_id: '0193c3f0-0000-7000-8000-0000000000ff',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  deleted_at: null,
  claim_number: 'CLM-0001',
  patient_id: '0193c3f0-0000-7000-8000-000000000002',
  encounter_id: null,
  invoice_id: null,
  coverage_id: '0193c3f0-0000-7000-8000-000000000011',
  payer_id: '0193c3f0-0000-7000-8000-000000000012',
  status: 'draft',
  country_pack: 'uae',
  claim_format: 'malaffi-fhir',
  currency: 'AED',
  claimed_minor: 105_000,
  approved_minor: 0,
  paid_minor: 0,
  denied_minor: 0,
  diagnosis_codes: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'J06.9', display: 'URTI' }],
  procedure_codes: [{ system: 'http://www.ama-assn.org/go/cpt', code: '99213' }],
  denial_risk_factors: [],
  denial_reason_codes: [],
  payload: {},
};

describe('country packs', () => {
  it('exposes all seven packs and resolves by ISO country', () => {
    expect(Object.keys(COUNTRY_PACKS)).toHaveLength(7);
    expect(packForCountry('AE').code).toBe('uae');
    expect(packForCountry('IN').code).toBe('india');
    expect(packForCountry('GB').code).toBe('uk');
    expect(packForCountry('DE').code).toBe('eu');
    expect(packForCountry('KE').code).toBe('africa');
  });

  it('throws for an unknown pack code', () => {
    expect(() => getCountryPack('atlantis')).toThrow(/Unknown country pack/);
  });

  it.each(Object.values(COUNTRY_PACKS))('$code implements the full interface', (pack) => {
    expect(typeof pack.validatePatientId).toBe('function');
    expect(pack.formatInvoice(invoice({ currency: pack.currency }))).toHaveProperty('total');
    expect(pack.buildClaimPayload(claim)).toHaveProperty('format');
    expect(pack.getInsuranceRules().claimSubmissionDeadlineDays).toBeGreaterThan(0);
    expect(pack.getRequiredFields('patient').length).toBeGreaterThan(0);
    expect(pack.getRequiredFields('invoice').length).toBeGreaterThan(0);
    expect(pack.getRequiredFields('claim').length).toBeGreaterThan(0);
  });

  it('validates an Emirates ID and rejects a malformed one', () => {
    expect(COUNTRY_PACKS.uae.validatePatientId('emirates-id', '784-1990-1234567-1').valid).toBe(true);
    expect(COUNTRY_PACKS.uae.validatePatientId('emirates-id', '123456789012345').valid).toBe(false);
  });

  it('validates the Aadhaar Verhoeff checksum', () => {
    expect(COUNTRY_PACKS.india.validatePatientId('aadhaar', '234567890124').valid).toBe(true);
    expect(COUNTRY_PACKS.india.validatePatientId('aadhaar', '234567890123').valid).toBe(false);
    expect(COUNTRY_PACKS.india.validatePatientId('aadhaar', '134567890124').valid).toBe(false);
  });

  it('validates the NHS number modulus-11 check digit', () => {
    expect(COUNTRY_PACKS.uk.validatePatientId('nhs-number', '9434765919').valid).toBe(true);
    expect(COUNTRY_PACKS.uk.validatePatientId('nhs-number', '9434765918').valid).toBe(false);
  });

  it('validates the NPI Luhn check digit', () => {
    expect(COUNTRY_PACKS.usa.validatePatientId('npi', '1234567893').valid).toBe(true);
    expect(COUNTRY_PACKS.usa.validatePatientId('npi', '1234567890').valid).toBe(false);
  });

  it('rejects reserved SSN ranges', () => {
    expect(COUNTRY_PACKS.usa.validatePatientId('ssn', '123-45-6789').valid).toBe(true);
    expect(COUNTRY_PACKS.usa.validatePatientId('ssn', '666-45-6789').valid).toBe(false);
    expect(COUNTRY_PACKS.usa.validatePatientId('ssn', '123-00-6789').valid).toBe(false);
  });

  it('validates the Saudi national ID checksum and prefix', () => {
    expect(COUNTRY_PACKS.saudi.validatePatientId('national-id', '1000000008').valid).toBe(true);
    expect(COUNTRY_PACKS.saudi.validatePatientId('national-id', '1000000009').valid).toBe(false);
    expect(COUNTRY_PACKS.saudi.validatePatientId('national-id', '3000000008').valid).toBe(false);
    expect(COUNTRY_PACKS.saudi.validatePatientId('iqama', '2000000006').valid).toBe(true);
  });

  it('builds an X12 837P claim for the USA', () => {
    const payload = COUNTRY_PACKS.usa.buildClaimPayload(claim, { providerLicense: '1234567893' });
    expect(payload.format).toBe('x12-837p');
    expect(String(payload.body.edi)).toContain('CLM*CLM-0001*1050.00');
  });

  it('builds an Nphies message bundle for Saudi Arabia', () => {
    const payload = COUNTRY_PACKS.saudi.buildClaimPayload(claim, { payerLicense: 'PAY-1' });
    expect(payload.format).toBe('nphies-fhir');
    expect((payload.body as { type: string }).type).toBe('message');
  });

  it('spells the invoice total in words where the regulator requires it', () => {
    const formatted = COUNTRY_PACKS.uae.formatInvoice(invoice());
    expect(formatted.amountInWords).toBe('AED one thousand and fifty only');
    expect(formatted.taxLabel).toBe('VAT (5%)');
  });

  it('treats UK medical care as VAT-exempt', () => {
    expect(COUNTRY_PACKS.uk.taxRateBp).toBe(0);
    expect(COUNTRY_PACKS.uk.formatInvoice(invoice({ currency: 'GBP' })).taxLabel).toMatch(/exempt/);
  });

  it('switches India between IGST and CGST+SGST by place of supply', () => {
    const intra = COUNTRY_PACKS.india.formatInvoice(
      invoice({ currency: 'INR', regulatory_fields: { place_of_supply: 'KA', supplier_state: 'KA' } }),
    );
    const inter = COUNTRY_PACKS.india.formatInvoice(
      invoice({ currency: 'INR', regulatory_fields: { place_of_supply: 'MH', supplier_state: 'KA' } }),
    );
    expect(intra.taxLabel).toContain('CGST');
    expect(inter.taxLabel).toContain('IGST');
  });
});
