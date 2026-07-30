'use client';

import clsx from 'clsx';

export interface TrendPoint {
  value: number | null;
  is_critical: boolean;
  interpretation: string | null;
}

/**
 * Inline sparkline for a lab trend.
 *
 * Scaled to the series, not to the reference range: a creatinine drifting from
 * 0.9 to 1.2 is entirely inside its range and is exactly what a clinician needs
 * to see. The reference band is drawn behind it for context when it is known.
 */
export function Sparkline({
  points,
  referenceLow,
  referenceHigh,
  className,
}: {
  points: readonly TrendPoint[];
  referenceLow?: number | null;
  referenceHigh?: number | null;
  className?: string;
}) {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (values.length === 0) {
    return <span className="text-xs text-slate-400">—</span>;
  }

  const width = 80;
  const height = 24;
  const pad = 2;

  const min = Math.min(...values, referenceLow ?? Number.POSITIVE_INFINITY);
  const max = Math.max(...values, referenceHigh ?? Number.NEGATIVE_INFINITY);
  const span = max - min || 1;

  const y = (value: number) => height - pad - ((value - min) / span) * (height - pad * 2);
  const x = (index: number) =>
    values.length === 1 ? width / 2 : pad + (index / (values.length - 1)) * (width - pad * 2);

  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const bandTop = referenceHigh != null ? y(referenceHigh) : null;
  const bandBottom = referenceLow != null ? y(referenceLow) : null;
  const latest = points[points.length - 1];
  const latestValue = values[values.length - 1]!;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={clsx('shrink-0', className)}
      role="img"
      aria-label={`Trend of ${values.length} values, latest ${latestValue}`}
    >
      {bandTop != null && bandBottom != null && (
        <rect
          x={0}
          y={Math.min(bandTop, bandBottom)}
          width={width}
          height={Math.abs(bandBottom - bandTop)}
          className="fill-emerald-500/10"
        />
      )}
      <path
        d={path}
        fill="none"
        strokeWidth={1.5}
        className={clsx(
          latest?.is_critical
            ? 'stroke-red-600'
            : latest?.interpretation && latest.interpretation !== 'N'
              ? 'stroke-amber-500'
              : 'stroke-sky-500',
        )}
      />
      <circle
        cx={x(values.length - 1)}
        cy={y(latestValue)}
        r={2}
        className={clsx(
          latest?.is_critical
            ? 'fill-red-600'
            : latest?.interpretation && latest.interpretation !== 'N'
              ? 'fill-amber-500'
              : 'fill-sky-500',
        )}
      />
    </svg>
  );
}

const TONE: Record<string, string> = {
  HH: 'bg-red-600 text-white',
  LL: 'bg-red-600 text-white',
  H: 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200',
  L: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200',
  N: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

/** H in red, L in blue, HH/LL solid — the convention on every printed report. */
export function ResultFlag({ interpretation }: { interpretation: string | null }) {
  if (!interpretation) return null;
  return (
    <span
      className={clsx(
        'inline-block rounded px-1.5 py-0.5 text-xs font-bold tabular-nums',
        TONE[interpretation] ?? TONE.N,
      )}
    >
      {interpretation}
    </span>
  );
}
