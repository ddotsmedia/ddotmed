# MediCore HMS

An international hospital management platform: EHR, revenue cycle, pharmacy, lab,
imaging, beds/ADT, rostering and clinical AI — deployable in the UAE, Saudi Arabia,
India, the USA, the EU, the UK and pan-African markets from one codebase.

---

## Architecture

```
                            ┌──────────────┐
   browser / desktop ──────▶│    nginx     │  80/443, TLS, rate limits, HSTS/CSP
   mobile (Flutter)  ──────▶└──────┬───────┘
                                   │  internal medicore-network (nothing else is published)
        ┌──────────────┬───────────┼───────────┬──────────────┐
        ▼              ▼           ▼           ▼              ▼
   ┌─────────┐   ┌──────────┐  ┌────────┐  ┌──────────┐  ┌─────────┐
   │  web    │   │ core-api │  │   ai   │  │hapi-fhir │  │  minio  │
   │ Next 15 │   │ NestJS11 │  │FastAPI │  │   R4     │  │ objects │
   └─────────┘   └────┬─────┘  └───┬────┘  └────┬─────┘  └─────────┘
                      │            │            │
              ┌───────┴───┬────────┴───┐        │
              ▼           ▼            ▼        │
        ┌──────────┐ ┌────────┐  ┌──────────┐   │
        │ postgres │ │ redis  │  │  kafka   │───┘  FHIR sync, alerts, ADT, audit
        │ +pgvector│ │        │  │ +zookeep │
        └──────────┘ └────────┘  └──────────┘
```

| Component | Stack | Role |
|---|---|---|
| `apps/web` | Next.js 15, React 19, Tailwind 4, TanStack Query | Clinical, billing and admin UI |
| `apps/mobile` | Flutter 3, BLoC, Hive | Doctor, nurse and patient apps |
| `apps/desktop` | Tauri 2, Rust | Workstation shell with native devices |
| `services/core-api` | NestJS 11, Fastify, Prisma 6 | Clinical domain, RBAC, audit, FHIR sync |
| `services/ai-service` | Python 3.12, FastAPI | Scribe, coding, risk prediction, RAG, voice |
| `packages/shared-types` | Zod | One source of truth for entities and events |
| `packages/country-packs` | TypeScript | Per-country identifiers, invoices, claims |
| `packages/i18n` | TypeScript | en · ar (RTL) · hi · fr · es · zh |
| `packages/ui-components` | React | Safety-critical shared components |

### Design decisions worth knowing

- **Money is integer minor units, everywhere.** No float touches a currency value.
  `services/core-api/src/billing/money.ts` is the only place arithmetic happens.
- **Tenant scope is structural.** `TenantInterceptor` puts the tenant in
  `AsyncLocalStorage`; `BaseRepository` reads it. A query cannot forget to scope.
- **PHI is never hard-deleted.** Every table carries `deleted_at` + `deleted_reason`.
- **AI never writes to the record.** Every AI response carries
  `requires_approval: true`; a clinician's signature is what commits it.
- **Safety checks are not advisory.** Allergy and interaction checks run on *every*
  prescription save, and both timestamps are persisted so an audit can prove it.
  A high-criticality allergy or a contraindicated interaction cannot be overridden.
- **Colour is never the only signal.** Bed status, EWS bands and overdue tasks are
  always accompanied by text or an icon.

---

## Local setup — 5 commands

```bash
pnpm install                       # 1  install the workspace
docker compose -f docker-compose.dev.yml up -d   # 2  postgres, redis, kafka, fhir, minio
cp .env.example .env               # 3  local config (dev defaults work as-is)
pnpm db:migrate                    # 4  apply the schema
pnpm dev                           # 5  run web + core-api
```

Then:

- Web app — <http://localhost:3000>
- API docs — <http://localhost:4000/api/docs>
- HAPI FHIR — <http://localhost:8080/fhir>
- MinIO console — <http://localhost:9001>

The AI service runs separately (it has a Python toolchain of its own):

```bash
cd services/ai-service && uv run uvicorn app.main:app --reload --port 8000
```

### Verification

```bash
pnpm type-check     # TypeScript across every package
pnpm test:unit      # Node/TypeScript unit tests
pnpm build          # build everything
cd services/ai-service && uv run pytest      # Python tests
cd apps/mobile && flutter test               # Flutter tests
bash infrastructure/security-check.sh        # security gate
```

---

## VPS deployment

Target: **Ubuntu 24.04 LTS**, 4 vCPU / 16 GB RAM / 100 GB SSD minimum
(HAPI FHIR and Kafka are the memory-hungry components).

### 1 — Provision

```bash
ssh root@your-server
git clone <repo-url> /tmp/medicore && cd /tmp/medicore
bash infrastructure/vps-setup.sh
```

This installs Docker, locks UFW to 22/80/443, enables a fail2ban SSH jail, disables
SSH password auth, creates the `medicore` user, and generates the database, Redis,
MinIO and RS256 JWT secrets into `/etc/medicore/.env` (mode 640).

### 2 — Configure

Edit `/etc/medicore/.env` and fill in what the script cannot generate:

