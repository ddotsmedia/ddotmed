import {
  allergyToFhir,
  conditionToFhir,
  encounterToFhir,
  invoiceToFhir,
  labResultToFhir,
  medicationRequestToFhir,
  patientToFhir,
  vitalsToFhirObservations,
  clinicalNoteToFhir,
} from './mappers';

describe('patientToFhir', () => {
  const row = {
    id: 'p1',
    fhir_id: null,
    mrn: 'MRN26000001',
    given_names: ['Ahmed', 'Ali'],
    family_name: 'Al Mansouri',
    gender: 'male',
    birth_date: new Date('1985-03-14T00:00:00Z'),
    deceased_at: null,
    preferred_language: 'ar',
    deleted_at: null,
    address: { city: 'Abu Dhabi', country: 'AE' },
    identifiers: [{ type: 'emirates-id', value: '784-1990-1234567-1', system: 'urn:ae:eid' }],
    contacts: [{ system: 'phone', value: '+971501234567', use: 'mobile' }],
  };

  it('maps identity, name and demographics', () => {
    const fhir = patientToFhir(row);
    expect(fhir.resourceType).toBe('Patient');
    expect(fhir.id).toBe('p1');
    expect(fhir.gender).toBe('male');
    expect(fhir.birthDate).toBe('1985-03-14');
    expect((fhir.name as Array<Record<string, unknown>>)[0]).toMatchObject({
      family: 'Al Mansouri',
      given: ['Ahmed', 'Ali'],
    });
  });

  it('includes the MRN and every additional identifier', () => {
    const identifiers = patientToFhir(row).identifier as Array<Record<string, unknown>>;
    expect(identifiers[0]!.value).toBe('MRN26000001');
    expect(identifiers.some((i) => i.value === '784-1990-1234567-1')).toBe(true);
  });

  it('prefers the assigned FHIR id when one exists', () => {
    expect(patientToFhir({ ...row, fhir_id: 'fhir-123' }).id).toBe('fhir-123');
  });

  it('marks a deceased patient with a date rather than a boolean', () => {
    const fhir = patientToFhir({ ...row, deceased_at: new Date('2026-01-01T00:00:00Z') });
    expect(fhir.deceasedDateTime).toBe('2026-01-01T00:00:00.000Z');
    expect(fhir.deceasedBoolean).toBeUndefined();
  });

  it('marks a soft-deleted record inactive', () => {
    expect(patientToFhir({ ...row, deleted_at: new Date() }).active).toBe(false);
  });
});

describe('encounterToFhir', () => {
  const row = {
    id: 'e1',
    fhir_id: null,
    patient_id: 'p1',
    practitioner_id: 'pr1',
    status: 'in_progress',
    class: 'IMP',
    period_start: new Date('2026-07-25T08:00:00Z'),
    period_end: null,
  };

  it('converts the internal status to the FHIR spelling', () => {
    expect(encounterToFhir(row).status).toBe('in-progress');
    expect(encounterToFhir({ ...row, status: 'closed' }).status).toBe('finished');
  });

  it('references the patient and practitioner', () => {
    const fhir = encounterToFhir(row);
    expect(fhir.subject).toEqual({ reference: 'Patient/p1' });
    expect((fhir.participant as Array<Record<string, unknown>>)[0]!.individual).toEqual({
      reference: 'Practitioner/pr1',
    });
  });
});

describe('conditionToFhir', () => {
  it('maps the code, category and statuses with underscores converted to hyphens', () => {
    const fhir = conditionToFhir({
      id: 'c1',
      fhir_id: null,
      patient_id: 'p1',
      code_system: 'http://hl7.org/fhir/sid/icd-10',
      code: 'J06.9',
      code_display: 'Acute URTI',
      snomed_code: '54150009',
      category: 'problem_list_item',
      clinical_status: 'active',
      verification_status: 'confirmed',
      created_at: new Date('2026-07-25T08:00:00Z'),
    });
    const category = (fhir.category as Array<{ coding: Array<{ code: string }> }>)[0]!;
    expect(category.coding[0]!.code).toBe('problem-list-item');
    const coding = (fhir.code as { coding: Array<{ code?: string; system?: string }> }).coding;
    expect(coding[0]!.code).toBe('J06.9');
    expect(coding[1]!.system).toBe('http://snomed.info/sct');
  });
});

describe('allergyToFhir', () => {
  it('maps criticality and reactions', () => {
    const fhir = allergyToFhir({
      id: 'a1',
      fhir_id: null,
      patient_id: 'p1',
      type: 'allergy',
      category: 'medication',
      criticality: 'high',
      code_system: 'http://snomed.info/sct',
      code: '387517004',
      code_display: 'Paracetamol',
      substance_rxnorm: '161',
      reaction: ['anaphylaxis', 'urticaria'],
      severity: 'severe',
      clinical_status: 'active',
    });
    expect(fhir.criticality).toBe('high');
    expect(fhir.category).toEqual(['medication']);
    const reaction = (fhir.reaction as Array<{ manifestation: Array<{ text: string }> }>)[0]!;
    expect(reaction.manifestation.map((m) => m.text)).toEqual(['anaphylaxis', 'urticaria']);
  });

  it('converts unable_to_assess to the FHIR hyphenated form', () => {
    const fhir = allergyToFhir({
      id: 'a1',
      patient_id: 'p1',
      criticality: 'unable_to_assess',
      code: 'x',
      reaction: [],
    });
    expect(fhir.criticality).toBe('unable-to-assess');
  });
});

