"""
phone-jarvis cloud — config loader.

Reads from environment variables (loaded from .env in dev, Fly secrets in prod).
Pydantic settings give us validation + helpful error messages on missing keys.
"""

from functools import lru_cache
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Operator-side config. Per-user provider keys come from Supabase, not env."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # --- Supabase (per-user auth + settings lookup) ---
    SUPABASE_URL: str = Field(default="")
    SUPABASE_SERVICE_ROLE_KEY: str = Field(default="")

    # --- Twilio (Path A) ---
    TWILIO_ACCOUNT_SID: str = Field(default="")
    TWILIO_AUTH_TOKEN: str = Field(default="")
    TWILIO_PHONE_NUMBER: str = Field(default="")

    # --- LiveKit (Path C) ---
    LIVEKIT_API_KEY: str = Field(default="")
    LIVEKIT_API_SECRET: str = Field(default="")
    LIVEKIT_URL: str = Field(default="")

    # --- Operator-default provider keys (fallback when user has no BYOK) ---
    DEEPGRAM_API_KEY: str = Field(default="")
    ANTHROPIC_API_KEY: str = Field(default="")
    CARTESIA_API_KEY: str = Field(default="")
    GROQ_API_KEY: str = Field(default="")

    # --- Bridge auth ---
    BRIDGE_TOKEN_PEPPER: str = Field(default="dev_pepper_replace_in_production")

    # --- Behavior ---
    AUDIT_RETENTION_DAYS: int = Field(default=30)
    COST_CAP_PER_CALL: float = Field(default=5.00)
    IDLE_HANGUP_SECONDS: int = Field(default=120)
    BRIDGE_TOKEN_TTL_SECONDS: int = Field(default=300)
    PIN_MAX_ATTEMPTS: int = Field(default=3)
    PIN_COOLDOWN_SECONDS: int = Field(default=3600)

    # --- Server ---
    PORT: int = Field(default=8080)
    LOG_LEVEL: str = Field(default="INFO")

    @property
    def has_twilio(self) -> bool:
        return bool(self.TWILIO_ACCOUNT_SID and self.TWILIO_AUTH_TOKEN and self.TWILIO_PHONE_NUMBER)

    @property
    def has_livekit(self) -> bool:
        return bool(self.LIVEKIT_API_KEY and self.LIVEKIT_API_SECRET and self.LIVEKIT_URL)

    @property
    def has_supabase(self) -> bool:
        return bool(self.SUPABASE_URL and self.SUPABASE_SERVICE_ROLE_KEY)


@lru_cache
def get_settings() -> Settings:
    """Cached singleton accessor. Re-import this; config never reloads at runtime."""
    return Settings()
