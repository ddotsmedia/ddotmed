import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface HieSubmitResult {
  accepted: boolean;
  hie: string;
  reference: string | null;
  message: string;
}

export interface IHieAdapter {
  readonly name: string;
  readonly countryPack: string;
  /** True only when the deployment has real credentials configured. */
  isConfigured(): boolean;
  submitDocument(patientIdentifier: string, bundle: Record<string, unknown>): Promise<HieSubmitResult>;
  fetchPatientRecord(patientIdentifier: string): Promise<Record<string, unknown> | null>;
}

/**
 * Base for national health-information-exchange connectors.
 * Each is a stub: the message shape and endpoints are modelled, but no adapter
 * transmits PHI until its credentials and onboarding are configured. Calling an
 * unconfigured adapter throws rather than silently no-ops.
 */
abstract class BaseHieAdapter implements IHieAdapter {
  protected readonly logger = new Logger(this.constructor.name);
  abstract readonly name: string;
  abstract readonly countryPack: string;
  protected abstract readonly envPrefix: string;

  constructor(protected readonly config: ConfigService) {}

  protected get baseUrl(): string | undefined {
    return this.config.get<string>(`${this.envPrefix}_BASE_URL`);
  }

  protected get clientId(): string | undefined {
    return this.config.get<string>(`${this.envPrefix}_CLIENT_ID`);
  }

  protected get clientSecret(): string | undefined {
    return this.config.get<string>(`${this.envPrefix}_CLIENT_SECRET`);
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.clientId && this.clientSecret);
  }

  protected assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new NotImplementedException(
        `${this.name} is not configured. Set ${this.envPrefix}_BASE_URL, ${this.envPrefix}_CLIENT_ID and ${this.envPrefix}_CLIENT_SECRET, and complete ${this.name} onboarding, before exchanging patient data.`,
      );
    }
  }

  abstract submitDocument(
    patientIdentifier: string,
    bundle: Record<string, unknown>,
  ): Promise<HieSubmitResult>;

  abstract fetchPatientRecord(patientIdentifier: string): Promise<Record<string, unknown> | null>;
}

/** UAE — Malaffi (Abu Dhabi HIE). FHIR R4 over mutual TLS. */
@Injectable()
export class MalaffiAdapter extends BaseHieAdapter {
  readonly name = 'Malaffi';
  readonly countryPack = 'uae';
  protected readonly envPrefix = 'MALAFFI';

  async submitDocument(patientIdentifier: string, bundle: Record<string, unknown>) {
    this.assertConfigured();
    const res = await fetch(`${this.baseUrl}/Bundle`, {
      method: 'POST',
      headers: {
        'content-type': 'application/fhir+json',
        'x-malaffi-facility': this.config.get<string>('MALAFFI_FACILITY_ID') ?? '',
      },
      body: JSON.stringify({ ...bundle, meta: { source: `urn:medicore:emirates-id:${patientIdentifier}` } }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return {
      accepted: res.ok,
      hie: this.name,
      reference: body.id ?? null,
      message: res.ok ? 'Submitted to Malaffi' : `Malaffi rejected the bundle (${res.status})`,
    };
  }

  async fetchPatientRecord(patientIdentifier: string) {
    this.assertConfigured();
    const res = await fetch(
      `${this.baseUrl}/Patient?identifier=urn:ae:emirates-id|${encodeURIComponent(patientIdentifier)}&_revinclude=*`,
      { headers: { accept: 'application/fhir+json' }, signal: AbortSignal.timeout(20_000) },
    );
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  }
}

/** India — ABDM (Ayushman Bharat Digital Mission). Consent-gated via the HIU flow. */
@Injectable()
export class AbdmAdapter extends BaseHieAdapter {
  readonly name = 'ABDM';
  readonly countryPack = 'india';
  protected readonly envPrefix = 'ABDM';

  async submitDocument(patientIdentifier: string, bundle: Record<string, unknown>) {
    this.assertConfigured();
    const res = await fetch(`${this.baseUrl}/v0.5/health-information/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-HIP-ID': this.config.get<string>('ABDM_HIP_ID') ?? '',
      },
      body: JSON.stringify({ abhaAddress: patientIdentifier, entries: [bundle] }),
      signal: AbortSignal.timeout(20_000),
    });
    return {
      accepted: res.ok,
      hie: this.name,
      reference: res.headers.get('x-request-id'),
      message: res.ok ? 'Notified ABDM gateway' : `ABDM rejected the notification (${res.status})`,
    };
  }

  async fetchPatientRecord(patientIdentifier: string) {
    this.assertConfigured();
    // ABDM requires an approved consent artefact before any record may be fetched.
    const consentId = this.config.get<string>('ABDM_CONSENT_ARTEFACT_ID');
    if (!consentId) {
      throw new NotImplementedException(
        'ABDM record retrieval requires an approved consent artefact (ABDM_CONSENT_ARTEFACT_ID)',
      );
    }
    const res = await fetch(`${this.baseUrl}/v0.5/health-information/cm/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ consent: { id: consentId }, abhaAddress: patientIdentifier }),
      signal: AbortSignal.timeout(20_000),
    });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  }
}

/** Saudi Arabia — Nphies (claims and clinical exchange). */
@Injectable()
export class NphiesAdapter extends BaseHieAdapter {
  readonly name = 'Nphies';
  readonly countryPack = 'saudi';
  protected readonly envPrefix = 'NPHIES';

  async submitDocument(patientIdentifier: string, bundle: Record<string, unknown>) {
    this.assertConfigured();
    const res = await fetch(`${this.baseUrl}/$process-message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/fhir+json',
        'x-nphies-license': this.config.get<string>('NPHIES_PROVIDER_LICENSE') ?? '',
      },
      body: JSON.stringify(bundle),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return {
      accepted: res.ok,
      hie: this.name,
      reference: body.id ?? null,
      message: res.ok ? 'Submitted to Nphies' : `Nphies rejected the message (${res.status})`,
    };
  }

  async fetchPatientRecord(patientIdentifier: string) {
    this.assertConfigured();
    const res = await fetch(
      `${this.baseUrl}/Patient?identifier=http://nphies.sa/identifier/nationalid|${encodeURIComponent(patientIdentifier)}`,
      { headers: { accept: 'application/fhir+json' }, signal: AbortSignal.timeout(20_000) },
    );
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  }
}

@Injectable()
export class HieRegistry {
  private readonly adapters: IHieAdapter[];

  constructor(malaffi: MalaffiAdapter, abdm: AbdmAdapter, nphies: NphiesAdapter) {
    this.adapters = [malaffi, abdm, nphies];
  }

  forCountryPack(countryPack: string): IHieAdapter | null {
    return this.adapters.find((a) => a.countryPack === countryPack) ?? null;
  }

  status(): Array<{ name: string; country_pack: string; configured: boolean }> {
    return this.adapters.map((a) => ({
      name: a.name,
      country_pack: a.countryPack,
      configured: a.isConfigured(),
    }));
  }
}