describe('medicationRequestToFhir', () => {
  it('builds a dosage instruction from the discrete fields', () => {
    const fhir = medicationRequestToFhir({
      id: 'm1',
      fhir_id: null,
      patient_id: 'p1',
      prescriber_id: 'pr1',
      status: 'on_hold',
      intent: 'order',
      code: '161',
      code_display: 'Paracetamol 500mg',
      dose_quantity: 1,
      dose_unit: 'tablet',
      route: 'oral',
      frequency: 'QDS',
      quantity: 20,
      refills: 1,
      is_prn: true,
      created_at: new Date('2026-07-25T08:00:00Z'),
    });
    expect(fhir.status).toBe('on-hold');
    const dosage = (fhir.dosageInstruction as Array<Record<string, unknown>>)[0]!;
    expect(dosage.text).toBe('1 tablet oral QDS');
    expect(dosage.asNeededBoolean).toBe(true);
  });
});

describe('vitalsToFhirObservations', () => {
  const row = {
    id: 'v1',
    fhir_id: null,
    patient_id: 'p1',
    encounter_id: 'e1',
    recorded_at: new Date('2026-07-25T08:00:00Z'),
    systolic_bp: 120,
    diastolic_bp: 80,
    heart_rate: 72,
    spo2: 98,
    temperature_c: 36.8,
    ews_score: 0,
  };

  it('emits a blood-pressure panel with both components', () => {
    const observations = vitalsToFhirObservations(row);
    const bp = observations.find((o) => String(o.id).endsWith('-bp'))!;
    expect((bp.component as unknown[]).length).toBe(2);
  });

  it('emits one observation per recorded measurement and skips the rest', () => {
    const observations = vitalsToFhirObservations(row);
    // bp panel + heart rate + spo2 + temperature + ews
    expect(observations).toHaveLength(5);
    expect(observations.every((o) => o.resourceType === 'Observation')).toBe(true);
  });

  it('emits nothing when no measurement was taken', () => {
    expect(vitalsToFhirObservations({ id: 'v2', patient_id: 'p1' })).toHaveLength(0);
  });
});

describe('labResultToFhir', () => {
  it('uses valueQuantity for a numeric result and a reference range', () => {
    const fhir = labResultToFhir({
      id: 'l1',
      patient_id: 'p1',
      loinc_code: '2823-3',
      display: 'Potassium',
      status: 'final',
      value_quantity: 6.8,
      unit: 'mmol/L',
      reference_low: 3.5,
      reference_high: 5.1,
      interpretation: 'HH',
      performed_at: new Date('2026-07-25T08:00:00Z'),
    });
    expect((fhir.valueQuantity as { value: number }).value).toBe(6.8);
    expect((fhir.referenceRange as Array<Record<string, unknown>>)[0]).toBeDefined();
  });

  it('falls back to valueString for a non-numeric result', () => {
    const fhir = labResultToFhir({
      id: 'l2',
      patient_id: 'p1',
      loinc_code: '11111-1',
      display: 'Comment',
      value_quantity: null,
      value_string: 'Haemolysed sample',
      performed_at: new Date(),
    });
    expect(fhir.valueString).toBe('Haemolysed sample');
    expect(fhir.valueQuantity).toBeUndefined();
  });
});

describe('invoiceToFhir', () => {
  it('converts integer minor units to decimal money exactly once', () => {
    const fhir = invoiceToFhir({
      id: 'i1',
      patient_id: 'p1',
      invoice_number: 'INV-1',
      status: 'partially_paid',
      currency: 'AED',
      subtotal_minor: 100_000,
      total_minor: 105_000,
      created_at: new Date(),
      line_items: [
        { charge_code: 'CONS-GP', description: 'Consultation', total_minor: 105_000 },
      ],
    });
    expect(fhir.status).toBe('partially-paid');
    expect(fhir.totalGross).toEqual({ value: 1050, currency: 'AED' });
    expect(fhir.totalNet).toEqual({ value: 1000, currency: 'AED' });
  });
});

describe('clinicalNoteToFhir', () => {
  it('escapes XML in the narrative so note text cannot inject markup', () => {
    const fhir = clinicalNoteToFhir({
      id: 'n1',
      patient_id: 'p1',
      encounter_id: 'e1',
      author_id: 'pr1',
      type: 'soap',
      status: 'signed',
      subjective: 'Patient said <script>alert("x")</script> & felt unwell',
      created_at: new Date(),
    });
    const section = (fhir.section as Array<{ text: { div: string } }>)[0]!;
    expect(section.text.div).toContain('&lt;script&gt;');
    expect(section.text.div).toContain('&amp;');
    expect(section.text.div).not.toContain('<script>');
  });

  it('maps a signed note to final and a draft to preliminary', () => {
    const base = {
      id: 'n1',
      patient_id: 'p1',
      encounter_id: 'e1',
      author_id: 'pr1',
      type: 'soap',
      body: 'text',
      created_at: new Date(),
    };
    expect(clinicalNoteToFhir({ ...base, status: 'signed' }).status).toBe('final');
    expect(clinicalNoteToFhir({ ...base, status: 'draft' }).status).toBe('preliminary');
  });
});
