"""Provider-swappable model gateway.

Every completion routes through :class:`ModelGateway` so that provider choice,
audit logging and the low-confidence contract are enforced in exactly one place.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol

import structlog

from .config import Provider, Settings, get_settings

log = structlog.get_logger(__name__)


@dataclass(slots=True)
class Message:
    role: str
    content: str


@dataclass(slots=True)
class CompletionResult:
    text: str
    model_version: str
    provider: Provider
    prompt_tokens: int
    completion_tokens: int
    latency_ms: int
    confidence_score: float
    low_confidence: bool
    request_id: str
    raw: dict[str, Any] = field(default_factory=dict)

    def as_audit(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "provider": self.provider,
            "model_version": self.model_version,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "latency_ms": self.latency_ms,
            "confidence_score": self.confidence_score,
            "low_confidence": self.low_confidence,
        }


class AuditSink(Protocol):
    async def record(self, entry: dict[str, Any]) -> None: ...


class InMemoryAuditSink:
    """Default sink. Production wires a Postgres-backed sink writing ai_audit_logs."""

    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []

    async def record(self, entry: dict[str, Any]) -> None:
        self.entries.append(entry)


# Direct identifiers stripped before a prompt leaves the building.
_PHI_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("EMAIL", re.compile(r"[\w\.\-+]+@[\w\-]+\.[\w\.\-]+")),
    ("PHONE", re.compile(r"\+?\d[\d\s\-().]{7,}\d")),
    ("MRN", re.compile(r"\bMRN\d{6,}\b", re.IGNORECASE)),
    ("NATIONAL_ID", re.compile(r"\b\d{9,15}\b")),
]


def redact_phi(text: str) -> str:
    """Masks direct identifiers. Clinical content is preserved — it is the payload."""
    out = text
    for label, pattern in _PHI_PATTERNS:
        out = pattern.sub(f"[{label}]", out)
    return out


def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class ProviderError(RuntimeError):
    """Raised when the selected provider is unreachable or unconfigured."""


class ModelGateway:
    """Routes completions to the configured provider and audits every call."""

    def __init__(self, settings: Settings | None = None, audit: AuditSink | None = None) -> None:
        self.settings = settings or get_settings()
        self.audit: AuditSink = audit or InMemoryAuditSink()

    @property
    def provider(self) -> Provider:
        return self.settings.ai_model_gateway

    @property
    def model_version(self) -> str:
        """The model a completion would run on right now, without making a call."""
        return self._model_name()

    def _model_name(self) -> str:
        s = self.settings
        # Falls back rather than raising: this runs on the audit path, which must
        # still record a failed call against an unknown provider.
        return {
            "azure_openai": s.azure_openai_deployment or "azure-deployment-unset",
            "openai": s.openai_model,
            "anthropic": s.anthropic_model,
            "google": s.google_model,
            "local": s.local_model,
        }.get(self.provider, f"unknown:{self.provider}")

    async def complete(
        self,
        messages: list[Message],
        *,
        operation: str,
        json_mode: bool = False,
        temperature: float = 0.2,
        max_tokens: int = 2048,
        patient_id: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
    ) -> CompletionResult:
        request_id = str(uuid.uuid4())
        started = time.perf_counter()

        redacted = [Message(role=m.role, content=redact_phi(m.content)) for m in messages]
        prompt_blob = json.dumps([{"role": m.role, "content": m.content} for m in redacted])

        try:
            text, usage, raw = await self._dispatch(redacted, json_mode, temperature, max_tokens)
            error: str | None = None
        except Exception as exc:  # noqa: BLE001 — surfaced to the caller after auditing
            text, usage, raw, error = "", {"prompt": 0, "completion": 0}, {}, str(exc)

        latency_ms = int((time.perf_counter() - started) * 1000)
        confidence = self._score_confidence(text, raw) if not error else 0.0
        low_confidence = confidence < self.settings.confidence_threshold

        await self.audit.record(
            {
                "request_id": request_id,
                "operation": operation,
                "provider": self.provider,
                "model_version": self._model_name(),
                "prompt_tokens": usage["prompt"],
                "completion_tokens": usage["completion"],
                "latency_ms": latency_ms,
                "confidence_score": confidence,
                "low_confidence": low_confidence,
                # Prompts are hashed, not stored — the record itself lives in core-api.
                "prompt_hash": hash_text(prompt_blob),
                "response_hash": hash_text(text) if text else None,
                "patient_id": patient_id,
                "user_id": user_id,
                "session_id": session_id,
                "error": error,
            }
        )

        if error:
            raise ProviderError(f"{self.provider} completion failed: {error}")

        return CompletionResult(
            text=text,
            model_version=self._model_name(),
            provider=self.provider,
            prompt_tokens=usage["prompt"],
            completion_tokens=usage["completion"],
            latency_ms=latency_ms,
            confidence_score=confidence,
            low_confidence=low_confidence,
            request_id=request_id,
            raw=raw,
        )

    async def _dispatch(
        self,
        messages: list[Message],
        json_mode: bool,
        temperature: float,
        max_tokens: int,
    ) -> tuple[str, dict[str, int], dict[str, Any]]:
        match self.provider:
            case "openai" | "azure_openai" | "local":
                return await self._openai_compatible(messages, json_mode, temperature, max_tokens)
            case "anthropic":
                return await self._anthropic(messages, temperature, max_tokens)
            case "google":
                return await self._google(messages, temperature, max_tokens)
        raise ProviderError(f"Unsupported provider {self.provider}")

    def _openai_client(self) -> Any:
        from openai import AsyncAzureOpenAI, AsyncOpenAI

        s = self.settings
        if self.provider == "azure_openai":
            if not (s.azure_openai_endpoint and s.azure_openai_key):
                raise ProviderError("AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_KEY are required")
            return AsyncAzureOpenAI(
                azure_endpoint=s.azure_openai_endpoint,
                api_key=s.azure_openai_key,
                api_version=s.azure_openai_api_version,
                timeout=s.ai_request_timeout_seconds,
            )
        if self.provider == "local":
            return AsyncOpenAI(
                base_url=s.local_model_base_url,
                api_key="local",
                timeout=s.ai_request_timeout_seconds,
            )
        if not s.openai_api_key:
            raise ProviderError("OPENAI_API_KEY is required")
        return AsyncOpenAI(api_key=s.openai_api_key, timeout=s.ai_request_timeout_seconds)

    async def _openai_compatible(
        self,
        messages: list[Message],
        json_mode: bool,
        temperature: float,
        max_tokens: int,
    ) -> tuple[str, dict[str, int], dict[str, Any]]:
        client = self._openai_client()
        response = await client.chat.completions.create(
            model=self._model_name(),
            messages=[{"role": m.role, "content": m.content} for m in messages],
            temperature=temperature,
            max_tokens=max_tokens,
            **({"response_format": {"type": "json_object"}} if json_mode else {}),
            logprobs=True,
        )
        choice = response.choices[0]
        usage = {
            "prompt": getattr(response.usage, "prompt_tokens", 0) or 0,
            "completion": getattr(response.usage, "completion_tokens", 0) or 0,
        }
        raw: dict[str, Any] = {"finish_reason": choice.finish_reason}
        if getattr(choice, "logprobs", None) and choice.logprobs.content:
            raw["token_logprobs"] = [t.logprob for t in choice.logprobs.content]
        return choice.message.content or "", usage, raw

    async def _anthropic(
        self, messages: list[Message], temperature: float, max_tokens: int
    ) -> tuple[str, dict[str, int], dict[str, Any]]:
        from anthropic import AsyncAnthropic

        if not self.settings.anthropic_api_key:
            raise ProviderError("ANTHROPIC_API_KEY is required")
        client = AsyncAnthropic(
            api_key=self.settings.anthropic_api_key,
            timeout=self.settings.ai_request_timeout_seconds,
        )
        system = "\n".join(m.content for m in messages if m.role == "system")
        turns = [
            {"role": m.role, "content": m.content} for m in messages if m.role in {"user", "assistant"}
        ]
        response = await client.messages.create(
            model=self._model_name(),
            system=system or None,
            messages=turns,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        text = "".join(block.text for block in response.content if block.type == "text")
        usage = {"prompt": response.usage.input_tokens, "completion": response.usage.output_tokens}
        return text, usage, {"stop_reason": response.stop_reason}

    async def _google(
        self, messages: list[Message], temperature: float, max_tokens: int
    ) -> tuple[str, dict[str, int], dict[str, Any]]:
        import httpx

        if not self.settings.google_api_key:
            raise ProviderError("GOOGLE_API_KEY is required")
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self._model_name()}:generateContent?key={self.settings.google_api_key}"
        )
        payload = {
            "contents": [
                {"role": "user" if m.role != "assistant" else "model", "parts": [{"text": m.content}]}
                for m in messages
                if m.role != "system"
            ],
            "systemInstruction": {
                "parts": [{"text": "\n".join(m.content for m in messages if m.role == "system")}]
            },
            "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
        }
        async with httpx.AsyncClient(timeout=self.settings.ai_request_timeout_seconds) as http:
            response = await http.post(url, json=payload)
            response.raise_for_status()
            body = response.json()
        text = body["candidates"][0]["content"]["parts"][0]["text"]
        meta = body.get("usageMetadata", {})
        usage = {
            "prompt": meta.get("promptTokenCount", 0),
            "completion": meta.get("candidatesTokenCount", 0),
        }
        return text, usage, {"finish_reason": body["candidates"][0].get("finishReason")}

    def _score_confidence(self, text: str, raw: dict[str, Any]) -> float:
        """Mean token probability when logprobs are available, else a conservative default.

        Providers that expose no logprobs get 0.75 — above the 0.70 threshold, so a
        usable answer is not gratuitously flagged, but well short of certainty.
        """
        logprobs = raw.get("token_logprobs")
        if isinstance(logprobs, list) and logprobs:
            import math

            probs = [math.exp(lp) for lp in logprobs if isinstance(lp, (int, float))]
            if probs:
                return round(sum(probs) / len(probs), 4)
        if raw.get("finish_reason") == "length":
            # A truncated answer is unreliable regardless of provider.
            return 0.5
        return 0.75 if text.strip() else 0.0

    @staticmethod
    def parse_json(text: str) -> dict[str, Any]:
        """Extracts a JSON object from a completion, tolerating markdown fences."""
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.MULTILINE).strip()
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", cleaned, re.DOTALL)
            if not match:
                raise
            parsed = json.loads(match.group(0))
        if not isinstance(parsed, dict):
            raise ValueError("Expected a JSON object")
        return parsed
