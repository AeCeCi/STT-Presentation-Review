"""사용자 계정 저장소 (output/auth/users.json).

- 로그인 아이디는 앞뒤 공백을 제거하고 대소문자 구분 없이 유일하다.
- 비밀번호는 PBKDF2-HMAC-SHA256(200,000회, 16바이트 무작위 salt) 해시만 저장한다.
  저장 형식: ``pbkdf2_sha256$<iters>$<salt_b64>$<hash_b64>``
- 파일 쓰기는 임시 파일 + os.replace 로 원자적으로 수행하고 threading.RLock 으로 직렬화한다.
- 서버 시작 시 admin 역할 사용자가 없을 때만 .env(ADMIN_LOGIN_ID/ADMIN_LOGIN_PASSWORD)로 관리자를 만든다.
  그 뒤로는 이 파일이 기준이며 .env 값을 바꿔도 기존 관리자 비밀번호는 바뀌지 않는다.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..config.settings import OUTPUT_DIR

KST = timezone(timedelta(hours=9))
AUTH_DIR = Path(OUTPUT_DIR) / "auth"
USERS_PATH = AUTH_DIR / "users.json"

PBKDF2_ALGORITHM = "pbkdf2_sha256"
PBKDF2_ITERATIONS = 200_000
SALT_BYTES = 16
MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_LENGTH = 256
MAX_ID_LENGTH = 64
MAX_NAME_LENGTH = 60
ROLES = ("admin", "user")
ID_EXTRA_CHARS = "@._+-"
# 외부(API·CLI)로 내보내는 필드 — password(해시)는 절대 포함하지 않는다.
PUBLIC_FIELDS = ("id", "name", "role", "created_at", "created_by", "disabled", "last_login_at", "password_changed_at")

_LOCK = threading.RLock()


class AuthError(Exception):
    """계정 처리 오류. status 는 HTTP 응답 코드로 쓴다."""

    status = 400


class PolicyError(AuthError):
    status = 400


class UserExistsError(AuthError):
    status = 409


class UserNotFoundError(AuthError):
    status = 404


def now_iso() -> str:
    return datetime.now(KST).isoformat(timespec="seconds")


# ---------- 입력 검증 ----------

def normalize_id(raw: Any) -> str:
    return str(raw or "").strip().lower()


def validate_id(login_id: str) -> str:
    normalized = normalize_id(login_id)
    if not normalized:
        raise PolicyError("아이디를 입력하세요.")
    if len(normalized) > MAX_ID_LENGTH:
        raise PolicyError(f"아이디는 {MAX_ID_LENGTH}자 이하여야 합니다.")
    if not all(ch.isalnum() or ch in ID_EXTRA_CHARS for ch in normalized):
        raise PolicyError("아이디에는 영문·숫자·한글과 @ . _ + - 만 쓸 수 있습니다.")
    return normalized


def validate_name(name: Any) -> str:
    cleaned = " ".join(str(name or "").split())
    if not cleaned:
        raise PolicyError("이름을 입력하세요.")
    if len(cleaned) > MAX_NAME_LENGTH:
        raise PolicyError(f"이름은 {MAX_NAME_LENGTH}자 이하여야 합니다.")
    return cleaned


def validate_role(role: Any) -> str:
    value = str(role or "user").strip().lower()
    if value not in ROLES:
        raise PolicyError("역할은 admin 또는 user 여야 합니다.")
    return value


def validate_password(password: Any) -> str:
    if not isinstance(password, str) or not password:
        raise PolicyError("비밀번호를 입력하세요.")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise PolicyError(f"비밀번호는 {MIN_PASSWORD_LENGTH}자 이상이어야 합니다.")
    if len(password) > MAX_PASSWORD_LENGTH:
        raise PolicyError(f"비밀번호는 {MAX_PASSWORD_LENGTH}자 이하여야 합니다.")
    return password


# ---------- 비밀번호 해시 ----------

def hash_password(password: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "$".join([
        PBKDF2_ALGORITHM,
        str(iterations),
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    ])


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, iterations, salt_b64, hash_b64 = str(stored or "").split("$")
        if algorithm != PBKDF2_ALGORITHM:
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        digest = hashlib.pbkdf2_hmac("sha256", str(password or "").encode("utf-8"), salt, int(iterations))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest, expected)


# 존재하지 않는 아이디로 로그인해도 해시 계산 시간을 비슷하게 맞추기 위한 더미 해시.
_DUMMY_HASH = hash_password(secrets.token_urlsafe(12))


# ---------- 파일 입출력 ----------

def _empty_store() -> dict[str, Any]:
    return {"version": 1, "users": []}


def _load() -> dict[str, Any]:
    if not USERS_PATH.exists():
        return _empty_store()
    raw = USERS_PATH.read_text(encoding="utf-8")
    if not raw.strip():
        return _empty_store()
    data = json.loads(raw)  # 손상된 파일은 조용히 덮어쓰지 않고 예외를 낸다.
    if not isinstance(data, dict) or not isinstance(data.get("users"), list):
        raise RuntimeError(f"users.json 형식이 올바르지 않습니다: {USERS_PATH}")
    return data


def _save(data: dict[str, Any]) -> None:
    AUTH_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = USERS_PATH.with_name(f".{USERS_PATH.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    text = json.dumps(data, ensure_ascii=False, indent=2)
    with open(tmp_path, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_path, USERS_PATH)


def _find(users: list[dict[str, Any]], normalized_id: str) -> dict[str, Any] | None:
    for record in users:
        if normalize_id(record.get("id")) == normalized_id:
            return record
    return None


def public_view(record: dict[str, Any]) -> dict[str, Any]:
    view = {key: record.get(key) for key in PUBLIC_FIELDS}
    view["disabled"] = bool(view.get("disabled"))
    return view


# ---------- 조회 ----------

def list_users() -> list[dict[str, Any]]:
    with _LOCK:
        return [public_view(record) for record in _load()["users"]]


def get_user(login_id: str) -> dict[str, Any] | None:
    """공개 필드만 담은 사용자 정보. 없으면 None."""
    with _LOCK:
        record = _find(_load()["users"], normalize_id(login_id))
    return public_view(record) if record else None


def has_admin() -> bool:
    with _LOCK:
        return any(record.get("role") == "admin" for record in _load()["users"])


def count_users() -> int:
    with _LOCK:
        return len(_load()["users"])


# ---------- 변경 ----------

def create_user(login_id: str, name: str, password: str, role: str = "user", created_by: str = "") -> dict[str, Any]:
    normalized = validate_id(login_id)
    clean_name = validate_name(name)
    clean_role = validate_role(role)
    validate_password(password)
    with _LOCK:
        data = _load()
        if _find(data["users"], normalized):
            raise UserExistsError("이미 존재하는 아이디입니다.")
        record = {
            "id": normalized,
            "name": clean_name,
            "role": clean_role,
            "password": hash_password(password),
            "created_at": now_iso(),
            "created_by": str(created_by or ""),
            "disabled": False,
            "last_login_at": None,
            "password_changed_at": now_iso(),
        }
        data["users"].append(record)
        _save(data)
    return public_view(record)


def authenticate(login_id: str, password: str) -> dict[str, Any] | None:
    """아이디·비밀번호가 맞고 비활성화되지 않은 계정이면 공개 정보를, 아니면 None.

    실패 사유(없는 아이디/비밀번호 불일치/비활성화)는 구분해 돌려주지 않는다.
    """
    normalized = normalize_id(login_id)
    with _LOCK:
        record = _find(_load()["users"], normalized)
    if record is None:
        verify_password(str(password or ""), _DUMMY_HASH)  # 응답 시간 평준화
        return None
    if not verify_password(str(password or ""), str(record.get("password", ""))):
        return None
    if record.get("disabled"):
        return None
    return public_view(record)


def record_login(login_id: str) -> dict[str, Any]:
    with _LOCK:
        data = _load()
        record = _find(data["users"], normalize_id(login_id))
        if record is None:
            raise UserNotFoundError("사용자를 찾을 수 없습니다.")
        record["last_login_at"] = now_iso()
        _save(data)
        return public_view(record)


def set_password(login_id: str, new_password: str) -> dict[str, Any]:
    validate_password(new_password)
    with _LOCK:
        data = _load()
        record = _find(data["users"], normalize_id(login_id))
        if record is None:
            raise UserNotFoundError("사용자를 찾을 수 없습니다.")
        record["password"] = hash_password(new_password)
        record["password_changed_at"] = now_iso()
        _save(data)
        return public_view(record)


def change_password(login_id: str, current_password: str, new_password: str) -> dict[str, Any]:
    """본인 비밀번호 변경: 현재 비밀번호가 맞아야 한다."""
    validate_password(new_password)
    with _LOCK:
        data = _load()
        record = _find(data["users"], normalize_id(login_id))
        if record is None:
            raise UserNotFoundError("사용자를 찾을 수 없습니다.")
        if not verify_password(str(current_password or ""), str(record.get("password", ""))):
            raise PolicyError("현재 비밀번호가 올바르지 않습니다.")
        if current_password == new_password:
            raise PolicyError("새 비밀번호가 현재 비밀번호와 같습니다.")
        record["password"] = hash_password(new_password)
        record["password_changed_at"] = now_iso()
        _save(data)
        return public_view(record)


def set_disabled(login_id: str, disabled: bool) -> dict[str, Any]:
    with _LOCK:
        data = _load()
        record = _find(data["users"], normalize_id(login_id))
        if record is None:
            raise UserNotFoundError("사용자를 찾을 수 없습니다.")
        record["disabled"] = bool(disabled)
        _save(data)
        return public_view(record)


def delete_user(login_id: str) -> dict[str, Any]:
    with _LOCK:
        data = _load()
        record = _find(data["users"], normalize_id(login_id))
        if record is None:
            raise UserNotFoundError("사용자를 찾을 수 없습니다.")
        data["users"] = [item for item in data["users"] if item is not record]
        _save(data)
        return public_view(record)


# ---------- 관리자 부트스트랩 ----------

def bootstrap_admin(login_id: str, password: str) -> tuple[str, str]:
    """admin 역할 사용자가 없을 때만 .env 값으로 관리자를 만든다.

    반환: (상태, 설명) — 상태는 "exists" | "created" | "missing-config" | "invalid" | "id-taken".
    기존 관리자가 있으면 어떤 값이 들어오든 손대지 않는다 (users.json 이 기준).
    """
    with _LOCK:
        data = _load()
        if any(record.get("role") == "admin" for record in data["users"]):
            return "exists", "관리자 계정이 이미 있어 .env의 ADMIN_LOGIN_* 값은 사용하지 않습니다."
        if not login_id or not password:
            return "missing-config", (
                "관리자 계정이 없고 .env에 ADMIN_LOGIN_ID / ADMIN_LOGIN_PASSWORD 가 없습니다. "
                "값을 넣고 서버를 재시작하거나 'python -m presentation_review.auth.manage create-user <id> --role admin' 으로 만드세요. "
                "그동안 로그인은 모두 실패합니다."
            )
        try:
            normalized = validate_id(login_id)
            validate_password(password)
        except PolicyError as exc:
            return "invalid", f"ADMIN_LOGIN_ID / ADMIN_LOGIN_PASSWORD 가 정책에 맞지 않아 관리자를 만들지 못했습니다: {exc}"
        if _find(data["users"], normalized):
            return "id-taken", (
                f"ADMIN_LOGIN_ID '{normalized}' 는 이미 일반 사용자로 존재해 관리자를 만들지 못했습니다. "
                "다른 아이디를 지정하거나 CLI로 관리자 계정을 만드세요."
            )
        data["users"].append({
            "id": normalized,
            "name": "관리자",
            "role": "admin",
            "password": hash_password(password),
            "created_at": now_iso(),
            "created_by": "bootstrap",
            "disabled": False,
            "last_login_at": None,
            "password_changed_at": now_iso(),
        })
        _save(data)
        return "created", f"관리자 계정 '{normalized}' 를 .env 값으로 만들었습니다 ({USERS_PATH})."
