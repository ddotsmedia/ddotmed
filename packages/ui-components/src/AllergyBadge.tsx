import clsx from 'clsx';
import type { Allergy } from '@medicore/shared-types';

export interface AllergyBadgeProps {
  allergy: Pick<Allergy, 'id' | 'code' | 'criticality' | 'category' | 'reaction'>;
  t: (key: string) => string;
  onClick?: () => void;
  className?: string;
}

const STYLES: Record<Allergy['criticality'], string> = {
  high: 'bg-red-600 text-white border-red-700',
  low: 'bg-amber-100 text-amber-900 border-amber-400',
  'unable-to-assess': 'bg-slate-200 text-slate-800 border-slate-400',
};

export function AllergyBadge({ allergy, t, onClick, className }: AllergyBadgeProps) {
  const label = allergy.code.display ?? allergy.code.code;
  const critical = allergy.criticality === 'high';
  return (
    <button
      type="button"
      onClick={onClick}
      // Colour alone must not carry the severity; the ⚠ glyph and the label do too.
      aria-label={`${critical ? t('clinical.allergyHigh') : t('clinical.allergyLow')}: ${label}`}
      title={allergy.reaction.join(', ') || label}
      className={clsx(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-semibold',
        STYLES[allergy.criticality],
        onClick && 'cursor-pointer hover:opacity-90',
        className,
      )}
      data-testid="allergy-badge"
      data-criticality={allergy.criticality}
    >
      {critical && <span aria-hidden>⚠</span>}
      <span className="max-w-[12rem] truncate">{label}</span>
    </button>
  );
}
