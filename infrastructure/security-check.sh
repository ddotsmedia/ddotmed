#!/usr/bin/env bash
# MediCore HMS — pre-deploy security gate.
# Fails the build on committed secrets or missing protections.
set -Eeuo pipefail

FAIL=0
note()  { printf '  \033[1;33m! %s\033[0m\n' "$*"; }
bad()   { printf '  \033[1;31m✖ %s\033[0m\n' "$*"; FAIL=1; }
good()  { printf '  \033[1;32m✓ %s\033[0m\n' "$*"; }
head()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

# Search only tracked source, never node_modules or build output.
sources() {
  git ls-files \
    ':!:*.lock' ':!:pnpm-lock.yaml' ':!:*.md' ':!:.env.template' ':!:.env.example' \
    ':!:infrastructure/security-check.sh' \
    -- '*.ts' '*.tsx' '*.js' '*.py' '*.dart' '*.rs' '*.yml' '*.yaml' '*.json' '*.sh'
}

head "Committed secrets"
if git ls-files | grep -Ex '\.env|.*/\.env' >/dev/null 2>&1; then
  bad ".env is tracked by git"
else
  good "no .env file is tracked"
fi

PATTERNS=(
  'sk-[A-Za-z0-9]{32,}'
  'sk-ant-[A-Za-z0-9_-]{32,}'
  'AKIA[0-9A-Z]{16}'
  'AIza[0-9A-Za-z_-]{35}'
  'ghp_[A-Za-z0-9]{36}'
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
)
found=0
for pattern in "${PATTERNS[@]}"; do
  if sources | xargs -r grep -InE "$pattern" 2>/dev/null | grep -v 'REPLACE_WITH\|CHANGE_ME\|example\|placeholder'; then
    found=1
  fi
done
if [[ $found -eq 1 ]]; then bad "possible hardcoded credential above"; else good "no credential patterns found"; fi

head "Hardcoded passwords in source"
if sources | grep -vE 'docker-compose\.dev\.yml|\.spec\.|_test\.|/test/|/tests/' \
   | xargs -r grep -InE '(password|passwd|secret|api_?key)\s*[:=]\s*["'"'"'][^"'"'"']{8,}["'"'"']' 2>/dev/null \
   | grep -viE 'process\.env|os\.environ|getenv|config\.get|String\.fromEnvironment|CHANGE_ME|placeholder|example|\$\{'; then
  bad "literal credential assignment above"
else
  good "no literal credential assignments"
fi

head "Raw SQL concatenation"
if sources | xargs -r grep -InE '\$(queryRaw|executeRaw)Unsafe' 2>/dev/null; then
  bad "Prisma unsafe raw query found — use the parameterised form"
else
  good "no unsafe Prisma raw queries"
fi
if git ls-files -- '*.py' | xargs -r grep -InE '(execute|fetch)\w*\(\s*f["'"'"']' 2>/dev/null; then
  bad "f-string interpolated SQL found"
else
  good "no f-string interpolated SQL"
fi

head "Auth coverage on PHI routes"
missing=0
while IFS= read -r file; do
  # Every controller must either require a permission or be explicitly public.
  if grep -q '@Controller' "$file" 2>/dev/null; then
    if ! grep -qE '@RequirePermissions|@Roles|@Public' "$file"; then
      bad "$(basename "$file") has no @RequirePermissions/@Roles/@Public"
      missing=1
    fi
  fi
done < <(git ls-files 'services/core-api/src/**/*.ts' | grep -E 'controller|module')
[[ $missing -eq 0 ]] && good "every controller declares access control"

head "Global guards registered"
if grep -q 'useGlobalGuards' services/core-api/src/main.ts && \
   grep -q 'JwtAuthGuard' services/core-api/src/main.ts && \
   grep -q 'RolesGuard' services/core-api/src/main.ts; then
  good "JwtAuthGuard and RolesGuard are registered globally"
else
  bad "global auth guards are not registered in main.ts"
fi

head "Rate limiting"
if grep -q '@fastify/rate-limit' services/core-api/src/main.ts; then
  good "core-api registers rate limiting"
else
  bad "core-api does not register rate limiting"
fi
if grep -q 'limit_req_zone .*auth_zone' nginx/nginx.conf && grep -q 'zone=auth_zone' nginx/nginx.conf; then
  good "nginx rate-limits auth endpoints separately"
else
  bad "nginx does not rate-limit auth endpoints"
fi

head "Security headers"
for header in Strict-Transport-Security X-Frame-Options X-Content-Type-Options Content-Security-Policy; do
  if grep -q "$header" nginx/nginx.conf; then good "$header present"; else bad "$header missing from nginx.conf"; fi
done

head "CORS"
if grep -q 'CORS_ORIGINS' services/core-api/src/main.ts && grep -q 'origin: origins.length ? origins : false' services/core-api/src/main.ts; then
  good "CORS uses an explicit allow-list and never reflects the origin"
else
  bad "CORS configuration does not use a strict allow-list"
fi

head "XSS on rendered content"
if git ls-files 'apps/web/**/*.tsx' | xargs -r grep -In 'dangerouslySetInnerHTML' 2>/dev/null; then
  bad "dangerouslySetInnerHTML found — sanitise or remove"
else
  good "no dangerouslySetInnerHTML in the web app"
fi
if grep -q 'escapeXml' services/core-api/src/fhir/mappers.ts; then
  good "FHIR narrative generation escapes XML"
else
  bad "FHIR narrative generation does not escape XML"
fi

head "Secrets are read from the environment"
if grep -q "envFilePath: \['/etc/medicore/.env'" services/core-api/src/app.module.ts; then
  good "core-api loads secrets from /etc/medicore/.env"
else
  note "core-api env file path differs from the documented location"
fi

printf '\n'
if [[ $FAIL -eq 1 ]]; then
  printf '\033[1;31m✖ Security check FAILED\033[0m\n'
  exit 1
fi
printf '\033[1;32m✓ Security check passed\033[0m\n'
