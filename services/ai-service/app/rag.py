"""Semantic search over a patient's FHIR records using pgvector."""

from __future__ import annotations

import json
from typing import Any

import structlog

from .config import get_settings
from .gateway import ModelGateway, redact_phi
from .schemas import SearchHit, SearchRequest, SearchResponse

log = structlog.get_logger(__name__)

SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS fhir_embeddings (
    id            uuid PRIMARY KEY,
    tenant_id     uuid NOT NULL,
    patient_id    uuid,
    resource_type text NOT NULL,
    resource_id   uuid NOT NULL,
    excerpt       text NOT NULL,
    recorded_at   timestamptz,
    embedding     vector(1536) NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS fhir_embeddings_tenant_patient_idx
    ON fhir_embeddings (tenant_id, patient_id);

CREATE INDEX IF NOT EXISTS fhir_embeddings_vector_idx
    ON fhir_embeddings USING hnsw (embedding vector_cosine_ops);
"""


class EmbeddingClient:
    """Wraps the embedding provider. Text is redacted before it leaves the process."""

    def __init__(self, gateway: ModelGateway | None = None) -> None:
        self.settings = get_settings()
        self.gateway = gateway or ModelGateway()

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        from openai import AsyncOpenAI

        if not self.settings.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY is required for embeddings")
        client = AsyncOpenAI(api_key=self.settings.openai_api_key)
        response = await client.embeddings.create(
            model=self.settings.embedding_model,
            input=[redact_phi(t) for t in texts],
        )
        return [d.embedding for d in response.data]


class RagService:
    def __init__(self, embeddings: EmbeddingClient | None = None) -> None:
        self.settings = get_settings()
        self.embeddings = embeddings or EmbeddingClient()
        self._pool: Any | None = None

    async def _connection_pool(self) -> Any:
        if self._pool is None:
            import asyncpg

            if not self.settings.database_url:
                raise RuntimeError("DATABASE_URL is required for RAG search")
            self._pool = await asyncpg.create_pool(self.settings.database_url, min_size=1, max_size=5)
        return self._pool

    async def ensure_schema(self) -> None:
        pool = await self._connection_pool()
        async with pool.acquire() as conn:
            await conn.execute(SCHEMA_SQL)

    @staticmethod
    def flatten_resource(resource: dict[str, Any]) -> str:
        """Renders a FHIR resource into the text that gets embedded."""
        parts: list[str] = [f"Resource: {resource.get('resourceType', 'Unknown')}"]

        def walk(node: Any, prefix: str = "") -> None:
            if isinstance(node, dict):
                for key, value in node.items():
                    if key in {"id", "meta", "identifier", "reference"}:
                        continue
                    walk(value, f"{prefix}{key}.")
            elif isinstance(node, list):
                for item in node:
                    walk(item, prefix)
            elif node is not None and str(node).strip():
                parts.append(f"{prefix.rstrip('.')}: {node}")

        walk(resource)
        return "\n".join(parts)

    async def index_resource(
        self,
        tenant_id: str,
        patient_id: str | None,
        resource_type: str,
        resource_id: str,
        resource: dict[str, Any],
        recorded_at: str | None = None,
    ) -> None:
        excerpt = self.flatten_resource(resource)[:8000]
        vectors = await self.embeddings.embed([excerpt])
        if not vectors:
            return

        pool = await self._connection_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO fhir_embeddings
                    (id, tenant_id, patient_id, resource_type, resource_id, excerpt, recorded_at, embedding)
                VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (tenant_id, resource_type, resource_id)
                DO UPDATE SET excerpt = EXCLUDED.excerpt,
                              embedding = EXCLUDED.embedding,
                              recorded_at = EXCLUDED.recorded_at
                """,
                tenant_id,
                patient_id,
                resource_type,
                resource_id,
                excerpt,
                recorded_at,
                json.dumps(vectors[0]),
            )

    async def search(self, tenant_id: str, req: SearchRequest) -> SearchResponse:
        vectors = await self.embeddings.embed([req.query])
        if not vectors:
            return SearchResponse(hits=[], query_embedding_model=self.settings.embedding_model, total=0)

        # Tenant scope is a WHERE clause on every query — a vector index does not
        # enforce isolation on its own.
        conditions = ["tenant_id = $2"]
        params: list[Any] = [json.dumps(vectors[0]), tenant_id]
        if req.patient_id:
            params.append(req.patient_id)
            conditions.append(f"patient_id = ${len(params)}")
        if req.resource_types:
            params.append(req.resource_types)
            conditions.append(f"resource_type = ANY(${len(params)})")
        params.append(req.limit)

        sql = f"""
            SELECT resource_type, resource_id, excerpt, recorded_at,
                   1 - (embedding <=> $1::vector) AS similarity
            FROM fhir_embeddings
            WHERE {' AND '.join(conditions)}
            ORDER BY embedding <=> $1::vector
            LIMIT ${len(params)}
        """

        pool = await self._connection_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)

        hits = [
            SearchHit(
                resource_type=r["resource_type"],
                resource_id=str(r["resource_id"]),
                excerpt=r["excerpt"][:500],
                similarity=round(float(r["similarity"]), 4),
                recorded_at=r["recorded_at"],
            )
            for r in rows
        ]
        return SearchResponse(
            hits=hits, query_embedding_model=self.settings.embedding_model, total=len(hits)
        )
