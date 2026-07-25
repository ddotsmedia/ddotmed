import type { FhirResourceType } from '@medicore/shared-types';

type Row = Record<string, unknown>;
const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const iso = (v: unknown): string | undefined =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : undefined;
const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const ref = (type: string, id: unknown) =>
  typeof id === 'string' ? { reference: `${type}/${id}` } : undefined;

const SYSTEMS = {
  loinc: 'http://loinc.org',
  snomed: 'http://snomed.info/sct',
  icd10: 'http://hl7.org/fhir/sid/icd-10',
  rxnorm: 'http://www.nlm.nih.gov/research/umls/rxnorm',
  ucum: 'http://unitsofmeasure.org',
} as const;

export function patientToFhir(p: Row & { identifiers?: Row[]; contacts?: Row[] }): Row {
  return {
    resourceType: 'Patient',
    id: s(p.fhir_id) ?? s(p.id),
    identifier: [
      { use: 'usual', type: { text: 'MRN' }, value: s(p.mrn) },
      ...(p.identifiers ?? []).map((i) => ({
        type: { text: s(i.type) },
        system: s(i.system),
        value: s(i.value),
      })),
    ],
    active: !p.deleted_at,
    name: [
      {
        use: 'official',
        family: s(p.family_name),
        given: Array.isArray(p.given_names) ? p.given_names : [],
      },
    ],
    telecom: (p.contacts ?? []).map((c) => ({
      system: s(c.system),
      value: s(c.value),
      use: s(c.use),
    })),
    gender: s(p.gender),
    birthDate: p.birth_date instanceof Date ? p.birth_date.toISOString().slice(0, 10) : s(p.birth_date),
    ...(p.deceased_at ? { deceasedDateTime: iso(p.deceased_at) } : { deceasedBoolean: false }),
    address: p.address ? [p.address] : [],
    communication: [{ language: { text: s(p.preferred_language) }, preferred: true }],
  };
}

export function encounterToFhir(e: Row): Row {
  const statusMap: Record<string, string> = {
    planned: 'planned',
    arrived: 'arrived',
    triaged: 'triaged',
    in_progress: 'in-progress',
    onleave: 'onleave',
    finished: 'finished',
    cancelled: 'cancelled',
    closed: 'finished',
  };
  return {
    resourceType: 'Encounter',
    id: s(e.fhir_id) ?? s(e.id),
    status: statusMap[s(e.status) ?? 'planned'] ?? 'unknown',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: s(e.class) },
    type: e.type_code
      ? [{ coding: [{ code: s(e.type_code), display: s(e.type_display) }] }]
      : undefined,
    subject: ref('Patient', e.patient_id),
    participant: e.practitioner_id
      ? [{ individual: ref('Practitioner', e.practitioner_id) }]
      : undefined,
    period: { start: iso(e.period_start), end: iso(e.period_end) },
    reasonCode: e.reason_text ? [{ text: s(e.reason_text) }] : undefined,
    location: e.location_id ? [{ location: ref('Location', e.location_id) }] : undefined,
    hospitalization: e.discharge_disposition
      ? { dischargeDisposition: { text: s(e.discharge_disposition) } }
      : undefined,
  };
}

export function conditionToFhir(c: Row): Row {
  return {
    resourceType: 'Condition',
    id: s(c.fhir_id) ?? s(c.id),
    clinicalStatus: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
          code: s(c.clinical_status),
        },
      ],
    },
    verificationStatus: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
          code: (s(c.verification_status) ?? '').replace(/_/g, '-'),
        },
      ],
    },
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/condition-category',
            code: (s(c.category) ?? '').replace(/_/g, '-'),
          },
        ],
      },
    ],
    severity: c.severity ? { text: s(c.severity) } : undefined,
    code: {
      coding: [
        { system: s(c.code_system) ?? SYSTEMS.icd10, code: s(c.code), display: s(c.code_display) },
        ...(c.snomed_code ? [{ system: SYSTEMS.snomed, code: s(c.snomed_code) }] : []),
      ],
    },
    subject: ref('Patient', c.patient_id),
    encounter: ref('Encounter', c.encounter_id),
    onsetDateTime: iso(c.onset_date),
    abatementDateTime: iso(c.abatement_date),
    recordedDate: iso(c.created_at),
  };
}

