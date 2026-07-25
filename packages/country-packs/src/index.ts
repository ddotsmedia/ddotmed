import type { CountryCode } from '@medicore/shared-types';
import type { ICountryPack } from './types.js';
import { uaePack } from './packs/uae.js';
import { saudiPack } from './packs/saudi.js';
import { indiaPack } from './packs/india.js';
import { usaPack } from './packs/usa.js';
import { euPack } from './packs/eu.js';
import { ukPack } from './packs/uk.js';
import { africaPack } from './packs/africa.js';

export * from './types.js';
export { amountInWords, formatMinor, luhn, verhoeff } from './shared.js';

export const COUNTRY_PACKS: Record<CountryCode, ICountryPack> = {
  uae: uaePack,
  saudi: saudiPack,
  india: indiaPack,
  usa: usaPack,
  eu: euPack,
  uk: ukPack,
  africa: africaPack,
};

export function getCountryPack(code: string): ICountryPack {
  const pack = COUNTRY_PACKS[code as CountryCode];
  if (!pack) throw new Error(`Unknown country pack: ${code}`);
  return pack;
}

/** Resolves the pack that owns an ISO-3166 alpha-2 country, defaulting to the EU pack. */
export function packForCountry(iso: string): ICountryPack {
  const upper = iso.toUpperCase();
  return Object.values(COUNTRY_PACKS).find((p) => p.isoCountries.includes(upper)) ?? euPack;
}

export { uaePack, saudiPack, indiaPack, usaPack, euPack, ukPack, africaPack };
