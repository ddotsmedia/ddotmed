from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

Provider = Literal["azure_openai", "openai", "anthropic", "google", "local"]


class Settings(BaseSettings):
    """Environment-driven configuration. Secrets never have defaults."""

    model_config = SettingsConfigDict(
        env_file=("/etc/medicore/.env", ".env"), extra="ignore", case_sensitive=False
    )

    port: int = 8000
    log_level: str = "INFO"

    # Provider selection is a single switch so a deployment can move between
    # clouds without touching call sites.
    # Anthropic by default; Haiku is the clinical-drafting workhorse — fast enough
    # for an ambient scribe to feel live, and cheap enough to run on every encounter.
    ai_model_gateway: Provider = "anthropic"
    ai_confidence_threshold: float = 0.70
    ai_request_timeout_seconds: int = 120

    azure_openai_endpoint: str | None = None
    azure_openai_key: str | None = None
    azure_openai_deployment: str | None = None
    azure_openai_api_version: str = "2024-10-21"

    openai_api_key: str | None = None
    openai_model: str = "gpt-4o"

    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-haiku-4-5"

    google_api_key: str | None = None
    google_model: str = "gemini-2.0-flash"

    local_model_base_url: str = "http://localhost:11434/v1"
    local_model: str = "llama3.1:8b"

    whisper_model: str = "base"
    embedding_model: str = "text-embedding-3-small"
    embedding_dimensions: int = 1536

    database_url: str | None = None
    core_api_url: str = "http://core-api:4000"

    # RS256 public key used to verify tokens minted by core-api.
    jwt_public_key: str | None = None
    jwt_issuer: str = "medicore"
    jwt_audience: str = "medicore-api"

    mlflow_tracking_uri: str | None = None

    @property
    def confidence_threshold(self) -> float:
        return self.ai_confidence_threshold


@lru_cache
def get_settings() -> Settings:
    return Settings()
