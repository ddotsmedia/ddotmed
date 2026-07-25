import type { en } from './locales/en.js';

export type Namespace = keyof typeof en;

/** Every locale must supply every key present in `en`. */
export type Translation = { [N in Namespace]: { [K in keyof (typeof en)[N]]: string } };

export type Locale = 'en' | 'ar' | 'hi' | 'fr' | 'es' | 'zh';

export type TranslationKey = {
  [N in Namespace]: `${N}.${Extract<keyof (typeof en)[N], string>}`;
}[Namespace];
