"""Anthropic Usage & Cost Admin API 조회 (조직/계정 전체 사용량).

일반 CLAUDE_API_KEY로는 계정 전체 사용량을 조회할 수 없다.
Anthropic이 공식 제공하는 Usage & Cost Admin API는 별도의
Admin API 키(sk-ant-admin01-...)를 요구하며, .env의 ANTHROPIC_ADMIN_KEY로 설정한다.

- 사용량:  GET /v1/organizations/usage_report/messages  (api_key_ids[] 필터 지원)
- 비용:    GET /v1/organizations/cost_report            (키별 필터 미지원, 조직 전체)
- 키 목록: GET /v1/organizations/api_keys               (partial_key_hint로 현재 키 식별)
"""

import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib import request as urllib_request
from urllib.error import HTTPError
from urllib.parse import urlencode

from ..config.settings import ADMIN_API_KEY, CLAUDE_API_KEY
from .token_usage import CACHE_READ_RATE, CACHE_WRITE_1H_RATE, CACHE_WRITE_RATE, KST, pricing_for_model

API_BASE = "https://api.anthropic.com"
LOGGER = logging.getLogger("org-usage")

# 관리자 화면에 노출할 대상 API 키 이름 — 이 이름의 키 사용량만 조회/표시한다.
TARGET_KEY_NAME = "voice-up"


def _admin_get(path: str, params: list[tuple[str, str]], _retried: bool = False) -> dict[str, Any]:
    if not ADMIN_API_KEY:
        raise RuntimeError("ANTHROPIC_ADMIN_KEY가 설정되어 있지 않습니다.")
    query = urlencode(params)
    LOGGER.info("Admin API 호출: GET %s?%s", path, query)
    req = urllib_request.Request(
        f"{API_BASE}{path}?{query}",
        headers={"x-api-key": ADMIN_API_KEY, "anthropic-version": "2023-06-01"},
    )
    try:
        with urllib_request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code == 429:
            try:
                wait = int(exc.headers.get("retry-after", "0"))
            except (TypeError, ValueError):
                wait = 0
            if not _retried and 0 < wait <= 20:
                # 잠깐이면 retry-after만큼 기다렸다가 1회 재시도
                time.sleep(wait)
                return _admin_get(path, params, _retried=True)
            raise RuntimeError(
                f"Anthropic Admin API 호출 한도(429)에 걸렸습니다. 약 {wait or 60}초 후 새로고침해 주세요."
            ) from exc
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise RuntimeError(f"Admin API 호출 실패 (HTTP {exc.code}, {path}): {detail}") from exc


def list_api_keys() -> list[dict[str, Any]]:
    """조직의 API 키 목록 전체(페이지네이션 포함)."""
    items: list[dict[str, Any]] = []
    after_id = ""
    for _ in range(10):
        params: list[tuple[str, str]] = [("limit", "100")]
        if after_id:
            params.append(("after_id", after_id))
        data = _admin_get("/v1/organizations/api_keys", params)
        items.extend(data.get("data", []))
        if not data.get("has_more"):
            break
        after_id = str(data.get("last_id") or "")
        if not after_id:
            break
    return items


def filter_keys_by_name(keys: list[dict[str, Any]], name: str = TARGET_KEY_NAME) -> list[dict[str, Any]]:
    """API 키 목록에서 이름이 name(대소문자·양끝 공백 무시)인 키만 남긴다."""
    wanted = name.strip().lower()
    return [item for item in keys if str(item.get("name") or "").strip().lower() == wanted]


def find_matching_api_key(keys: list[dict[str, Any]] | None = None) -> dict[str, Any] | None:
    """API 키 목록에서 현재 CLAUDE_API_KEY와 일치하는 항목을 partial_key_hint로 찾는다."""
    if not CLAUDE_API_KEY:
        return None
    for item in (list_api_keys() if keys is None else keys):
        hint = str(item.get("partial_key_hint") or "")
        if "..." in hint:
            prefix, suffix = hint.split("...", 1)
            if prefix and CLAUDE_API_KEY.startswith(prefix) and CLAUDE_API_KEY.endswith(suffix):
                return {"id": item.get("id"), "name": item.get("name"), "hint": hint}
    return None


