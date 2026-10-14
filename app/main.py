import asyncio
import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel

from app.config import (
    APP_LOGIN_PASSWORD,
    APP_SESSION_HOURS,
    APP_SESSION_SECRET,
    AUTH_MODE,
    GOOGLE_CLOUD_LOCATION,
    GOOGLE_CLOUD_PROJECT,
    INACTIVITY_TIMEOUT_SECONDS,
    LIVE_TRANSLATE_MODEL,
    PLAYOUT_DELAY_SECONDS,
    SUBTITLE_EXTRA_DELAY_SECONDS,
    SUPPORTED_LANGUAGES,
    SUPPORTED_VOICES,
    VALID_VOICE_IDS,
    VIDEOS_GCS_BUCKET,
    VIDEOS_GCS_PREFIX,
    create_genai_client,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("live-translate")

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(
    title="Google Gemini 3.5 Live Video Translate",
    description="Real-time video dubbing & subtitle translation powered by gemini-3.5-live-translate-preview",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Login gate (fixed shared password from .env, HMAC-signed HttpOnly cookie)
# ---------------------------------------------------------------------------
AUTH_COOKIE_NAME = "lt_auth"
LOGIN_ENABLED = bool(APP_LOGIN_PASSWORD)
# Paths reachable without a login cookie
PUBLIC_PATH_PREFIXES = ("/login", "/api/login", "/static/", "/favicon.ico")


def _sign(payload: str) -> str:
    return hmac.new(
        APP_SESSION_SECRET.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def _make_auth_token() -> str:
    """Token format: <expiry_epoch>.<nonce>.<hmac>"""
    expires = int(time.time()) + APP_SESSION_HOURS * 3600
    payload = f"{expires}.{secrets.token_urlsafe(16)}"
    return f"{payload}.{_sign(payload)}"


def _is_valid_auth_token(token: Optional[str]) -> bool:
    if not token:
        return False
    try:
        expires_str, nonce, sig = token.rsplit(".", 2)
        payload = f"{expires_str}.{nonce}"
        if not hmac.compare_digest(_sign(payload), sig):
            return False
        return int(expires_str) > int(time.time())
    except Exception:
        return False


def _is_authenticated(cookies: dict) -> bool:
    if not LOGIN_ENABLED:
        return True
    return _is_valid_auth_token(cookies.get(AUTH_COOKIE_NAME))


def _is_https(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    return proto == "https"


class LoginRequest(BaseModel):
    password: str


@app.middleware("http")
async def disable_static_cache(request, call_next):
    # Redirect 0.0.0.0 to localhost so browsers treat the page as a Secure Context
    host = request.headers.get("host", "")
    if host.startswith("0.0.0.0"):
        new_url = str(request.url).replace("://0.0.0.0", "://localhost", 1)
        return RedirectResponse(url=new_url, status_code=307)

    # Login gate: everything except login page/API and static UI assets requires a valid cookie.
    # Video media (/media/*) and APIs are intentionally NOT public.
    path = request.url.path
    is_public = path.startswith(PUBLIC_PATH_PREFIXES)
    if LOGIN_ENABLED and not is_public:
        if not _is_authenticated(request.cookies):
            if path.startswith("/api/") or path.startswith("/media/"):
                return JSONResponse(
                    status_code=401, content={"detail": "로그인이 필요합니다."}
                )
            return RedirectResponse(url="/login", status_code=303)

    response = await call_next(request)
    if path in ("/", "/login") or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


@app.get("/login")
async def serve_login(request: Request):
    if not LOGIN_ENABLED or _is_authenticated(request.cookies):
        return RedirectResponse(url="/", status_code=303)
    return FileResponse(str(STATIC_DIR / "login.html"))


@app.post("/api/login")
async def api_login(req: LoginRequest, request: Request):
    if not LOGIN_ENABLED:
        return {"ok": True}
    # Constant-time compare to avoid timing leaks
    if not hmac.compare_digest(req.password.strip(), APP_LOGIN_PASSWORD):
        await asyncio.sleep(0.6)  # slow down brute-force attempts
        raise HTTPException(status_code=401, detail="비밀번호가 올바르지 않습니다.")

    response = JSONResponse(content={"ok": True})
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=_make_auth_token(),
        max_age=APP_SESSION_HOURS * 3600,
        httponly=True,
        samesite="lax",
        secure=_is_https(request),
        path="/",
    )
    return response


@app.post("/api/logout")
async def api_logout():
    response = JSONResponse(content={"ok": True})
    response.delete_cookie(AUTH_COOKIE_NAME, path="/")
    return response


@app.get("/api/config")
async def get_config():
    """Return application configuration, supported languages and voice presets."""
    return {
        "auth_mode": AUTH_MODE,
        "project": GOOGLE_CLOUD_PROJECT,
        "location": GOOGLE_CLOUD_LOCATION,
        "live_translate_model": LIVE_TRANSLATE_MODEL,
        "inactivity_timeout_seconds": INACTIVITY_TIMEOUT_SECONDS,
        "default_target_language": "ko",
        "echo_target_language": True,
        "supported_languages": SUPPORTED_LANGUAGES,
        "supported_voices": SUPPORTED_VOICES,
        "video_source": f"gs://{VIDEOS_GCS_BUCKET}/{VIDEOS_GCS_PREFIX}".rstrip("/") if VIDEOS_GCS_BUCKET else "local",
        "playout_delay_seconds": PLAYOUT_DELAY_SECONDS,
        "subtitle_extra_delay_seconds": SUBTITLE_EXTRA_DELAY_SECONDS,
    }


# ---------------------------------------------------------------------------
# Video catalogue & media delivery.
#
# Source: a GCS bucket (VIDEOS_GCS_BUCKET) or, when unset, the local videos/ folder.
# Every media response is capped at MEDIA_CHUNK_BYTES and returned as 206 so a
# single response never exceeds Cloud Run's 32 MiB non-chunked limit; browsers
# simply keep requesting subsequent ranges.
# ---------------------------------------------------------------------------
VIDEOS_DIR = BASE_DIR / "videos"
MEDIA_CHUNK_BYTES = 8 * 1024 * 1024
MEDIA_READ_BLOCK = 1024 * 1024
MEDIA_TYPES = {".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v"}
GCS_META_TTL_SECONDS = 600

_gcs_client = None
_gcs_meta_cache: dict[str, tuple[float, int]] = {}  # object name -> (cached_at, size)


def _gcs_object_name(filename: str) -> str:
    return f"{VIDEOS_GCS_PREFIX}/{filename}" if VIDEOS_GCS_PREFIX else filename


def _gcs_bucket():
    """Lazily create the Storage client (ADC) and return the configured bucket."""
    global _gcs_client
    if _gcs_client is None:
        from google.cloud import storage  # imported lazily so local mode works without the package

        _gcs_client = storage.Client(project=GOOGLE_CLOUD_PROJECT or None)
    return _gcs_client.bucket(VIDEOS_GCS_BUCKET)


def _gcs_object_size(object_name: str) -> Optional[int]:
    """Blocking: fetch (and cache) the object size, or None if it does not exist."""
    now = time.monotonic()
    cached = _gcs_meta_cache.get(object_name)
    if cached and now - cached[0] < GCS_META_TTL_SECONDS:
        return cached[1]
    blob = _gcs_bucket().get_blob(object_name)
    if blob is None or blob.size is None:
        return None
    _gcs_meta_cache[object_name] = (now, int(blob.size))
    return int(blob.size)


def _gcs_read_range(object_name: str, start: int, end: int) -> bytes:
    """Blocking: download bytes [start, end] inclusive."""
    return _gcs_bucket().blob(object_name).download_as_bytes(start=start, end=end)


def _parse_range(header: Optional[str], size: int):
    """Return (start, end) inclusive for a single-range header, or None for full content."""
    if not header or not header.startswith("bytes="):
        return None
    spec = header[6:].split(",")[0].strip()
    if "-" not in spec:
        return None
    start_s, end_s = spec.split("-", 1)
    try:
        if start_s == "":
            # suffix range: last N bytes
            length = int(end_s)
            if length <= 0:
                return None
            return max(0, size - length), size - 1
        start = int(start_s)
        end = int(end_s) if end_s else size - 1
    except ValueError:
        return None
    if start >= size or start < 0:
        return "unsatisfiable"
    return start, min(end, size - 1)


@app.get("/api/videos")
async def list_videos():
    """Return the video catalogue (videos.json) from GCS or the local folder."""
    if VIDEOS_GCS_BUCKET:
        try:
            raw = await asyncio.to_thread(
                lambda: _gcs_bucket().blob(_gcs_object_name("videos.json")).download_as_bytes()
            )
            data = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            logger.error("Failed to load videos.json from gs://%s: %s", VIDEOS_GCS_BUCKET, exc)
            raise HTTPException(status_code=502, detail="비디오 목록을 GCS에서 불러오지 못했습니다.") from exc
    else:
        local = VIDEOS_DIR / "videos.json"
        if not local.is_file():
            return {"videos": [], "source": "local"}
        data = json.loads(local.read_text(encoding="utf-8"))
    videos = [v for v in data.get("videos", []) if isinstance(v, dict) and v.get("file")]
    return {"videos": videos, "source": f"gs://{VIDEOS_GCS_BUCKET}" if VIDEOS_GCS_BUCKET else "local"}


@app.get("/media/{filename}")
async def serve_media(filename: str, request: Request):
    safe_name = Path(filename).name
    suffix = Path(safe_name).suffix.lower()
    if safe_name != filename or suffix not in MEDIA_TYPES:
        raise HTTPException(status_code=404, detail="Video not found")
    media_type = MEDIA_TYPES[suffix]

    # Resolve size from the configured source
    if VIDEOS_GCS_BUCKET:
        object_name = _gcs_object_name(safe_name)
        try:
            size = await asyncio.to_thread(_gcs_object_size, object_name)
        except Exception as exc:
            logger.error("GCS metadata error for %s: %s", object_name, exc)
            raise HTTPException(status_code=502, detail="비디오 저장소에 접근할 수 없습니다.") from exc
        if size is None:
            raise HTTPException(status_code=404, detail="Video not found")
        file_path = None
    else:
        file_path = (VIDEOS_DIR / safe_name).resolve()
        if VIDEOS_DIR.resolve() not in file_path.parents or not file_path.is_file():
            raise HTTPException(status_code=404, detail="Video not found")
        size = file_path.stat().st_size
        object_name = None

    parsed = _parse_range(request.headers.get("range"), size)
    if parsed == "unsatisfiable":
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"})

    if parsed is None:
        start, end = 0, min(size, MEDIA_CHUNK_BYTES) - 1
    else:
        start, end = parsed
        end = min(end, start + MEDIA_CHUNK_BYTES - 1)
    length = end - start + 1

    async def iter_gcs():
        pos = start
        while pos <= end:
            block_end = min(end, pos + MEDIA_READ_BLOCK - 1)
            data = await asyncio.to_thread(_gcs_read_range, object_name, pos, block_end)
            if not data:
                break
            pos += len(data)
            yield data

    def iter_local():
        with open(file_path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                block = f.read(min(MEDIA_READ_BLOCK, remaining))
                if not block:
                    break
                remaining -= len(block)
                yield block

    headers = {
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Cache-Control": "private, max-age=3600",
    }
    body = iter_gcs() if VIDEOS_GCS_BUCKET else iter_local()
    # Always 206 so that no single response exceeds the platform size limit.
    return StreamingResponse(body, status_code=206, media_type=media_type, headers=headers)


def build_live_connect_config(
    target_language_code: str,
    echo_target_language: bool = True,
    voice_name: Optional[str] = None,
    session_handle: Optional[str] = None,
    enable_session_management: bool = True,
) -> types.LiveConnectConfig:
    """
    Build LiveConnectConfig for gemini-3.5-live-translate-preview.
    Includes:
    - response_modalities=["AUDIO"]
    - input_audio_transcription & output_audio_transcription
    - translation_config (target_language_code, echo_target_language)
    - optional speech_config (prebuilt voice) when voice_name is not "auto"
    - context_window_compression (SlidingWindow) & session_resumption (handle)
    """
    kwargs = {
        "response_modalities": ["AUDIO"],
        "input_audio_transcription": types.AudioTranscriptionConfig(),
        "output_audio_transcription": types.AudioTranscriptionConfig(),
        "translation_config": types.TranslationConfig(
            target_language_code=target_language_code,
            echo_target_language=echo_target_language,
        ),
    }

    if voice_name and voice_name != "auto":
        kwargs["speech_config"] = types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice_name)
            )
        )

    if enable_session_management:
        kwargs["context_window_compression"] = types.ContextWindowCompressionConfig(
            sliding_window=types.SlidingWindow()
        )
        kwargs["session_resumption"] = types.SessionResumptionConfig(
            handle=session_handle
        )

    return types.LiveConnectConfig(**kwargs)


# In-memory registry of recent session resumption handles keyed by client session_id.
# Allows mobile (iOS/Android) & web clients to seamlessly resume after brief network drops or app switches.
SESSION_HANDLE_TTL_SECONDS = 600  # 10 minutes
RESUMABLE_SESSIONS: dict[str, dict] = {}


def _cleanup_expired_sessions() -> None:
    now = time.monotonic()
    expired = [
        sid
        for sid, info in RESUMABLE_SESSIONS.items()
        if now - info.get("updated_at", now) > SESSION_HANDLE_TTL_SECONDS
    ]
    for sid in expired:
        RESUMABLE_SESSIONS.pop(sid, None)


@app.websocket("/ws/translate")
async def websocket_translate(websocket: WebSocket):
    """
    Bidirectional WebSocket endpoint bridging browser video audio/UI with
    Gemini 3.5 Live Translate (gemini-3.5-live-translate-preview).
    Implements:
    - Binary downstream frames carrying translated 24kHz PCM audio
    - Automatic session resumption (SessionResumptionConfig) & GoAway handling
    - Client session_id handle persistence across network drops
    - Context window compression (SlidingWindow)
    - Inactivity timeout auto-termination
    - Seamless mid-session target language / voice switching
    """
    # Login gate for WebSocket (HTTP middleware does not run for WS upgrades)
    if not _is_authenticated(websocket.cookies):
        await websocket.close(code=4401, reason="Login required")
        return

    await websocket.accept()
    _cleanup_expired_sessions()

    query = websocket.query_params
    session_id = (query.get("session_id") or "").strip()
    target_lang = query.get("target_lang", "ko")
    echo_str = query.get("echo_target_language", "true").lower()
    echo_target_language = echo_str != "false"
    voice_name = (query.get("voice") or "auto").strip()
    if voice_name not in VALID_VOICE_IDS:
        voice_name = "auto"
    api_key_override = query.get("api_key") or None

    # Restore previous resumption handle if this client is reconnecting with the same translation config
    prior_handle: Optional[str] = None
    if session_id and session_id in RESUMABLE_SESSIONS:
        saved = RESUMABLE_SESSIONS[session_id]
        if saved.get("target_lang") == target_lang and saved.get("voice") == voice_name:
            prior_handle = saved.get("handle")

    # Queue for 16kHz PCM audio chunks coming from the browser video element
    audio_queue: asyncio.Queue[Optional[bytes]] = asyncio.Queue(maxsize=300)

    # Shared state across seamless session reconnections
    session_state = {
        "session_id": session_id,
        "target_lang": target_lang,
        "echo_target_language": echo_target_language,
        "voice": voice_name,
        "resumption_handle": prior_handle,
        "explicitly_stopped": False,
        "enable_session_management": True,
        "client_disconnected": False,
        "reconnect_requested": False,
        "reconnect_reason": "",
        "last_activity_ts": time.monotonic(),
        "location_override": "global" if AUTH_MODE == "adc" else None,
    }
    force_reconnect_event = asyncio.Event()

    async def send_ws_json(payload: dict):
        if session_state["client_disconnected"]:
            return
        try:
            await websocket.send_text(json.dumps(payload, ensure_ascii=False))
        except Exception:
            session_state["client_disconnected"] = True

    async def send_ws_bytes(payload: bytes):
        if session_state["client_disconnected"]:
            return
        try:
            await websocket.send_bytes(payload)
        except Exception:
            session_state["client_disconnected"] = True

    async def inactivity_watchdog():
        """
        Monitor conversation/audio activity and automatically terminate the session
        if inactive for INACTIVITY_TIMEOUT_SECONDS (default: 600s = 10 minutes).
        """
        try:
            while not session_state["client_disconnected"]:
                await asyncio.sleep(5.0)
                if session_state["client_disconnected"]:
                    break
                idle_seconds = time.monotonic() - session_state["last_activity_ts"]
                if idle_seconds >= INACTIVITY_TIMEOUT_SECONDS:
                    mins = INACTIVITY_TIMEOUT_SECONDS // 60
                    logger.info(
                        "Session inactive for %.1fs (>= %ds). Terminating session.",
                        idle_seconds,
                        INACTIVITY_TIMEOUT_SECONDS,
                    )
                    await send_ws_json(
                        {
                            "type": "inactive_timeout",
                            "timeout_seconds": INACTIVITY_TIMEOUT_SECONDS,
                            "message": f"{mins}분 이상 오디오 입력이 없어 세션이 자동으로 종료되었습니다.",
                        }
                    )
                    session_state["client_disconnected"] = True
                    force_reconnect_event.set()
                    break
        except asyncio.CancelledError:
            pass

    async def client_reader_loop():
        """Read incoming PCM audio bytes or JSON control messages from the browser."""
        try:
            while not session_state["client_disconnected"]:
                msg = await websocket.receive()
                if msg.get("type") == "websocket.disconnect":
                    session_state["client_disconnected"] = True
                    break

                if "bytes" in msg and msg["bytes"] is not None:
                    pcm_bytes = msg["bytes"]
                    if pcm_bytes:
                        if audio_queue.full():
                            try:
                                audio_queue.get_nowait()
                            except asyncio.QueueEmpty:
                                pass
                        await audio_queue.put(pcm_bytes)

                elif "text" in msg and msg["text"] is not None:
                    try:
                        data = json.loads(msg["text"])
                    except json.JSONDecodeError:
                        continue

                    msg_type = data.get("type")
                    if msg_type == "audio":
                        b64_data = data.get("data", "")
                        if b64_data:
                            pcm_bytes = base64.b64decode(b64_data)
                            if audio_queue.full():
                                try:
                                    audio_queue.get_nowait()
                                except asyncio.QueueEmpty:
                                    pass
                            await audio_queue.put(pcm_bytes)

                    elif msg_type == "activity":
                        # Client reports audible source activity (keeps inactivity watchdog alive)
                        session_state["last_activity_ts"] = time.monotonic()

                    elif msg_type == "update_config":
                        session_state["last_activity_ts"] = time.monotonic()
                        new_target = data.get("target_lang", session_state["target_lang"])
                        new_echo = data.get(
                            "echo_target_language", session_state["echo_target_language"]
                        )
                        new_voice = (data.get("voice") or session_state["voice"]).strip()
                        if new_voice not in VALID_VOICE_IDS:
                            new_voice = session_state["voice"]

                        config_changed = (
                            new_target != session_state["target_lang"]
                            or bool(new_echo) != bool(session_state["echo_target_language"])
                            or new_voice != session_state["voice"]
                        )
                        session_state["target_lang"] = new_target
                        session_state["echo_target_language"] = bool(new_echo)
                        session_state["voice"] = new_voice

                        if config_changed:
                            # Reset resumption handle when translation config changes
                            session_state["resumption_handle"] = None
                            if session_state["session_id"]:
                                RESUMABLE_SESSIONS.pop(session_state["session_id"], None)
                            session_state["reconnect_requested"] = True
                            session_state["reconnect_reason"] = (
                                f"번역 설정 변경 (target={new_target}, voice={new_voice})으로 세션을 재연결합니다."
                            )
                            force_reconnect_event.set()
                        else:
                            await send_ws_json(
                                {
                                    "type": "config_updated",
                                    "target_lang": new_target,
                                    "echo_target_language": session_state[
                                        "echo_target_language"
                                    ],
                                    "voice": new_voice,
                                }
                            )

                    elif msg_type == "stop":
                        logger.info("Client requested explicit session termination.")
                        session_state["explicitly_stopped"] = True
                        if session_state["session_id"]:
                            RESUMABLE_SESSIONS.pop(session_state["session_id"], None)
                        await send_ws_json(
                            {
                                "type": "session_closed",
                                "reason": data.get("reason", "explicit_stop"),
                                "message": "Live API 세션이 종료되었습니다.",
                            }
                        )
                        session_state["client_disconnected"] = True
                        force_reconnect_event.set()
                        break

        except WebSocketDisconnect:
            session_state["client_disconnected"] = True
        except Exception as exc:
            logger.debug("Client reader loop ended: %s", exc)
            session_state["client_disconnected"] = True
        finally:
            force_reconnect_event.set()
            try:
                audio_queue.put_nowait(None)
            except asyncio.QueueFull:
                pass

    async def run_gemini_session(session):
        """Run concurrent audio sender and response receiver for an active Gemini Live session."""
        session_closed = asyncio.Event()

        async def upstream_sender():
            chunk_count = 0
            try:
                while (
                    not session_state["client_disconnected"]
                    and not session_closed.is_set()
                    and not force_reconnect_event.is_set()
                ):
                    try:
                        chunk = await asyncio.wait_for(audio_queue.get(), timeout=0.25)
                    except asyncio.TimeoutError:
                        continue

                    if chunk is None:
                        break

                    chunk_count += 1
                    if chunk_count == 1 or chunk_count % 50 == 0:
                        # Check peak 16-bit PCM sample amplitude for diagnostics
                        import array
                        samples = array.array("h", chunk[: len(chunk) - (len(chunk) % 2)])
                        peak = max((abs(s) for s in samples), default=0)
                        if peak > 350:
                            session_state["last_activity_ts"] = time.monotonic()
                        logger.info(
                            "Streaming audio chunk #%d (%d bytes, peak_amp=%d/32767)",
                            chunk_count,
                            len(chunk),
                            peak,
                        )

                    await session.send_realtime_input(
                        audio=types.Blob(
                            data=chunk,
                            mime_type="audio/pcm;rate=16000",
                        )
                    )
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                if not session_state["client_disconnected"]:
                    logger.warning("Upstream sender ended: %s", exc)
                session_closed.set()

        async def upstream_receiver():
            try:
                while (
                    not session_state["client_disconnected"]
                    and not session_closed.is_set()
                    and not force_reconnect_event.is_set()
                ):
                    async for response in session.receive():
                        if (
                            session_state["client_disconnected"]
                            or force_reconnect_event.is_set()
                        ):
                            break

                        # 1. Handle Session Resumption Token Update
                        if response.session_resumption_update:
                            update = response.session_resumption_update
                            if update.resumable and update.new_handle:
                                session_state["resumption_handle"] = update.new_handle
                                if (
                                    session_state["session_id"]
                                    and not session_state["explicitly_stopped"]
                                ):
                                    RESUMABLE_SESSIONS[session_state["session_id"]] = {
                                        "handle": update.new_handle,
                                        "target_lang": session_state["target_lang"],
                                        "voice": session_state["voice"],
                                        "updated_at": time.monotonic(),
                                    }
                                handle_preview = (
                                    update.new_handle[:10] + "..."
                                    if len(update.new_handle) > 10
                                    else update.new_handle
                                )
                                await send_ws_json(
                                    {
                                        "type": "session_resumption",
                                        "resumable": True,
                                        "handle_preview": handle_preview,
                                    }
                                )

                        # 2. Handle GoAway Message (Proactive connection termination notice for 2+ hour sessions)
                        if response.go_away is not None:
                            time_left = getattr(response.go_away, "time_left", None)
                            logger.info(
                                "Received GoAway from Live API (time_left=%s)", time_left
                            )
                            await send_ws_json(
                                {
                                    "type": "go_away",
                                    "time_left": str(time_left or "곧 만료"),
                                }
                            )
                            session_state["reconnect_requested"] = True
                            session_state["reconnect_reason"] = (
                                f"세션 수명 만료 알림(GoAway, 남은 시간: {time_left}) 수신 — 세션 핸들로 자동 연장합니다."
                            )
                            force_reconnect_event.set()
                            break

                        # 3. Handle Server Content (Transcriptions & Translated Audio)
                        server_content = response.server_content
                        if server_content:
                            # Interim input transcription (if provided)
                            interim_in = getattr(
                                server_content, "interim_input_transcription", None
                            )
                            if interim_in and getattr(interim_in, "text", None):
                                session_state["last_activity_ts"] = time.monotonic()
                                await send_ws_json(
                                    {
                                        "type": "input_transcription",
                                        "text": interim_in.text,
                                        "finished": bool(
                                            getattr(interim_in, "finished", False)
                                        ),
                                        "language_code": getattr(
                                            interim_in, "language_code", None
                                        ),
                                        "interim": True,
                                    }
                                )

                            # Input (Source) audio transcription
                            in_trans = server_content.input_transcription
                            if in_trans and in_trans.text:
                                session_state["last_activity_ts"] = time.monotonic()
                                logger.info(
                                    "[Source Transcript] (%s): %s",
                                    getattr(in_trans, "language_code", "-"),
                                    in_trans.text,
                                )
                                await send_ws_json(
                                    {
                                        "type": "input_transcription",
                                        "text": in_trans.text,
                                        "finished": bool(
                                            getattr(in_trans, "finished", False)
                                        ),
                                        "language_code": getattr(
                                            in_trans, "language_code", None
                                        ),
                                        "interim": False,
                                    }
                                )

                            # Output (Target translated) audio transcription
                            out_trans = server_content.output_transcription
                            if out_trans and out_trans.text:
                                session_state["last_activity_ts"] = time.monotonic()
                                logger.info(
                                    "[Target Translation] (%s): %s",
                                    session_state["target_lang"],
                                    out_trans.text,
                                )
                                await send_ws_json(
                                    {
                                        "type": "output_transcription",
                                        "text": out_trans.text,
                                        "finished": bool(
                                            getattr(out_trans, "finished", False)
                                        ),
                                        "language_code": getattr(
                                            out_trans, "language_code", None
                                        )
                                        or session_state["target_lang"],
                                    }
                                )

                            # Model turn: translated speech (raw 16-bit PCM @ 24kHz) -> binary WS frame
                            if server_content.model_turn and server_content.model_turn.parts:
                                session_state["last_activity_ts"] = time.monotonic()
                                for part in server_content.model_turn.parts:
                                    inline = getattr(part, "inline_data", None)
                                    if inline and inline.data:
                                        await send_ws_bytes(inline.data)

                            # Turn / Generation completion signals
                            if (
                                server_content.turn_complete
                                or server_content.generation_complete
                            ):
                                await send_ws_json(
                                    {
                                        "type": "turn_complete",
                                        "turn_complete": bool(
                                            server_content.turn_complete
                                        ),
                                        "generation_complete": bool(
                                            server_content.generation_complete
                                        ),
                                    }
                                )

            except asyncio.CancelledError:
                pass
            except genai_errors.APIError as api_err:
                if not session_state["client_disconnected"]:
                    logger.warning("Gemini Live session closed/error: %s", api_err)
                    session_state["reconnect_requested"] = True
                    session_state["reconnect_reason"] = (
                        "연결 주기가 도달하여 세션을 자동으로 연장합니다."
                    )
            except Exception as exc:
                if not session_state["client_disconnected"]:
                    logger.warning("Receiver loop ended with exception: %s", exc)
                    session_state["reconnect_requested"] = True
                    session_state["reconnect_reason"] = (
                        "일시적 연결 끊김이 감지되어 자동 재연결합니다."
                    )
            finally:
                session_closed.set()

        sender_task = asyncio.create_task(upstream_sender())
        receiver_task = asyncio.create_task(upstream_receiver())

        done, pending = await asyncio.wait(
            [sender_task, receiver_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    # Start reading from client browser WebSocket and inactivity watchdog in background
    reader_task = asyncio.create_task(client_reader_loop())
    watchdog_task = asyncio.create_task(inactivity_watchdog())

    client = create_genai_client(
        api_key_override=api_key_override,
        location_override=session_state["location_override"],
    )
    retry_count = 0

    try:
        while not session_state["client_disconnected"]:
            force_reconnect_event.clear()
            target_lang_now = session_state["target_lang"]
            echo_now = session_state["echo_target_language"]
            voice_now = session_state["voice"]
            handle_now = session_state["resumption_handle"]

            config = build_live_connect_config(
                target_language_code=target_lang_now,
                echo_target_language=echo_now,
                voice_name=voice_now,
                session_handle=handle_now,
                enable_session_management=session_state["enable_session_management"],
            )

            status_mode = "resuming" if handle_now else "connecting"
            await send_ws_json(
                {
                    "type": "status",
                    "status": status_mode,
                    "model": LIVE_TRANSLATE_MODEL,
                    "target_lang": target_lang_now,
                    "echo_target_language": echo_now,
                    "voice": voice_now,
                    "session_management": session_state["enable_session_management"],
                    "resumed": bool(handle_now),
                    "message": session_state["reconnect_reason"]
                    or (
                        "이전 세션 핸들로 연결을 자동 연장 중입니다..."
                        if handle_now
                        else "Gemini 3.5 Live Translate 세션 연결 중..."
                    ),
                }
            )
            session_state["reconnect_reason"] = ""

            try:
                async with client.aio.live.connect(
                    model=LIVE_TRANSLATE_MODEL, config=config
                ) as session:
                    retry_count = 0
                    session_state["last_activity_ts"] = time.monotonic()
                    await send_ws_json(
                        {
                            "type": "status",
                            "status": "connected",
                            "model": LIVE_TRANSLATE_MODEL,
                            "target_lang": target_lang_now,
                            "echo_target_language": echo_now,
                            "voice": voice_now,
                            "session_management": session_state[
                                "enable_session_management"
                            ],
                            "resumed": bool(handle_now),
                            "message": "실시간 번역 세션이 활성화되었습니다.",
                        }
                    )
                    await run_gemini_session(session)

            except Exception as conn_err:
                if session_state["client_disconnected"]:
                    break

                err_msg = str(conn_err)
                logger.warning("Live connect exception: %s", err_msg)

                # If resumption handle expired or was rejected, clear it and retry immediately
                if session_state["resumption_handle"] is not None:
                    logger.info(
                        "Clearing expired/invalid resumption handle and retrying..."
                    )
                    session_state["resumption_handle"] = None
                    continue

                # If preview model endpoint rejected compression/resumption setup fields, fallback cleanly
                if session_state["enable_session_management"] and (
                    "compression" in err_msg.lower()
                    or "resumption" in err_msg.lower()
                    or "invalid" in err_msg.lower()
                    or "unsupported" in err_msg.lower()
                    or "1007" in err_msg
                ):
                    logger.info(
                        "Falling back to standard LiveConnectConfig without optional session management fields"
                    )
                    session_state["enable_session_management"] = False
                    continue

                retry_count += 1
                if retry_count > 3:
                    await send_ws_json(
                        {
                            "type": "error",
                            "message": f"Gemini Live API 연결 실패: {err_msg}",
                        }
                    )
                    break

                await send_ws_json(
                    {
                        "type": "status",
                        "status": "reconnecting",
                        "message": f"연결 재시도 중 ({retry_count}/3)...",
                    }
                )
                await asyncio.sleep(1.0)

    finally:
        session_state["client_disconnected"] = True
        reader_task.cancel()
        watchdog_task.cancel()
        await asyncio.gather(reader_task, watchdog_task, return_exceptions=True)
        try:
            await websocket.close()
        except Exception:
            pass
        logger.info("Live Translate WebSocket session explicitly closed.")


# Serve static files and root index.html
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def serve_index():
    return FileResponse(str(STATIC_DIR / "index.html"))
