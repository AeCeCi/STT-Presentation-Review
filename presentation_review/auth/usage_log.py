"""로그인 사용자별 기능 호출 로그 (output/api_usage.jsonl).

한 줄 = 한 호출(JSON). 성공/실패와 관계없이 기록한다.
{
  "ts_kst": "2026-10-23T14:03:11+09:00", "user_id": "...", "role": "user",
  "path": "/api/analyze", "feature": "발표 분석", "ok": true, "status": 200,
  "elapsed_ms": 1234, "bytes_in": 48213, "ip": "1.2.3.4", "detail": {...}
}
detail 에는 파일명·크기·텍스트 길이·대상 언어 같은 안전한 메타데이터만 들어간다.
전사문·답변·비밀번호 같은 내용은 절대 쓰지 않는다 (서버에서 note_usage 로 넘기는 값만 기록).
"""

import json
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..config.settings import OUTPUT_DIR

KST = timezone(timedelta(hours=9))
USAGE_LOG_PATH = Path(OUTPUT_DIR) / "api_usage.jsonl"

FEATURE_NAMES: dict[str, str] = {
    "/api/analyze": "발표 분석",
    "/api/analyze-text": "텍스트 분석",
    "/api/translate": "번역",
    "/api/evaluate-answer": "답변 평가",
    "/api/report": "PDF 리포트",
    "/api/material-preview": "자료 미리보기",
    "/api/save-recording": "녹음 저장",
}
# detail 에 허용하는 키 — 이 밖의 키는 기록하지 않는다 (내용 유출 방지).
SAFE_DETAIL_KEYS = {
    "file_name", "file_size", "material_name", "material_size", "material_type", "page_count",
    "text_chars", "transcript_chars", "answer_chars", "question_chars", "target_language",
    "question_index", "source", "saved_as", "error",
}
MAX_DETAIL_STRING = 200

_LOCK = threading.Lock()


def feature_name(path: str) -> str:
    return FEATURE_NAMES.get(path, path)


def sanitize_detail(detail: dict[str, Any] | None) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    for key, value in (detail or {}).items():
        if key not in SAFE_DETAIL_KEYS or value is None:
            continue
        if isinstance(value, bool) or isinstance(value, (int, float)):
            cleaned[key] = value
        else:
            cleaned[key] = str(value)[:MAX_DETAIL_STRING]
    return cleaned


def record(
    user_id: str,
    role: str,
    path: str,
    status: int | None,
    elapsed_ms: float,
    bytes_in: int = 0,
    ip: str = "",
    detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    row = {
        "ts_kst": datetime.now(KST).isoformat(timespec="seconds"),
        "user_id": str(user_id or "-"),
        "role": str(role or "-"),
        "path": path,
        "feature": feature_name(path),
        "ok": bool(status is not None and 200 <= int(status) < 400),
        "status": int(status) if status is not None else None,
        "elapsed_ms": int(round(elapsed_ms)),
        "bytes_in": int(bytes_in or 0),
        "ip": str(ip or ""),
        "detail": sanitize_detail(detail),
    }
    line = json.dumps(row, ensure_ascii=False)
    with _LOCK:
        USAGE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(USAGE_LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    return row


def _load_rows() -> list[dict[str, Any]]:
    if not USAGE_LOG_PATH.exists():
        return []
    rows: list[dict[str, Any]] = []
    with _LOCK:
        with open(USAGE_LOG_PATH, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict):
                    rows.append(item)
    return rows


def _parse_since(since: Any) -> datetime | None:
    if not since:
        return None
    text = str(since).strip()
    if not text:
        return None
    try:
        value = datetime.fromisoformat(text)
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=KST)
    return value


def _row_time(row: dict[str, Any]) -> datetime | None:
    try:
        value = datetime.fromisoformat(str(row.get("ts_kst", "")))
    except ValueError:
        return None
    return value if value.tzinfo else value.replace(tzinfo=KST)


def read_usage(
    limit: int = 200,
    user_id: str | None = None,
    feature: str | None = None,
    since: Any = None,
) -> list[dict[str, Any]]:
    """최신순으로 최대 limit 건. feature 는 한글 기능명 또는 /api/... 경로 모두 허용."""
    rows = _load_rows()
    wanted_user = str(user_id or "").strip().lower()
    wanted_feature = str(feature or "").strip()
    if wanted_feature in FEATURE_NAMES:
        wanted_feature = FEATURE_NAMES[wanted_feature]
    since_dt = _parse_since(since)

    selected: list[dict[str, Any]] = []
    for row in reversed(rows):
        if wanted_user and str(row.get("user_id", "")).lower() != wanted_user:
            continue
        if wanted_feature and str(row.get("feature", "")) != wanted_feature:
            continue
        if since_dt is not None:
            row_time = _row_time(row)
            if row_time is None or row_time < since_dt:
                continue
        selected.append(row)
        if len(selected) >= max(1, int(limit)):
            break
    return selected


def usage_summary() -> dict[str, Any]:
    """사용자별·기능별 호출 수(성공/실패)와 마지막 사용 시각."""
    rows = _load_rows()
    by_user: dict[str, dict[str, Any]] = {}
    by_feature: dict[str, dict[str, Any]] = {}
    for row in rows:
        ok = bool(row.get("ok"))
        ts = str(row.get("ts_kst", ""))
        user_key = str(row.get("user_id", "-"))
        feature_key = str(row.get("feature", row.get("path", "-")))

        user = by_user.setdefault(user_key, {"user_id": user_key, "role": row.get("role", "-"), "calls": 0, "ok": 0, "failed": 0, "last_used_at": "", "features": {}})
        user["calls"] += 1
        user["ok" if ok else "failed"] += 1
        user["last_used_at"] = max(user["last_used_at"], ts)
        user["features"][feature_key] = user["features"].get(feature_key, 0) + 1

        feat = by_feature.setdefault(feature_key, {"feature": feature_key, "calls": 0, "ok": 0, "failed": 0, "last_used_at": "", "users": 0, "_users": set()})
        feat["calls"] += 1
        feat["ok" if ok else "failed"] += 1
        feat["last_used_at"] = max(feat["last_used_at"], ts)
        feat["_users"].add(user_key)

    features_out = []
    for feat in by_feature.values():
        feat["users"] = len(feat.pop("_users"))
        features_out.append(feat)
    return {
        "total": len(rows),
        "by_user": sorted(by_user.values(), key=lambda item: item["calls"], reverse=True),
        "by_feature": sorted(features_out, key=lambda item: item["calls"], reverse=True),
        "log_path": str(USAGE_LOG_PATH),
    }
