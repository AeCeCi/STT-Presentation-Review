import re
from typing import Any

from ..shared.utils import clamp_number

STOPWORDS = {
    "그리고", "그러나", "그래서", "저희", "저는", "우리", "이것", "그것", "있는", "하는", "합니다",
    "입니다", "됩니다", "대한", "통해", "위해", "경우", "같은", "이번", "일단", "이제", "그냥",
}


def content_tokens(text: str) -> list[str]:
    tokens = re.findall(r"[0-9A-Za-z\uAC00-\uD7A3]{2,}", text or "")
    return [token.lower() for token in tokens if token.lower() not in STOPWORDS]


def coverage_ratio(source_text: str, target_text: str) -> int:
    source = set(content_tokens(source_text))
    target = set(content_tokens(target_text))
    if not source or not target:
        return 0
    return clamp_number(round(len(source & target) / len(source) * 100), 0, 0, 100)


def top_missing_terms(source_text: str, target_text: str, limit: int = 12) -> list[str]:
    source = content_tokens(source_text)
    target = set(content_tokens(target_text))
    counts: dict[str, int] = {}
    for token in source:
        if token not in target:
            counts[token] = counts.get(token, 0) + 1
    return [token for token, _ in sorted(counts.items(), key=lambda item: item[1], reverse=True)[:limit]]


def build_document_match(transcript: str, material_info: dict[str, Any]) -> dict[str, Any]:
    sections = material_info.get("sections") or []
    document_text = material_info.get("text", "")
    if not document_text:
        return {
            "available": False,
            "name": material_info.get("name", ""),
            "type": material_info.get("type", ""),
            "score": 0,
            "summary": material_info.get("error") or "비교할 발표자료가 없습니다.",
            "document_coverage": 0,
            "speech_extra_ratio": 0,
            "missing_terms": [],
            "extra_terms": [],
            "sections": [],
        }

    document_coverage = coverage_ratio(document_text, transcript)
    speech_to_doc = coverage_ratio(transcript, document_text)
    score = clamp_number(round(document_coverage * 0.7 + speech_to_doc * 0.3), 0, 0, 100)
    section_rows = []
    for section in sections[:40]:
        section_score = coverage_ratio(section.get("text", ""), transcript)
        section_rows.append({
            "page": section.get("page", ""),
            "title": section.get("title", ""),
            "score": section_score,
            "status": "발표 반영" if section_score >= 55 else "일부 누락" if section_score >= 25 else "누락 가능",
            "missing": top_missing_terms(section.get("text", ""), transcript, 5),
        })

    missing = top_missing_terms(document_text, transcript, 12)
    extra = top_missing_terms(transcript, document_text, 12)
    return {
        "available": True,
        "name": material_info.get("name", ""),
        "type": material_info.get("type", ""),
        "score": score,
        "summary": f"발표자료 핵심어 기준 약 {document_coverage}%가 음성 전사에 반영되었습니다.",
        "document_coverage": document_coverage,
        "speech_extra_ratio": max(0, 100 - speech_to_doc),
        "missing_terms": missing,
        "extra_terms": extra,
        "sections": section_rows,
    }

