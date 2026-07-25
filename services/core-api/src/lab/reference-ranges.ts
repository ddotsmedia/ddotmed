export interface ReferenceRange {
  loinc: string;
  name: string;
  unit: string;
  low: number | null;
  high: number | null;
  /** Values at or beyond these bounds are critical and trigger an immediate alert. */
  criticalLow?: number | null;
  criticalHigh?: number | null;
  text?: string;
}

export interface Demographics {
  gender: string;
  ageYears: number;
}

interface RangeRule extends ReferenceRange {
  gender?: 'male' | 'female';
  minAge?: number;
  maxAge?: number;
}

/**
 * Adult reference ranges with critical thresholds. Demographic variants are listed
 * before the general fallback and the first match wins.
 */
const RANGES: RangeRule[] = [
  { loinc: '718-7', name: 'Haemoglobin', unit: 'g/dL', low: 13.5, high: 17.5, criticalLow: 7, criticalHigh: 20, gender: 'male', minAge: 18 },
  { loinc: '718-7', name: 'Haemoglobin', unit: 'g/dL', low: 12.0, high: 15.5, criticalLow: 7, criticalHigh: 20, gender: 'female', minAge: 18 },
  { loinc: '718-7', name: 'Haemoglobin', unit: 'g/dL', low: 11.0, high: 14.0, criticalLow: 7, criticalHigh: 20, maxAge: 17 },

  { loinc: '2345-7', name: 'Glucose', unit: 'mg/dL', low: 70, high: 99, criticalLow: 40, criticalHigh: 500 },
  { loinc: '2160-0', name: 'Creatinine', unit: 'mg/dL', low: 0.7, high: 1.3, criticalHigh: 7.4, gender: 'male' },
  { loinc: '2160-0', name: 'Creatinine', unit: 'mg/dL', low: 0.6, high: 1.1, criticalHigh: 7.4, gender: 'female' },

  { loinc: '2823-3', name: 'Potassium', unit: 'mmol/L', low: 3.5, high: 5.1, criticalLow: 2.5, criticalHigh: 6.5 },
  { loinc: '2951-2', name: 'Sodium', unit: 'mmol/L', low: 136, high: 145, criticalLow: 120, criticalHigh: 160 },
  { loinc: '17861-6', name: 'Calcium', unit: 'mg/dL', low: 8.5, high: 10.2, criticalLow: 6.0, criticalHigh: 13.0 },

  { loinc: '6690-2', name: 'White cell count', unit: '10*3/uL', low: 4.0, high: 11.0, criticalLow: 1.0, criticalHigh: 50.0 },
  { loinc: '777-3', name: 'Platelet count', unit: '10*3/uL', low: 150, high: 400, criticalLow: 20, criticalHigh: 1000 },
  { loinc: '4544-3', name: 'Haematocrit', unit: '%', low: 38.3, high: 48.6, criticalLow: 20, criticalHigh: 60 },

  { loinc: '5902-2', name: 'Prothrombin time', unit: 's', low: 11, high: 13.5, criticalHigh: 30 },
  { loinc: '6301-6', name: 'INR', unit: '{ratio}', low: 0.8, high: 1.2, criticalHigh: 5.0 },
  { loinc: '1975-2', name: 'Bilirubin total', unit: 'mg/dL', low: 0.1, high: 1.2, criticalHigh: 15 },
  { loinc: '1742-6', name: 'ALT', unit: 'U/L', low: 7, high: 56, criticalHigh: 1000 },
  { loinc: '1920-8', name: 'AST', unit: 'U/L', low: 10, high: 40, criticalHigh: 1000 },
  { loinc: '2532-0', name: 'Lactate dehydrogenase', unit: 'U/L', low: 140, high: 280 },
  { loinc: '2524-7', name: 'Lactate', unit: 'mmol/L', low: 0.5, high: 2.2, criticalHigh: 4.0 },
  { loinc: '33762-6', name: 'NT-proBNP', unit: 'pg/mL', low: 0, high: 125, criticalHigh: 5000 },
  { loinc: '10839-9', name: 'Troponin I', unit: 'ng/mL', low: 0, high: 0.04, criticalHigh: 0.4 },
  { loinc: '1988-5', name: 'C-reactive protein', unit: 'mg/L', low: 0, high: 5, criticalHigh: 200 },
  { loinc: '4548-4', name: 'HbA1c', unit: '%', low: 4.0, high: 5.6, criticalHigh: 14 },
  { loinc: '3016-3', name: 'TSH', unit: 'mIU/L', low: 0.4, high: 4.0 },
  { loinc: '2075-0', name: 'Chloride', unit: 'mmol/L', low: 98, high: 107, criticalLow: 80, criticalHigh: 120 },
  { loinc: '3094-0', name: 'Urea nitrogen', unit: 'mg/dL', low: 7, high: 20, criticalHigh: 100 },
];

