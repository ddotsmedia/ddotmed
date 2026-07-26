import { z } from 'zod';

/** Digits-only length expected per identifier type, mirroring the country packs. */
export const ID_TYPE_HINTS: Record<string, { label: string; placeholder: string; help?: string }> = {
  'emirates-id': { label: 'Emirates ID', placeholder: '784-YYYY-NNNNNNN-C', help: '15 digits starting 784' },
  'national-id': { label: 'National ID', placeholder: '1XXXXXXXXX' },
  iqama: { label: 'Iqama', placeholder: '2XXXXXXXXX' },
  'border-number': { label: 'Border number', placeholder: '10 digits' },
  aadhaar: { label: 'Aadhaar', placeholder: 'XXXX XXXX XXXX', help: '12 digits, Verhoeff checked' },
  abha: { label: 'ABHA number', placeholder: '14 digits' },
  'abha-address': { label: 'ABHA address', placeholder: 'name@abdm' },
  pan: { label: 'PAN', placeholder: 'AAAAA9999A' },
  ssn: { label: 'SSN', placeholder: 'XXX-XX-XXXX' },
  mbi: { label: 'Medicare MBI', placeholder: '1EG4-TE5-MK73' },
  npi: { label: 'NPI', placeholder: '10 digits' },
  'nhs-number': { label: 'NHS number', placeholder: 'XXX XXX XXXX', help: '10 digits, modulus-11 checked' },
  'chi-number': { label: 'CHI number', placeholder: 'DDMMYYXXXX' },
  'ni-number': { label: 'National Insurance no.', placeholder: 'QQ123456C' },
  ehic: { label: 'EHIC', placeholder: '20 digits' },
  'vat-number': { label: 'VAT number', placeholder: 'DE123456789' },
  'sa-id': { label: 'South African ID', placeholder: '13 digits' },
  'nhif-number': { label: 'NHIF number', placeholder: '6-12 digits' },
  'nhis-number': { label: 'NHIS number', placeholder: '6-15 characters' },
  'drivers-license': { label: "Driver's licence", placeholder: '' },
  passport: { label: 'Passport', placeholder: '' },
  mrn: { label: 'Existing MRN', placeholder: '' },
};

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a real date')
  .refine((v) => new Date(v) <= new Date(), 'Date of birth cannot be in the future')
  .refine(
    (v) => new Date(v) > new Date(Date.now() - 150 * 365.25 * 86_400_000),
    'Date of birth is implausibly long ago',
  );

export const identifierSchema = z.object({
  type: z.string().min(1, 'Choose an identifier type'),
  value: z.string().trim().min(1, 'Required'),
  is_primary: z.boolean().default(false),
});

export const contactSchema = z.object({
  relationship: z.string().min(1, 'Required'),
  given_names: z.array(z.string()).default([]),
  family_name: z.string().trim().optional(),
  system: z.enum(['phone', 'email', 'sms']),
  value: z.string().trim().min(1, 'Required'),
  use: z.enum(['home', 'work', 'mobile', 'temp']).default('mobile'),
  is_emergency: z.boolean().default(false),
  is_primary: z.boolean().default(false),
});

export const registrationSchema = z.object({
  // Step 1 — demographics
  given_names: z
    .array(z.string().trim().min(1, 'Required'))
    .min(1, 'At least one given name')
    .max(4),
  family_name: z.string().trim().min(1, 'Family name is required').max(120),
  gender: z.enum(['male', 'female', 'other', 'unknown'], {
    errorMap: () => ({ message: 'Select a gender' }),
  }),
  birth_date: isoDate,
  nationality: z.string().length(2, 'Two-letter country code').optional().or(z.literal('')),
  preferred_language: z.string().min(2).default('en'),
  marital_status: z.string().optional(),
  blood_group: z
    .enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'])
    .optional(),
  is_vip: z.boolean().default(false),
  address: z
    .object({
      line: z.array(z.string()).default([]),
      city: z.string().optional(),
      district: z.string().optional(),
      state: z.string().optional(),
      postal_code: z.string().optional(),
      country: z.string().length(2, 'Two-letter country code'),
    })
    .optional(),

  // Step 2 — identifiers
  identifiers: z.array(identifierSchema).default([]),

  // Step 3 — contact and next of kin
  contacts: z.array(contactSchema).default([]),

  // Step 4 — insurance
  insurance: z
    .object({
      payer_id: z.string().uuid('Select a payer'),
      member_id: z.string().trim().min(1, 'Required'),
      policy_number: z.string().trim().min(1, 'Required'),
      plan_name: z.string().trim().optional(),
      relationship: z.enum(['self', 'spouse', 'child', 'parent', 'other']).default('self'),
      starts_at: isoDate,
      ends_at: isoDate.optional().or(z.literal('')),
    })
    .nullable()
    .optional(),

  // Step 5 — photo
  photo_url: z.string().nullable().optional(),

  force_create: z.boolean().default(false),
});

export type RegistrationValues = z.infer<typeof registrationSchema>;

export interface DuplicateCandidate {
  id: string;
  mrn: string;
  name: string;
  birth_date: string;
  score: number;
  reasons: string[];
}

/** Field names belonging to each wizard step, so a step can be validated alone. */
export const STEP_FIELDS: Array<Array<keyof RegistrationValues>> = [
  ['given_names', 'family_name', 'gender', 'birth_date', 'nationality', 'address'],
  ['identifiers'],
  ['contacts'],
  ['insurance'],
  ['photo_url'],
];

export const STEP_LABELS = ['Demographics', 'Identifiers', 'Contacts', 'Insurance', 'Photo'];

export const emptyRegistration: RegistrationValues = {
  given_names: [''],
  family_name: '',
  gender: 'unknown',
  birth_date: '',
  preferred_language: 'en',
  is_vip: false,
  identifiers: [],
  contacts: [],
  insurance: null,
  photo_url: null,
  force_create: false,
};
