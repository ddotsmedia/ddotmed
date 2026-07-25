#!/bin/bash
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE hapi_fhir;
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";
EOSQL

# pgvector powers RAG search in ai-service; tolerate absence on vanilla postgres images.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;' || echo 'pgvector unavailable - RAG search disabled'