def _fetch_paginated(path: str, base_params: list[tuple[str, str]]) -> list[dict[str, Any]]:
    buckets: list[dict[str, Any]] = []
    page = ""
    for _ in range(40):
        params = list(base_params)
        if page:
            params.append(("page", page))
        data = _admin_get(path, params)
        buckets.extend(data.get("data", []))
        if not data.get("has_more"):
            break
        page = str(data.get("next_page") or "")
        if not page:
            break
    return buckets


def _period_params(days: int, start_date: str | None = None) -> list[tuple[str, str]]:
    """조회 기간 파라미터. start_date("YYYY-MM-DD")가 있으면 그 날부터, 없으면 최근 days일.

    ending_at을 생략하면 '버킷 종료시각 < 조회시각' 조건 때문에 아직 끝나지 않은
    오늘(당일) 버킷이 빠진다. 내일모레 00:00(UTC)을 명시해 오늘 버킷을 포함시킨다.
    긴 기간은 페이지네이션(next_page)으로 31일씩 나눠 내려온다.
    """
    now = datetime.now(timezone.utc)
    starting = f"{start_date}T00:00:00Z" if start_date else (now - timedelta(days=days)).strftime("%Y-%m-%dT00:00:00Z")
    return [
        ("starting_at", starting),
        ("ending_at", (now + timedelta(days=2)).strftime("%Y-%m-%dT00:00:00Z")),
    ]


def _today_hourly_bucket(api_key_ids: list[str] | None, group_by: tuple[str, ...]) -> dict[str, Any] | None:
    """오늘(UTC) 사용량을 1h 버킷으로 모아 하루짜리 합성 버킷으로 만든다.

    1d 버킷은 완결된 날만 반환되어 진행 중인 오늘이 빠진다. 1h 버킷은 완료된
    시간까지 제공되므로 이를 합쳐 오늘 데이터를 채운다 (최대 ~1시간 지연).
    """
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    params = [("starting_at", f"{today}T00:00:00Z"), ("bucket_width", "1h"), ("limit", "24")]
    params.extend(("group_by[]", value) for value in group_by)
    params.extend(("api_key_ids[]", key_id) for key_id in api_key_ids or [])
    hours = _fetch_paginated("/v1/organizations/usage_report/messages", params)
    results = [result for bucket in hours for result in bucket.get("results", [])]
    if not results:
        return None
    return {"starting_at": f"{today}T00:00:00Z", "ending_at": f"{today}T24:00:00Z", "results": results}


def fetch_usage_buckets(days: int = 30, api_key_ids: list[str] | None = None,
                        group_by: tuple[str, ...] = ("model",),
                        start_date: str | None = None) -> list[dict[str, Any]]:
    days = max(1, min(31, days))
    params = _period_params(days, start_date) + [("bucket_width", "1d"), ("limit", "31")]
    params.extend(("group_by[]", value) for value in group_by)
    params.extend(("api_key_ids[]", key_id) for key_id in api_key_ids or [])
    buckets = _fetch_paginated("/v1/organizations/usage_report/messages", params)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if not any(str(bucket.get("starting_at", ""))[:10] == today for bucket in buckets):
        today_bucket = _today_hourly_bucket(api_key_ids, group_by)
        if today_bucket:
            buckets.append(today_bucket)
    return buckets


_FIELDS = ("uncached_input", "cache_read", "cache_write_5m", "cache_write_1h", "output")


def _empty() -> dict[str, int]:
    return {key: 0 for key in _FIELDS}


