"""Server-only Sarvam provider boundary.

The native app never imports this module and never receives ``SARVAM_API_KEY``.
The concrete calls will be moved here from ``api/sarvam.py`` incrementally.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


class ProviderConfigurationError(RuntimeError):
    """Raised when the backend cannot safely call Sarvam."""


@dataclass(frozen=True)
class SarvamConfig:
    api_key: str
    stt_model: str = "saaras:v3"
    llm_model: str = "sarvam-105b"
    tts_model: str = "bulbul:v3"

    @classmethod
    def from_environment(cls) -> "SarvamConfig":
        key = (os.getenv("SARVAM_API_KEY") or "").strip()
        if not key:
            raise ProviderConfigurationError("SARVAM_API_KEY is required on the server")
        return cls(api_key=key)


class SarvamClient:
    """Provider seam; implementations are injected into the voice worker."""

    def __init__(self, config: SarvamConfig | None = None):
        self.config = config or SarvamConfig.from_environment()

    @property
    def models(self) -> dict[str, str]:
        return {
            "stt": self.config.stt_model,
            "llm": self.config.llm_model,
            "tts": self.config.tts_model,
        }
