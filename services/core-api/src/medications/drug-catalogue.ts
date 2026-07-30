/**
 * Bundled starter formulary for the prescribing search box.
 *
 * A tenant's own `drug_formulary` is the real source and always wins. This exists
 * so a site that has not loaded one yet can still prescribe safely — with RxNorm
 * codes attached, which is what makes the interaction and allergy checks work at
 * all. A drug typed as free text is a drug nothing can check.
 *
 * Defaults are per class, not per patient: they save typing, and the prescriber
 * still confirms every field before the order is written.
 */

export type DrugClass =
  | 'analgesic'
  | 'nsaid'
  | 'opioid'
  | 'antibiotic'
  | 'antifungal'
  | 'anticoagulant'
  | 'antiplatelet'
  | 'antihypertensive'
  | 'diuretic'
  | 'statin'
  | 'antidiabetic'
  | 'ppi'
  | 'antidepressant'
  | 'antipsychotic'
  | 'benzodiazepine'
  | 'bronchodilator'
  | 'corticosteroid'
  | 'antiemetic'
  | 'thyroid'
  | 'other';

export interface CatalogueDrug {
  rxnorm: string;
  atc: string;
  generic_name: string;
  brand_name?: string;
  strength: string;
  dose_form: string;
  drug_class: DrugClass;
  is_controlled?: boolean;
  controlled_schedule?: string;
}

