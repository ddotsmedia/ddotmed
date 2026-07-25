import { z } from 'zod';

export const uuid = z.string().uuid();
export const isoDate = z.string().datetime({ offset: true });

/** Every persisted entity carries tenant scoping, soft-delete and audit stamps. */
export const BaseEntitySchema = z.object({
  id: uuid,
  fhir_id: uuid.nullable(),
  tenant_id: uuid,
  created_at: isoDate,
  updated_at: isoDate,
  deleted_at: isoDate.nullable(),
  deleted_reason: z.string().max(500).nullable().optional(),
});
export type BaseEntity = z.infer<typeof BaseEntitySchema>;

export const CodingSchema = z.object({
  system: z.string(),
  code: z.string(),
  display: z.string().optional(),
});
export type Coding = z.infer<typeof CodingSchema>;

export const PeriodSchema = z.object({ start: isoDate, end: isoDate.nullable().optional() });
export type Period = z.infer<typeof PeriodSchema>;

/** Money is stored as integer minor units. Floats are never used for currency. */
export const MoneySchema = z.object({
  amount_minor: z.number().int(),
  currency: z.string().length(3),
});
export type Money = z.infer<typeof MoneySchema>;

export const AddressSchema = z.object({
  line: z.array(z.string()).default([]),
  city: z.string().optional(),
  district: z.string().optional(),
  state: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().length(2),
});
export type Address = z.infer<typeof AddressSchema>;

export const HumanNameSchema = z.object({
  given: z.array(z.string()).min(1),
  family: z.string().min(1),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  text: z.string().optional(),
});
export type HumanName = z.infer<typeof HumanNameSchema>;

export const ContactPointSchema = z.object({
  system: z.enum(['phone', 'email', 'fax', 'url', 'sms', 'other']),
  value: z.string().min(1),
  use: z.enum(['home', 'work', 'temp', 'old', 'mobile']).default('mobile'),
  rank: z.number().int().positive().optional(),
});
export type ContactPoint = z.infer<typeof ContactPointSchema>;

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export type CountryCode = 'uae' | 'saudi' | 'india' | 'usa' | 'eu' | 'uk' | 'africa';
export const COUNTRY_CODES: readonly CountryCode[] = [
  'uae',
  'saudi',
  'india',
  'usa',
  'eu',
  'uk',
  'africa',
] as const;
