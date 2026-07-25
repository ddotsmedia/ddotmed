'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_LOCALE,
  LOCALE_META,
  LOCALES,
  createTranslator,
  dirOf,
  formatDate,
  formatMoney,
  isLocale,
  type Locale,
  type TranslationKey,
} from '@medicore/i18n';

interface I18nValue {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey | string, params?: Record<string, string | number>) => string;
  money: (minor: number, currency: string) => string;
  date: (value: string | Date, withTime?: boolean) => string;
  locales: readonly Locale[];
}

const I18nContext = createContext<I18nValue | null>(null);
const STORAGE_KEY = 'medicore.locale';

export function I18nProvider({
  children,
  initialLocale = DEFAULT_LOCALE,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isLocale(stored)) setLocaleState(stored);
  }, []);

  // Writing dir on <html> is what makes CSS logical properties flip for Arabic.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dirOf(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem(STORAGE_KEY, next);
    setLocaleState(next);
  }, []);

  const value = useMemo<I18nValue>(() => {
    const t = createTranslator(locale);
    return {
      locale,
      dir: dirOf(locale),
      setLocale,
      t,
      money: (minor, currency) => formatMoney(minor, currency, locale),
      date: (v, withTime = false) => formatDate(v, locale, withTime),
      locales: LOCALES,
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}

/** Convenience hook for components that only need the translator. */
export function useT() {
  return useI18n().t;
}

export { LOCALE_META };
export type { Locale };
