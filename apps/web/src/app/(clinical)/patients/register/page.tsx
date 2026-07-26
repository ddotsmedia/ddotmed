'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { PageHeader, Field } from '@/components/ui';
import { PhotoCapture } from './PhotoCapture';
import { DuplicatePrompt } from './DuplicatePrompt';
import {
  ID_TYPE_HINTS,
  STEP_FIELDS,
  STEP_LABELS,
  emptyRegistration,
  registrationSchema,
  type DuplicateCandidate,
  type RegistrationValues,
} from './registration-schema';

interface RegistrationSchemaResponse {
  code: string;
  display_name: string;
  id_types: string[];
  required_fields: Array<{ field: string; label: string; required: boolean; note?: string }>;
}

interface PayerOption {
  id: string;
  name: string;
  code: string;
}

type FieldErrors = Record<string, string>;

export default function RegisterPatientPage() {
  const router = useRouter();
  const { t } = useI18n();

  const [step, setStep] = useState(0);
  const [values, setValues] = useState<RegistrationValues>(emptyRegistration);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);


  const schema = useQuery<RegistrationSchemaResponse>({
    queryKey: ['patients', 'registration-schema'],
    queryFn: () => api.get<RegistrationSchemaResponse>('/patients/registration-schema/uae'),
    staleTime: 60 * 60_000,
  });

  const payers = useQuery<PayerOption[]>({
    queryKey: ['payers'],
    queryFn: () => api.get<PayerOption[]>('/insurance/payers'),
    retry: false,
    staleTime: 60 * 60_000,
  });

  const idTypes = schema.data?.id_types ?? ['passport', 'mrn'];

  const set = <K extends keyof RegistrationValues>(key: K, value: RegistrationValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => {
      const { [key as string]: _dropped, ...rest } = e;
      return rest;
    });
  };

  /** Validates only the current step, so the user is not blocked by later fields. */
  const validateStep = (index: number): boolean => {
    const result = registrationSchema.safeParse(values);
    if (result.success) return true;

    const stepKeys = new Set(STEP_FIELDS[index]?.map(String) ?? []);
    const next: FieldErrors = {};
    for (const issue of result.error.issues) {
      const root = String(issue.path[0] ?? '');
      if (stepKeys.has(root)) next[issue.path.join('.')] = issue.message;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = useMutation<{ id: string; mrn: string }, Error, boolean>({
    mutationFn: async (force) => {
      const payload = registrationSchema.parse({ ...values, force_create: force });
      return api.post<{ id: string; mrn: string }>('/patients', {
        ...payload,
        nationality: payload.nationality || undefined,
        insurance: payload.insurance
          ? { ...payload.insurance, ends_at: payload.insurance.ends_at || undefined }
          : undefined,
      });
    },
    onSuccess: (patient) => {
      setDuplicates(null);
      router.push(`/patients/${patient.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        const body = error.body as { code?: string; candidates?: DuplicateCandidate[] };
        if (body.code === 'DUPLICATE_PATIENT' && body.candidates) {
          setDuplicates(body.candidates);
          return;
        }
      }
      // A country-pack identifier rejection comes back as a 400 naming the field.
      if (error instanceof ApiError && error.status === 400) {
        setErrors({ identifiers: error.message });
        setStep(1);
      }
    },
  });

  const isLastStep = step === STEP_LABELS.length - 1;
  const progress = useMemo(() => ((step + 1) / STEP_LABELS.length) * 100, [step]);

  return (
    <>
      <PageHeader title="Register patient" subtitle={schema.data?.display_name} />

      {/* Mobile-first: a compact progress bar rather than a wide stepper. */}
      <div className="mb-4">
        <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
          <span className="font-medium">{STEP_LABELS[step]}</span>
          <span>
            {step + 1}/{STEP_LABELS.length}
          </span>
        </div>
        <div className="mt-1 h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-700">
          <div
            className="h-1.5 rounded-full bg-sky-600 transition-[width]"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <form
        className="card space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!validateStep(step)) return;
          if (isLastStep) submit.mutate(false);
          else setStep((s) => s + 1);
        }}
      >
        {step === 0 && (
          <>
            <Field label="Given name(s)" required error={errors['given_names.0'] ?? errors.given_names}>
              {values.given_names.map((name, index) => (
                <input
                  key={index}
                  className="input mb-2"
                  value={name}
                  autoComplete="given-name"
                  onChange={(e) => {
                    const next = [...values.given_names];
                    next[index] = e.target.value;
                    set('given_names', next);
                  }}
                />
              ))}
              {values.given_names.length < 4 && (
                <button
                  type="button"
                  className="text-xs text-sky-700 underline"
                  onClick={() => set('given_names', [...values.given_names, ''])}
                >
                  + middle name
                </button>
              )}
            </Field>

            <Field label="Family name" required error={errors.family_name}>
              <input
                className="input"
                value={values.family_name}
                autoComplete="family-name"
                onChange={(e) => set('family_name', e.target.value)}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label={t('clinical.gender')} required error={errors.gender}>
                <select
                  className="input"
                  value={values.gender}
                  onChange={(e) => set('gender', e.target.value as RegistrationValues['gender'])}
                >
                  <option value="unknown">—</option>
                  <option value="male">{t('clinical.male')}</option>
                  <option value="female">{t('clinical.female')}</option>
                  <option value="other">{t('clinical.other')}</option>
                </select>
              </Field>

              <Field label={t('clinical.dob')} required error={errors.birth_date}>
                <input
                  className="input"
                  type="date"
                  value={values.birth_date}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => set('birth_date', e.target.value)}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Nationality" error={errors.nationality}>
                <input
                  className="input uppercase"
                  maxLength={2}
                  placeholder="AE"
                  value={values.nationality ?? ''}
                  onChange={(e) => set('nationality', e.target.value.toUpperCase())}
                />
              </Field>
              <Field label="Blood group">
                <select
                  className="input"
                  value={values.blood_group ?? ''}
                  onChange={(e) =>
                    set('blood_group', (e.target.value || undefined) as RegistrationValues['blood_group'])
                  }
                >
                  <option value="">—</option>
                  {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label={t('common.language')}>
              <select
                className="input"
                value={values.preferred_language}
                onChange={(e) => set('preferred_language', e.target.value)}
              >
                {['en', 'ar', 'hi', 'fr', 'es', 'zh'].map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values.is_vip}
                onChange={(e) => set('is_vip', e.target.checked)}
              />
              VIP
            </label>
          </>
        )}

        {step === 1 && (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Identifiers are checksum-validated against the {schema.data?.display_name ?? 'country'}{' '}
              rules on save.
            </p>
            {errors.identifiers && (
              <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                {errors.identifiers}
              </p>
            )}

            {values.identifiers.map((identifier, index) => {
              const hint = ID_TYPE_HINTS[identifier.type];
              return (
                <div key={index} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Type" required>
                      <select
                        className="input"
                        value={identifier.type}
                        onChange={(e) => {
                          const next = [...values.identifiers];
                          next[index] = { ...identifier, type: e.target.value };
                          set('identifiers', next);
                        }}
                      >
                        <option value="">—</option>
                        {idTypes.map((type) => (
                          <option key={type} value={type}>
                            {ID_TYPE_HINTS[type]?.label ?? type}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field
                      label="Number"
                      required
                      error={errors[`identifiers.${index}.value`]}
                    >
                      <input
                        className="input font-mono"
                        inputMode="text"
                        placeholder={hint?.placeholder}
                        value={identifier.value}
                        onChange={(e) => {
                          const next = [...values.identifiers];
                          next[index] = { ...identifier, value: e.target.value };
                          set('identifiers', next);
                        }}
                      />
                    </Field>
                  </div>
                  {hint?.help && <p className="mt-1 text-xs text-slate-500">{hint.help}</p>}
                  <button
                    type="button"
                    className="mt-2 text-xs text-red-700 underline"
                    onClick={() =>
                      set(
                        'identifiers',
                        values.identifiers.filter((_, i) => i !== index),
                      )
                    }
                  >
                    {t('common.delete')}
                  </button>
                </div>
              );
            })}

            <button
              type="button"
              className="btn-secondary w-full"
              onClick={() =>
                set('identifiers', [
                  ...values.identifiers,
                  { type: '', value: '', is_primary: values.identifiers.length === 0 },
                ])
              }
            >
              + Add identifier
            </button>
          </>
        )}

        {step === 2 && (
          <>
            {values.contacts.map((contact, index) => (
              <div key={index} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Relationship" required>
                    <input
                      className="input"
                      placeholder="self, spouse, parent…"
                      value={contact.relationship}
                      onChange={(e) => {
                        const next = [...values.contacts];
                        next[index] = { ...contact, relationship: e.target.value };
                        set('contacts', next);
                      }}
                    />
                  </Field>
                  <Field label="Type" required>
                    <select
                      className="input"
                      value={contact.system}
                      onChange={(e) => {
                        const next = [...values.contacts];
                        next[index] = {
                          ...contact,
                          system: e.target.value as 'phone' | 'email' | 'sms',
                        };
                        set('contacts', next);
                      }}
                    >
                      <option value="phone">Phone</option>
                      <option value="sms">SMS</option>
                      <option value="email">Email</option>
                    </select>
                  </Field>
                </div>

                <Field label="Value" required error={errors[`contacts.${index}.value`]}>
                  <input
                    className="input"
                    inputMode={contact.system === 'email' ? 'email' : 'tel'}
                    placeholder={contact.system === 'email' ? 'name@example.com' : '+971 50 123 4567'}
                    value={contact.value}
                    onChange={(e) => {
                      const next = [...values.contacts];
                      next[index] = { ...contact, value: e.target.value };
                      set('contacts', next);
                    }}
                  />
                </Field>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={contact.is_emergency}
                    onChange={(e) => {
                      const next = [...values.contacts];
                      next[index] = { ...contact, is_emergency: e.target.checked };
                      set('contacts', next);
                    }}
                  />
                  Emergency contact
                </label>

                <button
                  type="button"
                  className="mt-2 text-xs text-red-700 underline"
                  onClick={() =>
                    set(
                      'contacts',
                      values.contacts.filter((_, i) => i !== index),
                    )
                  }
                >
                  {t('common.delete')}
                </button>
              </div>
            ))}

            <button
              type="button"
              className="btn-secondary w-full"
              onClick={() =>
                set('contacts', [
                  ...values.contacts,
                  {
                    relationship: values.contacts.length === 0 ? 'self' : 'next-of-kin',
                    given_names: [],
                    system: 'phone',
                    value: '',
                    use: 'mobile',
                    is_emergency: values.contacts.length > 0,
                    is_primary: values.contacts.length === 0,
                  },
                ])
              }
            >
              + Add contact
            </button>
          </>
        )}

        {step === 3 && (
          <>
            {!values.insurance ? (
              <div className="space-y-3">
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  Self-paying, or add insurance now.
                </p>
                <button
                  type="button"
                  className="btn-secondary w-full"
                  onClick={() =>
                    set('insurance', {
                      payer_id: '',
                      member_id: '',
                      policy_number: '',
                      relationship: 'self',
                      starts_at: new Date().toISOString().slice(0, 10),
                    })
                  }
                >
                  + Add insurance
                </button>
              </div>
            ) : (
              <>
                <Field label={t('billing.payer')} required error={errors['insurance.payer_id']}>
                  <select
                    className="input"
                    value={values.insurance.payer_id}
                    onChange={(e) =>
                      set('insurance', { ...values.insurance!, payer_id: e.target.value })
                    }
                  >
                    <option value="">—</option>
                    {(payers.data ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {payers.isError && (
                    <span className="mt-1 block text-xs text-amber-700">
                      Payer list unavailable — insurance can be added later from the patient profile.
                    </span>
                  )}
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Member ID" required error={errors['insurance.member_id']}>
                    <input
                      className="input font-mono"
                      value={values.insurance.member_id}
                      onChange={(e) =>
                        set('insurance', { ...values.insurance!, member_id: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Policy number" required error={errors['insurance.policy_number']}>
                    <input
                      className="input font-mono"
                      value={values.insurance.policy_number}
                      onChange={(e) =>
                        set('insurance', { ...values.insurance!, policy_number: e.target.value })
                      }
                    />
                  </Field>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Valid from" required error={errors['insurance.starts_at']}>
                    <input
                      className="input"
                      type="date"
                      value={values.insurance.starts_at}
                      onChange={(e) =>
                        set('insurance', { ...values.insurance!, starts_at: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Valid to">
                    <input
                      className="input"
                      type="date"
                      value={values.insurance.ends_at ?? ''}
                      onChange={(e) =>
                        set('insurance', { ...values.insurance!, ends_at: e.target.value })
                      }
                    />
                  </Field>
                </div>

                <button
                  type="button"
                  className="text-xs text-red-700 underline"
                  onClick={() => set('insurance', null)}
                >
                  Remove insurance
                </button>
              </>
            )}
          </>
        )}

        {step === 4 && (
          <>
            <PhotoCapture
              value={values.photo_url}
              onChange={(url) => set('photo_url', url)}
              label="Patient photo (optional)"
            />

            <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800">
              <h3 className="font-semibold">Review</h3>
              <dl className="mt-2 space-y-1 text-xs">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Name</dt>
                  <dd className="font-medium">
                    {values.given_names.filter(Boolean).join(' ')} {values.family_name}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">{t('clinical.dob')}</dt>
                  <dd>{values.birth_date || '—'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Identifiers</dt>
                  <dd>{values.identifiers.length}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Contacts</dt>
                  <dd>{values.contacts.length}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">{t('billing.insurance')}</dt>
                  <dd>{values.insurance ? 'Yes' : 'Self-pay'}</dd>
                </div>
              </dl>
            </div>
          </>
        )}

        {submit.isError && !duplicates && (
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            {submit.error.message}
          </p>
        )}

        {/* Sticky action bar keeps the primary action reachable one-handed. */}
        <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
          {step > 0 && (
            <button type="button" className="btn-secondary flex-1" onClick={() => setStep((s) => s - 1)}>
              {t('common.back')}
            </button>
          )}
          <button type="submit" className="btn-primary flex-1" disabled={submit.isPending}>
            {submit.isPending ? t('common.loading') : isLastStep ? t('common.submit') : t('common.next')}
          </button>
        </div>
      </form>

      {duplicates && (
        <DuplicatePrompt
          candidates={duplicates}
          isSubmitting={submit.isPending}
          onCancel={() => setDuplicates(null)}
          onCreateAnyway={() => submit.mutate(true)}
        />
      )}
    </>
  );
}