def _add(target: dict[str, Any], result: dict[str, Any]) -> None:
    cache_creation = result.get("cache_creation") or {}
    target["uncached_input"] += int(result.get("uncached_input_tokens") or 0)
    target["cache_read"] += int(result.get("cache_read_input_tokens") or 0)
    target["cache_write_5m"] += int(cache_creation.get("ephemeral_5m_input_tokens") or 0)
    target["cache_write_1h"] += int(cache_creation.get("ephemeral_1h_input_tokens") or 0)
    target["output"] += int(result.get("output_tokens") or 0)


def _estimate_model_cost(model: str, row: dict[str, Any], usage_date: str | None = None) -> float | None:
    pricing = pricing_for_model(model, usage_date)
    if pricing is None:
        return None
    input_rate, output_rate = pricing
    return (
        row["uncached_input"] * input_rate
        + row["output"] * output_rate
        + row["cache_read"] * input_rate * CACHE_READ_RATE
        + row["cache_write_5m"] * input_rate * CACHE_WRITE_RATE
        + row["cache_write_1h"] * input_rate * CACHE_WRITE_1H_RATE
    ) / 1_000_000


def fetch_raw_snapshot(days: int = 30) -> dict[str, Any]:
    """디버깅용: Admin API 원본 응답을 대상 키(TARGET_KEY_NAME)로 한정해 모아 반환한다."""
    days = max(1, min(31, days))
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    keys_response = _admin_get("/v1/organizations/api_keys", [("limit", "100")])
    keys_response = {**keys_response, "data": filter_keys_by_name(keys_response.get("data", []))}
    key_ids = [str(item.get("id")) for item in keys_response["data"] if item.get("id")]
    key_params = [("api_key_ids[]", key_id) for key_id in key_ids]
    return {
        "api_keys": {
            "request": f"GET /v1/organizations/api_keys?limit=100 ('{TARGET_KEY_NAME}' 키만 표시)",
            "response": keys_response,
        },
        "usage_report_1d": {
            "request": f"GET /v1/organizations/usage_report/messages (최근 {days}일, bucket_width=1d, group_by=model,api_key_id, '{TARGET_KEY_NAME}' 키 필터)",
            "response": _admin_get(
                "/v1/organizations/usage_report/messages",
                _period_params(days) + [("bucket_width", "1d"), ("limit", "31"),
                                        ("group_by[]", "model"), ("group_by[]", "api_key_id")] + key_params,
            ),
        },
        "usage_report_1h_today": {
            "request": f"GET /v1/organizations/usage_report/messages (오늘 {today} UTC, bucket_width=1h, group_by=model,api_key_id, '{TARGET_KEY_NAME}' 키 필터)",
            "response": _admin_get(
                "/v1/organizations/usage_report/messages",
                [("starting_at", f"{today}T00:00:00Z"), ("bucket_width", "1h"), ("limit", "24"),
                 ("group_by[]", "model"), ("group_by[]", "api_key_id")] + key_params,
            ),
        },
        "cost_report_1d": {
            "request": "GET /v1/organizations/cost_report — 미조회",
            "response": {
                "skipped": f"Cost API는 API 키별 필터를 지원하지 않아 '{TARGET_KEY_NAME}' 외 키의 비용이 섞이므로 조회하지 않습니다."
            },
        },
    }


def filter_buckets_by_key(buckets: list[dict[str, Any]], api_key_id: str) -> list[dict[str, Any]]:
    """group_by=api_key_id,model 버킷에서 특정 API 키의 결과만 남긴다 (추가 API 호출 없이 재사용)."""
    filtered = []
    for bucket in buckets:
        results = [r for r in bucket.get("results", []) if str(r.get("api_key_id") or "") == api_key_id]
        if results:
            filtered.append({"starting_at": bucket.get("starting_at"), "ending_at": bucket.get("ending_at"), "results": results})
    return filtered