export function allergyToFhir(a: Row): Row {
  return {
    resourceType: 'AllergyIntolerance',
    id: s(a.fhir_id) ?? s(a.id),
    clinicalStatus: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
          code: s(a.clinical_status),
        },
      ],
    },
    type: s(a.type),
    category: [s(a.category)],
    criticality: (s(a.criticality) ?? '').replace(/_/g, '-'),
    code: {
      coding: [
        { system: s(a.code_system) ?? SYSTEMS.snomed, code: s(a.code), display: s(a.code_display) },
        ...(a.substance_rxnorm ? [{ system: SYSTEMS.rxnorm, code: s(a.substance_rxnorm) }] : []),
      ],
    },
    patient: ref('Patient', a.patient_id),
    onsetDateTime: iso(a.onset_date),
    reaction: Array.isArray(a.reaction) && a.reaction.length
      ? [{ manifestation: (a.reaction as string[]).map((r) => ({ text: r })), severity: s(a.severity) }]
      : undefined,
  };
}

export function medicationRequestToFhir(m: Row): Row {
  return {
    resourceType: 'MedicationRequest',
    id: s(m.fhir_id) ?? s(m.id),
    status: (s(m.status) ?? '').replace(/_/g, '-'),
    intent: s(m.intent),
    medicationCodeableConcept: {
      coding: [{ system: s(m.code_system) ?? SYSTEMS.rxnorm, code: s(m.code), display: s(m.code_display) }],
    },
    subject: ref('Patient', m.patient_id),
    encounter: ref('Encounter', m.encounter_id),
    requester: ref('Practitioner', m.prescriber_id),
    authoredOn: iso(m.created_at),
    dosageInstruction: [
      {
        // dose_quantity is numeric (Prisma Decimal), so it must not go through s().
        text: [num(m.dose_quantity), s(m.dose_unit), s(m.route), s(m.frequency)]
          .filter((part) => part !== undefined && part !== '')
          .join(' '),
        asNeededBoolean: m.is_prn === true,
        route: { text: s(m.route) },
        timing: { code: { text: s(m.frequency) } },
        doseAndRate: [
          {
            doseQuantity: {
              value: num(m.dose_quantity),
              unit: s(m.dose_unit),
              system: SYSTEMS.ucum,
            },
          },
        ],
        patientInstruction: s(m.instructions),
      },
    ],
    dispenseRequest: {
      quantity: { value: num(m.quantity) },
      numberOfRepeatsAllowed: num(m.refills),
      expectedSupplyDuration: m.duration_days
        ? { value: num(m.duration_days), unit: 'd', system: SYSTEMS.ucum }
        : undefined,
    },
  };
}

export function medicationDispenseToFhir(d: Row): Row {
  return {
    resourceType: 'MedicationDispense',
    id: s(d.fhir_id) ?? s(d.id),
    status: s(d.status),
    subject: ref('Patient', d.patient_id),
    authorizingPrescription: [ref('MedicationRequest', d.medication_id)].filter(Boolean),
    quantity: { value: num(d.quantity) },
    whenHandedOver: iso(d.dispensed_at),
    substitution: { wasSubstituted: d.substituted === true, reason: d.substitution_reason ? [{ text: s(d.substitution_reason) }] : undefined },
  };
}

export function medicationAdministrationToFhir(a: Row): Row {
  return {
    resourceType: 'MedicationAdministration',
    id: s(a.fhir_id) ?? s(a.id),
    status: s(a.status),
    subject: ref('Patient', a.patient_id),
    request: ref('MedicationRequest', a.medication_id),
    effectiveDateTime: iso(a.administered_at),
    performer: [{ actor: ref('Practitioner', a.administered_by) }],
    dosage: {
      route: { text: s(a.route) },
      site: a.site ? { text: s(a.site) } : undefined,
      dose: { value: num(a.dose_given), unit: s(a.dose_unit), system: SYSTEMS.ucum },
    },
    statusReason: a.not_given_reason ? [{ text: s(a.not_given_reason) }] : undefined,
  };
}

/** LOINC codes for the vital-sign panel members. */
const VITAL_LOINC: Array<[string, string, string, string]> = [
  ['heart_rate', '8867-4', 'Heart rate', '/min'],
  ['respiratory_rate', '9279-1', 'Respiratory rate', '/min'],
  ['temperature_c', '8310-5', 'Body temperature', 'Cel'],
  ['spo2', '59408-5', 'Oxygen saturation', '%'],
  ['weight_kg', '29463-7', 'Body weight', 'kg'],
  ['height_cm', '8302-2', 'Body height', 'cm'],
  ['bmi', '39156-5', 'Body mass index', 'kg/m2'],
  ['pain_score', '72514-3', 'Pain severity', '{score}'],
  ['ews_score', '9269-2', 'Glasgow-equivalent early warning score', '{score}'],
];

