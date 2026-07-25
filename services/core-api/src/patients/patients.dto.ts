import { z } from 'zod';

export const IdentifierInput = z.object({
  type: z.string().min(1),
  value: z.string().min(1).max(64),
  system: z.string().optional(),
  country: z.string().length(2).optional(),
  is_primary: z.boolean().default(false),
  expires_at: z.coerce.date().nullable().optional(),
});

export const ContactInput = z.object({
  relationship: z.string().default('self'),
  given_names: z.array(z.string()).default([]),
  family_name: z.string().optional(),
  system: z.enum(['phone', 'email', 'sms', 'fax', 'url', 'other']),
  value: z.string().min(1).max(200),
  use: z.enum(['home', 'work', 'temp', 'old', 'mobile']).default('mobile'),
  is_emergency: z.boolean().default(false),
  is_primary: z.boolean().default(false),
});

export const RegisterPatientDto = z.object({
  given_names: z.array(z.string().min(1)).min(1),
  family_name: z.string().min(1).max(120),
  gender: z.enum(['male', 'female', 'other', 'unknown']),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nationality: z.string().length(2).optional(),
  preferred_language: z.string().default('en'),
  marital_status: z.string().optional(),
  blood_group: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown']).optional(),
  address: z
    .object({
      line: z.array(z.string()).default([]),
      city: z.string().optional(),
      district: z.string().optional(),
      state: z.string().optional(),
      postal_code: z.string().optional(),
      country: z.string().length(2),
    })
    .optional(),
  is_vip: z.boolean().default(false),
  identifiers: z.array(IdentifierInput).default([]),
  contacts: z.array(ContactInput).default([]),
  /** Set once the user has reviewed a duplicate-match list and confirmed a new record. */
  force_create: z.boolean().default(false),
});
export type RegisterPatientDto = z.infer<typeof RegisterPatientDto>;

export const CheckDuplicatesDto = RegisterPatientDto.pick({
  given_names: true,
  family_name: true,
  birth_date: true,
  gender: true,
});
export type CheckDuplicatesDto = z.infer<typeof CheckDuplicatesDto>;

export const UpdatePatientDto = RegisterPatientDto.partial().omit({ force_create: true });
export type UpdatePatientDto = z.infer<typeof UpdatePatientDto>;

export const SearchPatientDto = z.object({
  q: z.string().max(120).optional(),
  mrn: z.string().max(64).optional(),
  identifier: z.string().max(64).optional(),
  identifier_type: z.string().max(40).optional(),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  gender: z.enum(['male', 'female', 'other', 'unknown']).optional(),
  phone: z.string().max(30).optional(),
  include_merged: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type SearchPatientDto = z.infer<typeof SearchPatientDto>;

export const MergePatientDto = z.object({
  source_id: z.string().uuid(),
  target_id: z.string().uuid(),
  reason: z.string().min(10).max(500),
});
export type MergePatientDto = z.infer<typeof MergePatientDto>;

export const UnmergePatientDto = z.object({
  patient_id: z.string().uuid(),
  reason: z.string().min(10).max(500),
});
export type UnmergePatientDto = z.infer<typeof UnmergePatientDto>;
