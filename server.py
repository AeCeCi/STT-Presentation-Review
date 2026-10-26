import cgi
import json
import logging
import os
import re
import threading
import time
import zipfile
from collections import deque
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, unquote, urlparse

import app as analysis_app
from presentation_review.auth import history as auth_history
from presentation_review.auth import sessions as auth_sessions
from presentation_review.auth import store as auth_store
from presentation_review.auth import usage_log as auth_usage
from presentation_review.config.settings import (
    ADMIN_LOGIN_ID,
    ADMIN_LOGIN_PASSWORD,
    CLAUDE_API_KEY,
    CLAUDE_MODEL,
    HAS_ADMIN_KEY,
    OUTPUT_DIR,
)
from presentation_review.materials.extractor import extract_material_text
from presentation_review.reports.usage_excel import build_org_usage_xlsx
from presentation_review.shared import org_usage, token_usage

ROOT = Path(__file__).parent
PORT = int(os.environ.get("PORT") or "8502")  # 환경 변수 PORT 로 바꿀 수 있다 (기본 8502)
RECORDING_DIR = OUTPUT_DIR / "recordings"
logging.basicConfig(level=logging.INFO)
LOGGER = logging.getLogger("presentation-review")
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}

# 정적 파일 화이트리스트 — 여기 없는 경로는 전부 404.
# (예전에는 프로젝트 루트 아래 모든 파일을 서빙해 .env/소스/output 이 외부에 노출됐다.)
PUBLIC_FILES = {
    "/index.html": ROOT / "index.html",
    "/app.js": ROOT / "app.js",
    "/styles.css": ROOT / "styles.css",
    "/favicon.ico": ROOT / "favicon.ico",
}
# 홈 화면 사진(assets/*.jpg|png|svg)만 추가로 서빙 — 폴더 밖 경로는 resolve() 뒤 parents 검사로 차단.
PUBLIC_ASSET_DIR = (ROOT / "assets").resolve()
PUBLIC_ASSET_SUFFIXES = {".jpg", ".jpeg", ".png", ".svg"}
ADMIN_PAGE_FILE = ROOT / "admin_token_check.html"

# 로그인 뒤에도 /api/* 가 오픈 프록시처럼 악용되지 않도록 본문 크기·텍스트 길이·호출 빈도를 제한한다.
MAX_JSON_BODY_BYTES = 2 * 1024 * 1024        # JSON 요청 본문
MAX_UPLOAD_BYTES = 200 * 1024 * 1024         # 음성/자료 업로드(multipart)
MAX_TEXT_CHARS = 20_000                       # 번역 텍스트, Q&A 답변
MAX_TRANSCRIPT_CHARS = 300_000                # 전사문
UPLOAD_PATHS = {"/api/analyze", "/api/save-recording", "/api/material-preview"}
RATE_LIMITS = {  # path -> (최대 요청 수, 윈도우 초) — 클라이언트 IP별
    "/api/translate": (60, 60),
    "/api/analyze": (20, 600),
    "/api/analyze-text": (20, 600),
    "/api/evaluate-answer": (40, 600),
    "/api/auth/login": (20, 600),
}

# 로그인 시스템 — 모든 /api/* 는 로그인 세션(쿠키 stt_session)이 필요하고, 아래 두 경로만 예외다.
PUBLIC_API_PATHS = {"/api/auth/login", "/api/auth/logout"}
# 사용 로그(output/api_usage.jsonl)에 기록하는 기능 경로 — 유료 4개(분석·텍스트 분석·번역·답변 평가) + 무료 3개(리포트·자료 미리보기·녹음 저장)
FEATURE_PATHS = frozenset(auth_usage.FEATURE_NAMES)
LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW = 5, 600  # 같은 아이디의 로그인 실패 허용 횟수 / 윈도우(초) — 넘으면 10분 잠금
ADMIN_USER_ROUTE = re.compile(r"^/api/admin/users/([^/]+)(?:/(password|status))?$")


class RateLimiter:
    """IP별 슬라이딩 윈도우 호출 제한 (프로세스 메모리, 재시작 시 초기화)."""

    def __init__(self) -> None:
        self._hits: dict[str, deque] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, max_requests: int, window_sec: int) -> bool:
        now = time.monotonic()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and now - hits[0] > window_sec:
                hits.popleft()
            if len(hits) >= max_requests:
                return False
            hits.append(now)
            return True

    def count(self, key: str, window_sec: int) -> int:
        """윈도우 안의 기록 수만 돌려준다 (기록하지 않음)."""
        now = time.monotonic()
        with self._lock:
            hits = self._hits.get(key)
            if not hits:
                return 0
            while hits and now - hits[0] > window_sec:
                hits.popleft()
            return len(hits)

    def reset(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)


RATE_LIMITER = RateLimiter()

TRANSLATION_LANGUAGES = {
    "en": "English",
    "ja": "Japanese",
    "zh": "Simplified Chinese",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "vi": "Vietnamese",
    "id": "Indonesian",
}


class UploadedFile:
    def __init__(self, name: str, data: bytes) -> None:
        self.name = name
        self._data = data

    def getvalue(self) -> bytes:
        return self._data