/** A vitals row becomes several FHIR Observations — one per measured component. */
export function vitalsToFhirObservations(v: Row): Row[] {
  const base = {
    status: 'final',
    category: [
      {
        coding: [
          { system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' },
        ],
      },
    ],
    subject: ref('Patient', v.patient_id),
    encounter: ref('Encounter', v.encounter_id),
    effectiveDateTime: iso(v.recorded_at),
  };

  const out: Row[] = [];

  if (v.systolic_bp != null || v.diastolic_bp != null) {
    out.push({
      resourceType: 'Observation',
      id: `${s(v.fhir_id) ?? s(v.id)}-bp`,
      ...base,
      code: { coding: [{ system: SYSTEMS.loinc, code: '85354-9', display: 'Blood pressure panel' }] },
      component: [
        v.systolic_bp != null && {
          code: { coding: [{ system: SYSTEMS.loinc, code: '8480-6', display: 'Systolic blood pressure' }] },
          valueQuantity: { value: num(v.systolic_bp), unit: 'mm[Hg]', system: SYSTEMS.ucum },
        },
        v.diastolic_bp != null && {
          code: { coding: [{ system: SYSTEMS.loinc, code: '8462-4', display: 'Diastolic blood pressure' }] },
          valueQuantity: { value: num(v.diastolic_bp), unit: 'mm[Hg]', system: SYSTEMS.ucum },
        },
      ].filter(Boolean),
    });
  }

  for (const [field, code, display, unit] of VITAL_LOINC) {
    const value = num(v[field]);
    if (value === undefined) continue;
    out.push({
      resourceType: 'Observation',
      id: `${s(v.fhir_id) ?? s(v.id)}-${code}`,
      ...base,
      code: { coding: [{ system: SYSTEMS.loinc, code, display }] },
      valueQuantity: { value, unit, system: SYSTEMS.ucum },
    });
  }

  return out;
}

export function labResultToFhir(r: Row): Row {
  const value = num(r.value_quantity);
  return {
    resourceType: 'Observation',
    id: s(r.fhir_id) ?? s(r.id),
    status: (s(r.status) ?? 'final').replace(/_/g, '-'),
    category: [
      {
        coding: [
          { system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' },
        ],
      },
    ],
    code: { coding: [{ system: SYSTEMS.loinc, code: s(r.loinc_code), display: s(r.display) }] },
    subject: ref('Patient', r.patient_id),
    encounter: ref('Encounter', r.encounter_id),
    effectiveDateTime: iso(r.performed_at),
    ...(value !== undefined
      ? { valueQuantity: { value, unit: s(r.unit), system: SYSTEMS.ucum } }
      : { valueString: s(r.value_string) }),
    interpretation: r.interpretation
      ? [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
                code: s(r.interpretation),
              },
            ],
          },
        ]
      : undefined,
    referenceRange:
      r.reference_low != null || r.reference_high != null
        ? [
            {
              low: r.reference_low != null ? { value: num(r.reference_low), unit: s(r.unit) } : undefined,
              high: r.reference_high != null ? { value: num(r.reference_high), unit: s(r.unit) } : undefined,
              text: s(r.reference_text),
            },
          ]
        : undefined,
    specimen: ref('Specimen', r.specimen_id),
    performer: r.verified_by ? [ref('Practitioner', r.verified_by)] : undefined,
  };
}

export function imagingStudyToFhir(st: Row): Row {
  return {
    resourceType: 'ImagingStudy',
    id: s(st.fhir_id) ?? s(st.id),
    identifier: [{ system: 'urn:dicom:uid', value: `urn:oid:${s(st.study_instance_uid)}` }],
    status: s(st.status) === 'completed' ? 'available' : 'registered',
    modality: [{ system: 'http://dicom.nema.org/resources/ontology/DCM', code: s(st.modality) }],
    subject: ref('Patient', st.patient_id),
    encounter: ref('Encounter', st.encounter_id),
    started: iso(st.started_at),
    numberOfSeries: num(st.series_count),
    numberOfInstances: num(st.instance_count),
    description: s(st.description),
    basedOn: st.service_request_id ? [ref('ServiceRequest', st.service_request_id)] : undefined,
  };
}