export function rangeFor(loinc: string, demo: Demographics): ReferenceRange | null {
  const candidates = RANGES.filter((r) => r.loinc === loinc);
  if (candidates.length === 0) return null;

  const match =
    candidates.find(
      (r) =>
        (!r.gender || r.gender === demo.gender) &&
        (r.minAge === undefined || demo.ageYears >= r.minAge) &&
        (r.maxAge === undefined || demo.ageYears <= r.maxAge),
    ) ?? candidates.find((r) => !r.gender && r.minAge === undefined && r.maxAge === undefined);

  return match ?? candidates[0] ?? null;
}

export type Interpretation = 'N' | 'L' | 'H' | 'LL' | 'HH';

export interface InterpretationResult {
  code: Interpretation | null;
  isCritical: boolean;
  reason: string | null;
}

export function interpretResult(
  value: number | null,
  range: ReferenceRange | null,
): InterpretationResult {
  if (value === null || !range) return { code: null, isCritical: false, reason: null };

  if (range.criticalLow != null && value <= range.criticalLow) {
    return {
      code: 'LL',
      isCritical: true,
      reason: `${range.name} ${value} ${range.unit} is at or below the critical low of ${range.criticalLow}`,
    };
  }
  if (range.criticalHigh != null && value >= range.criticalHigh) {
    return {
      code: 'HH',
      isCritical: true,
      reason: `${range.name} ${value} ${range.unit} is at or above the critical high of ${range.criticalHigh}`,
    };
  }
  if (range.low != null && value < range.low) {
    return { code: 'L', isCritical: false, reason: `Below the reference range (${range.low}–${range.high})` };
  }
  if (range.high != null && value > range.high) {
    return { code: 'H', isCritical: false, reason: `Above the reference range (${range.low}–${range.high})` };
  }
  return { code: 'N', isCritical: false, reason: null };
}

export interface ParsedObx {
  loinc: string;
  display: string;
  rawValue: string;
  numericValue: number | null;
  unit: string | null;
  abnormalFlag: string | null;
  status: 'preliminary' | 'final' | 'corrected';
}

export interface ParsedOru {
  messageType: string;
  messageControlId: string | null;
  accessionNumber: string | null;
  patientIdentifier: string | null;
  observations: ParsedObx[];
}

const OBX_STATUS: Record<string, ParsedObx['status']> = {
  P: 'preliminary',
  F: 'final',
  C: 'corrected',
};

/** Minimal HL7 v2.x ORU^R01 parser covering MSH, PID, OBR and OBX segments. */
export function parseHl7Oru(message: string): ParsedOru {
  const segments = message
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: ParsedOru = {
    messageType: 'unknown',
    messageControlId: null,
    accessionNumber: null,
    patientIdentifier: null,
    observations: [],
  };

  for (const segment of segments) {
    const f = segment.split('|');
    switch (f[0]) {
      case 'MSH':
        out.messageType = f[8] ?? 'unknown';
        out.messageControlId = f[9] ?? null;
        break;
      case 'PID':
        out.patientIdentifier = f[3]?.split('^')[0] ?? null;
        break;
      case 'OBR':
        // OBR-3 filler order number is the accession the lab returns results under.
        out.accessionNumber = f[3]?.split('^')[0] ?? f[2]?.split('^')[0] ?? null;
        break;
      case 'OBX': {
        const identifier = (f[3] ?? '').split('^');
        const raw = f[5] ?? '';
        const numeric = Number(raw);
        out.observations.push({
          loinc: identifier[0] ?? '',
          display: identifier[1] ?? identifier[0] ?? '',
          rawValue: raw,
          numericValue: raw !== '' && Number.isFinite(numeric) ? numeric : null,
          unit: f[6] || null,
          abnormalFlag: f[8] || null,
          status: OBX_STATUS[f[11] ?? 'F'] ?? 'final',
        });
        break;
      }
      default:
        break;
    }
  }

  return out;
}