def summarize_usage_buckets(buckets: list[dict[str, Any]]) -> dict[str, Any]:
    """일별/모델별 합계와 추정비용(사용일 기준 단가, 인트로 할인 반영)을 계산한다."""
    daily: list[dict[str, Any]] = []
    models: dict[str, dict[str, Any]] = {}
    model_costs: dict[str, float] = {}
    model_cost_known: dict[str, bool] = {}
    totals = _empty()
    for bucket in buckets:
        date = str(bucket.get("starting_at", ""))[:10]
        day: dict[str, Any] = _empty()
        day["date"] = date
        day_cost = 0.0
        day_cost_known = True
        for result in bucket.get("results", []):
            _add(day, result)
            model = str(result.get("model") or "(모델 미상)")
            _add(models.setdefault(model, _empty()), result)
            _add(totals, result)
            row = _empty()
            _add(row, result)
            cost = _estimate_model_cost(model, row, date)
            if cost is None:
                model_cost_known[model] = False
                day_cost_known = False
            else:
                model_costs[model] = model_costs.get(model, 0.0) + cost
                model_cost_known.setdefault(model, True)
                day_cost += cost
        day["est_cost_usd"] = round(day_cost, 4) if day_cost_known else None
        if any(day[key] for key in _FIELDS):
            daily.append(day)

    model_rows = []
    for model, row in sorted(models.items()):
        known = model_cost_known.get(model, False)
        model_rows.append({"model": model, **row, "est_cost_usd": round(model_costs.get(model, 0.0), 4) if known else None})
    return {"daily": daily, "models": model_rows, "totals": totals}


def bucket_token_total(bucket: dict[str, Any]) -> int:
    """버킷 안 전체 토큰 수(입력+출력+캐시). 오늘 데이터의 완전성 비교용."""
    total = 0
    for result in bucket.get("results", []):
        cache_creation = result.get("cache_creation") or {}
        total += (
            int(result.get("uncached_input_tokens") or 0)
            + int(result.get("output_tokens") or 0)
            + int(result.get("cache_read_input_tokens") or 0)
            + int(cache_creation.get("ephemeral_5m_input_tokens") or 0)
            + int(cache_creation.get("ephemeral_1h_input_tokens") or 0)
        )
    return total


def today_bucket_from_call_log(rows: list[dict[str, Any]], api_key_id: str) -> dict[str, Any] | None:
    """서버 호출 로그에서 오늘(UTC) Claude 사용량을 usage_report 버킷 형태로 합성한다.

    Admin API의 오늘 집계는 완료된 시간까지만(~1시간 지연) 반영되므로,
    현재 서버 키의 실시간 추정치로 보완할 때 쓴다. 이 서버를 거친 호출만 포함된다.
    로그의 캐시쓰기 토큰은 5m/1h 구분이 없어 전부 5m으로 계상한다 (비용 추정도 동일 기준).
    """
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    per_model: dict[str, dict[str, int]] = {}
    for row in rows:
        if row.get("provider") != "Anthropic" or not row.get("success"):
            continue
        try:
            called = datetime.strptime(str(row.get("called_at_kst")), "%Y-%m-%d %H:%M:%S").replace(tzinfo=KST)
        except (TypeError, ValueError):
            continue
        if called.astimezone(timezone.utc).strftime("%Y-%m-%d") != today:
            continue
        model = per_model.setdefault(str(row.get("model") or "(모델 미상)"),
                                     {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0})
        model["input"] += int(row.get("input_tokens") or 0)
        model["output"] += int(row.get("output_tokens") or 0)
        model["cache_read"] += int(row.get("cache_read_tokens") or 0)
        model["cache_write"] += int(row.get("cache_write_tokens") or 0)
    if not per_model:
        return None
    results = [
        {
            "api_key_id": api_key_id,
            "model": model,
            "uncached_input_tokens": counts["input"],
            "cache_read_input_tokens": counts["cache_read"],
            "cache_creation": {"ephemeral_5m_input_tokens": counts["cache_write"], "ephemeral_1h_input_tokens": 0},
            "output_tokens": counts["output"],
        }
        for model, counts in per_model.items()
    ]
    return {"starting_at": f"{today}T00:00:00Z", "ending_at": f"{today}T24:00:00Z", "results": results}