export const DRUG_CATALOGUE: readonly CatalogueDrug[] = [
  { rxnorm: '161', atc: 'N02BE01', generic_name: 'Paracetamol', brand_name: 'Panadol', strength: '500 mg', dose_form: 'tablet', drug_class: 'analgesic' },
  { rxnorm: '5640', atc: 'M01AE01', generic_name: 'Ibuprofen', brand_name: 'Brufen', strength: '400 mg', dose_form: 'tablet', drug_class: 'nsaid' },
  { rxnorm: '1191', atc: 'B01AC06', generic_name: 'Aspirin', strength: '75 mg', dose_form: 'tablet', drug_class: 'antiplatelet' },
  { rxnorm: '2670', atc: 'R05DA04', generic_name: 'Codeine', strength: '30 mg', dose_form: 'tablet', drug_class: 'opioid', is_controlled: true, controlled_schedule: 'CD5' },
  { rxnorm: '7052', atc: 'N02AA01', generic_name: 'Morphine', strength: '10 mg', dose_form: 'tablet', drug_class: 'opioid', is_controlled: true, controlled_schedule: 'CD2' },
  { rxnorm: '10689', atc: 'N02AX02', generic_name: 'Tramadol', strength: '50 mg', dose_form: 'capsule', drug_class: 'opioid', is_controlled: true, controlled_schedule: 'CD3' },
  { rxnorm: '6960', atc: 'N05CD08', generic_name: 'Midazolam', strength: '5 mg/mL', dose_form: 'injection', drug_class: 'benzodiazepine', is_controlled: true, controlled_schedule: 'CD3' },
  { rxnorm: '6470', atc: 'N05BA01', generic_name: 'Diazepam', strength: '5 mg', dose_form: 'tablet', drug_class: 'benzodiazepine', is_controlled: true, controlled_schedule: 'CD4' },

  { rxnorm: '723', atc: 'J01CA04', generic_name: 'Amoxicillin', strength: '500 mg', dose_form: 'capsule', drug_class: 'antibiotic' },
  { rxnorm: '18631', atc: 'J01MA02', generic_name: 'Ciprofloxacin', strength: '500 mg', dose_form: 'tablet', drug_class: 'antibiotic' },
  { rxnorm: '2551', atc: 'J01FA09', generic_name: 'Clarithromycin', strength: '500 mg', dose_form: 'tablet', drug_class: 'antibiotic' },
  { rxnorm: '10180', atc: 'J01EA01', generic_name: 'Trimethoprim', strength: '200 mg', dose_form: 'tablet', drug_class: 'antibiotic' },
  { rxnorm: '733', atc: 'J01CR02', generic_name: 'Co-amoxiclav', brand_name: 'Augmentin', strength: '625 mg', dose_form: 'tablet', drug_class: 'antibiotic' },
  { rxnorm: '4450', atc: 'J02AC01', generic_name: 'Fluconazole', strength: '150 mg', dose_form: 'capsule', drug_class: 'antifungal' },

  { rxnorm: '11289', atc: 'B01AA03', generic_name: 'Warfarin', strength: '5 mg', dose_form: 'tablet', drug_class: 'anticoagulant' },
  { rxnorm: '42463', atc: 'B01AC04', generic_name: 'Clopidogrel', strength: '75 mg', dose_form: 'tablet', drug_class: 'antiplatelet' },

  { rxnorm: '29046', atc: 'C09AA03', generic_name: 'Lisinopril', strength: '10 mg', dose_form: 'tablet', drug_class: 'antihypertensive' },
  { rxnorm: '17767', atc: 'C09CA01', generic_name: 'Losartan', strength: '50 mg', dose_form: 'tablet', drug_class: 'antihypertensive' },
  { rxnorm: '1202', atc: 'C07AB02', generic_name: 'Metoprolol', strength: '50 mg', dose_form: 'tablet', drug_class: 'antihypertensive' },
  { rxnorm: '17767000', atc: 'C08CA01', generic_name: 'Amlodipine', strength: '5 mg', dose_form: 'tablet', drug_class: 'antihypertensive' },
  { rxnorm: '4109', atc: 'C03CA01', generic_name: 'Furosemide', strength: '40 mg', dose_form: 'tablet', drug_class: 'diuretic' },
  { rxnorm: '9997', atc: 'C03DA01', generic_name: 'Spironolactone', strength: '25 mg', dose_form: 'tablet', drug_class: 'diuretic' },
  { rxnorm: '3827', atc: 'C01AA05', generic_name: 'Digoxin', strength: '125 mcg', dose_form: 'tablet', drug_class: 'other' },
  { rxnorm: '1596', atc: 'C01BD01', generic_name: 'Amiodarone', strength: '200 mg', dose_form: 'tablet', drug_class: 'other' },

  { rxnorm: '36567', atc: 'C10AA01', generic_name: 'Simvastatin', strength: '40 mg', dose_form: 'tablet', drug_class: 'statin' },
  { rxnorm: '83367', atc: 'C10AA05', generic_name: 'Atorvastatin', strength: '20 mg', dose_form: 'tablet', drug_class: 'statin' },

  { rxnorm: '6809', atc: 'A10BA02', generic_name: 'Metformin', strength: '500 mg', dose_form: 'tablet', drug_class: 'antidiabetic' },
  { rxnorm: '4821', atc: 'A10BB12', generic_name: 'Gliclazide', strength: '80 mg', dose_form: 'tablet', drug_class: 'antidiabetic' },

  { rxnorm: '7646', atc: 'A02BC01', generic_name: 'Omeprazole', strength: '20 mg', dose_form: 'capsule', drug_class: 'ppi' },
  { rxnorm: '40790', atc: 'A02BC02', generic_name: 'Pantoprazole', strength: '40 mg', dose_form: 'tablet', drug_class: 'ppi' },

  { rxnorm: '32937', atc: 'N06AB06', generic_name: 'Sertraline', strength: '50 mg', dose_form: 'tablet', drug_class: 'antidepressant' },
  { rxnorm: '4493', atc: 'N06AB03', generic_name: 'Fluoxetine', strength: '20 mg', dose_form: 'capsule', drug_class: 'antidepressant' },
  { rxnorm: '6135', atc: 'N05AN01', generic_name: 'Lithium carbonate', strength: '400 mg', dose_form: 'tablet', drug_class: 'antipsychotic' },

  { rxnorm: '435', atc: 'R03AC02', generic_name: 'Salbutamol', brand_name: 'Ventolin', strength: '100 mcg', dose_form: 'inhaler', drug_class: 'bronchodilator' },
  { rxnorm: '8640', atc: 'H02AB07', generic_name: 'Prednisolone', strength: '5 mg', dose_form: 'tablet', drug_class: 'corticosteroid' },

  { rxnorm: '6963', atc: 'A04AA01', generic_name: 'Ondansetron', strength: '4 mg', dose_form: 'tablet', drug_class: 'antiemetic' },
  { rxnorm: '6851', atc: 'A03FA01', generic_name: 'Metoclopramide', strength: '10 mg', dose_form: 'tablet', drug_class: 'antiemetic' },

  { rxnorm: '10582', atc: 'H03AA01', generic_name: 'Levothyroxine', strength: '50 mcg', dose_form: 'tablet', drug_class: 'thyroid' },

  { rxnorm: '8591', atc: 'A12BA01', generic_name: 'Potassium chloride', strength: '600 mg', dose_form: 'tablet', drug_class: 'other' },
  { rxnorm: '1287', atc: 'A02AC01', generic_name: 'Calcium carbonate', strength: '1.25 g', dose_form: 'tablet', drug_class: 'other' },
];

export interface PrescribingDefaults {
  dose_quantity: number;
  dose_unit: string;
  route: string;
  frequency: string;
  duration_days: number | null;
  /** Warning worth surfacing beside the defaults, if any. */
  note?: string;
}

const ROUTE_BY_FORM: Record<string, string> = {
  tablet: 'oral',
  capsule: 'oral',
  syrup: 'oral',
  suspension: 'oral',
  injection: 'intravenous',
  inhaler: 'inhaled',
  cream: 'topical',
  ointment: 'topical',
  drops: 'ophthalmic',
  patch: 'transdermal',
  suppository: 'rectal',
};

