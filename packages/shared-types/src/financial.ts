import { z } from 'zod';
import { BaseEntitySchema, CodingSchema, isoDate, uuid } from './base.js';

export const InvoiceStatusSchema = z.enum([
  'draft',
  'issued',
  'partially-paid',
  'paid',
  'overdue',
  'cancelled',
  'written-off',
]);
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

export const InvoiceLineItemSchema = z.object({
  id: uuid,
  charge_code: z.string(),
  description: z.string(),
  quantity: z.number().int().positive(),
  unit_price_minor: z.number().int().min(0),
  discount_minor: z.number().int().min(0).default(0),
  tax_rate_bp: z.number().int().min(0).max(10000).default(0),
  tax_minor: z.number().int().min(0).default(0),
  total_minor: z.number().int().min(0),
  payer_share_minor: z.number().int().min(0).default(0),
  patient_share_minor: z.number().int().min(0).default(0),
  service_date: isoDate,
});
export type InvoiceLineItem = z.infer<typeof InvoiceLineItemSchema>;

/** All monetary fields are integer minor units (fils/halala/paise/cents). Never floats. */
export const InvoiceSchema = BaseEntitySchema.extend({
  invoice_number: z.string(),
  patient_id: uuid,
  encounter_id: uuid.nullable(),
  coverage_id: uuid.nullable().optional(),
  status: InvoiceStatusSchema,
  currency: z.string().length(3),
  country_pack: z.string(),
  subtotal_minor: z.number().int().min(0),
  discount_minor: z.number().int().min(0).default(0),
  tax_minor: z.number().int().min(0).default(0),
  total_minor: z.number().int().min(0),
  paid_minor: z.number().int().min(0).default(0),
  balance_minor: z.number().int(),
  payer_share_minor: z.number().int().min(0).default(0),
  patient_share_minor: z.number().int().min(0).default(0),
  issued_at: isoDate.nullable().optional(),
  due_at: isoDate.nullable().optional(),
  line_items: z.array(InvoiceLineItemSchema).default([]),
  tax_registration_number: z.string().nullable().optional(),
  regulatory_fields: z.record(z.string()).default({}),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

export const ClaimStatusSchema = z.enum([
  'draft',
  'pre-auth-required',
  'pre-auth-approved',
  'pre-auth-denied',
  'submitted',
  'accepted',
  'rejected',
  'partially-paid',
  'paid',
  'denied',
  'appealed',
  'closed',
]);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

export const InsuranceClaimSchema = BaseEntitySchema.extend({
  claim_number: z.string(),
  patient_id: uuid,
  encounter_id: uuid.nullable(),
  invoice_id: uuid.nullable(),
  coverage_id: uuid,
  payer_id: uuid,
  status: ClaimStatusSchema,
  country_pack: z.string(),
  claim_format: z.string(),
  currency: z.string().length(3),
  claimed_minor: z.number().int().min(0),
  approved_minor: z.number().int().min(0).default(0),
  paid_minor: z.number().int().min(0).default(0),
  denied_minor: z.number().int().min(0).default(0),
  diagnosis_codes: z.array(CodingSchema).default([]),
  procedure_codes: z.array(CodingSchema).default([]),
  denial_risk: z.number().min(0).max(1).nullable().optional(),
  denial_risk_factors: z.array(z.string()).default([]),
  denial_reason_codes: z.array(z.string()).default([]),
  submitted_at: isoDate.nullable().optional(),
  adjudicated_at: isoDate.nullable().optional(),
  payload: z.record(z.unknown()).default({}),
});
export type InsuranceClaim = z.infer<typeof InsuranceClaimSchema>;

export const CoverageSchema = BaseEntitySchema.extend({
  patient_id: uuid,
  payer_id: uuid,
  member_id: z.string(),
  policy_number: z.string(),
  plan_name: z.string().nullable().optional(),
  network: z.string().nullable().optional(),
  relationship: z.enum(['self', 'spouse', 'child', 'parent', 'other']).default('self'),
  status: z.enum(['active', 'cancelled', 'draft', 'entered-in-error']).default('active'),
  starts_at: isoDate,
  ends_at: isoDate.nullable(),
  copay_bp: z.number().int().min(0).max(10000).default(0),
  deductible_minor: z.number().int().min(0).default(0),
  annual_limit_minor: z.number().int().min(0).nullable().optional(),
  used_minor: z.number().int().min(0).default(0),
  requires_preauth: z.boolean().default(false),
  last_eligibility_check_at: isoDate.nullable().optional(),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const PaymentSchema = BaseEntitySchema.extend({
  invoice_id: uuid,
  patient_id: uuid,
  receipt_number: z.string(),
  method: z.enum([
    'cash',
    'card',
    'bank-transfer',
    'insurance',
    'wallet',
    'apple-pay',
    'google-pay',
    'cheque',
  ]),
  currency: z.string().length(3),
  amount_minor: z.number().int().positive(),
  status: z.enum(['pending', 'succeeded', 'failed', 'refunded', 'partially-refunded']),
  gateway_reference: z.string().nullable().optional(),
  received_by: uuid.nullable(),
  received_at: isoDate,
  refunded_minor: z.number().int().min(0).default(0),
});
export type Payment = z.infer<typeof PaymentSchema>;
