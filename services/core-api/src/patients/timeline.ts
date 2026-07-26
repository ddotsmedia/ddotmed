/**
 * Timeline assembly.
 *
 * Each clinical domain is queried on its own index and the results are merged
 * here rather than in SQL, because the domains have no common table to join on
 * and a UNION over eight differently-shaped tables is both slower and harder to
 * evolve than merging typed rows in memory.
 */

export type TimelineType =
  | 'encounter'
  | 'condition'
  | 'medication'
  | 'lab'
  | 'imaging'
  | 'note'
  | 'vitals'
  | 'appointment'
  | 'admission';

export interface TimelineEntry {
  id: string;
  type: TimelineType;
  at: Date;
  title: string;
  detail: string | null;
  /** Drives colour and iconography in the UI; never the only signal. */
  severity: 'normal' | 'warning' | 'critical';
  encounter_id: string | null;
  data: Record<string, unknown>;
}

/** Deterministic ordering: newest first, then a stable tiebreak. */
export function sortTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  return [...entries].sort((a, b) => {
    const delta = b.at.getTime() - a.at.getTime();
    if (delta !== 0) return delta;
    // Same instant: order by type then id so pagination never repeats or skips.
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.id.localeCompare(b.id);
  });
}

/** Groups a sorted timeline by calendar day for the UI's date separators. */
export function groupByDay(entries: TimelineEntry[]): Array<{ day: string; entries: TimelineEntry[] }> {
  const groups = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const day = entry.at.toISOString().slice(0, 10);
    const bucket = groups.get(day);
    if (bucket) bucket.push(entry);
    else groups.set(day, [entry]);
  }
  return [...groups.entries()].map(([day, dayEntries]) => ({ day, entries: dayEntries }));
}

export interface TimelineFilter {
  types?: TimelineType[];
  from?: Date;
  to?: Date;
}

export function filterTimeline(entries: TimelineEntry[], filter: TimelineFilter): TimelineEntry[] {
  const types = filter.types?.length ? new Set(filter.types) : null;
  return entries.filter((entry) => {
    if (types && !types.has(entry.type)) return false;
    if (filter.from && entry.at < filter.from) return false;
    if (filter.to && entry.at > filter.to) return false;
    return true;
  });
}
