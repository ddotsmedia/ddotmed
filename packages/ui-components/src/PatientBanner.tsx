import clsx from 'clsx';
import type { Allergy, Patient } from '@medicore/shared-types';
import { AllergyBadge } from './AllergyBadge.js';

export interface PatientBannerProps {
  patient: Pick<Patient, 'id' | 'mrn' | 'name' | 'gender' | 'birth_date' | 'blood_group' | 'is_vip'>;
  allergies?: Allergy[];
  encounterLabel?: string;
  bedLabel?: string;
  t: (key: string) => string;
  onSelectAllergies?: () => void;
  className?: string;
}

export function ageFrom(birthDate: string, now = new Date()): number {
  const dob = new Date(birthDate);
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

/**
 * Sticky identity strip shown above every clinical screen. Allergies are always
 * rendered — silence here would read as "no allergies" to a clinician.
 */
export function PatientBanner({
  patient,
  allergies = [],
  encounterLabel,
  bedLabel,
  t,
  onSelectAllergies,
  className,
}: PatientBannerProps) {
  const active = allergies.filter((a) => a.clinical_status === 'active');
  const fullName = patient.name.text ?? `${patient.name.given.join(' ')} ${patient.name.family}`;

  return (
    <header
      className={clsx(
        'sticky top-0 z-30 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-4 py-2 shadow-sm dark:border-slate-700 dark:bg-slate-900',
        className,
      )}
      data-testid="patient-banner"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-base font-semibold text-slate-900 dark:text-slate-50">
            {fullName}
          </h2>
          {patient.is_vip && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
              VIP
            </span>
          )}
        </div>
        <dl className="flex flex-wrap gap-x-3 text-xs text-slate-600 dark:text-slate-300">
          <div className="flex gap-1">
            <dt>{t('clinical.mrn')}:</dt>
            <dd className="font-mono font-medium">{patient.mrn}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t('clinical.age')}:</dt>
            <dd>{ageFrom(patient.birth_date)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t('clinical.gender')}:</dt>
            <dd>{t(`clinical.${patient.gender}`)}</dd>
          </div>
          {patient.blood_group && patient.blood_group !== 'unknown' && (
            <dd className="font-medium text-rose-700 dark:text-rose-400">{patient.blood_group}</dd>
          )}
          {encounterLabel && <dd>{encounterLabel}</dd>}
          {bedLabel && <dd>{bedLabel}</dd>}
        </dl>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {active.length === 0 ? (
          <span className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 dark:border-slate-600 dark:text-slate-300">
            {t('clinical.noKnownAllergies')}
          </span>
        ) : (
          active
            .slice(0, 4)
            .map((a) => <AllergyBadge key={a.id} allergy={a} t={t} onClick={onSelectAllergies} />)
        )}
        {active.length > 4 && (
          <button
            type="button"
            onClick={onSelectAllergies}
            className="text-xs font-medium text-sky-700 underline dark:text-sky-400"
          >
            +{active.length - 4}
          </button>
        )}
      </div>
    </header>
  );
}
