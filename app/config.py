import os
import subprocess
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv
from google import genai

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env", override=True)


def _detect_gcloud_project() -> str:
    """Fallback to active gcloud project if GOOGLE_CLOUD_PROJECT is not set."""
    try:
        res = subprocess.run(
            ["gcloud", "config", "get-value", "project"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        proj = res.stdout.strip()
        if proj and proj != "(unset)":
            return proj
    except Exception:
        pass
    return ""


AUTH_MODE: str = os.getenv("AUTH_MODE", "adc").strip().lower()
GOOGLE_CLOUD_PROJECT: str = (
    os.getenv("GOOGLE_CLOUD_PROJECT", "").strip() or _detect_gcloud_project()
)
GOOGLE_CLOUD_LOCATION: str = (
    os.getenv("GOOGLE_CLOUD_LOCATION", "global").strip() or "global"
)
GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "").strip()

LIVE_TRANSLATE_MODEL: str = (
    os.getenv("LIVE_TRANSLATE_MODEL", "gemini-3.5-live-translate-preview").strip()
    or "gemini-3.5-live-translate-preview"
)
INACTIVITY_TIMEOUT_SECONDS: int = int(
    os.getenv("INACTIVITY_TIMEOUT_SECONDS", "600").strip() or "600"
)

# Video source: GCS bucket name (without gs://). Empty = serve from local videos/ folder.
VIDEOS_GCS_BUCKET: str = os.getenv("VIDEOS_GCS_BUCKET", "").strip().replace("gs://", "").strip("/")
# Optional object prefix inside the bucket (e.g. "videos"). Empty = bucket root.
VIDEOS_GCS_PREFIX: str = os.getenv("VIDEOS_GCS_PREFIX", "").strip().strip("/")

# Playout delay (seconds): the visible video is held back by this amount while the
# model is fed audio from this far ahead, so subtitles/dubbed audio land in sync.
# Model latency varies ~2-4s (short utterances fast, continuous speech slow). Dubbing can only be
# delayed, never advanced, so 2.5 keeps it from ever leading the picture (it may trail slightly on
# continuous speech). Raise toward 4.0 for tighter sync on news-style content. 0 disables the feeder.
def _float_env(name: str, default: float, lo: float, hi: float) -> float:
    try:
        v = float(os.getenv(name, str(default)).strip() or default)
    except ValueError:
        v = default
    return max(lo, min(hi, v))


PLAYOUT_DELAY_SECONDS: float = _float_env("PLAYOUT_DELAY_SECONDS", 2.5, 0.0, 10.0)

# Translated-speech voice presets exposed in the settings UI.
# "auto" omits speech_config so the model uses its default behaviour (speaker voice replication).
# The remaining entries are the standard Live API prebuilt voices; the Live Translate preview
# accepts speech_config without error, but actual voice change is subject to model support.
SUPPORTED_VOICES = [
    {"id": "auto", "name": "자동 (화자 음성 복제)", "description": "원 화자의 목소리를 따라 번역 음성을 생성합니다."},
    {"id": "Puck", "name": "Puck", "description": "경쾌한 중성 음성"},
    {"id": "Charon", "name": "Charon", "description": "차분한 저음 음성"},
    {"id": "Kore", "name": "Kore", "description": "또렷한 여성 음성"},
    {"id": "Fenrir", "name": "Fenrir", "description": "힘 있는 남성 음성"},
    {"id": "Aoede", "name": "Aoede", "description": "부드러운 여성 음성"},
    {"id": "Leda", "name": "Leda", "description": "밝은 여성 음성"},
    {"id": "Orus", "name": "Orus", "description": "안정적인 남성 음성"},
    {"id": "Zephyr", "name": "Zephyr", "description": "자연스러운 중성 음성"},
]
VALID_VOICE_IDS = {v["id"] for v in SUPPORTED_VOICES}

# Simple shared-password login gate (set APP_LOGIN_PASSWORD in .env). Empty = login disabled.
APP_LOGIN_PASSWORD: str = os.getenv("APP_LOGIN_PASSWORD", "").strip()
# Secret used to sign the auth cookie. Falls back to a random per-process value if unset
# (sessions then reset whenever the server restarts or scales to a new instance).
APP_SESSION_SECRET: str = (
    os.getenv("APP_SESSION_SECRET", "").strip() or os.urandom(32).hex()
)
# Login session lifetime in hours (default 12h)
APP_SESSION_HOURS: int = int(os.getenv("APP_SESSION_HOURS", "12").strip() or "12")


def create_genai_client(
    api_key_override: Optional[str] = None,
    location_override: Optional[str] = None,
) -> genai.Client:
    """
    Create a Google GenAI Client.
    Defaults to ADC / Agent Platform (vertexai=True, location="global") as configured in .env,
    with support for GEMINI_API_KEY when AUTH_MODE=api_key or api_key_override is passed.
    """
    if api_key_override:
        return genai.Client(api_key=api_key_override)

    if AUTH_MODE == "api_key" and GEMINI_API_KEY:
        return genai.Client(api_key=GEMINI_API_KEY)

    target_location = location_override or GOOGLE_CLOUD_LOCATION or "global"

    # Default: ADC (Agent Platform / Vertex AI)
    if GOOGLE_CLOUD_PROJECT:
        return genai.Client(
            vertexai=True,
            project=GOOGLE_CLOUD_PROJECT,
            location=target_location,
        )

    # Fallback if no project is found but API key is present
    if GEMINI_API_KEY:
        return genai.Client(api_key=GEMINI_API_KEY)

    return genai.Client(vertexai=True, location=target_location)


# Official 78 languages supported by gemini-3.5-live-translate-preview
# Popular languages are marked with popular=True so UI can group them at the top.
SUPPORTED_LANGUAGES = [
    {"code": "en", "name": "English", "ko_name": "영어", "popular": True},
    {"code": "ko", "name": "Korean", "ko_name": "한국어", "popular": True},
    {"code": "ja", "name": "Japanese", "ko_name": "일본어", "popular": True},
    {"code": "zh-Hans", "name": "Chinese (Simplified)", "ko_name": "중국어 (간체)", "popular": True},
    {"code": "zh-Hant", "name": "Chinese (Traditional)", "ko_name": "중국어 (번체)", "popular": True},
    {"code": "es", "name": "Spanish", "ko_name": "스페인어", "popular": True},
    {"code": "fr", "name": "French", "ko_name": "프랑스어", "popular": True},
    {"code": "de", "name": "German", "ko_name": "독일어", "popular": True},
    {"code": "vi", "name": "Vietnamese", "ko_name": "베트남어", "popular": True},
    {"code": "th", "name": "Thai", "ko_name": "태국어", "popular": True},
    {"code": "id", "name": "Indonesian", "ko_name": "인도네시아어", "popular": True},
    {"code": "ru", "name": "Russian", "ko_name": "러시아어", "popular": True},
    {"code": "pt-BR", "name": "Portuguese (Brazil)", "ko_name": "포르투갈어 (브라질)", "popular": True},
    {"code": "ar", "name": "Arabic", "ko_name": "아랍어", "popular": True},
    {"code": "hi", "name": "Hindi", "ko_name": "힌디어", "popular": True},
    # Full alphabetical list of remaining supported BCP-47 languages
    {"code": "af", "name": "Afrikaans", "ko_name": "아프리칸스어", "popular": False},
    {"code": "ak", "name": "Akan", "ko_name": "아칸어", "popular": False},
    {"code": "sq", "name": "Albanian", "ko_name": "알바니아어", "popular": False},
    {"code": "am", "name": "Amharic", "ko_name": "암하라어", "popular": False},
    {"code": "hy", "name": "Armenian", "ko_name": "아르메니아어", "popular": False},
    {"code": "az", "name": "Azerbaijani", "ko_name": "아제르바이잔어", "popular": False},
    {"code": "eu", "name": "Basque", "ko_name": "바스크어", "popular": False},
    {"code": "be", "name": "Belarusian", "ko_name": "벨라루스어", "popular": False},
    {"code": "bn", "name": "Bengali", "ko_name": "벵골어", "popular": False},
    {"code": "bg", "name": "Bulgarian", "ko_name": "불가리아어", "popular": False},
    {"code": "my", "name": "Burmese (Myanmar)", "ko_name": "미얀마어 (버마어)", "popular": False},
    {"code": "ca", "name": "Catalan", "ko_name": "카탈로니아어", "popular": False},
    {"code": "hr", "name": "Croatian", "ko_name": "크로아티아어", "popular": False},
    {"code": "cs", "name": "Czech", "ko_name": "체코어", "popular": False},
    {"code": "da", "name": "Danish", "ko_name": "덴마크어", "popular": False},
    {"code": "nl", "name": "Dutch", "ko_name": "네덜란드어", "popular": False},
    {"code": "et", "name": "Estonian", "ko_name": "에스토니아어", "popular": False},
    {"code": "fil", "name": "Filipino", "ko_name": "필리핀어", "popular": False},
    {"code": "fi", "name": "Finnish", "ko_name": "핀란드어", "popular": False},
    {"code": "gl", "name": "Galician", "ko_name": "갈리시아어", "popular": False},
    {"code": "ka", "name": "Georgian", "ko_name": "조지아어", "popular": False},
    {"code": "el", "name": "Greek", "ko_name": "그리스어", "popular": False},
    {"code": "gu", "name": "Gujarati", "ko_name": "구자라트어", "popular": False},
    {"code": "ha", "name": "Hausa", "ko_name": "하우사어", "popular": False},
    {"code": "he", "name": "Hebrew", "ko_name": "히브리어", "popular": False},
    {"code": "hu", "name": "Hungarian", "ko_name": "헝가리어", "popular": False},
    {"code": "is", "name": "Icelandic", "ko_name": "아이슬란드어", "popular": False},
    {"code": "it", "name": "Italian", "ko_name": "이탈리아어", "popular": False},
    {"code": "jv", "name": "Javanese", "ko_name": "자바어", "popular": False},
    {"code": "kn", "name": "Kannada", "ko_name": "칸나다어", "popular": False},
    {"code": "kk", "name": "Kazakh", "ko_name": "카자흐어", "popular": False},
    {"code": "km", "name": "Khmer", "ko_name": "크메르어", "popular": False},
    {"code": "rw", "name": "Kinyarwanda", "ko_name": "키냐르완다어", "popular": False},
    {"code": "lo", "name": "Lao", "ko_name": "라오어", "popular": False},
    {"code": "lv", "name": "Latvian", "ko_name": "라트비아어", "popular": False},
    {"code": "lt", "name": "Lithuanian", "ko_name": "리투아니아어", "popular": False},
    {"code": "mk", "name": "Macedonian", "ko_name": "마케도니아어", "popular": False},
    {"code": "ms", "name": "Malay", "ko_name": "말레이어", "popular": False},
    {"code": "ml", "name": "Malayalam", "ko_name": "말라얄람어", "popular": False},
    {"code": "mr", "name": "Marathi", "ko_name": "마라티어", "popular": False},
    {"code": "mn", "name": "Mongolian", "ko_name": "몽골어", "popular": False},
    {"code": "ne", "name": "Nepali", "ko_name": "네팔어", "popular": False},
    {"code": "no", "name": "Norwegian", "ko_name": "노르웨이어", "popular": False},
    {"code": "nb", "name": "Norwegian Bokmål", "ko_name": "노르웨이어 (보크몰)", "popular": False},
    {"code": "fa", "name": "Persian", "ko_name": "페르시아어", "popular": False},
    {"code": "pl", "name": "Polish", "ko_name": "폴란드어", "popular": False},
    {"code": "pt-PT", "name": "Portuguese (Portugal)", "ko_name": "포르투갈어 (포르투갈)", "popular": False},
    {"code": "pa", "name": "Punjabi", "ko_name": "펀자브어", "popular": False},
    {"code": "ro", "name": "Romanian", "ko_name": "루마니아어", "popular": False},
    {"code": "sr", "name": "Serbian", "ko_name": "세르비아어", "popular": False},
    {"code": "sd", "name": "Sindhi", "ko_name": "신디어", "popular": False},
    {"code": "si", "name": "Sinhala", "ko_name": "싱할라어", "popular": False},
    {"code": "sk", "name": "Slovak", "ko_name": "슬로바키아어", "popular": False},
    {"code": "sl", "name": "Slovenian", "ko_name": "슬로베니아어", "popular": False},
    {"code": "su", "name": "Sundanese", "ko_name": "순다어", "popular": False},
    {"code": "sw", "name": "Swahili", "ko_name": "스와힐리어", "popular": False},
    {"code": "sv", "name": "Swedish", "ko_name": "스웨덴어", "popular": False},
    {"code": "ta", "name": "Tamil", "ko_name": "타밀어", "popular": False},
    {"code": "te", "name": "Telugu", "ko_name": "텔루구어", "popular": False},
    {"code": "tr", "name": "Turkish", "ko_name": "튀르키예어", "popular": False},
    {"code": "uk", "name": "Ukrainian", "ko_name": "우크라이나어", "popular": False},
    {"code": "ur", "name": "Urdu", "ko_name": "우르두어", "popular": False},
    {"code": "uz", "name": "Uzbek", "ko_name": "우즈베크어", "popular": False},
    {"code": "zu", "name": "Zulu", "ko_name": "줄루어", "popular": False},
]
