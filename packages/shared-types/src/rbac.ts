export const ROLES = [
  'super-admin',
  'tenant-admin',
  'doctor',
  'nurse',
  'pharmacist',
  'lab-tech',
  'radiologist',
  'receptionist',
  'billing-officer',
  'insurance-officer',
  'inventory-manager',
  'hr-manager',
  'patient',
  'auditor',
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'patient:read',
  'patient:write',
  'patient:merge',
  'encounter:read',
  'encounter:write',
  'note:read',
  'note:write',
  'note:sign',
  'condition:write',
  'allergy:write',
  'medication:prescribe',
  'medication:dispense',
  'medication:administer',
  'controlled:witness',
  'vitals:write',
  'lab:order',
  'lab:result',
  'lab:verify',
  'imaging:order',
  'imaging:report',
  'bed:manage',
  'adt:manage',
  'invoice:read',
  'invoice:write',
  'payment:write',
  'claim:read',
  'claim:write',
  'claim:submit',
  'inventory:manage',
  'hr:manage',
  'config:manage',
  'user:manage',
  'audit:read',
  'ai:use',
  'ai:approve',
  'break-glass',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  'super-admin': ALL,
  'tenant-admin': ALL.filter((p) => p !== 'break-glass'),
  doctor: [
    'patient:read',
    'patient:write',
    'encounter:read',
    'encounter:write',
    'note:read',
    'note:write',
    'note:sign',
    'condition:write',
    'allergy:write',
    'medication:prescribe',
    'vitals:write',
    'lab:order',
    'imaging:order',
    'imaging:report',
    'adt:manage',
    'invoice:read',
    'ai:use',
    'ai:approve',
    'break-glass',
  ],
  nurse: [
    'patient:read',
    'encounter:read',
    'note:read',
    'note:write',
    'allergy:write',
    'medication:administer',
    'vitals:write',
    'lab:order',
    'bed:manage',
    'adt:manage',
    'ai:use',
  ],
  pharmacist: [
    'patient:read',
    'encounter:read',
    'medication:dispense',
    'controlled:witness',
    'inventory:manage',
    'ai:use',
  ],
  'lab-tech': ['patient:read', 'encounter:read', 'lab:order', 'lab:result', 'lab:verify'],
  radiologist: ['patient:read', 'encounter:read', 'imaging:order', 'imaging:report', 'ai:use'],
  receptionist: ['patient:read', 'patient:write', 'encounter:read', 'invoice:read', 'payment:write'],
  'billing-officer': [
    'patient:read',
    'encounter:read',
    'invoice:read',
    'invoice:write',
    'payment:write',
    'claim:read',
  ],
  'insurance-officer': [
    'patient:read',
    'encounter:read',
    'invoice:read',
    'claim:read',
    'claim:write',
    'claim:submit',
    'ai:use',
  ],
  'inventory-manager': ['inventory:manage'],
  'hr-manager': ['hr:manage', 'user:manage'],
  patient: ['patient:read', 'invoice:read', 'payment:write'],
  auditor: ['audit:read', 'patient:read', 'encounter:read', 'invoice:read', 'claim:read'],
};

export interface JwtPayload {
  sub: string;
  tenant_id: string;
  roles: Role[];
  permissions: Permission[];
  practitioner_id?: string | null;
  patient_id?: string | null;
  session_id: string;
  mfa_verified: boolean;
  break_glass?: boolean;
  iat: number;
  exp: number;
}

/** Idle window before the client force-logs-out (ms). */
export const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
