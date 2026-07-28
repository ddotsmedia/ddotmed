/**
 * Diagnosis autocomplete.
 *
 * The catalogue below is a working subset of ICD-10 covering the presentations a
 * general clinic actually codes day to day. It is deliberately bundled rather
 * than fetched: an autocomplete that stalls or fails mid-consultation pushes
 * clinicians towards free text, and free text does not bill or report.
 *
 * A tenant that licences the full WHO release supplies it through
 * `searchIcd10(query, { extra })`; matching and ranking are identical either way.
 */

export interface Icd10Code {
  code: string;
  display: string;
  /** Chapter grouping, shown as a hint so similar codes can be told apart. */
  chapter: string;
}

export interface Icd10Match extends Icd10Code {
  score: number;
}

export const ICD10_CATALOGUE: readonly Icd10Code[] = [
  // Infectious
  { code: 'A09', display: 'Infectious gastroenteritis and colitis, unspecified', chapter: 'Infectious' },
  { code: 'A41.9', display: 'Sepsis, unspecified organism', chapter: 'Infectious' },
  { code: 'B34.9', display: 'Viral infection, unspecified', chapter: 'Infectious' },
  { code: 'U07.1', display: 'COVID-19, virus identified', chapter: 'Infectious' },

  // Neoplasms
  { code: 'C50.9', display: 'Malignant neoplasm of breast, unspecified', chapter: 'Neoplasms' },
  { code: 'D64.9', display: 'Anaemia, unspecified', chapter: 'Blood' },
  { code: 'D50.9', display: 'Iron deficiency anaemia, unspecified', chapter: 'Blood' },

  // Endocrine and metabolic
  { code: 'E03.9', display: 'Hypothyroidism, unspecified', chapter: 'Endocrine' },
  { code: 'E05.90', display: 'Thyrotoxicosis, unspecified', chapter: 'Endocrine' },
  { code: 'E10.9', display: 'Type 1 diabetes mellitus without complications', chapter: 'Endocrine' },
  { code: 'E11.9', display: 'Type 2 diabetes mellitus without complications', chapter: 'Endocrine' },
  { code: 'E11.65', display: 'Type 2 diabetes mellitus with hyperglycaemia', chapter: 'Endocrine' },
  { code: 'E66.9', display: 'Obesity, unspecified', chapter: 'Endocrine' },
  { code: 'E78.5', display: 'Hyperlipidaemia, unspecified', chapter: 'Endocrine' },
  { code: 'E86.0', display: 'Dehydration', chapter: 'Endocrine' },
  { code: 'E87.6', display: 'Hypokalaemia', chapter: 'Endocrine' },

  // Mental health
  { code: 'F32.9', display: 'Major depressive disorder, single episode, unspecified', chapter: 'Mental health' },
  { code: 'F41.1', display: 'Generalised anxiety disorder', chapter: 'Mental health' },
  { code: 'F41.9', display: 'Anxiety disorder, unspecified', chapter: 'Mental health' },
  { code: 'F51.0', display: 'Insomnia, not due to a substance', chapter: 'Mental health' },

  // Nervous system
  { code: 'G43.909', display: 'Migraine, unspecified, not intractable', chapter: 'Nervous system' },
  { code: 'G47.33', display: 'Obstructive sleep apnoea', chapter: 'Nervous system' },
  { code: 'G40.909', display: 'Epilepsy, unspecified, without status epilepticus', chapter: 'Nervous system' },
  { code: 'G62.9', display: 'Polyneuropathy, unspecified', chapter: 'Nervous system' },

  // Eye and ear
  { code: 'H10.9', display: 'Conjunctivitis, unspecified', chapter: 'Eye' },
  { code: 'H66.90', display: 'Otitis media, unspecified, unspecified ear', chapter: 'Ear' },
  { code: 'H81.10', display: 'Benign paroxysmal vertigo, unspecified ear', chapter: 'Ear' },

  // Circulatory
  { code: 'I10', display: 'Essential (primary) hypertension', chapter: 'Circulatory' },
  { code: 'I20.9', display: 'Angina pectoris, unspecified', chapter: 'Circulatory' },
  { code: 'I21.9', display: 'Acute myocardial infarction, unspecified', chapter: 'Circulatory' },
  { code: 'I25.10', display: 'Atherosclerotic heart disease without angina', chapter: 'Circulatory' },
  { code: 'I48.91', display: 'Atrial fibrillation, unspecified', chapter: 'Circulatory' },
  { code: 'I50.9', display: 'Heart failure, unspecified', chapter: 'Circulatory' },
  { code: 'I63.9', display: 'Cerebral infarction, unspecified', chapter: 'Circulatory' },
  { code: 'I83.90', display: 'Varicose veins of lower extremity, unspecified', chapter: 'Circulatory' },

  // Respiratory
  { code: 'J01.90', display: 'Acute sinusitis, unspecified', chapter: 'Respiratory' },
  { code: 'J02.9', display: 'Acute pharyngitis, unspecified', chapter: 'Respiratory' },
  { code: 'J06.9', display: 'Acute upper respiratory infection, unspecified', chapter: 'Respiratory' },
  { code: 'J18.9', display: 'Pneumonia, unspecified organism', chapter: 'Respiratory' },
  { code: 'J20.9', display: 'Acute bronchitis, unspecified', chapter: 'Respiratory' },
  { code: 'J30.9', display: 'Allergic rhinitis, unspecified', chapter: 'Respiratory' },
  { code: 'J44.9', display: 'Chronic obstructive pulmonary disease, unspecified', chapter: 'Respiratory' },
  { code: 'J45.909', display: 'Asthma, unspecified, uncomplicated', chapter: 'Respiratory' },

  // Digestive
  { code: 'K21.9', display: 'Gastro-oesophageal reflux disease without oesophagitis', chapter: 'Digestive' },
  { code: 'K29.70', display: 'Gastritis, unspecified, without bleeding', chapter: 'Digestive' },
  { code: 'K35.80', display: 'Acute appendicitis, unspecified', chapter: 'Digestive' },
  { code: 'K57.30', display: 'Diverticulosis of large intestine without perforation', chapter: 'Digestive' },
  { code: 'K59.00', display: 'Constipation, unspecified', chapter: 'Digestive' },
  { code: 'K80.20', display: 'Calculus of gallbladder without cholecystitis', chapter: 'Digestive' },

  // Skin
  { code: 'L03.90', display: 'Cellulitis, unspecified', chapter: 'Skin' },
  { code: 'L20.9', display: 'Atopic dermatitis, unspecified', chapter: 'Skin' },
  { code: 'L30.9', display: 'Dermatitis, unspecified', chapter: 'Skin' },
  { code: 'L50.9', display: 'Urticaria, unspecified', chapter: 'Skin' },

  // Musculoskeletal
  { code: 'M10.9', display: 'Gout, unspecified', chapter: 'Musculoskeletal' },
  { code: 'M17.9', display: 'Osteoarthritis of knee, unspecified', chapter: 'Musculoskeletal' },
  { code: 'M25.561', display: 'Pain in right knee', chapter: 'Musculoskeletal' },
  { code: 'M25.562', display: 'Pain in left knee', chapter: 'Musculoskeletal' },
  { code: 'M54.5', display: 'Low back pain', chapter: 'Musculoskeletal' },
  { code: 'M79.10', display: 'Myalgia, unspecified site', chapter: 'Musculoskeletal' },
  { code: 'M81.0', display: 'Age-related osteoporosis without fracture', chapter: 'Musculoskeletal' },

  // Genitourinary
  { code: 'N18.3', display: 'Chronic kidney disease, stage 3, unspecified', chapter: 'Genitourinary' },
  { code: 'N20.0', display: 'Calculus of kidney', chapter: 'Genitourinary' },
  { code: 'N39.0', display: 'Urinary tract infection, site not specified', chapter: 'Genitourinary' },
  { code: 'N92.0', display: 'Excessive and frequent menstruation with regular cycle', chapter: 'Genitourinary' },

  // Pregnancy
  { code: 'O24.419', display: 'Gestational diabetes mellitus in pregnancy, unspecified control', chapter: 'Pregnancy' },
  { code: 'O80', display: 'Encounter for full-term uncomplicated delivery', chapter: 'Pregnancy' },
  { code: 'Z34.90', display: 'Supervision of normal pregnancy, unspecified trimester', chapter: 'Pregnancy' },

  // Perinatal / congenital
  { code: 'P59.9', display: 'Neonatal jaundice, unspecified', chapter: 'Perinatal' },

  // Symptoms and signs
  { code: 'R05.9', display: 'Cough, unspecified', chapter: 'Symptoms' },
  { code: 'R07.9', display: 'Chest pain, unspecified', chapter: 'Symptoms' },
  { code: 'R10.9', display: 'Unspecified abdominal pain', chapter: 'Symptoms' },
  { code: 'R11.2', display: 'Nausea with vomiting, unspecified', chapter: 'Symptoms' },
  { code: 'R42', display: 'Dizziness and giddiness', chapter: 'Symptoms' },
  { code: 'R50.9', display: 'Fever, unspecified', chapter: 'Symptoms' },
  { code: 'R51.9', display: 'Headache, unspecified', chapter: 'Symptoms' },
  { code: 'R53.83', display: 'Other fatigue', chapter: 'Symptoms' },
  { code: 'R55', display: 'Syncope and collapse', chapter: 'Symptoms' },
  { code: 'R60.0', display: 'Localised oedema', chapter: 'Symptoms' },

  // Injury
  { code: 'S06.0X0A', display: 'Concussion without loss of consciousness, initial encounter', chapter: 'Injury' },
  { code: 'S52.501A', display: 'Fracture of lower end of right radius, initial encounter', chapter: 'Injury' },
  { code: 'S93.401A', display: 'Sprain of right ankle, initial encounter', chapter: 'Injury' },
  { code: 'T78.2XXA', display: 'Anaphylactic shock, unspecified, initial encounter', chapter: 'Injury' },

  // Factors influencing health status
  { code: 'Z00.00', display: 'General adult medical examination without abnormal findings', chapter: 'Health status' },
  { code: 'Z23', display: 'Encounter for immunisation', chapter: 'Health status' },
  { code: 'Z79.4', display: 'Long term (current) use of insulin', chapter: 'Health status' },
];

