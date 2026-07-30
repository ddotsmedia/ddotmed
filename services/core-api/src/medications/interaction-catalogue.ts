/**
 * Bundled drug-drug interaction reference.
 *
 * A licensed feed (First Databank, Multum, Stockley's) is the right long-term
 * source, but a prescribing screen must not be silently unsafe while a tenant is
 * waiting for one. This is a curated set of pairs that block or change practice —
 * the ones a prescriber would expect any system to catch — keyed by RxNorm
 * ingredient code and matched by ingredient name as a fallback.
 *
 * Tenant rows in `drug_interactions` always win over anything here.
 */

export type InteractionSeverity = 'contraindicated' | 'major' | 'moderate' | 'minor';

export interface CatalogueInteraction {
  rxnorm_a: string;
  rxnorm_b: string;
  /** Ingredient names, lowercase, used when a prescription carries no RxNorm code. */
  name_a: string;
  name_b: string;
  severity: InteractionSeverity;
  mechanism: string;
  clinical_effect: string;
  management: string;
}

export const INTERACTION_CATALOGUE: readonly CatalogueInteraction[] = [
  {
    rxnorm_a: '11289',
    name_a: 'warfarin',
    rxnorm_b: '1191',
    name_b: 'aspirin',
    severity: 'major',
    mechanism: 'Additive inhibition of haemostasis; aspirin also displaces warfarin from albumin',
    clinical_effect: 'Substantially increased risk of gastrointestinal and intracranial bleeding',
    management: 'Avoid unless there is a compelling indication. If combined, use the lowest aspirin dose, add gastroprotection and monitor INR and haemoglobin closely.',
  },
  {
    rxnorm_a: '11289',
    name_a: 'warfarin',
    rxnorm_b: '10180',
    name_b: 'trimethoprim',
    severity: 'major',
    mechanism: 'CYP2C9 inhibition reduces warfarin clearance',
    clinical_effect: 'Sharp rise in INR within days, with bleeding risk',
    management: 'Prefer an alternative antibiotic. If unavoidable, check INR at 3-5 days and reduce the warfarin dose pre-emptively.',
  },
  {
    rxnorm_a: '11289',
    name_a: 'warfarin',
    rxnorm_b: '4450',
    name_b: 'fluconazole',
    severity: 'major',
    mechanism: 'Potent CYP2C9 inhibition',
    clinical_effect: 'Marked INR elevation and bleeding',
    management: 'Reduce the warfarin dose and monitor INR every 2-3 days during and after the antifungal course.',
  },
  {
    rxnorm_a: '6809',
    name_a: 'metformin',
    rxnorm_b: '21949',
    name_b: 'iodinated contrast',
    severity: 'major',
    mechanism: 'Contrast-induced renal impairment reduces metformin clearance',
    clinical_effect: 'Accumulation of metformin with risk of lactic acidosis',
    management: 'Withhold metformin at the time of the procedure and for 48 hours afterwards; restart once renal function is confirmed stable.',
  },
  {
    rxnorm_a: '36567',
    name_a: 'simvastatin',
    rxnorm_b: '2551',
    name_b: 'clarithromycin',
    severity: 'contraindicated',
    mechanism: 'Strong CYP3A4 inhibition raises simvastatin exposure several-fold',
    clinical_effect: 'Rhabdomyolysis and acute kidney injury',
    management: 'Do not co-prescribe. Suspend the statin for the duration of the macrolide course, or choose azithromycin.',
  },
  {
    rxnorm_a: '36567',
    name_a: 'simvastatin',
    rxnorm_b: '4450',
    name_b: 'fluconazole',
    severity: 'major',
    mechanism: 'CYP3A4 inhibition increases statin plasma levels',
    clinical_effect: 'Myopathy and raised creatine kinase',
    management: 'Suspend the statin during the antifungal course, or switch to pravastatin which is not CYP3A4 dependent.',
  },
  {
    rxnorm_a: '7052',
    name_a: 'morphine',
    rxnorm_b: '6960',
    name_b: 'midazolam',
    severity: 'major',
    mechanism: 'Additive central nervous system and respiratory depression',
    clinical_effect: 'Respiratory arrest, profound sedation',
    management: 'Combine only with continuous monitoring and naloxone/flumazenil available. Reduce both doses.',
  },
  {
    rxnorm_a: '7052',
    name_a: 'morphine',
    rxnorm_b: '6813',
    name_b: 'naltrexone',
    severity: 'contraindicated',
    mechanism: 'Competitive opioid receptor antagonism',
    clinical_effect: 'Complete loss of analgesia and precipitated acute withdrawal',
    management: 'Do not co-prescribe. Use a non-opioid analgesic strategy.',
  },
  {
    rxnorm_a: '32937',
    name_a: 'sertraline',
    rxnorm_b: '6935',
    name_b: 'monoamine oxidase inhibitor',
    severity: 'contraindicated',
    mechanism: 'Excess synaptic serotonin',
    clinical_effect: 'Serotonin syndrome — hyperthermia, rigidity, autonomic instability, death',
    management: 'Never combine. Allow a 14-day washout between an MAOI and an SSRI (5 weeks after fluoxetine).',
  },
  {
    rxnorm_a: '32937',
    name_a: 'sertraline',
    rxnorm_b: '10689',
    name_b: 'tramadol',
    severity: 'major',
    mechanism: 'Additive serotonergic activity; tramadol also lowers the seizure threshold',
    clinical_effect: 'Serotonin syndrome and seizures',
    management: 'Prefer a non-serotonergic analgesic. If combined, use the lowest dose and counsel the patient on serotonin syndrome symptoms.',
  },
  {
    rxnorm_a: '29046',
    name_a: 'lisinopril',
    rxnorm_b: '8591',
    name_b: 'potassium chloride',
    severity: 'major',
    mechanism: 'ACE inhibition reduces aldosterone-driven potassium excretion',
    clinical_effect: 'Hyperkalaemia with risk of fatal arrhythmia',
    management: 'Avoid routine potassium supplementation. If required, check potassium within a week and repeat regularly.',
  },
  {
    rxnorm_a: '29046',
    name_a: 'lisinopril',
    rxnorm_b: '9997',
    name_b: 'spironolactone',
    severity: 'major',
    mechanism: 'Two independent mechanisms retaining potassium',
    clinical_effect: 'Hyperkalaemia, particularly in renal impairment',
    management: 'Monitor potassium and creatinine at 1 and 4 weeks, then at each dose change.',
  },
  {
    rxnorm_a: '29046',
    name_a: 'lisinopril',
    rxnorm_b: '5640',
    name_b: 'ibuprofen',
    severity: 'moderate',
    mechanism: 'Prostaglandin inhibition reduces renal perfusion and blunts the antihypertensive effect',
    clinical_effect: 'Rising blood pressure and acute kidney injury, especially with a diuretic',
    management: 'Use paracetamol where possible. If an NSAID is needed, keep the course short and check renal function.',
  },
  {
    rxnorm_a: '42463',
    name_a: 'clopidogrel',
    rxnorm_b: '7646',
    name_b: 'omeprazole',
    severity: 'moderate',
    mechanism: 'CYP2C19 inhibition reduces conversion of clopidogrel to its active metabolite',
    clinical_effect: 'Reduced antiplatelet effect and higher cardiovascular event rate',
    management: 'Switch to pantoprazole, which inhibits CYP2C19 far less.',
  },
  {
    rxnorm_a: '3827',
    name_a: 'digoxin',
    rxnorm_b: '4109',
    name_b: 'furosemide',
    severity: 'moderate',
    mechanism: 'Diuretic-induced hypokalaemia increases myocardial sensitivity to digoxin',
    clinical_effect: 'Digoxin toxicity — nausea, visual disturbance, arrhythmia',
    management: 'Monitor potassium and magnesium; supplement as needed and check digoxin levels if symptoms appear.',
  },
  {
    rxnorm_a: '3827',
    name_a: 'digoxin',
    rxnorm_b: '1596',
    name_b: 'amiodarone',
    severity: 'major',
    mechanism: 'P-glycoprotein inhibition reduces digoxin clearance',
    clinical_effect: 'Digoxin levels roughly double, with bradycardia and heart block',
    management: 'Halve the digoxin dose when starting amiodarone and check levels after a week.',
  },
  {
    rxnorm_a: '6135',
    name_a: 'lithium',
    rxnorm_b: '5640',
    name_b: 'ibuprofen',
    severity: 'major',
    mechanism: 'NSAIDs reduce renal lithium clearance',
    clinical_effect: 'Lithium toxicity — tremor, confusion, seizures',
    management: 'Avoid NSAIDs. If unavoidable, check lithium levels within 5 days and counsel on toxicity symptoms.',
  },
  {
    rxnorm_a: '2670',
    name_a: 'codeine',
    rxnorm_b: '161',
    name_b: 'paracetamol',
    severity: 'minor',
    mechanism: 'Frequently co-formulated; risk is duplicate paracetamol exposure rather than an interaction',
    clinical_effect: 'Inadvertent paracetamol overdose when a combination product is taken alongside plain paracetamol',
    management: 'Check the total daily paracetamol dose across all products stays below 4 g.',
  },
  {
    rxnorm_a: '18631',
    name_a: 'ciprofloxacin',
    rxnorm_b: '1287',
    name_b: 'calcium carbonate',
    severity: 'moderate',
    mechanism: 'Divalent cations chelate the quinolone in the gut',
    clinical_effect: 'Markedly reduced antibiotic absorption and treatment failure',
    management: 'Separate the doses by at least 2 hours before or 6 hours after the antacid.',
  },
  {
    rxnorm_a: '10689',
    name_a: 'tramadol',
    rxnorm_b: '6960',
    name_b: 'midazolam',
    severity: 'major',
    mechanism: 'Additive central nervous system depression',
    clinical_effect: 'Sedation and respiratory depression',
    management: 'Avoid where possible; if combined, monitor respiratory rate and sedation score.',
  },
];

