/**
 * Development seed: one tenant, the RBAC matrix, a facility with beds, a charge
 * master, a small drug formulary with a real interaction pair, and demo staff.
 *
 * Idempotent — safe to re-run. Never run against production.
 */
import { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS } from '@medicore/shared-types';

const prisma = new PrismaClient();

const SLUG = process.env.DEFAULT_TENANT_SLUG ?? 'demo';
const COUNTRY_PACK = process.env.DEFAULT_COUNTRY_PACK ?? 'uae';
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'ChangeMe123!';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database');
  }

  const tenant = await prisma.tenant.upsert({
    where: { slug: SLUG },
    update: {},
    create: {
      slug: SLUG,
      name: 'MediCore Demo Hospital',
      country_pack: COUNTRY_PACK,
      default_locale: 'en',
      timezone: 'Asia/Dubai',
      currency: 'AED',
      active_modules: [
        'patients', 'appointments', 'encounters', 'notes', 'conditions', 'allergies',
        'medications', 'vitals', 'lab', 'radiology', 'pharmacy', 'beds', 'billing',
        'insurance', 'inventory', 'hr',
      ],
    },
  });

  // Permissions are global; roles are per tenant.
  for (const key of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, category: key.split(':')[0]!, description: key },
    });
  }
  const permissionRows = await prisma.permission.findMany();
  const permissionByKey = new Map(permissionRows.map((p) => [p.key, p.id]));

  for (const roleKey of ROLES) {
    const role = await prisma.role.upsert({
      where: { tenant_id_key: { tenant_id: tenant.id, key: roleKey } },
      update: {},
      create: {
        tenant_id: tenant.id,
        key: roleKey,
        name: roleKey.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        is_system: true,
      },
    });

    for (const permissionKey of ROLE_PERMISSIONS[roleKey]) {
      const permissionId = permissionByKey.get(permissionKey);
      if (!permissionId) continue;
      await prisma.rolePermission.upsert({
        where: { role_id_permission_id: { role_id: role.id, permission_id: permissionId } },
        update: {},
        create: { tenant_id: tenant.id, role_id: role.id, permission_id: permissionId },
      });
    }
  }

  const organization = await prisma.organization.create({
    data: {
      tenant_id: tenant.id,
      name: 'MediCore Demo Hospital',
      type: 'hospital',
      country: 'AE',
      license_number: 'DOH-DEMO-0001',
      tax_registration_number: '100000000000003',
    },
  });

  const location = await prisma.location.create({
    data: {
      tenant_id: tenant.id,
      organization_id: organization.id,
      name: 'Main Building',
      type: 'building',
    },
  });

  const passwordHash = await hash(DEMO_PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

  const staff: Array<{ email: string; role: string; given: string; family: string }> = [
    { email: 'admin@demo.medicore', role: 'tenant-admin', given: 'Aisha', family: 'Rahman' },
    { email: 'doctor@demo.medicore', role: 'doctor', given: 'Omar', family: 'Haddad' },
    { email: 'nurse@demo.medicore', role: 'nurse', given: 'Priya', family: 'Nair' },
    { email: 'pharmacist@demo.medicore', role: 'pharmacist', given: 'Chen', family: 'Wei' },
    { email: 'lab@demo.medicore', role: 'lab-tech', given: 'Marie', family: 'Dubois' },
    { email: 'billing@demo.medicore', role: 'billing-officer', given: 'Kwame', family: 'Mensah' },
  ];

  for (const person of staff) {
    const user = await prisma.user.upsert({
      where: { tenant_id_email: { tenant_id: tenant.id, email: person.email } },
      update: {},
      create: {
        tenant_id: tenant.id,
        email: person.email,
        password_hash: passwordHash,
        is_active: true,
        email_verified_at: new Date(),
      },
    });

    const role = await prisma.role.findUnique({
      where: { tenant_id_key: { tenant_id: tenant.id, key: person.role } },
    });
    if (role) {
      await prisma.userRole.upsert({
        where: { user_id_role_id_location_id: { user_id: user.id, role_id: role.id, location_id: null } },
        update: {},
        create: { tenant_id: tenant.id, user_id: user.id, role_id: role.id },
      }).catch(() => undefined);
    }

    if (person.role === 'doctor' || person.role === 'nurse') {
      await prisma.practitioner.upsert({
        where: { tenant_id_license_number: { tenant_id: tenant.id, license_number: `LIC-${person.role}-001` } },
        update: {},
        create: {
          tenant_id: tenant.id,
          user_id: user.id,
          given_names: [person.given],
          family_name: person.family,
          license_number: `LIC-${person.role}-001`,
          license_authority: 'DOH Abu Dhabi',
          license_expires_at: new Date(Date.now() + 365 * 86_400_000),
          specialties: person.role === 'doctor' ? ['internal-medicine'] : ['general-nursing'],
        },
      });
    }
  }

  // Beds across three wards with different acuity.
  const wards: Array<{ ward: string; type: 'general' | 'icu' | 'er'; count: number; rate: number }> = [
    { ward: 'WARD3', type: 'general', count: 12, rate: 45_000 },
    { ward: 'ICU1', type: 'icu', count: 6, rate: 180_000 },
    { ward: 'ER', type: 'er', count: 8, rate: 60_000 },
  ];
  for (const w of wards) {
    for (let i = 1; i <= w.count; i++) {
      await prisma.bed.upsert({
        where: {
          tenant_id_ward_room_bed_number: {
            tenant_id: tenant.id,
            ward: w.ward,
            room: `R${Math.ceil(i / 2)}`,
            bed_number: `B${i}`,
          },
        },
        update: {},
        create: {
          tenant_id: tenant.id,
          location_id: location.id,
          ward: w.ward,
          room: `R${Math.ceil(i / 2)}`,
          bed_number: `B${i}`,
          bed_type: w.type,
          status: 'available',
          currency: 'AED',
          daily_rate_minor: w.rate,
          is_oxygen_supported: w.type !== 'general',
          is_ventilator_supported: w.type === 'icu',
        },
      });
    }
  }

  const charges: Array<[string, string, string, number]> = [
    ['CONS-GP', 'General practitioner consultation', 'consultation', 15_000],
    ['CONS-SPEC', 'Specialist consultation', 'consultation', 35_000],
    ['LAB-CBC', 'Complete blood count', 'laboratory', 8_000],
    ['LAB-CMP', 'Comprehensive metabolic panel', 'laboratory', 12_000],
    ['RAD-CXR', 'Chest X-ray', 'imaging', 20_000],
    ['RAD-CT', 'CT scan', 'imaging', 150_000],
    ['BED-GEN', 'General ward bed per day', 'inpatient', 45_000],
    ['BED-ICU', 'ICU bed per day', 'inpatient', 180_000],
  ];
  for (const [code, description, category, price] of charges) {
    await prisma.chargeMaster.upsert({
      where: { tenant_id_charge_code: { tenant_id: tenant.id, charge_code: code } },
      update: {},
      create: {
        tenant_id: tenant.id,
        charge_code: code,
        description,
        category,
        unit_price_minor: price,
        currency: 'AED',
        tax_rate_bp: 500,
        effective_from: new Date('2026-01-01T00:00:00Z'),
      },
    });
  }

  const drugs: Array<{ rxnorm: string; generic: string; brand: string; strength: string; controlled?: string }> = [
    { rxnorm: '161', generic: 'Paracetamol', brand: 'Panadol', strength: '500mg' },
    { rxnorm: '11289', generic: 'Warfarin', brand: 'Coumadin', strength: '5mg' },
    { rxnorm: '723', generic: 'Amoxicillin', brand: 'Amoxil', strength: '500mg' },
    { rxnorm: '7052', generic: 'Morphine', brand: 'MST', strength: '10mg', controlled: 'CD2' },
    { rxnorm: '1191', generic: 'Aspirin', brand: 'Aspro', strength: '75mg' },
  ];
  for (const drug of drugs) {
    await prisma.drugFormulary.create({
      data: {
        tenant_id: tenant.id,
        rxnorm_code: drug.rxnorm,
        generic_name: drug.generic,
        brand_name: drug.brand,
        strength: drug.strength,
        dose_form: 'tablet',
        route: 'oral',
        is_controlled: Boolean(drug.controlled),
        controlled_schedule: drug.controlled ?? null,
        requires_witness: Boolean(drug.controlled),
        is_high_alert: Boolean(drug.controlled) || drug.generic === 'Warfarin',
      },
    }).catch(() => undefined);
  }

  // Real, clinically significant interaction pairs.
  const interactions: Array<[string, string, string, string, string]> = [
    ['11289', '1191', 'major', 'Additive anticoagulant effect increases bleeding risk', 'Monitor INR closely; consider gastroprotection'],
    ['11289', '161', 'moderate', 'High-dose paracetamol may potentiate warfarin', 'Monitor INR if paracetamol is used regularly'],
    ['7052', '11289', 'moderate', 'Additive CNS depression', 'Monitor sedation and respiratory rate'],
  ];
  for (const [a, b, severity, effect, management] of interactions) {
    await prisma.drugInteraction.upsert({
      where: { rxnorm_a_rxnorm_b: { rxnorm_a: a, rxnorm_b: b } },
      update: {},
      create: {
        rxnorm_a: a,
        rxnorm_b: b,
        severity,
        clinical_effect: effect,
        management,
        evidence_level: 'established',
        source: 'seed',
      },
    });
  }

  const payer = await prisma.payer.upsert({
    where: { tenant_id_code: { tenant_id: tenant.id, code: 'DAMAN' } },
    update: {},
    create: {
      tenant_id: tenant.id,
      name: 'Daman National Health Insurance',
      code: 'DAMAN',
      country_pack: COUNTRY_PACK,
      license_number: 'DOH-PAYER-001',
      claim_format: 'malaffi-fhir',
      supports_realtime_eligibility: true,
      average_days_to_pay: 30,
    },
  });

  const shifts: Array<[string, string, string, string, boolean]> = [
    ['Morning', 'AM', '07:00', '15:00', false],
    ['Evening', 'PM', '15:00', '23:00', false],
    ['Night', 'ND', '23:00', '07:00', true],
  ];
  for (const [name, code, start, end, isNight] of shifts) {
    await prisma.shift.upsert({
      where: { tenant_id_code: { tenant_id: tenant.id, code } },
      update: {},
      create: {
        tenant_id: tenant.id,
        name,
        code,
        start_time: start,
        end_time: end,
        is_night_shift: isNight,
        min_nurses: 3,
        min_doctors: 1,
      },
    });
  }

  console.log(`
Seed complete.
  Tenant       : ${tenant.slug} (${tenant.country_pack})
  Users        : ${staff.map((s) => s.email).join(', ')}
  Password     : ${DEMO_PASSWORD}
  Beds         : ${wards.reduce((sum, w) => sum + w.count, 0)}
  Payer        : ${payer.name}
`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
