"""Settings read from environment variables (and the project .env for local dev)."""
import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(BACKEND_DIR / ".env")
load_dotenv(BACKEND_DIR.parent / ".env")

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"


def _origins(project_id):
    raw = os.getenv("FRONTEND_ORIGINS")
    if raw:
        return [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
    local = ["http://localhost:5000", "http://127.0.0.1:5000"]
    if project_id:
        local += [f"https://{project_id}.web.app", f"https://{project_id}.firebaseapp.com"]
    return local


@dataclass
class Settings:
    ai_provider: str = "openai_compatible"
    ai_api_key: str = ""
    ai_model: str = "gemini-3.5-flash,gemini-flash-latest"  # comma-separated: primary, then fallbacks
    ai_reasoning_effort: str = "low"
    ai_base_url: str = GEMINI_BASE_URL
    ai_timeout: float = 20.0
    firebase_credentials: str = ""
    firebase_project_id: str = ""
    data_store: str = "firestore"
    frontend_origins: list = field(default_factory=list)
    auto_resolve_threshold: float = 0.8
    escalation_priority: int = 4
    duplicate_min_score: float = 0.25
    duplicate_fallback_score: float = 0.75
    tickets_per_window: int = 5
    rate_window_seconds: int = 600
    replies_per_minute: int = 30
    image_sweep_seconds: int = 3600  # how often to look for images past their deletion date; 0 = off

    @classmethod
    def from_env(cls):
        project_id = os.getenv("FIREBASE_PROJECT_ID") or os.getenv("projectId", "")
        return cls(
            ai_provider=os.getenv("AI_PROVIDER", "openai_compatible"),
            # gemini_key is the project's key name; AI_API_KEY wins if set
            ai_api_key=os.getenv("AI_API_KEY") or os.getenv("gemini_key", ""),
            ai_model=os.getenv("AI_MODEL", "gemini-3.5-flash,gemini-flash-latest"),
            ai_base_url=os.getenv("AI_BASE_URL", GEMINI_BASE_URL).rstrip("/"),
            # Limits hidden "thinking" tokens on Gemini; set empty for providers that reject it
            ai_reasoning_effort=os.getenv("AI_REASONING_EFFORT", "low"),
            ai_timeout=float(os.getenv("AI_TIMEOUT", 20)),
            firebase_credentials=os.getenv("FIREBASE_CREDENTIALS_JSON", ""),
            firebase_project_id=project_id,
            data_store=os.getenv("DATA_STORE", "firestore"),
            frontend_origins=_origins(project_id),
            auto_resolve_threshold=float(os.getenv("AUTO_RESOLVE_THRESHOLD", 0.8)),
            escalation_priority=int(os.getenv("ESCALATION_PRIORITY", 4)),
            duplicate_min_score=float(os.getenv("DUPLICATE_MIN_SCORE", 0.25)),
            duplicate_fallback_score=float(os.getenv("DUPLICATE_FALLBACK_SCORE", 0.75)),
            tickets_per_window=int(os.getenv("TICKETS_PER_WINDOW", 5)),
            rate_window_seconds=int(os.getenv("RATE_WINDOW_SECONDS", 600)),
            replies_per_minute=int(os.getenv("REPLIES_PER_MINUTE", 30)),
            image_sweep_seconds=int(os.getenv("IMAGE_SWEEP_SECONDS", 3600)),
        )