/** Severities that stop an order outright and cannot be overridden. */
export const HARD_BLOCK: ReadonlySet<InteractionSeverity> = new Set(['contraindicated']);

/** Severities that may proceed only with a documented reason. */
export const REQUIRES_OVERRIDE: ReadonlySet<InteractionSeverity> = new Set(['major']);

const norm = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

/** Order-independent key for a pair, so a lookup never depends on argument order. */
export function pairKey(a: string, b: string): string {
  const [x, y] = [norm(a), norm(b)].sort();
  return `${x}|${y}`;
}

export interface DrugRef {
  rxnorm?: string | null;
  name: string;
}

const matches = (entry: CatalogueInteraction, drug: DrugRef, side: 'a' | 'b'): boolean => {
  const code = side === 'a' ? entry.rxnorm_a : entry.rxnorm_b;
  const name = side === 'a' ? entry.name_a : entry.name_b;
  if (drug.rxnorm && norm(drug.rxnorm) === norm(code)) return true;
  const candidate = norm(drug.name);
  return Boolean(candidate) && (candidate.includes(name) || name.includes(candidate));
};

/** The bundled entry for a pair, in either order, or undefined. */
export function findCatalogueInteraction(
  a: DrugRef,
  b: DrugRef,
): CatalogueInteraction | undefined {
  return INTERACTION_CATALOGUE.find(
    (entry) =>
      (matches(entry, a, 'a') && matches(entry, b, 'b')) ||
      (matches(entry, b, 'a') && matches(entry, a, 'b')),
  );
}

