'use client';

import { useCallback, useRef, useState } from 'react';
import clsx from 'clsx';
import { useI18n } from '@/lib/i18n';
import { NOTE_TEMPLATES, templateById, type SoapSections } from '@/lib/note-templates';

export type NoteType = 'soap' | 'progress' | 'nursing' | 'discharge';

const SECTIONS: Array<keyof SoapSections> = ['subjective', 'objective', 'assessment', 'plan'];

const SECTION_LABEL: Record<keyof SoapSections, string> = {
  subjective: 'clinical.soapSubjective',
  objective: 'clinical.soapObjective',
  assessment: 'clinical.soapAssessment',
  plan: 'clinical.soapPlan',
};

const NOTE_TYPES: NoteType[] = ['soap', 'progress', 'nursing', 'discharge'];

/**
 * Formatting is applied to the text itself rather than to markup.
 *
 * A clinical note is transmitted as FHIR narrative and printed into paper
 * records; anything that only survives as HTML in one database column is lost
 * the moment the note leaves this screen. Bullets and emphasis are therefore
 * plain characters, which every downstream reader renders identically.
 */
type Mark = 'bullet' | 'emphasis' | 'heading';

function applyMark(value: string, selectionStart: number, selectionEnd: number, mark: Mark): {
  text: string;
  caret: number;
} {
  const start = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const endIndex = value.indexOf('\n', selectionEnd);
  const end = endIndex === -1 ? value.length : endIndex;
  const block = value.slice(start, end);

  const transformed = block
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (mark === 'bullet') {
        return trimmed.startsWith('• ') ? line.replace('• ', '') : `• ${line}`;
      }
      if (mark === 'heading') {
        return trimmed.endsWith(':') || !trimmed ? line : `${line}:`;
      }
      if (!trimmed) return line;
      return trimmed.startsWith('*') && trimmed.endsWith('*')
        ? line.replace(/\*/g, '')
        : `*${line}*`;
    })
    .join('\n');

  const text = value.slice(0, start) + transformed + value.slice(end);
  return { text, caret: start + transformed.length };
}

function RichTextArea({
  id,
  value,
  onChange,
  disabled,
  label,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  label: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const mark = useCallback(
    (kind: Mark) => {
      const field = ref.current;
      if (!field) return;
      const { text, caret } = applyMark(field.value, field.selectionStart, field.selectionEnd, kind);
      onChange(text);
      requestAnimationFrame(() => {
        field.focus();
        field.setSelectionRange(caret, caret);
      });
    },
    [onChange],
  );

  return (
    <div>
      <div className="mb-1 flex items-center gap-1">
        <label htmlFor={id} className="label mb-0 flex-1">
          {label}
        </label>
        {(['bullet', 'heading', 'emphasis'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className="rounded border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            onClick={() => mark(kind)}
            disabled={disabled}
            aria-label={`${label} — ${kind}`}
            title={kind}
          >
            {kind === 'bullet' ? '• List' : kind === 'heading' ? 'Head' : 'Emph'}
          </button>
        ))}
      </div>
      <textarea
        id={id}
        ref={ref}
        className="input min-h-28 font-sans leading-relaxed"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function SoapEditor({
  value,
  onChange,
  noteType,
  onNoteTypeChange,
  onSave,
  saving,
  disabled,
  error,
  aiDrafted,
}: {
  value: SoapSections;
  onChange: (next: SoapSections) => void;
  noteType: NoteType;
  onNoteTypeChange: (next: NoteType) => void;
  onSave: () => void;
  saving: boolean;
  disabled?: boolean;
  error?: string | null;
  aiDrafted?: boolean;
}) {
  const { t } = useI18n();
  const [templateId, setTemplateId] = useState('blank');

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const template = templateById(id);
    if (!template) return;
    onNoteTypeChange(template.noteType);
    // Only empty sections are filled: a template must never overwrite what a
    // clinician — or the scribe — has already put in the note.
    onChange({
      subjective: value.subjective.trim() || template.sections.subjective,
      objective: value.objective.trim() || template.sections.objective,
      assessment: value.assessment.trim() || template.sections.assessment,
      plan: value.plan.trim() || template.sections.plan,
    });
  };

  const empty = SECTIONS.every((section) => !value[section].trim());

  return (
    <form
      className="card space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{t('clinical.clinicalNotes')}</h3>
        {aiDrafted && (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            {t('clinical.aiDraft')}
          </span>
        )}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="note-type">
            {t('clinical.noteType')}
          </label>
          <select
            id="note-type"
            className="input w-auto py-1 text-sm"
            value={noteType}
            onChange={(e) => onNoteTypeChange(e.target.value as NoteType)}
            disabled={disabled}
          >
            {NOTE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="note-template">
            {t('clinical.noteTemplate')}
          </label>
          <select
            id="note-template"
            className="input w-auto py-1 text-sm"
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value)}
            disabled={disabled}
          >
            {NOTE_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {SECTIONS.map((section) => (
        <RichTextArea
          key={section}
          id={`soap-${section}`}
          label={t(SECTION_LABEL[section])}
          value={value[section]}
          disabled={disabled}
          onChange={(next) => onChange({ ...value, [section]: next })}
        />
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn-primary" disabled={saving || disabled || empty}>
          {t('common.save')}
        </button>
        <button
          type="button"
          className={clsx('btn-secondary', empty && 'invisible')}
          onClick={() => onChange({ subjective: '', objective: '', assessment: '', plan: '' })}
          disabled={saving || disabled}
        >
          {t('common.cancel')}
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
