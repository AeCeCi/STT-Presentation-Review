"""계정별 분석 결과 보관 (JSON 파일, 가벼운 방식).

output/users/<계정 폴더>/analyses/<id>.json 하나가 분석 한 건이다.
파일 구조: {"meta": {...요약...}, "analysis": {...분석 결과 전체...}}
- meta 는 목록 화면용 요약(제목·파일명·점수·등급·WPM·추임새·생성 시각)이고 서버가 analysis 에서 다시 계산한다.
- 계정당 최대 MAX_PER_USER 건을 넘으면 가장 오래된 것부터 지운다.
- 사용자 수가 적다는 전제의 설계다. 사용자가 늘면 SQLite 로 옮기되 이 모듈의 함수 시그니처는 유지한다.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..config.settings import OUTPUT_DIR

USERS_DIR = Path(OUTPUT_DIR) / "users"
MAX_PER_USER = 50
MAX_ANALYSIS_BYTES = 1_500_000  # 분석 JSON 한 건의 상한(전사문 포함 보통 100~400KB)
MAX_QA_BYTES = 400_000  # 예상 질문 답변·평가 기록(qa)의 상한
MAX_TEXT = 200
ITEM_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,48}$")
KST = timezone(timedelta(hours=9))
_LOCK = threading.Lock()


class HistoryError(ValueError):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def now_iso() -> str:
    return datetime.now(KST).isoformat(timespec="seconds")


def user_dir(user_id: str) -> Path:
    """계정 아이디를 폴더 이름으로 안전하게 바꾼다 (소문자, 허용 문자 외는 _)."""
    safe = re.sub(r"[^a-z0-9._@-]+", "_", str(user_id).strip().lower()).strip("._") or "user"
    return USERS_DIR / safe / "analyses"


def _text(value: Any, limit: int = MAX_TEXT) -> str:
    return str(value or "").strip()[:limit]


def _number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _grade_of(analysis: dict[str, Any]) -> str:
    grade = _text(analysis.get("grade"), 8)
    if grade and grade not in ("-", "–"):
        return grade
    score = _number(analysis.get("score"))
    for threshold, label in ((90, "A"), (85, "A-"), (80, "B+"), (75, "B"), (70, "B-"), (65, "C+"), (60, "C"), (55, "C-")):
        if score >= threshold:
            return label
    return "D"


def qa_summary(qa: Any) -> dict[str, Any]:
    """예상 질문 답변 연습 진행도: 평가받은 답변 수와 평균 점수."""
    results = qa.get("results") if isinstance(qa, dict) else None
    scores = []
    if isinstance(results, dict):
        for result in results.values():
            if isinstance(result, dict):
                scores.append(max(0.0, min(100.0, _number(result.get("score")))))
    return {"qa_done": len(scores), "qa_avg": round(sum(scores) / len(scores)) if scores else 0}


def build_meta(item_id: str, meta_in: dict[str, Any], analysis: dict[str, Any], created_at: str, qa: Any = None) -> dict[str, Any]:
    """목록 화면에 필요한 요약만 analysis 에서 계산한다 (클라이언트가 보낸 숫자는 믿지 않는다)."""
    return {
        "id": item_id,
        "title": _text(meta_in.get("title")) or _text(analysis.get("audio_name")) or "제목 없는 발표",
        "audio": _text(meta_in.get("audio")) or _text(analysis.get("audio_name")),
        "material": _text(meta_in.get("material")) or _text(analysis.get("document_name")),
        "created_at": created_at,
        "score": round(max(0.0, min(100.0, _number(analysis.get("score"))))),
        "grade": _grade_of(analysis),
        "wpm": round(_number(analysis.get("wpm"))),
        "fillers": round(_number(analysis.get("filler_total"))),
        "llm_failed": bool(analysis.get("llm_error")),
        "sentences": len(analysis.get("sentence_segments") or []),
        "has_material": bool((analysis.get("document_match") or {}).get("available")),
        "questions": len(analysis.get("questions") or []),
        "pages": len((analysis.get("document_match") or {}).get("sections") or []),
        **qa_summary(qa),
    }


def _read(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("meta"), dict):
        return None
    return data


def _write(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False)
    os.replace(tmp, path)


def _complete_meta(data: dict[str, Any]) -> dict[str, Any]:
    """예전에 저장된 기록에도 질문 수·페이지 수·답변 진행도를 채워 준다 (파일은 고치지 않는다)."""
    meta = dict(data["meta"])
    analysis = data.get("analysis") or {}
    if "questions" not in meta:
        meta["questions"] = len(analysis.get("questions") or [])
    if "pages" not in meta:
        meta["pages"] = len((analysis.get("document_match") or {}).get("sections") or [])
    if "qa_done" not in meta:
        meta.update(qa_summary(data.get("qa")))
    return meta


def list_analyses(user_id: str) -> list[dict[str, Any]]:
    """계정의 분석 요약 목록, 최신순."""
    folder = user_dir(user_id)
    if not folder.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for path in folder.glob("*.json"):
        data = _read(path)
        if data is not None:
            items.append(_complete_meta(data))
    items.sort(key=lambda meta: str(meta.get("created_at", "")), reverse=True)
    return items


def count_analyses(user_id: str) -> int:
    folder = user_dir(user_id)
    return sum(1 for _ in folder.glob("*.json")) if folder.is_dir() else 0


def _item_path(user_id: str, item_id: str) -> Path:
    if not ITEM_ID_RE.match(str(item_id or "")):
        raise HistoryError("잘못된 분석 ID 입니다.", 400)
    return user_dir(user_id) / f"{item_id}.json"


def get_analysis(user_id: str, item_id: str) -> dict[str, Any] | None:
    path = _item_path(user_id, item_id)
    return _read(path) if path.is_file() else None


def save_analysis(user_id: str, meta_in: dict[str, Any] | None, analysis: Any) -> dict[str, Any]:
    """분석 결과 한 건을 저장하고 meta 를 돌려준다."""
    if not isinstance(analysis, dict) or not analysis:
        raise HistoryError("분석 결과(analysis)가 비어 있습니다.", 400)
    encoded = json.dumps(analysis, ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_ANALYSIS_BYTES:
        raise HistoryError("분석 결과가 너무 커서 저장할 수 없습니다.", 413)
    created_at = now_iso()
    item_id = f"a{datetime.now(KST).strftime('%Y%m%d%H%M%S')}{secrets.token_hex(3)}"
    meta = build_meta(item_id, meta_in or {}, analysis, created_at)
    with _LOCK:
        _write(_item_path(user_id, item_id), {"meta": meta, "analysis": analysis})
        _trim(user_id)
    return meta


def update_qa(user_id: str, item_id: str, qa: Any) -> dict[str, Any] | None:
    """예상 질문 답변·평가 기록을 분석 한 건에 붙여 저장하고 갱신된 meta 를 돌려준다 (없으면 None)."""
    if not isinstance(qa, dict):
        raise HistoryError("답변 기록(qa)이 올바르지 않습니다.", 400)
    clean = {key: (qa.get(key) if isinstance(qa.get(key), dict) else {}) for key in ("answers", "results", "info")}
    encoded = json.dumps(clean, ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_QA_BYTES:
        raise HistoryError("답변 기록이 너무 커서 저장할 수 없습니다.", 413)
    path = _item_path(user_id, item_id)
    with _LOCK:
        data = _read(path) if path.is_file() else None
        if data is None:
            return None
        data["qa"] = clean
        meta = data["meta"]
        meta["questions"] = len((data.get("analysis") or {}).get("questions") or [])
        meta.update(qa_summary(clean))
        _write(path, data)
    return meta


def _trim(user_id: str) -> None:
    items = list_analyses(user_id)
    for old in items[MAX_PER_USER:]:
        try:
            _item_path(user_id, old["id"]).unlink()
        except (OSError, HistoryError):
            pass


def delete_analysis(user_id: str, item_id: str) -> bool:
    path = _item_path(user_id, item_id)
    with _LOCK:
        if not path.is_file():
            return False
        path.unlink()
    return True


def delete_user_analyses(user_id: str) -> int:
    """계정 삭제 시 분석 기록도 함께 지운다."""
    folder = user_dir(user_id)
    if not folder.is_dir():
        return 0
    removed = 0
    with _LOCK:
        for path in folder.glob("*.json"):
            try:
                path.unlink()
                removed += 1
            except OSError:
                pass
    return removed
