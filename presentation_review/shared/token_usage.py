"""Claude API 토큰 사용량 기록.

모든 Claude 호출은 send_claude_request()를 거치며, 성공/실패와 관계없이
output/claude_token_usage.jsonl 에 한 줄씩 기록된다.
"""

import hashlib
import json
import threading
import time
import uuid
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError

from ..config.settings import CLAUDE_API_KEY, CLAUDE_TIMEOUT_SECONDS

KST = timezone(timedelta(hours=9))
PROJECT_ROOT = Path(__file__).resolve().parents[2]
USAGE_LOG_PATH = PROJECT_ROOT / "output" / "claude_token_usage.jsonl"
_LOG_LOCK = threading.Lock()

_analysis_id: ContextVar[str] = ContextVar("token_usage_analysis_id", default="")
_user_id: ContextVar[str] = ContextVar("token_usage_user_id", default="")
_target: ContextVar[str] = ContextVar("token_usage_target", default="")
_claude_timing: ContextVar[dict | None] = ContextVar("claude_timing", default=None)

# USD / 1M tokens (input, output). Anthropic 정가 기준 (2026-06 요금표).
PRICING_PER_MTOK: dict[str, tuple[float, float]] = {
    "claude-fable-5": (10.0, 50.0),
    "claude-mythos-5": (10.0, 50.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-sonnet-5": (3.0, 15.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-3-5-haiku": (0.8, 4.0),
}
CACHE_READ_RATE = 0.1      # 캐시 읽기 = 입력 단가의 10%
CACHE_WRITE_RATE = 1.25    # 캐시 쓰기(5분 TTL) = 입력 단가의 125%
CACHE_WRITE_1H_RATE = 2.0  # 캐시 쓰기(1시간 TTL) = 입력 단가의 200%

# 기간 한정 인트로 단가: {모델 prefix: ("마지막 적용일(UTC)", (input, output))}
INTRO_PRICING_PER_MTOK: dict[str, tuple[str, tuple[float, float]]] = {
    "claude-sonnet-5": ("2026-08-31", (2.0, 10.0)),
}

COLUMNS: list[tuple[str, str]] = [
    ("호출시각(KST)", "called_at_kst"),
    ("분석ID", "analysis_id"),
    ("사용자ID", "user_id"),
    ("용도", "purpose"),
    ("대상", "target"),
    ("요청형식", "request_format"),
    ("제공사", "provider"),
    ("모델", "model"),
    ("API키지문", "api_key_fingerprint"),
    ("입력토큰", "input_tokens"),
    ("출력토큰", "output_tokens"),
    ("캐시읽기토큰", "cache_read_tokens"),
    ("캐시쓰기토큰", "cache_write_tokens"),
    ("소요시간(초)", "duration_sec"),
    ("시도횟수", "attempts"),
    ("성공여부", "success_label"),
    ("실패유형", "failure_type"),
    ("추정비용(USD)", "cost_usd"),
]


def reset_claude_timing() -> None:
    """현재 요청 컨텍스트의 Claude 호출 누적 시간을 0으로 초기화한다 (run_analysis 시작 시 호출)."""
    _claude_timing.set({"calls": 0, "seconds": 0.0, "input_tokens": 0, "output_tokens": 0})


def claude_timing() -> dict[str, Any]:
    """현재 요청 컨텍스트에서 누적된 Claude HTTP 호출 횟수·소요시간(초)·토큰 수."""
    current = _claude_timing.get()
    return dict(current) if current else {"calls": 0, "seconds": 0.0, "input_tokens": 0, "output_tokens": 0}


def _accumulate_claude_timing(elapsed: float, usage: dict[str, Any]) -> None:
    current = _claude_timing.get()
    if current is None:
        return
    current["calls"] += 1
    current["seconds"] = round(current["seconds"] + elapsed, 3)
    current["input_tokens"] += int(usage.get("input_tokens") or 0)
    current["output_tokens"] += int(usage.get("output_tokens") or 0)


def begin_request_context(user_id: str) -> str:
    analysis_id = uuid.uuid4().hex[:12]
    _analysis_id.set(analysis_id)
    _user_id.set(user_id or "-")
    _target.set("")
    return analysis_id


def set_call_target(target: str) -> None:
    _target.set(str(target or "").strip())


def api_key_fingerprint() -> str:
    if not CLAUDE_API_KEY:
        return "-"
    return hashlib.sha256(CLAUDE_API_KEY.encode("utf-8")).hexdigest()[:12]


def pricing_for_model(model: str, usage_date: str | None = None) -> tuple[float, float] | None:
    """모델 단가(USD/1M). usage_date("YYYY-MM-DD", UTC)가 인트로 기간이면 인트로 단가를 적용한다."""
    normalized = str(model or "").strip().lower()
    best_key = ""
    for key in PRICING_PER_MTOK:
        if normalized.startswith(key) and len(key) > len(best_key):
            best_key = key
    if not best_key:
        return None
    intro = INTRO_PRICING_PER_MTOK.get(best_key)
    if intro and usage_date and usage_date <= intro[0]:
        return intro[1]
    return PRICING_PER_MTOK[best_key]


def estimate_cost_usd(model: str, input_tokens: Any, output_tokens: Any,
                      cache_read: Any, cache_write: Any) -> float | None:
    pricing = pricing_for_model(model, datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    if pricing is None or input_tokens is None or output_tokens is None:
        return None
    input_rate, output_rate = pricing
    cost = (
        float(input_tokens) * input_rate
        + float(output_tokens) * output_rate
        + float(cache_read or 0) * input_rate * CACHE_READ_RATE
        + float(cache_write or 0) * input_rate * CACHE_WRITE_RATE
    ) / 1_000_000
    return round(cost, 6)


def _append_log(row: dict[str, Any]) -> None:
    try:
        USAGE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(row, ensure_ascii=False)
        with _LOG_LOCK:
            with USAGE_LOG_PATH.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
    except OSError:
        # 로그 기록 실패가 본 기능(분석/번역)을 막아서는 안 된다.
        pass


def send_claude_request(payload: dict[str, Any], purpose: str, target: str | None = None) -> dict[str, Any]:
    """Claude Messages API 호출 + 사용량 기록. 실패 시 원래 예외를 그대로 다시 던진다."""
    req = urllib_request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "x-api-key": CLAUDE_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    started = time.perf_counter()
    usage: dict[str, Any] = {}
    success = False
    failure_type = ""
    try:
        with urllib_request.urlopen(req, timeout=CLAUDE_TIMEOUT_SECONDS) as res:
            data = json.loads(res.read().decode("utf-8"))
        usage = data.get("usage") or {}
        success = True
        return data
    except HTTPError as exc:
        failure_type = f"HTTP {exc.code}"
        raise
    except URLError as exc:
        reason = getattr(exc, "reason", exc)
        failure_type = "타임아웃" if "timed out" in str(reason) else f"네트워크 오류({reason})"
        raise
    except TimeoutError:
        failure_type = "타임아웃"
        raise
    except Exception as exc:
        failure_type = type(exc).__name__
        raise
    finally:
        elapsed = time.perf_counter() - started
        _accumulate_claude_timing(elapsed, usage)
        model = str(payload.get("model", ""))
        input_tokens = usage.get("input_tokens")
        output_tokens = usage.get("output_tokens")
        cache_read = usage.get("cache_read_input_tokens")
        cache_write = usage.get("cache_creation_input_tokens")
        _append_log({
            "called_at_kst": datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S"),
            "analysis_id": _analysis_id.get() or "-",
            "user_id": _user_id.get() or "-",
            "purpose": purpose,
            "target": (target or _target.get() or "-"),
            "request_format": "REST /v1/messages (sync)",
            "provider": "Anthropic",
            "model": model,
            "api_key_fingerprint": api_key_fingerprint(),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
            "duration_sec": round(elapsed, 2),
            "attempts": 1,
            "success": success,
            "failure_type": failure_type,
            "cost_usd": estimate_cost_usd(model, input_tokens, output_tokens, cache_read, cache_write) if success else None,
        })


def log_external_api_call(provider: str, model: str, purpose: str, request_format: str,
                          secret: str, duration_sec: float, success: bool,
                          failure_type: str = "", target: str | None = None) -> None:
    """Claude 외의 외부 API(예: CLOVA Speech) 호출도 같은 로그 형식으로 기록한다.

    토큰/비용 개념이 없는 API이므로 해당 필드는 None(화면에서는 '-')으로 남긴다.
    """
    _append_log({
        "called_at_kst": datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S"),
        "analysis_id": _analysis_id.get() or "-",
        "user_id": _user_id.get() or "-",
        "purpose": purpose,
        "target": (target or _target.get() or "-"),
        "request_format": request_format,
        "provider": provider,
        "model": model,
        "api_key_fingerprint": hashlib.sha256(secret.encode("utf-8")).hexdigest()[:12] if secret else "-",
        "input_tokens": None,
        "output_tokens": None,
        "cache_read_tokens": None,
        "cache_write_tokens": None,
        "duration_sec": round(duration_sec, 2),
        "attempts": 1,
        "success": success,
        "failure_type": failure_type,
        "cost_usd": None,
    })


def load_usage_rows() -> list[dict[str, Any]]:
    if not USAGE_LOG_PATH.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in USAGE_LOG_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        row["success_label"] = "성공" if row.get("success") else "실패"
        rows.append(row)
    return rows


def usage_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    def total(key: str) -> int:
        return sum(int(row[key]) for row in rows if isinstance(row.get(key), (int, float)))

    known_costs = [row["cost_usd"] for row in rows if isinstance(row.get("cost_usd"), (int, float))]
    return {
        "total_calls": len(rows),
        "success_calls": sum(1 for row in rows if row.get("success")),
        "failed_calls": sum(1 for row in rows if not row.get("success")),
        "input_tokens": total("input_tokens"),
        "output_tokens": total("output_tokens"),
        "cache_read_tokens": total("cache_read_tokens"),
        "cache_write_tokens": total("cache_write_tokens"),
        "cost_usd": round(sum(known_costs), 6),
        "rows_without_cost": sum(1 for row in rows if row.get("success") and row.get("cost_usd") is None),
    }