def ensure_today_row(summary: dict[str, Any]) -> dict[str, Any]:
    """일별 목록에 오늘(UTC) 행이 없으면 0 사용량 행을 추가한다.

    사용량이 아직 없거나 시간 단위 집계 지연(~1시간)으로 오늘 버킷이 빠졌을 때도
    화면/리포트에 오늘 날짜가 항상 보이도록 한다.
    """
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    daily = summary.setdefault("daily", [])
    if not any(day.get("date") == today for day in daily):
        day = _empty()
        day["date"] = today
        day["est_cost_usd"] = 0.0
        daily.append(day)
    return summary


def summarize_usage_by_key(buckets: list[dict[str, Any]], key_names: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """group_by=api_key_id,model 버킷을 API 키별 합계 행으로 만든다."""
    per_key: dict[str, dict[str, Any]] = {}
    per_key_cost: dict[str, float] = {}
    per_key_cost_known: dict[str, bool] = {}
    for bucket in buckets:
        date = str(bucket.get("starting_at", ""))[:10]
        for result in bucket.get("results", []):
            key_id = str(result.get("api_key_id") or "")
            model = str(result.get("model") or "(모델 미상)")
            _add(per_key.setdefault(key_id, _empty()), result)
            row = _empty()
            _add(row, result)
            cost = _estimate_model_cost(model, row, date)
            if cost is None:
                per_key_cost_known[key_id] = False
            else:
                per_key_cost[key_id] = per_key_cost.get(key_id, 0.0) + cost
                per_key_cost_known.setdefault(key_id, True)

    rows: list[dict[str, Any]] = []
    for key_id, totals in per_key.items():
        cost_known = per_key_cost_known.get(key_id, False)
        est_cost = per_key_cost.get(key_id, 0.0)
        info = key_names.get(key_id, {})
        rows.append({
            "api_key_id": key_id or None,
            "name": info.get("name") or ("(API 키 아님: Console/Playground)" if not key_id else key_id),
            "hint": info.get("hint") or "",
            **totals,
            "est_cost_usd": round(est_cost, 4) if cost_known else None,
        })
    rows.sort(key=lambda row: row["uncached_input"] + row["cache_read"] + row["output"], reverse=True)
    return rows


def fetch_cost_summary(days: int = 30, start_date: str | None = None) -> dict[str, Any]:
    """조직 전체 청구 비용(USD). Cost API는 API 키별 필터를 지원하지 않는다."""
    days = max(1, min(31, days))
    buckets = _fetch_paginated(
        "/v1/organizations/cost_report",
        _period_params(days, start_date) + [("bucket_width", "1d"), ("limit", "31"), ("group_by[]", "description")],
    )
    daily: list[dict[str, Any]] = []
    by_model: dict[str, float] = {}
    total = 0.0
    for bucket in buckets:
        day_total = 0.0
        for result in bucket.get("results", []):
            try:
                amount_usd = float(result.get("amount") or 0) / 100.0  # amount는 센트 단위 십진 문자열
            except (TypeError, ValueError):
                continue
            day_total += amount_usd
            total += amount_usd
            label = str(result.get("model") or result.get("description") or result.get("cost_type") or "기타")
            by_model[label] = by_model.get(label, 0.0) + amount_usd
        if day_total:
            daily.append({"date": str(bucket.get("starting_at", ""))[:10], "amount_usd": round(day_total, 4)})
    return {
        "daily": daily,
        "by_model": {label: round(value, 4) for label, value in sorted(by_model.items())},
        "total_usd": round(total, 4),
    }