def translate_text(text: str, target: str) -> str:
    if not CLAUDE_API_KEY:
        raise RuntimeError("Claude API 키가 설정되어 있지 않아 번역을 사용할 수 없습니다. .env의 CLAUDE_API_KEY를 확인해 주세요.")
    language = TRANSLATION_LANGUAGES.get(target, "English")
    payload = {
        "model": CLAUDE_MODEL,
        "max_tokens": 1600,
        "system": "You are a professional real-time speech translator.",
        "messages": [{
            "role": "user",
            "content": (
                f"Translate the following Korean speech transcript into {language}. "
                "Preserve paragraph breaks. Return only the translated text.\n\n"
                f"{text}"
            ),
        }],
    }
    try:
        data = token_usage.send_claude_request(
            payload,
            purpose="실시간 전사 번역",
            target=f"{language} 번역 ({len(text)}자)",
        )
    except HTTPError as exc:
        raise RuntimeError(f"Claude API 번역 요청이 실패했습니다 (HTTP {exc.code}).") from exc

    chunks = []
    for item in data.get("content", []):
        if isinstance(item, dict) and item.get("type") == "text":
            chunks.append(str(item.get("text", "")))
    return "\n".join(chunks).strip()


class Handler(BaseHTTPRequestHandler):
    _sent_status: int | None = None   # 마지막으로 보낸 HTTP 상태 (사용 로그용)
    _usage_detail: dict | None = None  # 기능 호출 중 note_usage() 로 모은 안전한 메타데이터

    def log_message(self, format: str, *args) -> None:
        return

    def send_response(self, code: int, message: str | None = None) -> None:
        # send_error 도 여기를 거치므로, 실제로 보낸 상태 코드를 사용 로그에 남길 수 있다.
        self._sent_status = code
        super().send_response(code, message)

    def send_bytes(self, data: bytes, content_type: str, status: int = 200, extra_headers: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload: dict, status: int = 200, extra_headers: dict | None = None) -> None:
        self.send_bytes(
            json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
            status,
            extra_headers,
        )

    def client_ip(self) -> str:
        # 프록시/로드밸런서 뒤에서는 X-Forwarded-For의 첫 IP가 실제 클라이언트다.
        # (프록시 없이 노출된 환경에서는 클라이언트가 위조할 수 있는 값이므로 기록용으로만 쓴다)
        forwarded = self.headers.get("X-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return self.client_address[0]

    def read_json_body(self) -> dict:
        """JSON 본문을 dict 로 읽는다. 본문이 없으면 {}, 형식이 틀리면 ValueError."""
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw.strip():
            return {}
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSON 객체가 필요합니다.")
        return data

    def send_bad_json(self) -> None:
        self.send_json({"ok": False, "error": "JSON 본문이 올바르지 않습니다."}, 400)

    # ---------- 로그인 세션 ----------

    def is_https(self) -> bool:
        """리버스 프록시가 X-Forwarded-Proto: https 를 붙였을 때만 쿠키에 Secure 를 단다."""
        return self.headers.get("X-Forwarded-Proto", "").split(",")[0].strip().lower() == "https"

    def session_token(self) -> str:
        return auth_sessions.token_from_cookie_header(self.headers.get("Cookie"))

    def session_cookie(self, token: str) -> dict:
        return {"Set-Cookie": auth_sessions.cookie_header(token, self.is_https())}

    def current_user(self) -> tuple[dict | None, str]:
        """쿠키의 세션이 유효하면 (사용자, "ok"). 아니면 (None, "none" | "disabled")."""
        token = self.session_token()
        session = auth_sessions.get_session(token) if token else None
        if session is None:
            return None, "none"
        user = auth_store.get_user(session.get("user_id", ""))
        if user is None:  # 삭제된 사용자의 세션은 정리
            auth_sessions.delete_session(token)
            return None, "none"
        if user.get("disabled"):
            return None, "disabled"
        return user, "ok"

    def require_login(self) -> dict | None:
        """로그인 세션이 없으면 401 JSON 을 보내고 None. 있으면 사용자(공개 필드)."""
        user, state = self.current_user()
        if user is not None:
            return user
        if state == "disabled":
            self.send_json({"ok": False, "auth_required": True, "error": "비활성화된 계정입니다."}, 401)
        else:
            self.send_json({"ok": False, "auth_required": True, "error": "로그인이 필요합니다."}, 401)
        return None

    def require_admin(self) -> dict | None:
        """관리자 세션이 아니면 401/403 JSON 을 보내고 None."""
        user = self.require_login()
        if user is None:
            return None
        if user.get("role") != "admin":
            self.send_json({"ok": False, "error": "관리자만 사용할 수 있습니다."}, 403)
            return None
        return user

    @staticmethod
    def user_payload(user: dict, with_login: bool = False) -> dict:
        payload = {"id": user.get("id"), "name": user.get("name"), "role": user.get("role")}
        if with_login:
            payload["last_login_at"] = user.get("last_login_at")
        return payload

    def note_usage(self, **detail) -> None:
        """사용 로그 detail 에 안전한 메타데이터(파일명·크기·글자 수 등)만 덧붙인다. 내용(전사문·답변)은 넣지 않는다."""
        if self._usage_detail is not None:
            self._usage_detail.update({key: value for key, value in detail.items() if value is not None})

    def handle_login(self) -> None:
        try:
            data = self.read_json_body()
        except (ValueError, UnicodeDecodeError):
            self.send_bad_json()
            return
        login_id = auth_store.normalize_id(data.get("id"))
        password = data.get("password")
        if not login_id or not isinstance(password, str) or not password:
            self.send_json({"ok": False, "error": "아이디와 비밀번호를 입력하세요."}, 400)
            return
        # 같은 아이디로 LOGIN_FAIL_LIMIT 번 틀리면 10분 잠금 (무차별 대입 방지). IP별 빈도 제한은 check_request_limits 에서.
        fail_key = f"login-fail|{login_id}"
        if RATE_LIMITER.count(fail_key, LOGIN_FAIL_WINDOW) >= LOGIN_FAIL_LIMIT:
            self.send_json({"ok": False, "error": "로그인 시도가 너무 많습니다. 10분 후 다시 시도하세요."}, 429)
            return
        user = auth_store.authenticate(login_id, password)
        if user is None:  # 없는 아이디 / 비밀번호 불일치 / 비활성화 — 같은 메시지
            RATE_LIMITER.allow(fail_key, LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW)
            self.send_json({"ok": False, "error": "아이디 또는 비밀번호가 올바르지 않습니다."}, 401)
            return
        RATE_LIMITER.reset(fail_key)
        user = auth_store.record_login(user["id"])
        token = auth_sessions.create_session(user["id"], self.client_ip(), self.headers.get("User-Agent", ""))
        self.send_json({"ok": True, "user": self.user_payload(user)}, extra_headers=self.session_cookie(token))

    def handle_logout(self) -> None:
        token = self.session_token()
        if token:
            auth_sessions.delete_session(token)
        self.send_json({"ok": True}, extra_headers={"Set-Cookie": auth_sessions.expired_cookie_header(self.is_https())})

    def handle_change_password(self, user: dict) -> None:
        try:
            data = self.read_json_body()
        except (ValueError, UnicodeDecodeError):
            self.send_bad_json()
            return
        current = data.get("current_password")
        new = data.get("new_password")
        if not isinstance(current, str) or not isinstance(new, str) or not current or not new:
            self.send_json({"ok": False, "error": "현재 비밀번호와 새 비밀번호를 입력하세요."}, 400)
            return
        try:
            auth_store.change_password(user["id"], current, new)
        except auth_store.AuthError as exc:
            self.send_json({"ok": False, "error": str(exc)}, exc.status)
            return
        # 지금 쓰는 세션만 남기고 다른 기기의 세션은 종료한다.
        auth_sessions.delete_user_sessions(user["id"], keep_token=self.session_token())
        self.send_json({"ok": True})

    def handle_admin_post(self, path: str, admin: dict) -> None:
        try:
            data = self.read_json_body()
        except (ValueError, UnicodeDecodeError):
            self.send_bad_json()
            return
        try:
            if path == "/api/admin/users":
                user = auth_store.create_user(
                    data.get("id", ""), data.get("name", ""), data.get("password"),
                    role=data.get("role") or "user", created_by=admin["id"],
                )
                self.send_json({"ok": True, "user": user}, 201)
                return
            match = ADMIN_USER_ROUTE.match(path)
            if not match or not match.group(2):
                self.send_json({"ok": False, "error": "없는 경로입니다."}, 404)
                return
            target = auth_store.normalize_id(unquote(match.group(1)))
            if match.group(2) == "password":
                user = auth_store.set_password(target, data.get("password"))
                # 재설정된 계정의 세션은 모두 종료 (본인 비밀번호를 바꾼 관리자는 현재 세션 유지)
                auth_sessions.delete_user_sessions(target, keep_token=self.session_token() if target == admin["id"] else None)
                self.send_json({"ok": True, "user": user})
                return
            disabled = data.get("disabled")
            if not isinstance(disabled, bool):
                self.send_json({"ok": False, "error": "disabled 값은 true/false 여야 합니다."}, 400)
                return
            if disabled and target == admin["id"]:
                self.send_json({"ok": False, "error": "자기 자신은 비활성화할 수 없습니다."}, 400)
                return
            user = auth_store.set_disabled(target, disabled)
            self.send_json({"ok": True, "user": user})
        except auth_store.AuthError as exc:
            self.send_json({"ok": False, "error": str(exc)}, exc.status)

    def handle_admin_delete(self, path: str, admin: dict) -> None:
        match = ADMIN_USER_ROUTE.match(path)
        if not match or match.group(2):
            self.send_json({"ok": False, "error": "없는 경로입니다."}, 404)
            return
        target = auth_store.normalize_id(unquote(match.group(1)))
        if target == admin["id"]:
            self.send_json({"ok": False, "error": "자기 자신은 삭제할 수 없습니다."}, 400)
            return
        try:
            user = auth_store.delete_user(target)
        except auth_store.AuthError as exc:
            self.send_json({"ok": False, "error": str(exc)}, exc.status)
            return
        dropped = auth_sessions.delete_user_sessions(target)
        removed = auth_history.delete_user_analyses(target)
        self.send_json({"ok": True, "user": user, "sessions_dropped": dropped, "analyses_removed": removed})

    def handle_usage_log(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        try:
            limit = max(1, min(1000, int(query.get("limit", ["200"])[0])))
        except (TypeError, ValueError):
            limit = 200
        items = auth_usage.read_usage(
            limit=limit,
            user_id=query.get("user", [""])[0] or None,
            feature=query.get("feature", [""])[0] or None,
            since=query.get("since", [""])[0] or None,
        )
        self.send_json({"ok": True, "items": items, "count": len(items), "log_path": str(auth_usage.USAGE_LOG_PATH)})

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/auth/me":
            user = self.require_login()
            if user is not None:
                # 응답마다 쿠키 Max-Age 를 다시 7일로 늘려 서버의 슬라이딩 만료와 맞춘다.
                self.send_json({"ok": True, "user": self.user_payload(user, with_login=True)}, extra_headers=self.session_cookie(self.session_token()))
            return
        if path == "/admin-token-check" or path.startswith("/api/admin/"):
            # 관리자 화면·엔드포인트는 모두 admin 역할 세션이 필요하다 (미로그인 401 / 일반 사용자 403, 모두 JSON).
            if self.require_admin() is None:
                return
            if path == "/admin-token-check":
                self.send_bytes(ADMIN_PAGE_FILE.read_bytes(), STATIC_TYPES[".html"])
            elif path == "/api/admin/org-usage":
                self.handle_org_usage()
            elif path == "/api/admin/call-log":
                self.handle_call_log()
            elif path == "/api/admin/org-usage-raw":
                self.handle_org_usage_raw()
            elif path == "/api/admin/org-usage.xlsx":
                self.handle_org_usage_xlsx()
            elif path == "/api/admin/users":
                users = auth_store.list_users()
                for item in users:
                    item["analyses"] = auth_history.count_analyses(item["id"])
                self.send_json({"ok": True, "users": users})
            elif path == "/api/admin/usage-log":
                self.handle_usage_log()
            elif path == "/api/admin/usage-summary":
                self.send_json({"ok": True, **auth_usage.usage_summary()})
            else:
                self.send_json({"ok": False, "error": "없는 경로입니다."}, 404)
            return
        if path == "/api/history" or path.startswith("/api/history/"):
            user = self.require_login()
            if user is not None:
                self.handle_history_get(path, user)
            return
        if path.startswith("/api/"):
            if self.require_login() is None:
                return
            self.send_json({"ok": False, "error": "없는 경로입니다."}, 404)
            return
        if path == "/":
            path = "/index.html"
        file_path = PUBLIC_FILES.get(path)
        if file_path is None and path.startswith("/assets/"):
            candidate = (PUBLIC_ASSET_DIR / path[len("/assets/"):]).resolve()
            if candidate.suffix.lower() in PUBLIC_ASSET_SUFFIXES and PUBLIC_ASSET_DIR in candidate.parents:
                file_path = candidate
        if file_path is None or not file_path.is_file():
            self.send_error(404)
            return
        self.send_bytes(file_path.read_bytes(), STATIC_TYPES.get(file_path.suffix.lower(), "application/octet-stream"))

    def check_request_limits(self, path: str) -> bool:
        """본문 크기 상한(413)과 IP별 호출 빈도 제한(429). 통과하면 True."""
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = 0
        limit = MAX_UPLOAD_BYTES if path in UPLOAD_PATHS else MAX_JSON_BODY_BYTES
        if length > limit:
            self.send_json({"ok": False, "error": f"요청 본문이 너무 큽니다 (최대 {limit // (1024 * 1024)}MB)."}, 413)
            return False
        rule = RATE_LIMITS.get(path)
        if rule and not RATE_LIMITER.allow(f"{self.client_ip()}|{path}", *rule):
            self.send_json({"ok": False, "error": "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요."}, 429)
            return False
        return True

    ADMIN_KEY_MISSING_MESSAGE = (
        "ANTHROPIC_ADMIN_KEY가 .env에 설정되어 있지 않습니다. "
        "계정 전체 사용량 조회에는 일반 CLAUDE_API_KEY가 아니라 Admin API 키(sk-ant-admin01-...)가 필요합니다."
    )

    ORG_REPORT_CACHE_SECONDS = 60
    _org_report_caches: dict = {}

    def report_period(self) -> str:
        query = parse_qs(urlparse(self.path).query)
        period = (query.get("period", ["30d"])[0] or "30d").lower()
        return "all" if period == "all" else "30d"

    def collect_org_report(self, period: str = "30d") -> dict:
        # Admin API 한도(usage_report 계열은 더 엄격) 보호 — 기간별 60초 캐시.
        cache = Handler._org_report_caches.get(period)
        if cache and time.monotonic() - cache["time"] < self.ORG_REPORT_CACHE_SECONDS:
            return cache["data"]
        try:
            report = self._fetch_org_report(period)
            Handler._org_report_caches[period] = {"time": time.monotonic(), "data": report}
            return report
        except Exception:
            if cache:
                # 일시적 실패(한도 등)면 마지막 성공 데이터를 30초간 대신 제공한다.
                Handler._org_report_caches[period] = {
                    "time": time.monotonic() - self.ORG_REPORT_CACHE_SECONDS + 30,
                    "data": cache["data"],
                }
                return {**cache["data"], "stale": True}
            raise

    def _fetch_org_report(self, period: str) -> dict:
        # 관리자 화면은 TARGET_KEY_NAME("voice-up") 키의 사용량만 다룬다.
        keys = org_usage.filter_keys_by_name(org_usage.list_api_keys())
        if not keys:
            raise RuntimeError(
                f"조직 API 키 목록에서 '{org_usage.TARGET_KEY_NAME}' 이름의 키를 찾지 못했습니다. "
                "Anthropic Console(Settings → API keys)의 키 이름을 확인해 주세요."
            )
        key_names = {
            str(item.get("id")): {"name": item.get("name"), "hint": item.get("partial_key_hint")}
            for item in keys
        }
        matched = org_usage.find_matching_api_key(keys)

        start_date = None
        period_label = "최근 30일"
        if period == "all":
            # 사용량은 API 키가 있어야 발생하므로, 가장 오래된 키 생성일 - 30일을 전체 조회 시작점으로 삼는다.
            created_dates = sorted(str(item.get("created_at") or "")[:10] for item in keys if item.get("created_at"))
            if created_dates:
                earliest = datetime.strptime(created_dates[0], "%Y-%m-%d") - timedelta(days=30)
            else:
                earliest = datetime.now(timezone.utc) - timedelta(days=365)
            start_date = earliest.strftime("%Y-%m-%d")
            period_label = f"전체 ({start_date} ~ 오늘)"

        # group_by=api_key_id,model 한 번의 조회로 키별/합산/현재 키 요약을 모두 계산한다 (호출 수 절감).
        buckets = org_usage.fetch_usage_buckets(
            30, api_key_ids=list(key_names), group_by=("api_key_id", "model"), start_date=start_date
        )
        # 오늘(UTC)은 Admin API 시간 집계가 최대 ~1시간 늦어 0으로 보일 수 있다.
        # 현재 서버 키가 voice-up이면 이 서버의 호출 로그로 오늘 사용량을 합산해,
        # Admin 집계보다 크면 오늘 버킷을 로그 기반 추정으로 대체한다 (출처는 today_source로 명시).
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        today_source = "admin_api"
        if matched and matched.get("id"):
            local_bucket = org_usage.today_bucket_from_call_log(
                token_usage.load_usage_rows(), str(matched["id"])
            )
            if local_bucket:
                admin_today_total = sum(
                    org_usage.bucket_token_total(bucket) for bucket in buckets
                    if str(bucket.get("starting_at", ""))[:10] == today
                )
                if org_usage.bucket_token_total(local_bucket) > admin_today_total:
                    buckets = [b for b in buckets if str(b.get("starting_at", ""))[:10] != today]
                    buckets.append(local_bucket)
                    today_source = "local_log"
        by_key = org_usage.summarize_usage_by_key(buckets, key_names)
        org_summary = org_usage.summarize_usage_buckets(buckets)
        key_usage = None
        if matched and matched.get("id"):
            key_usage = org_usage.summarize_usage_buckets(
                org_usage.filter_buckets_by_key(buckets, str(matched["id"]))
            )
        # 오늘(UTC) 행이 집계 지연 등으로 빠져도 항상 표시되도록 0 사용량 행을 보충한다.
        org_usage.ensure_today_row(org_summary)
        if key_usage:
            org_usage.ensure_today_row(key_usage)
        # Cost API(실측 청구액)는 API 키별 필터를 지원하지 않아 다른 키 비용이 섞인다.
        # voice-up만 보여주기 위해 사용량×단가 추정치로 대체한다 (오늘 포함).
        known_days = [d for d in org_summary.get("daily", []) if isinstance(d.get("est_cost_usd"), (int, float))]
        unknown_models = [m["model"] for m in org_summary.get("models", []) if m.get("est_cost_usd") is None]
        cost = {
            "estimated": True,
            "daily": [{"date": d["date"], "amount_usd": d["est_cost_usd"]} for d in known_days],
            "by_model": {
                m["model"]: m["est_cost_usd"]
                for m in org_summary.get("models", [])
                if isinstance(m.get("est_cost_usd"), (int, float))
            },
            "total_usd": round(sum(d["est_cost_usd"] for d in known_days), 4),
        }
        if unknown_models:
            cost["note"] = "단가 미등록 모델은 추정 비용에서 제외됨: " + ", ".join(unknown_models)
        return {
            "period": period,
            "period_label": period_label,
            "fetched_at_kst": datetime.now(token_usage.KST).strftime("%Y-%m-%d %H:%M:%S"),
            "today_date": today,
            "today_source": today_source,
            "target_key_name": org_usage.TARGET_KEY_NAME,
            "matched_key": matched,
            "key_usage": key_usage,
            "by_key": by_key,
            "org_usage": org_summary,
            "cost": cost,
        }

    def handle_org_usage(self) -> None:
        if not HAS_ADMIN_KEY:
            self.send_json({"ok": False, "admin_key_missing": True, "error": self.ADMIN_KEY_MISSING_MESSAGE})
            return
        try:
            self.send_json({"ok": True, **self.collect_org_report(self.report_period())})
        except Exception as exc:
            LOGGER.exception("org-usage failed")
            self.send_json({"ok": False, "error": str(exc) or "Admin API 조회에 실패했습니다."}, 502)

    def handle_call_log(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        try:
            limit = max(1, min(1000, int(query.get("limit", ["200"])[0])))
        except (TypeError, ValueError):
            limit = 200
        rows = token_usage.load_usage_rows()
        total = len(rows)
        rows.reverse()  # 최신순
        self.send_json({
            "ok": True,
            "total": total,
            "rows": rows[:limit],
            "summary": token_usage.usage_summary(rows),
            "log_path": str(token_usage.USAGE_LOG_PATH),
        })

    def handle_org_usage_raw(self) -> None:
        if not HAS_ADMIN_KEY:
            self.send_json({"ok": False, "admin_key_missing": True, "error": self.ADMIN_KEY_MISSING_MESSAGE}, 400)
            return
        try:
            self.send_json({"ok": True, **org_usage.fetch_raw_snapshot()})
        except Exception as exc:
            LOGGER.exception("org-usage raw failed")
            self.send_json({"ok": False, "error": str(exc) or "Admin API 조회에 실패했습니다."}, 502)

    def handle_org_usage_xlsx(self) -> None:
        if not HAS_ADMIN_KEY:
            self.send_json({"ok": False, "admin_key_missing": True, "error": self.ADMIN_KEY_MISSING_MESSAGE}, 400)
            return
        try:
            data = build_org_usage_xlsx(self.collect_org_report(self.report_period()))
        except Exception as exc:
            LOGGER.exception("org-usage xlsx failed")
            self.send_json({"ok": False, "error": str(exc) or "Admin API 조회에 실패했습니다."}, 502)
            return
        filename = datetime.now(token_usage.KST).strftime("claude-usage-report-%Y%m%d-%H%M%S.xlsx")
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if not self.check_request_limits(path):
            return
        if path == "/api/auth/login":
            self.handle_login()
            return
        if path == "/api/auth/logout":
            self.handle_logout()
            return
        if path == "/api/auth/change-password":
            user = self.require_login()
            if user is not None:
                self.handle_change_password(user)
            return
        if path.startswith("/api/admin/"):
            admin = self.require_admin()
            if admin is not None:
                self.handle_admin_post(path, admin)
            return
        if path == "/api/history":
            user = self.require_login()
            if user is not None:
                self.handle_history_post(user)
            return
        if path.startswith("/api/history/") and path.endswith("/qa"):
            user = self.require_login()
            if user is not None:
                self.handle_history_qa_post(path, user)
            return
        if path not in FEATURE_PATHS:
            self.send_json({"ok": False, "error": "없는 경로입니다."}, 404)
            return
        user = self.require_login()
        if user is None:
            return  # 로그인 전에는 업로드 파싱·외부 API 호출을 전혀 하지 않는다 (401)
        self.run_feature(path, user)

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        if path.startswith("/api/admin/"):
            admin = self.require_admin()
            if admin is not None:
                self.handle_admin_delete(path, admin)
            return
        if path.startswith("/api/history/"):
            user = self.require_login()
            if user is not None:
                self.handle_history_delete(path, user)
            return
        if path.startswith("/api/"):
            if self.require_login() is not None:
                self.send_json({"ok": False, "error": "없는 경로입니다."}, 404)
            return
        self.send_error(404)

    # ---------- 계정별 분석 기록 (output/users/<id>/analyses/*.json) ----------

    def handle_history_get(self, path: str, user: dict) -> None:
        if path == "/api/history":
            self.send_json({"ok": True, "items": auth_history.list_analyses(user["id"])})
            return
        item_id = unquote(path[len("/api/history/"):])
        try:
            item = auth_history.get_analysis(user["id"], item_id)
        except auth_history.HistoryError as exc:
            self.send_json({"ok": False, "error": str(exc)}, exc.status)
            return
        if item is None:
            self.send_json({"ok": False, "error": "분석 기록을 찾을 수 없습니다."}, 404)
            return
        self.send_json({"ok": True, "item": item})

    def handle_history_post(self, user: dict) -> None:
        try:
            body = self.read_json_body()
        except ValueError:
            self.send_bad_json()
            return
        try:
            meta = auth_history.save_analysis(user["id"], body, body.get("analysis"))
        except auth_history.HistoryError as exc:
            self.send_json({"ok": False, "error": str(exc)}, exc.status)
            return
        self.send_json({"ok": True, "item": meta}, 201)

    def handle_history_qa_post(self, path: str, user: dict) -> None:
        """예상 질문 답변·평가 진행도를 분석 기록에 붙여 둔다 (유료 호출 아님)."""
        item_id = unquote(path[len("/api/history/"):-len("/qa")])
        try:
            body = self.read_json_body()
        except ValueError:
            self.send_bad_json()
            return
        try:
            meta = auth_history.update_qa(user["id"], item_id, body.get("qa"))
        except auth_history.HistoryError as exc:
            self.send_json({"ok": False, "error": str(exc)}, exc.status)
            return
        if meta is None:
            self.send_json({"ok": False, "error": "분석 기록을 찾을 수 없습니다."}, 404)
            return
        self.send_json({"ok": True, "item": meta})

    def handle_history_delete(self, path: str, user: dict) -> None:
        item_id = unquote(path[len("/api/history/"):])
        try:
            removed = auth_history.delete_analysis(user["id"], item_id)
        except auth_history.HistoryError as exc:
            self.send_json({"ok": False, "error": str(exc)}, exc.status)
            return
        if not removed:
            self.send_json({"ok": False, "error": "분석 기록을 찾을 수 없습니다."}, 404)
            return
        self.send_json({"ok": True})

    def run_feature(self, path: str, user: dict) -> None:
        """로그인 사용자의 기능 호출(FEATURE_PATHS)을 처리하고, 성공·실패와 관계없이 사용 로그를 남긴다."""
        started = time.perf_counter()
        self._usage_detail = {}
        self._sent_status = None
        try:
            bytes_in = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            bytes_in = 0
        token_usage.begin_request_context(user["id"])  # Claude 호출 로그의 사용자ID 칸에도 로그인 아이디가 남는다
        try:
            if path == "/api/analyze":
                self.handle_analyze()
            elif path == "/api/analyze-text":
                self.handle_analyze_text()
            elif path == "/api/translate":
                self.handle_translate()
            elif path == "/api/save-recording":
                self.handle_save_recording()
            elif path == "/api/material-preview":
                self.handle_material_preview()
            elif path == "/api/evaluate-answer":
                self.handle_evaluate_answer()
            elif path == "/api/report":
                self.handle_report()
        except Exception as exc:
            LOGGER.exception("Request failed: %s", path)
            self.send_json({"ok": False, "error": str(exc) or "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."}, 500)
        finally:
            try:
                auth_usage.record(
                    user_id=user["id"],
                    role=user.get("role", "-"),
                    path=path,
                    status=self._sent_status,
                    elapsed_ms=(time.perf_counter() - started) * 1000,
                    bytes_in=bytes_in,
                    ip=self.client_ip(),
                    detail=self._usage_detail,
                )
            except Exception:
                LOGGER.exception("usage log write failed: %s", path)
            self._usage_detail = None

    def material_from_form(self, form: cgi.FieldStorage) -> UploadedFile | None:
        material_field = form["material"] if "material" in form else None
        if material_field is not None and getattr(material_field, "filename", ""):
            return UploadedFile(Path(material_field.filename).name, material_field.file.read())
        return None

    def safe_filename(self, name: str, fallback: str = "recording.webm") -> str:
        cleaned = re.sub(r"[^0-9A-Za-z가-힣._-]+", "-", Path(name or fallback).name).strip(".-")
        return cleaned or fallback

    def handle_save_recording(self) -> None:
        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST"})
        field = form["audio"] if "audio" in form else None
        if field is None or not getattr(field, "filename", ""):
            self.send_json({"ok": False, "error": "저장할 녹음 파일이 없습니다."}, 400)
            return

        RECORDING_DIR.mkdir(parents=True, exist_ok=True)
        filename = self.safe_filename(field.filename)
        target = RECORDING_DIR / filename
        if target.exists():
            stem = target.stem
            suffix = target.suffix
            index = 2
            while target.exists():
                target = RECORDING_DIR / f"{stem}-{index}{suffix}"
                index += 1

        payload = field.file.read()
        target.write_bytes(payload)

        transcript = str(form.getfirst("transcript", "") or "")
        self.note_usage(file_name=filename, saved_as=target.name, file_size=len(payload), transcript_chars=len(transcript))
        timeline = str(form.getfirst("timeline", "") or "[]")
        meta_path = target.with_suffix(target.suffix + ".json")
        try:
            parsed_timeline = json.loads(timeline)
        except json.JSONDecodeError:
            parsed_timeline = []
        meta_path.write_text(
            json.dumps(
                {
                    "audio_file": target.name,
                    "transcript": transcript,
                    "timeline": parsed_timeline,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        self.send_json({"ok": True, "path": str(target.relative_to(ROOT)).replace("\\", "/")})

    def handle_analyze(self) -> None:
        request_started = time.perf_counter()
        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST"})
        parse_seconds = round(time.perf_counter() - request_started, 3)
        field = form["audio"] if "audio" in form else None
        streaming_transcript = str(form.getfirst("streaming_transcript", "") or "").strip()
        if len(streaming_transcript) > MAX_TRANSCRIPT_CHARS:
            self.send_json({"ok": False, "error": f"전사문이 너무 깁니다 (최대 {MAX_TRANSCRIPT_CHARS:,}자)."}, 400)
            return
        streaming_timeline = self.parse_streaming_timeline(str(form.getfirst("streaming_timeline", "") or "[]"))
        material = self.material_from_form(form)
        self.note_usage(
            transcript_chars=len(streaming_transcript) or None,
            material_name=material.name if material else None,
            material_size=len(material.getvalue()) if material else None,
        )

        if field is None or not getattr(field, "filename", ""):
            if streaming_transcript:
                self.note_usage(source="streaming_transcript")
                token_usage.set_call_target(f"실시간 STT 전사문({len(streaming_transcript)}자)")
                result = analysis_app.run_analysis_from_transcript(streaming_transcript, material, "실시간 STT 전사문", streaming_timeline)
                self.attach_request_timing(result, request_started, parse_seconds, "실시간 STT 전사문")
                self.send_json({"ok": True, "analysis": result})
                return
            self.send_json({"ok": False, "error": "audio 파일 또는 스트리밍 전사문이 없습니다."}, 400)
            return

        audio = UploadedFile(Path(field.filename).name, field.file.read())
        self.note_usage(source="audio", file_name=audio.name, file_size=len(audio.getvalue()))
        token_usage.set_call_target(audio.name)
        result = analysis_app.run_analysis(audio, material)
        if streaming_transcript:
            result["streaming_transcript"] = streaming_transcript
        if streaming_timeline:
            result["streaming_timeline"] = streaming_timeline
        self.attach_request_timing(result, request_started, parse_seconds, audio.name, len(audio.getvalue()))
        self.send_json({"ok": True, "analysis": result})

    def attach_request_timing(self, result: dict, request_started: float, parse_seconds: float, target: str, audio_bytes: int = 0) -> None:
        """서버 관점 총 처리 시간(업로드 파싱 포함)을 결과에 붙이고 단계별 타이밍과 함께 로그로 남긴다."""
        timing = result.setdefault("timing_seconds", {})
        timing["request_parse"] = parse_seconds
        timing["request_total"] = round(time.perf_counter() - request_started, 3)
        if audio_bytes:
            timing["audio_bytes"] = audio_bytes
        LOGGER.info("analyze request [%s] %s", target, json.dumps(timing, ensure_ascii=False))

    def parse_streaming_timeline(self, raw: str) -> list:
        try:
            parsed = json.loads(raw or "[]")
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []

    def handle_material_preview(self) -> None:
        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST"})
        material = self.material_from_form(form)
        if material is None:
            self.send_json({"ok": False, "error": "PPT/PDF 발표자료가 없습니다."}, 400)
            return

        self.note_usage(file_name=material.name, file_size=len(material.getvalue()))
        info = extract_material_text(material)
        sections = info.get("sections") or []
        page_count = self.material_page_count(material, info.get("type", ""), sections)
        self.note_usage(material_type=info.get("type") or None, page_count=page_count, error=info.get("error") or None)
        self.send_json({
            "ok": True,
            "name": info.get("name", ""),
            "type": info.get("type", ""),
            "sections": sections,
            "page_count": page_count,
            "error": info.get("error", ""),
        })

    def material_page_count(self, material: UploadedFile, material_type: str, sections: list) -> int:
        data = material.getvalue()
        kind = str(material_type or "").upper()
        if kind == "PPTX":
            try:
                with zipfile.ZipFile(BytesIO(data)) as archive:
                    return max(1, len([name for name in archive.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", name)]))
            except Exception:
                return max(1, len(sections))
        if kind == "PDF":
            try:
                try:
                    from pypdf import PdfReader
                except Exception:
                    from PyPDF2 import PdfReader
                return max(1, len(PdfReader(BytesIO(data)).pages))
            except Exception:
                return max(1, len(sections))
        return max(1, len(sections))

    def handle_analyze_text(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        data = json.loads(self.rfile.read(length).decode("utf-8"))
        transcript = str(data.get("transcript", "")).strip()
        if not transcript:
            self.send_json({"ok": False, "error": "분석할 스트리밍 전사문이 없습니다."}, 400)
            return
        if len(transcript) > MAX_TRANSCRIPT_CHARS:
            self.send_json({"ok": False, "error": f"전사문이 너무 깁니다 (최대 {MAX_TRANSCRIPT_CHARS:,}자)."}, 400)
            return
        self.note_usage(transcript_chars=len(transcript))
        token_usage.set_call_target(f"실시간 STT 전사문({len(transcript)}자)")
        result = analysis_app.run_analysis_from_transcript(transcript, None, "실시간 STT 전사문", data.get("timeline", []))
        self.send_json({"ok": True, "analysis": result})

    def handle_translate(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        data = json.loads(self.rfile.read(length).decode("utf-8"))
        text = str(data.get("text", "")).strip()
        target = str(data.get("target", "en")).strip()
        self.note_usage(text_chars=len(text), target_language=target)
        if not text:
            self.send_json({"ok": True, "translation": ""})
            return
        if len(text) > MAX_TEXT_CHARS:
            self.send_json({"ok": False, "error": f"번역할 텍스트가 너무 깁니다 (최대 {MAX_TEXT_CHARS:,}자)."}, 400)
            return
        self.send_json({"ok": True, "translation": translate_text(text, target)})

    def handle_evaluate_answer(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        data = json.loads(self.rfile.read(length).decode("utf-8"))
        question = data.get("question", {})
        if len(str(data.get("answer", ""))) > MAX_TEXT_CHARS or len(str(data.get("transcript", ""))) > MAX_TRANSCRIPT_CHARS:
            self.send_json({"ok": False, "error": "답변 또는 전사문이 너무 깁니다."}, 400)
            return
        question_text = str(question.get("question", "") if isinstance(question, dict) else question)[:40]
        self.note_usage(
            answer_chars=len(str(data.get("answer", ""))),
            transcript_chars=len(str(data.get("transcript", ""))),
            question_chars=len(str(question.get("question", "") if isinstance(question, dict) else question)),
            question_index=question.get("index") if isinstance(question, dict) else None,
        )
        token_usage.set_call_target(f"Q&A: {question_text}" if question_text else "Q&A 답변")
        result = analysis_app.evaluate_qa_answer(
            data.get("question", {}),
            data.get("answer", ""),
            data.get("transcript", ""),
        )
        self.send_json({"ok": True, "result": result})

    def handle_report(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        analysis = json.loads(self.rfile.read(length).decode("utf-8")).get("analysis")
        if not analysis:
            self.send_json({"ok": False, "error": "analysis 데이터가 없습니다."}, 400)
            return
        pdf = analysis_app.build_report_pdf(analysis)
        self.note_usage(file_size=len(pdf))
        self.send_bytes(pdf, "application/pdf")


if __name__ == "__main__":
    # admin 역할 사용자가 없을 때만 .env(ADMIN_LOGIN_ID/ADMIN_LOGIN_PASSWORD)로 관리자를 만든다.
    # 설정이 없거나 정책 위반이면 경고만 남기고 계속 서비스한다 (로그인은 전부 실패).
    bootstrap_status, bootstrap_message = auth_store.bootstrap_admin(ADMIN_LOGIN_ID, ADMIN_LOGIN_PASSWORD)
    if bootstrap_status in ("created", "exists"):
        LOGGER.info("auth bootstrap: %s", bootstrap_message)
    else:
        LOGGER.warning("auth bootstrap: %s", bootstrap_message)
    LOGGER.info("serving on http://127.0.0.1:%d (users=%d, auth dir=%s)", PORT, auth_store.count_users(), auth_store.AUTH_DIR)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()
