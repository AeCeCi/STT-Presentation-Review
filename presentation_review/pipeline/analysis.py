import json
import logging
from time import perf_counter

from ..llm.evaluator import llm_analysis, measured_analysis
from ..materials.extractor import extract_material_text
from ..materials.matcher import build_document_match
from ..shared import token_usage
from ..speech_analysis.metrics import pace_from_timings, speaker_stats_from_segments, timing_units_from_segments
from ..speech_to_text.clova_speech import clova_transcribe

LOGGER = logging.getLogger("presentation-review.analysis")


def segments_from_streaming_timeline(timeline) -> list[dict]:
    segments = []
    for idx, item in enumerate(timeline if isinstance(timeline, list) else [], 1):
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", "") or "").strip()
        if not text:
            continue
        try:
            start = float(item.get("start", 0) or 0)
            end = float(item.get("end", start) or start)
        except (TypeError, ValueError):
            start, end = 0.0, 0.0
        if end <= start:
            end = start + max(1.0, len(text.split()) / 1.7)
        gap = 0.0
        if segments:
            gap = max(0.0, start - float(segments[-1].get("end", 0) or 0))
        segments.append({
            "time": item.get("time") or f"{int(start // 60):02d}:{int(start % 60):02d}-{int(end // 60):02d}:{int(end % 60):02d}",
            "start": round(start, 2),
            "end": round(end, 2),
            "speaker": item.get("speaker") or "화자 1",
            "section": item.get("page") or item.get("section") or 1,
            "gap_before": round(gap, 2),
            "text": text,
        })
    return segments


def analyze_with_llm(transcript: str, name: str, measured_pace, sentence_segments, speaker_stats) -> dict:
    """Claude 평가를 시도하고, 실패하면 전사/측정 지표는 유지한 채 실패 원인을 llm_error로 명시한다."""
    try:
        return llm_analysis(transcript, name, measured_pace, sentence_segments, speaker_stats)
    except Exception as exc:
        result = measured_analysis(transcript, name, measured_pace, sentence_segments, speaker_stats)
        result["llm_error"] = str(exc)
        result["llm_used"] = False
        result["analysis_source"] = "CLOVA Speech + Python metrics (AI 평가 실패)"
        result["status"] = "AI 평가 실패"
        result["grade"] = "-"
        result["summary"] = f"AI 종합평가를 생성하지 못했습니다: {exc}"
        return result


def _timed(timings: dict, label: str, func, *args, **kwargs):
    """func 를 실행하고 소요 시간(초)을 timings[label] 에 기록한다."""
    started = perf_counter()
    try:
        return func(*args, **kwargs)
    finally:
        timings[label] = round(perf_counter() - started, 3)


def _finish_timings(timings: dict, started: float, name: str, sentence_segments) -> dict:
    """Claude HTTP 호출 시간을 분리해 넣고 전체 소요 시간을 확정한 뒤 로그로 남긴다."""
    claude = token_usage.claude_timing()
    timings["claude_api"] = claude["seconds"]
    timings["claude_calls"] = claude["calls"]
    # analysis 단계 = Python 지표 계산 + 프롬프트 구성 + Claude 호출 + 응답 정규화 → Claude HTTP 시간을 빼면 순수 로컬 처리 시간
    if "analysis" in timings:
        timings["analysis_local"] = round(max(0.0, timings["analysis"] - claude["seconds"]), 3)
    timings["audio_seconds"] = round(max((float(item.get("end", 0) or 0) for item in (sentence_segments or [])), default=0.0), 2)
    timings["total"] = round(perf_counter() - started, 3)
    LOGGER.info("analysis timing [%s] %s", name, json.dumps(timings, ensure_ascii=False))
    return timings


def run_analysis(audio, material=None) -> dict:
    started = perf_counter()
    token_usage.reset_claude_timing()
    timings: dict = {}
    name = audio.name if audio else "uploaded-audio"
    transcript, measured_pace, sentence_segments, speaker_stats = _timed(timings, "stt", clova_transcribe, audio)
    result = _timed(timings, "analysis", analyze_with_llm, transcript, name, measured_pace, sentence_segments, speaker_stats)
    material_info = _timed(timings, "material_extract", extract_material_text, material)
    match = _timed(timings, "document_match", build_document_match, transcript, material_info)
    result["document_name"] = material_info.get("name", "")
    result["document_type"] = material_info.get("type", "")
    result["document_match"] = match
    if match.get("available"):
        result["material_summary"] = match.get("summary", "")
    result["timing_seconds"] = _finish_timings(timings, started, name, sentence_segments)
    return result


def run_analysis_from_transcript(transcript: str, material=None, name: str = "streaming-transcript", timeline=None) -> dict:
    started = perf_counter()
    token_usage.reset_claude_timing()
    timings: dict = {}
    clean_transcript = str(transcript or "").strip()
    sentence_segments = segments_from_streaming_timeline(timeline)
    measured_pace = pace_from_timings(timing_units_from_segments(sentence_segments), total_end=max((item["end"] for item in sentence_segments), default=0))
    speaker_stats = speaker_stats_from_segments(sentence_segments) if sentence_segments else []
    timings["timeline_metrics"] = round(perf_counter() - started, 3)
    result = _timed(timings, "analysis", analyze_with_llm, clean_transcript, name, measured_pace, sentence_segments, speaker_stats)
    material_info = _timed(timings, "material_extract", extract_material_text, material)
    match = _timed(timings, "document_match", build_document_match, clean_transcript, material_info)
    result["timing_seconds"] = _finish_timings(timings, started, name, sentence_segments)
    result["audio_name"] = name
    result["document_name"] = material_info.get("name", "")
    result["document_type"] = material_info.get("type", "")
    result["document_match"] = match
    result["analysis_source"] = f"{result.get('analysis_source', 'Claude')} + streaming STT transcript/timeline"
    if match.get("available"):
        result["material_summary"] = match.get("summary", "")
    return result


__all__ = ["run_analysis", "run_analysis_from_transcript", "segments_from_streaming_timeline"]