```
DOMAIN_PLACEHOLDER=hospital.example.com
LETSENCRYPT_EMAIL=ops@example.com
OPENAI_API_KEY=...            # or AZURE_OPENAI_* / ANTHROPIC_API_KEY
TWILIO_ACCOUNT_SID=...        # SMS and WhatsApp reminders
SMTP_HOST=...                 # credential-expiry and system email
```

### 3 — Deploy

```bash
cd /opt/medicore
sudo -u medicore git clone <repo-url> .
sudo -u medicore bash infrastructure/deploy.sh
```

`deploy.sh` builds in parallel, waits for every health check, and **rolls back to
the previous commit** if the stack does not become healthy within 300 seconds.

### 4 — Assign the domain and enable SSL

Point an `A` record at the server, wait for DNS, then:

```bash
sudo bash infrastructure/certbot-setup.sh
```

It issues the certificate, replaces every `DOMAIN_PLACEHOLDER` in `nginx/nginx.conf`,
validates the new config before committing to it, and installs a renewal hook plus a
twice-daily cron entry.

> `DOMAIN_PLACEHOLDER` also appears in `apps/desktop/src-tauri/tauri.conf.json` and
> the Flutter flavour entrypoints. Replace it there before building the desktop or
> mobile artefacts, or pass `--dart-define=API_BASE_URL=...` to `flutter build`.

### 5 — Continuous deployment

Add these repository secrets and pushes to `main` deploy automatically:

| Secret | Value |
|---|---|
| `VPS_HOST` | Server IP or hostname |
| `VPS_USER` | `medicore` |
| `VPS_SSH_KEY` | Private key authorised for that user |
| `VPS_PORT` | SSH port (optional, defaults to 22) |

---

## Country pack activation

A tenant's `country_pack` column selects the pack. It drives national identifier
validation, invoice layout and tax labels, the claim format, and pre-authorisation
thresholds.

| Pack | Currency | Tax | Identifiers | Claim format | HIE |
|---|---|---|---|---|---|
| `uae` | AED | VAT 5% | Emirates ID, passport, visa | Malaffi FHIR | Malaffi |
| `saudi` | SAR | VAT 15% | National ID, Iqama, border no. | Nphies message bundle | Nphies |
| `india` | INR | GST 18% (IGST vs CGST+SGST) | Aadhaar, ABHA, PAN | NHCX FHIR | ABDM |
| `usa` | USD | Sales tax (state) | SSN, MBI, NPI | X12 837P | Carequality/TEFCA |
| `eu` | EUR | VAT (member state) | EHIC, national ID, VAT no. | FHIR R4 (EU profile) | MyHealth@EU |
| `uk` | GBP | Exempt (medical care) | NHS number, CHI, NI | FHIR R4 (UKCore) | NHS Spine |
| `africa` | USD | VAT (varies) | National ID, SA ID, NHIF, NHIS | FHIR R4 | — |

Every pack implements real checksum validation — Aadhaar Verhoeff, NHS modulus-11,
NPI Luhn, Saudi national ID, South African ID — not format-only checks.

To activate a pack:

```sql
UPDATE tenants SET country_pack = 'saudi', currency = 'SAR' WHERE slug = 'my-hospital';
```

Then supply the pack-specific fields listed by `GET /api/config` (VAT number, ZATCA
UUID, GSTIN, facility NPI, ODS code…). National HIE adapters stay dormant until
their credentials are set — an unconfigured adapter refuses to transmit rather than
failing silently.

---

## Environment variables

Full list with comments: [`.env.template`](.env.template). The ones without which
nothing works:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL 17 with the `vector` extension |
| `REDIS_URL` | Sessions and caching |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | RS256 PEM, `\n`-escaped. **Required in production** — the API refuses to start without them |
| `CORS_ORIGINS` | Explicit allow-list; the origin is never reflected |
| `KAFKA_BROKERS` | FHIR sync, alerts, ADT, audit mirroring |
| `FHIR_SERVER_URL` | HAPI FHIR base |
| `AI_MODEL_GATEWAY` | `azure_openai` \| `openai` \| `anthropic` \| `google` \| `local` |
| `AI_CONFIDENCE_THRESHOLD` | Default `0.70`; below this a response is flagged `low_confidence` |
| `DOMAIN_PLACEHOLDER` | Set before running `certbot-setup.sh` |

---

## Compliance posture

Implemented: RS256 auth with rotating refresh tokens, TOTP MFA, per-tenant RBAC with
a permission matrix, audit rows on every PHI write, break-glass access audited
*before* the token is issued, 15-minute idle logout enforced server-side, soft
deletes with mandatory reasons, PHI redaction before any prompt leaves the process,
AI prompts hashed rather than stored, TLS 1.2+ with HSTS preload.

Not a substitute for certification. HIPAA, GDPR, UAE DoH/DHA, Saudi NPHIES and
India's DPDP Act each require organisational controls, a BAA/DPA with your hosting
and AI providers, a signed risk assessment, and independent audit. **Do not process
real patient data until that work is complete.**

---

## Licence

Proprietary. All rights reserved.
