import base64
import cgi
import hmac
import json
import logging
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
from urllib.parse import parse_qs, urlparse

import app as analysis_app
from presentation_review.config.settings import ADMIN_PAGE_PASSWORD, CLAUDE_API_KEY, CLAUDE_MODEL, HAS_ADMIN_KEY
from presentation_review.materials.extractor import extract_material_text
from presentation_review.reports.usage_excel import build_org_usage_xlsx
from presentation_review.shared import org_usage, token_usage

ROOT = Path(__file__).parent
RECORDING_DIR = ROOT / "output" / "recordings"
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
}

# 정적 파일 화이트리스트 — 여기 없는 경로는 전부 404.
# (예전에는 프로젝트 루트 아래 모든 파일을 서빙해 .env/소스/output 이 외부에 노출됐다.)
PUBLIC_FILES = {
    "/index.html": ROOT / "index.html",
    "/app.js": ROOT / "app.js",
    "/styles.css": ROOT / "styles.css",
}
ADMIN_PAGE_FILE = ROOT / "admin_token_check.html"

# 무인증 /api/* 가 오픈 프록시로 악용되지 않도록 본문 크기·텍스트 길이·호출 빈도를 제한한다.
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
}


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
    def log_message(self, format: str, *args) -> None:
        return

    def send_bytes(self, data: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload: dict, status: int = 200) -> None:
        self.send_bytes(
            json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
            status,
        )

    def client_ip(self) -> str:
        # 프록시/로드밸런서 뒤에서는 X-Forwarded-For의 첫 IP가 실제 클라이언트다.
        # (프록시 없이 노출된 환경에서는 클라이언트가 위조할 수 있는 값이므로 기록용으로만 쓴다)
        forwarded = self.headers.get("X-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return self.client_address[0]

    def require_admin_access(self) -> bool:
        """관리자 화면/엔드포인트 접근 제어.

        - ADMIN_PAGE_PASSWORD 설정 시: HTTP Basic 인증(아이디 무관, 비밀번호 일치) 요구.
        - 미설정 시: 소켓 주소 기준 로컬(127.0.0.1)에서만 허용. (X-Forwarded-For는 위조
          가능하므로 보안 판정에는 쓰지 않는다)
        """
        if ADMIN_PAGE_PASSWORD:
            header = self.headers.get("Authorization", "")
            if header.startswith("Basic "):
                try:
                    decoded = base64.b64decode(header[6:]).decode("utf-8")
                    _, _, password = decoded.partition(":")
                    if hmac.compare_digest(password, ADMIN_PAGE_PASSWORD):
                        return True
                except Exception:
                    pass
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="admin-token-check"')
            body = "관리자 비밀번호가 필요합니다.".encode("utf-8")
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return False
        if self.client_address[0] in ("127.0.0.1", "::1"):
            return True
        self.send_json({
            "ok": False,
            "error": "ADMIN_PAGE_PASSWORD가 설정되지 않아 관리자 화면은 로컬(127.0.0.1)에서만 접근할 수 있습니다. 운영 배포 시 .env에 ADMIN_PAGE_PASSWORD를 설정하세요.",
        }, 403)
        return False

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if (path == "/admin-token-check" or path.startswith("/api/admin/")) and not self.require_admin_access():
            return
        if path == "/admin-token-check":
            self.send_bytes(ADMIN_PAGE_FILE.read_bytes(), STATIC_TYPES[".html"])
            return
        elif path == "/api/admin/org-usage":
            self.handle_org_usage()
            return
        elif path == "/api/admin/call-log":
            self.handle_call_log()
            return
        elif path == "/api/admin/org-usage-raw":
            self.handle_org_usage_raw()
            return
        elif path == "/api/admin/org-usage.xlsx":
            self.handle_org_usage_xlsx()
            return
        if path == "/":
            path = "/index.html"
        file_path = PUBLIC_FILES.get(path)
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
        token_usage.begin_request_context(self.client_ip())
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
            else:
                self.send_error(404)
        except Exception as exc:
            LOGGER.exception("Request failed: %s", path)
            self.send_json({"ok": False, "error": str(exc) or "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."}, 500)

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

        target.write_bytes(field.file.read())

        transcript = str(form.getfirst("transcript", "") or "")
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

        if field is None or not getattr(field, "filename", ""):
            if streaming_transcript:
                token_usage.set_call_target(f"실시간 STT 전사문({len(streaming_transcript)}자)")
                result = analysis_app.run_analysis_from_transcript(streaming_transcript, material, "실시간 STT 전사문", streaming_timeline)
                self.attach_request_timing(result, request_started, parse_seconds, "실시간 STT 전사문")
                self.send_json({"ok": True, "analysis": result})
                return
            self.send_json({"ok": False, "error": "audio 파일 또는 스트리밍 전사문이 없습니다."}, 400)
            return

        audio = UploadedFile(Path(field.filename).name, field.file.read())
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

        info = extract_material_text(material)
        sections = info.get("sections") or []
        page_count = self.material_page_count(material, info.get("type", ""), sections)
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
        token_usage.set_call_target(f"실시간 STT 전사문({len(transcript)}자)")
        result = analysis_app.run_analysis_from_transcript(transcript, None, "실시간 STT 전사문", data.get("timeline", []))
        self.send_json({"ok": True, "analysis": result})

    def handle_translate(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        data = json.loads(self.rfile.read(length).decode("utf-8"))
        text = str(data.get("text", "")).strip()
        target = str(data.get("target", "en")).strip()
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
        self.send_bytes(pdf, "application/pdf")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8502), Handler)
    server.serve_forever()