const CLASS_DEFAULTS: Record<DrugClass, Omit<PrescribingDefaults, 'route'>> = {
  analgesic: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'QDS', duration_days: 5 },
  nsaid: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'TDS', duration_days: 5, note: 'Take with food; check renal function and gastric risk' },
  opioid: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'QDS PRN', duration_days: 3, note: 'Shortest effective course; counsel on driving and constipation' },
  antibiotic: { dose_quantity: 1, dose_unit: 'capsule', frequency: 'TDS', duration_days: 7, note: 'Complete the course; review against local sensitivities' },
  antifungal: { dose_quantity: 1, dose_unit: 'capsule', frequency: 'OD', duration_days: 7 },
  anticoagulant: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'OD', duration_days: null, note: 'Dose is INR-guided; arrange monitoring before the first dose' },
  antiplatelet: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'OD', duration_days: null },
  antihypertensive: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'OD', duration_days: 28 },
  diuretic: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'OM', duration_days: 28, note: 'Morning dosing; monitor electrolytes and renal function' },
  statin: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'ON', duration_days: 28 },
  antidiabetic: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'BD', duration_days: 28, note: 'Take with meals' },
  ppi: { dose_quantity: 1, dose_unit: 'capsule', frequency: 'OM', duration_days: 28 },
  antidepressant: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'OM', duration_days: 28, note: 'Review at 2 weeks; do not stop abruptly' },
  antipsychotic: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'ON', duration_days: 28, note: 'Requires level monitoring' },
  benzodiazepine: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'ON PRN', duration_days: 7, note: 'Short course only; dependence risk' },
  bronchodilator: { dose_quantity: 2, dose_unit: 'puff', frequency: 'QDS PRN', duration_days: null, note: 'Check inhaler technique' },
  corticosteroid: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'OM', duration_days: 5, note: 'Take in the morning with food' },
  antiemetic: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'TDS PRN', duration_days: 3 },
  thyroid: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'OM', duration_days: 28, note: 'Take on an empty stomach, 30 minutes before food' },
  other: { dose_quantity: 1, dose_unit: 'tablet', frequency: 'OD', duration_days: 7 },
};

/** Frequencies to doses per day, used to size the quantity to dispense. */
const DOSES_PER_DAY: Record<string, number> = {
  OD: 1,
  OM: 1,
  ON: 1,
  BD: 2,
  TDS: 3,
  QDS: 4,
};

export function dosesPerDay(frequency: string): number {
  const key = frequency.replace(/\s*PRN$/i, '').trim().toUpperCase();
  return DOSES_PER_DAY[key] ?? 1;
}

/** Quantity to dispense for a course, rounded up to a whole unit. */
export function suggestedQuantity(
  doseQuantity: number,
  frequency: string,
  durationDays: number | null,
): number {
  const days = durationDays ?? 28;
  return Math.max(1, Math.ceil(doseQuantity * dosesPerDay(frequency) * days));
}

export function defaultsFor(drug: {
  drug_class?: DrugClass | null;
  dose_form?: string | null;
}): PrescribingDefaults {
  const base = CLASS_DEFAULTS[drug.drug_class ?? 'other'] ?? CLASS_DEFAULTS.other;
  const form = (drug.dose_form ?? '').toLowerCase();
  return {
    ...base,
    dose_unit: form && form !== 'tablet' && form !== 'capsule' ? base.dose_unit : form || base.dose_unit,
    route: ROUTE_BY_FORM[form] ?? 'oral',
  };
}

const norm = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

export interface DrugMatch extends CatalogueDrug {
  score: number;
  source: 'tenant' | 'bundled';
  formulary_id?: string;
}

/**
 * Ranks a drug against a query. An exact code wins, then a name that starts with
 * the query, then a name that merely contains it — so typing "met" offers
 * Metformin and Metoprolol before Clarithromycin.
 */
export function scoreDrug(drug: CatalogueDrug, query: string): number {
  const q = norm(query);
  if (!q) return 0;

  if (norm(drug.rxnorm) === q || norm(drug.atc) === q) return 1;
  if (norm(drug.atc).startsWith(q) && q.length >= 3) return 0.9;

  const generic = norm(drug.generic_name);
  const brand = norm(drug.brand_name);

  if (generic === q || brand === q) return 0.95;
  if (generic.startsWith(q)) return 0.8;
  if (brand.startsWith(q)) return 0.75;
  if (generic.includes(q)) return 0.5;
  if (brand.includes(q)) return 0.45;
  return 0;
}

export function searchDrugCatalogue(
  query: string,
  options: { limit?: number; extra?: readonly DrugMatch[] } = {},
): DrugMatch[] {
  const { limit = 10, extra = [] } = options;
  if (norm(query).length < 2) return [];

  const seen = new Set(extra.map((d) => norm(d.rxnorm) || norm(d.generic_name)));
  const bundled: DrugMatch[] = DRUG_CATALOGUE.filter(
    (d) => !seen.has(norm(d.rxnorm)) && !seen.has(norm(d.generic_name)),
  ).map((d) => ({ ...d, score: 0, source: 'bundled' as const }));

  return [...extra, ...bundled]
    .map((drug) => ({ ...drug, score: scoreDrug(drug, query) }))
    .filter((drug) => drug.score > 0)
    .sort((a, b) => b.score - a.score || a.generic_name.localeCompare(b.generic_name))
    .slice(0, limit);
}
