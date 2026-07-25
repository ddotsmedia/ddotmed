import { en } from './locales/en.js';
import { ar } from './locales/ar.js';
import { hi } from './locales/hi.js';
import { fr } from './locales/fr.js';
import { es } from './locales/es.js';
import { zh } from './locales/zh.js';
import type { Locale, Namespace, Translation, TranslationKey } from './types.js';

export type { Locale, Namespace, Translation, TranslationKey };

export const translations: Record<Locale, Translation> = { en, ar, hi, fr, es, zh };

export const LOCALES: readonly Locale[] = ['en', 'ar', 'hi', 'fr', 'es', 'zh'] as const;
export const DEFAULT_LOCALE: Locale = 'en';
export const RTL_LOCALES: readonly Locale[] = ['ar'] as const;

export const LOCALE_META: Record<Locale, { label: string; dir: 'ltr' | 'rtl'; intl: string }> = {
  en: { label: 'English', dir: 'ltr', intl: 'en-GB' },
  ar: { label: 'العربية', dir: 'rtl', intl: 'ar-AE' },
  hi: { label: 'हिन्दी', dir: 'ltr', intl: 'hi-IN' },
  fr: { label: 'Français', dir: 'ltr', intl: 'fr-FR' },
  es: { label: 'Español', dir: 'ltr', intl: 'es-ES' },
  zh: { label: '中文', dir: 'ltr', intl: 'zh-CN' },
};

export const isRtl = (locale: Locale): boolean => RTL_LOCALES.includes(locale);
export const dirOf = (locale: Locale): 'ltr' | 'rtl' => LOCALE_META[locale].dir;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Resolves `namespace.key`, falling back to English then to the key itself. */
export function translate(
  locale: Locale,
  key: TranslationKey | string,
  params?: Record<string, string | number>,
): string {
  const [ns, ...rest] = key.split('.');
  const leaf = rest.join('.');
  const bundle = translations[locale] ?? translations[DEFAULT_LOCALE];
  const table = (bundle as Record<string, Record<string, string>>)[ns ?? ''];
  const fallback = (translations[DEFAULT_LOCALE] as unknown as Record<string, Record<string, string>>)[
    ns ?? ''
  ];
  const raw = table?.[leaf] ?? fallback?.[leaf] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, p: string) => String(params[p] ?? m));
}

export function createTranslator(locale: Locale) {
  return (key: TranslationKey | string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
}

export function formatMoney(minor: number, currency: string, locale: Locale): string {
  const zeroDecimal = ['JPY', 'KRW', 'VND', 'XOF', 'XAF', 'UGX', 'RWF'];
  const digits = zeroDecimal.includes(currency) ? 0 : 2;
  return new Intl.NumberFormat(LOCALE_META[locale].intl, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
  }).format(minor / 10 ** digits);
}

export function formatDate(value: string | Date, locale: Locale, withTime = false): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(LOCALE_META[locale].intl, {
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' as const } : {}),
  }).format(d);
}