export function serviceRequestToFhir(sr: Row): Row {
  return {
    resourceType: 'ServiceRequest',
    id: s(sr.fhir_id) ?? s(sr.id),
    identifier: [{ value: s(sr.order_number) }],
    status: (s(sr.status) ?? 'active').replace(/_/g, '-'),
    intent: s(sr.intent),
    priority: s(sr.priority),
    category: [{ text: s(sr.category) }],
    code: { coding: [{ system: s(sr.code_system), code: s(sr.code), display: s(sr.code_display) }] },
    subject: ref('Patient', sr.patient_id),
    encounter: ref('Encounter', sr.encounter_id),
    requester: ref('Practitioner', sr.requester_id),
    occurrenceDateTime: iso(sr.scheduled_for),
    reasonCode: sr.reason_text ? [{ text: s(sr.reason_text) }] : undefined,
  };
}

export function appointmentToFhir(a: Row): Row {
  return {
    resourceType: 'Appointment',
    id: s(a.fhir_id) ?? s(a.id),
    status: (s(a.status) ?? 'booked').replace(/_/g, '-'),
    serviceType: [{ text: s(a.service_type) }],
    specialty: a.specialty ? [{ text: s(a.specialty) }] : undefined,
    start: iso(a.start),
    end: iso(a.end),
    minutesDuration: num(a.minutes_duration),
    description: s(a.reason_text),
    participant: [
      { actor: ref('Patient', a.patient_id), status: 'accepted', required: 'required' },
      ...(a.practitioner_id
        ? [{ actor: ref('Practitioner', a.practitioner_id), status: 'accepted', required: 'required' }]
        : []),
    ],
  };
}

export function clinicalNoteToFhir(n: Row): Row {
  const sections = [
    ['Subjective', n.subjective],
    ['Objective', n.objective],
    ['Assessment', n.assessment],
    ['Plan', n.plan],
    ['Note', n.body],
  ].filter(([, v]) => typeof v === 'string' && v.length > 0);

  return {
    resourceType: 'Composition',
    id: s(n.fhir_id) ?? s(n.id),
    status: s(n.status) === 'signed' ? 'final' : 'preliminary',
    type: { coding: [{ system: SYSTEMS.loinc, code: '11488-4', display: 'Consult note' }] },
    subject: ref('Patient', n.patient_id),
    encounter: ref('Encounter', n.encounter_id),
    date: iso(n.created_at),
    author: [ref('Practitioner', n.author_id)],
    title: `${s(n.type)?.toUpperCase()} note`,
    section: sections.map(([title, text]) => ({
      title,
      text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeXml(String(text))}</div>` },
    })),
  };
}

export function coverageToFhir(c: Row): Row {
  return {
    resourceType: 'Coverage',
    id: s(c.fhir_id) ?? s(c.id),
    status: s(c.status),
    subscriberId: s(c.member_id),
    beneficiary: ref('Patient', c.patient_id),
    payor: [ref('Organization', c.payer_id)],
    relationship: { coding: [{ code: s(c.relationship) }] },
    period: { start: iso(c.starts_at), end: iso(c.ends_at) },
    identifier: [{ value: s(c.policy_number) }],
  };
}

export function invoiceToFhir(inv: Row & { line_items?: Row[] }): Row {
  const money = (minor: unknown) => ({ value: (num(minor) ?? 0) / 100, currency: s(inv.currency) });
  return {
    resourceType: 'Invoice',
    id: s(inv.fhir_id) ?? s(inv.id),
    identifier: [{ value: s(inv.invoice_number) }],
    status: (s(inv.status) ?? 'draft').replace(/_/g, '-'),
    subject: ref('Patient', inv.patient_id),
    date: iso(inv.issued_at ?? inv.created_at),
    lineItem: (inv.line_items ?? []).map((li, i) => ({
      sequence: i + 1,
      chargeItemCodeableConcept: { coding: [{ code: s(li.charge_code), display: s(li.description) }] },
      priceComponent: [{ type: 'base', amount: money(li.total_minor) }],
    })),
    totalNet: money(inv.subtotal_minor),
    totalGross: money(inv.total_minor),
  };
}

export const RESOURCE_MAPPERS: Partial<Record<FhirResourceType, (row: Row) => Row | Row[]>> = {
  Patient: patientToFhir,
  Encounter: encounterToFhir,
  Condition: conditionToFhir,
  AllergyIntolerance: allergyToFhir,
  MedicationRequest: medicationRequestToFhir,
  MedicationDispense: medicationDispenseToFhir,
  MedicationAdministration: medicationAdministrationToFhir,
  Observation: labResultToFhir,
  ServiceRequest: serviceRequestToFhir,
  ImagingStudy: imagingStudyToFhir,
  Appointment: appointmentToFhir,
  Coverage: coverageToFhir,
  Invoice: invoiceToFhir,
  Composition: clinicalNoteToFhir,
};

function escapeXml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