/** Every bundled entry involving this drug, against a list of others. */
export function findCatalogueInteractions(
  candidate: DrugRef,
  others: readonly DrugRef[],
): Array<{ other: DrugRef; entry: CatalogueInteraction }> {
  const found: Array<{ other: DrugRef; entry: CatalogueInteraction }> = [];
  for (const other of others) {
    const entry = findCatalogueInteraction(candidate, other);
    if (entry) found.push({ other, entry });
  }
  return found;
}

export type InteractionAction = 'block' | 'override' | 'warn';

/**
 * What a severity means for the order in front of the prescriber.
 * Only `contraindicated` is absolute; `major` is a decision the prescriber may
 * make and must justify; anything lower is information.
 */
export function actionFor(severity: InteractionSeverity): InteractionAction {
  if (HARD_BLOCK.has(severity)) return 'block';
  if (REQUIRES_OVERRIDE.has(severity)) return 'override';
  return 'warn';
}

/**
 * Fallback wording used when no model-written explanation has been cached yet.
 * Never blank: a warning a clinician cannot read is a warning they will dismiss.
 */
export function fallbackExplanation(entry: {
  drug_a: string;
  drug_b: string;
  severity: string;
  clinical_effect: string;
  management?: string | null;
}): string {
  const lead = `Taking ${entry.drug_a} with ${entry.drug_b} can cause ${entry.clinical_effect.toLowerCase()}.`;
  return entry.management ? `${lead} ${entry.management}` : lead;
}
