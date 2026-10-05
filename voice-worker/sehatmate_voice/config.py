from dataclasses import dataclass, field
import os
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Config:
    backend_url: str
    livekit_url: str

    livekit_key: str = field(repr=False)
    livekit_secret: str = field(repr=False)
    worker_key: str = field(repr=False)
    deepgram_key: str = field(repr=False)
    fish_key: str = field(repr=False)

    fish_model: str = "s2.1-pro-free"
    fish_voice: str = ""
    language: str = "en"

    stt_enabled: bool = False
    fish_enabled: bool = False

    session_seconds: int = 600
    idle_seconds: int = 60
    concurrent_jobs: int = 1
    retries: int = 1
    request_seconds: int = 15
    poll_seconds: int = 120
    audio_seconds: int = 30
    tts_requests: int = 8
    tts_seconds: int = 12
    tts_segment_chars: int = 120

    @classmethod
    def from_env(cls, env=None):
        e = os.environ if env is None else env

        def validated_url(name, allowed_schemes):
            value = str(e.get(name, "")).strip()
            parsed = urlsplit(value)

            if (
                parsed.scheme.lower() not in allowed_schemes
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
                or parsed.path not in ("", "/")
            ):
                raise ValueError(f"Invalid {name}")

            return value.rstrip("/")

        def number(name, default, low, high):
            raw = str(e.get(name, default))

            if not raw.isdecimal():
                raise ValueError(f"Invalid {name}")

            value = int(raw)

            if not low <= value <= high:
                raise ValueError(f"Invalid {name}")

            return value

        def flag(name):
            return str(e.get(name, "false")).lower() == "true"

        if not flag("VOICE_WORKER_ENABLED"):
            raise ValueError("Worker disabled")

        forbidden = (
            "JWT_SECRET",
            "DB_PASSWORD",
            "OPENROUTER_API_KEY",
            "VOICE_DELEGATION_SECRET",
            "VOICE_RECEIPT_ENCRYPTION_KEY",
        )

        if any(e.get(name) for name in forbidden):
            raise ValueError("Forbidden backend credentials in Worker environment")

        for name in (
            "LIVEKIT_API_KEY",
            "LIVEKIT_API_SECRET",
            "VOICE_WORKER_AUTH_KEY",
        ):
            minimum_length = 1 if name == "LIVEKIT_API_KEY" else 32

            if len(e.get(name, "")) < minimum_length:
                raise ValueError(f"Missing {name}")

        language = e.get("VOICE_STT_LANGUAGE", "en")

        if language not in ("en", "ur"):
            raise ValueError("VOICE_STT_LANGUAGE must be en or ur")

        # LiveKit Cloud may provide its project URL in a secure HTTPS
        # or WSS form. The LiveKit Agents SDK handles HTTPS -> WSS
        # conversion internally when registering the worker.
        livekit_url = validated_url(
            "LIVEKIT_URL",
            {"wss", "https"},
        )

        backend_url = validated_url(
            "VOICE_BACKEND_URL",
            {"https"},
        )

        return cls(
            backend_url=backend_url,
            livekit_url=livekit_url,

            livekit_key=e["LIVEKIT_API_KEY"],
            livekit_secret=e["LIVEKIT_API_SECRET"],
            worker_key=e["VOICE_WORKER_AUTH_KEY"],

            deepgram_key=e.get("DEEPGRAM_API_KEY", ""),
            fish_key=e.get("FISH_API_KEY", ""),

            fish_model=e.get("FISH_TTS_MODEL", ""),
            fish_voice=e.get("FISH_REFERENCE_ID", ""),

            language=language,

            stt_enabled=(
                flag("DEEPGRAM_ENABLED")
                and bool(e.get("DEEPGRAM_API_KEY"))
                and not flag("DEEPGRAM_DISABLED")
            ),

            fish_enabled=(
                flag("FISH_ENABLED")
                and bool(e.get("FISH_API_KEY"))
                and e.get("FISH_TTS_MODEL") == "s2.1-pro-free"
                and bool(e.get("FISH_REFERENCE_ID"))
                and not flag("FISH_DISABLED")
            ),

            session_seconds=number(
                "VOICE_MAX_SESSION_SECONDS",
                600,
                30,
                600,
            ),

            idle_seconds=number(
                "VOICE_IDLE_TIMEOUT_SECONDS",
                60,
                15,
                60,
            ),

            concurrent_jobs=number(
                "VOICE_WORKER_MAX_CONCURRENT_JOBS",
                1,
                1,
                5,
            ),

            retries=number(
                "VOICE_PROVIDER_RETRIES",
                1,
                0,
                2,
            ),

            request_seconds=number(
                "VOICE_PROVIDER_TIMEOUT_SECONDS",
                15,
                3,
                30,
            ),

            poll_seconds=number(
                "VOICE_RECEIPT_POLL_SECONDS",
                120,
                5,
                180,
            ),

            audio_seconds=number(
                "VOICE_MAX_AUDIO_SECONDS",
                30,
                5,
                60,
            ),

            tts_requests=number(
                "VOICE_MAX_TTS_REQUESTS",
                8,
                0,
                20,
            ),

            tts_seconds=number(
                "VOICE_MAX_TTS_SECONDS",
                12,
                1,
                20,
            ),

            tts_segment_chars=number(
                "VOICE_TTS_SEGMENT_CHARS",
                120,
                80,
                500,
            ),
        )