const normalise = (value: string): string => value.trim().toLowerCase();
const codeKey = (value: string): string => value.replace(/[.\s]/g, '').toLowerCase();

/**
 * Scores one candidate against a query. Exact code beats code prefix, which beats
 * a word starting in the description, which beats a substring anywhere — so
 * typing "E11" never buries the diabetes code under something merely containing it.
 */
export function scoreIcd10(entry: Icd10Code, query: string): number {
  const q = normalise(query);
  if (!q) return 0;

  const qCode = codeKey(q);
  const eCode = codeKey(entry.code);
  if (eCode === qCode) return 1;
  if (eCode.startsWith(qCode)) return 0.9;

  const display = normalise(entry.display);
  if (display === q) return 0.85;

  const words = display.split(/[^a-z0-9]+/).filter(Boolean);
  const terms = q.split(/\s+/).filter(Boolean);

  // Every term has to land somewhere, so "knee pain" does not match plain "pain".
  const matched: number[] = terms.map((term) => {
    if (words.some((w) => w === term)) return 0.75;
    if (words.some((w) => w.startsWith(term))) return 0.6;
    if (display.includes(term)) return 0.4;
    if (eCode.includes(codeKey(term))) return 0.35;
    return 0;
  });
  if (matched.some((m) => m === 0)) return 0;

  return matched.reduce((a, b) => a + b, 0) / matched.length;
}

export interface Icd10SearchOptions {
  limit?: number;
  /** Codes already used in this tenant, merged ahead of the bundled catalogue. */
  extra?: readonly Icd10Code[];
}

export function searchIcd10(query: string, options: Icd10SearchOptions = {}): Icd10Match[] {
  const { limit = 10, extra = [] } = options;
  if (normalise(query).length < 2) return [];

  const seen = new Set<string>();
  const pool: Icd10Code[] = [];
  for (const entry of [...extra, ...ICD10_CATALOGUE]) {
    const key = codeKey(entry.code);
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(entry);
  }

  return pool
    .map((entry) => ({ ...entry, score: scoreIcd10(entry, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code))
    .slice(0, limit);
}
