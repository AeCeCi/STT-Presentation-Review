"""로그인 세션 저장소 (output/auth/sessions.json).

- 토큰: secrets.token_urlsafe(32). 파일에는 토큰의 sha256 16진수만 키로 저장한다.
- 값: {user_id, created_at, last_seen_at, ip, user_agent}
- 만료: last_seen_at 기준 7일 (요청마다 연장되는 슬라이딩 방식). 읽기/쓰기 때 만료분을 정리한다.
- 쿠키: stt_session; HttpOnly; SameSite=Lax; Path=/; X-Forwarded-Proto 가 https 일 때만 Secure.
"""

import json
import os
import secrets
import threading
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

from .store import AUTH_DIR, KST, normalize_id

SESSIONS_PATH = Path(AUTH_DIR) / "sessions.json"
SESSION_TTL_SECONDS = 7 * 24 * 3600
TOUCH_INTERVAL_SECONDS = 60  # last_seen_at 갱신을 파일에 쓰는 최소 간격 (요청마다 쓰지 않도록)
COOKIE_NAME = "stt_session"

_LOCK = threading.RLock()


def _now() -> datetime:
    return datetime.now(KST)


def _parse(ts: Any) -> datetime | None:
    try:
        value = datetime.fromisoformat(str(ts))
    except (TypeError, ValueError):
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=KST)
    return value


def hash_token(token: str) -> str:
    return sha256(str(token or "").encode("utf-8")).hexdigest()


def _is_expired(session: dict[str, Any], now: datetime) -> bool:
    last_seen = _parse(session.get("last_seen_at")) or _parse(session.get("created_at"))
    if last_seen is None:
        return True
    return (now - last_seen).total_seconds() > SESSION_TTL_SECONDS


def _load() -> dict[str, dict[str, Any]]:
    """세션 전체를 읽고 만료분을 걸러 돌려준다 (파일은 저장 시점에 정리된다)."""
    if not SESSIONS_PATH.exists():
        return {}
    try:
        raw = json.loads(SESSIONS_PATH.read_text(encoding="utf-8") or "{}")
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(raw, dict):
        return {}
    now = _now()
    return {
        key: value for key, value in raw.items()
        if isinstance(value, dict) and not _is_expired(value, now)
    }


def _save(sessions: dict[str, dict[str, Any]]) -> None:
    now = _now()
    cleaned = {key: value for key, value in sessions.items() if not _is_expired(value, now)}
    AUTH_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = SESSIONS_PATH.with_name(f".{SESSIONS_PATH.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(cleaned, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_path, SESSIONS_PATH)


def create_session(user_id: str, ip: str = "", user_agent: str = "") -> str:
    token = secrets.token_urlsafe(32)
    now_iso = _now().isoformat(timespec="seconds")
    with _LOCK:
        sessions = _load()
        sessions[hash_token(token)] = {
            "user_id": normalize_id(user_id),
            "created_at": now_iso,
            "last_seen_at": now_iso,
            "ip": str(ip or "")[:64],
            "user_agent": str(user_agent or "")[:256],
        }
        _save(sessions)
    return token


def get_session(token: str) -> dict[str, Any] | None:
    """유효한 세션이면 값을 돌려주고 last_seen_at 을 연장한다. 없거나 만료면 None."""
    if not token:
        return None
    key = hash_token(token)
    with _LOCK:
        sessions = _load()
        session = sessions.get(key)
        if session is None:
            return None
        now = _now()
        last_seen = _parse(session.get("last_seen_at"))
        if last_seen is None or (now - last_seen).total_seconds() >= TOUCH_INTERVAL_SECONDS:
            session["last_seen_at"] = now.isoformat(timespec="seconds")
            _save(sessions)
        return dict(session)


def delete_session(token: str) -> bool:
    if not token:
        return False
    key = hash_token(token)
    with _LOCK:
        sessions = _load()
        if key not in sessions:
            _save(sessions)
            return False
        del sessions[key]
        _save(sessions)
        return True


def delete_user_sessions(user_id: str, keep_token: str | None = None) -> int:
    """해당 사용자의 세션을 모두 지운다. keep_token 이 있으면 그 세션은 남긴다."""
    target = normalize_id(user_id)
    keep_key = hash_token(keep_token) if keep_token else None
    with _LOCK:
        sessions = _load()
        doomed = [
            key for key, value in sessions.items()
            if normalize_id(value.get("user_id")) == target and key != keep_key
        ]
        for key in doomed:
            del sessions[key]
        _save(sessions)
    return len(doomed)


def count_sessions() -> int:
    with _LOCK:
        return len(_load())


# ---------- 쿠키 ----------

def token_from_cookie_header(header: str | None) -> str:
    """Cookie 헤더에서 stt_session 값을 꺼낸다. 없으면 빈 문자열."""
    for part in str(header or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name.strip() == COOKIE_NAME:
            return value.strip().strip('"')
    return ""


def cookie_header(token: str, secure: bool) -> str:
    attrs = [f"{COOKIE_NAME}={token}", f"Max-Age={SESSION_TTL_SECONDS}", "Path=/", "HttpOnly", "SameSite=Lax"]
    if secure:
        attrs.append("Secure")
    return "; ".join(attrs)


def expired_cookie_header(secure: bool) -> str:
    attrs = [f"{COOKIE_NAME}=", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT", "Path=/", "HttpOnly", "SameSite=Lax"]
    if secure:
        attrs.append("Secure")
    return "; ".join(attrs)
