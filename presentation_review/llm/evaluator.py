import json
import re
from typing import Any
from urllib.error import HTTPError

from ..config.settings import CLAUDE_MODEL, HAS_CLAUDE
from ..shared.token_usage import send_claude_request
from ..shared.utils import clamp_number, normalize_score, parse_count_text
from ..speech_analysis.metrics import (
    direct_filler_words,
    overall_wpm_from_pace,
    python_quantitative_metrics,
    section_rows_from_segments,
    transcript_wpm,
)


def extract_claude_text(data: dict[str, Any]) -> str:
    chunks: list[str] = []
    for content in data.get("content", []):
        if isinstance(content, dict) and content.get("type") == "text":
            chunks.append(str(content.get("text", "")))
    return "\n".join(chunks).strip()


def parse_json_object(raw: str) -> dict[str, Any]:
    raw = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        if start < 0:
            raise
        decoder = json.JSONDecoder()
        parsed, _ = decoder.raw_decode(raw[start:])
        if not isinstance(parsed, dict):
            raise ValueError("Claude response JSON is not an object")
        return parsed


def call_claude(system_prompt: str, user_prompt: str, max_tokens: int = 4096, purpose: str = "LLM 평가") -> dict[str, Any]:
    payload = {
        "model": CLAUDE_MODEL,
        "max_tokens": max_tokens,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
    }
    try:
        data = send_claude_request(payload, purpose=purpose)
    except HTTPError as exc:
        raise RuntimeError(f"Claude API request failed with status {exc.code}") from exc
    return parse_json_object(extract_claude_text(data))


def fallback_analysis(transcript: str, audio_name: str, message: str = "") -> dict[str, Any]:
    wpm = transcript_wpm(transcript)
    fillers = direct_filler_words(transcript)
    return {
        "audio_name": audio_name,
        "transcript": transcript,
        "score": 0,
        "grade": "-",
        "status": "기본 평가 제공",
        "wpm": wpm,
        "filler_total": sum(item["count"] for item in fillers),
        "vocab_issues": 0,
        "voice_scores": {"발표 흐름": 0, "내용 전달력": 0, "Q&A 대응": 0, "시간 관리": 0},
        "filler_counts": {item["word"]: item["count"] for item in fillers},
        "filler_words": fillers,
        "vocab_suggestions": [],
        "pace_series": [{"time": f"{i}:00", "wpm": wpm} for i in range(7)],
        "sentence_segments": [],
        "speaker_stats": [],
        "slide_rows": [],
        "problems": [],
        "questions": [],
        "summary": message or "AI 종합평가는 기본 정량 지표 기반으로 생성되었습니다.",
        "improvement_priorities": [],
        "analysis_source": "Python deterministic fallback",
        "llm_used": False,
    }


def merge_fillers(model_items: list[Any], transcript: str) -> list[dict[str, Any]]:
    return direct_filler_words(transcript)


def sync_speaker_stats(analysis: dict[str, Any]) -> dict[str, Any]:
    speakers = analysis.get("speaker_stats")
    if not isinstance(speakers, list) or not speakers:
        return analysis
    filler_total = sum(clamp_number(item.get("count"), 0, 0, 999) for item in analysis.get("filler_words", []) if isinstance(item, dict))
    analysis["filler_total"] = filler_total
    valid_rows = [row for row in speakers if isinstance(row, dict)]
    if len(valid_rows) == 1:
        valid_rows[0]["wpm"] = clamp_number(analysis.get("wpm"), valid_rows[0].get("wpm", 0), 0, 500)
        valid_rows[0]["fillers"] = filler_total
    return analysis


def sync_slide_filler_totals(analysis: dict[str, Any]) -> dict[str, Any]:
    rows = analysis.get("slide_rows")
    if not isinstance(rows, list) or not rows:
        return analysis
    filler_total = clamp_number(analysis.get("filler_total"), 0, 0, 999)
    valid_rows = [row for row in rows if isinstance(row, dict)]
    if not valid_rows:
        return analysis
    if filler_total <= 0:
        for row in valid_rows:
            row["fillers"] = "0회"
        return analysis
    weights = [parse_count_text(row.get("fillers")) or parse_count_text(row.get("duration")) or 1 for row in valid_rows]
    weight_sum = sum(weights) or len(valid_rows)
    assigned = []
    remainders = []
    running = 0
    for weight in weights:
        raw = filler_total * weight / weight_sum
        value = int(raw)
        assigned.append(value)
        remainders.append(raw - value)
        running += value
    for idx in sorted(range(len(assigned)), key=lambda i: remainders[i], reverse=True)[:max(0, filler_total - running)]:
        assigned[idx] += 1
    for row, value in zip(valid_rows, assigned):
        row["fillers"] = f"{value}회"
    return analysis


def sync_consistent_counts(analysis: dict[str, Any]) -> dict[str, Any]:
    return sync_slide_filler_totals(sync_speaker_stats(analysis))


def text_value(value: Any, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, (str, int, float, bool)):
        return str(value).strip()
    if isinstance(value, list):
        return ", ".join(text_value(item) for item in value if text_value(item))
    if isinstance(value, dict):
        for key in ("title", "question", "detail", "fix", "summary", "text", "value", "name", "category", "reason"):
            if value.get(key):
                return text_value(value.get(key), default)
    return default


def meaningful_text(value: Any, default: str = "") -> str:
    text = text_value(value, default).strip()
    if not text or re.fullmatch(r"\d+\.?", text):
        return ""
    return text


def clean_problem_items(items: Any) -> list[dict[str, Any]]:
    cleaned = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, str):
            row = {"category": "문제", "level": "확인", "title": meaningful_text(item), "fix": ""}
        else:
            row = {
                "category": text_value(item.get("category") if isinstance(item, dict) else "", "문제"),
                "level": text_value(item.get("level") if isinstance(item, dict) else "", "확인"),
                "title": meaningful_text((item.get("title") or item.get("problem") or item.get("issue")) if isinstance(item, dict) else ""),
                "fix": meaningful_text((item.get("fix") or item.get("solution") or item.get("detail")) if isinstance(item, dict) else ""),
            }
        if row["title"] or row["fix"]:
            cleaned.append(row)
    return cleaned


def clean_question_items(items: Any) -> list[dict[str, Any]]:
    cleaned = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, str):
            row = {"category": "질문", "question": meaningful_text(item), "level": "-"}
        else:
            row = {
                "category": text_value((item.get("category") or item.get("type")) if isinstance(item, dict) else "", "질문"),
                "question": meaningful_text((item.get("question") or item.get("title") or item.get("text")) if isinstance(item, dict) else ""),
                "level": text_value((item.get("level") or item.get("difficulty")) if isinstance(item, dict) else "", "-"),
            }
        if row["question"]:
            cleaned.append(row)
    return cleaned


def clean_priority_items(items: Any) -> list[dict[str, Any]]:
    cleaned = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, str):
            row = {"title": meaningful_text(item), "impact": "", "detail": ""}
        else:
            row = {
                "title": meaningful_text((item.get("title") or item.get("priority") or item.get("name")) if isinstance(item, dict) else ""),
                "impact": text_value((item.get("impact") or item.get("level")) if isinstance(item, dict) else ""),
                "detail": meaningful_text((item.get("detail") or item.get("fix") or item.get("reason")) if isinstance(item, dict) else ""),
            }
        if row["title"] or row["detail"]:
            cleaned.append(row)
    return cleaned


def clean_vocab_suggestions(items: Any) -> list[dict[str, Any]]:
    cleaned = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, str):
            row = {"original": item, "replacement": "", "reason": ""}
        elif isinstance(item, dict):
            row = {
                "original": text_value(item.get("original") or item.get("before") or item.get("word") or item.get("expression")),
                "replacement": text_value(item.get("replacement") or item.get("after") or item.get("suggestion")),
                "reason": text_value(item.get("reason") or item.get("detail")),
            }
        else:
            row = {"original": "", "replacement": "", "reason": ""}
        if row["original"] or row["replacement"] or row["reason"]:
            cleaned.append(row)
    return cleaned


def vocab_issue_count(value: Any, suggestions: Any) -> int:
    if isinstance(value, list):
        return len(value)
    if isinstance(value, dict):
        return len(value)
    return clamp_number(value, len(suggestions) if isinstance(suggestions, list) else 0, 0, 999)


def fallback_voice_scores(score: int, wpm: int, filler_total: int) -> dict[str, int]:
    return {
        "발표 흐름": clamp_number(score + (3 if 110 <= wpm <= 150 else -8), score, 0, 100),
        "내용 전달력": clamp_number(score - min(14, filler_total // 4), score, 0, 100),
        "Q&A 대응": clamp_number(score - 8, score, 0, 100),
        "시간 관리": clamp_number(90 - abs(wpm - 135) // 2, score, 0, 100),
    }


def normalize_analysis(judged: dict[str, Any], base: dict[str, Any]) -> dict[str, Any]:
    result = base.copy()
    for key, value in judged.items():
        if key in {"transcript", "audio_name", "filler_words", "filler_total", "filler_counts"}:
            continue
        if value not in [None, ""]:
            result[key] = value
    result["score"] = clamp_number(result.get("score"), 0, 0, 100)
    result["wpm"] = clamp_number(result.get("wpm"), base["wpm"], 0, 500)
    voice = result.get("voice_scores") if isinstance(result.get("voice_scores"), dict) else {}
    result["voice_scores"] = {key: clamp_number(voice.get(key), 0, 0, 100) for key in ["발표 흐름", "내용 전달력", "Q&A 대응", "시간 관리"]}
    for key in ["pace_series", "sentence_segments", "speaker_stats", "filler_words", "vocab_suggestions", "slide_rows", "problems", "questions", "improvement_priorities"]:
        if not isinstance(result.get(key), list):
            result[key] = []
    result["vocab_suggestions"] = clean_vocab_suggestions(result.get("vocab_suggestions"))
    result["vocab_issues"] = vocab_issue_count(result.get("vocab_issues"), result.get("vocab_suggestions", []))
    result["problems"] = clean_problem_items(result.get("problems"))
    result["questions"] = clean_question_items(result.get("questions"))
    result["improvement_priorities"] = clean_priority_items(result.get("improvement_priorities"))
    result["filler_words"] = merge_fillers(result["filler_words"], result.get("transcript", ""))
    result["filler_total"] = sum(clamp_number(item.get("count"), 0, 0, 999) for item in result["filler_words"])
    result["filler_counts"] = {str(item["word"]): item["count"] for item in result["filler_words"] if item.get("word")}
    if sum(result["voice_scores"].values()) == 0 and result["score"] > 0:
        result["voice_scores"] = fallback_voice_scores(result["score"], result["wpm"], result["filler_total"])
    result["analysis_source"] = "CLOVA Speech + Claude"
    result["llm_used"] = True
    return sync_consistent_counts(result)


def measured_analysis(transcript: str, audio_name: str, measured_pace: list[dict[str, Any]] | None = None, sentence_segments: list[dict[str, Any]] | None = None, speaker_stats: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    base = fallback_analysis(transcript, audio_name)
    sentence_segments = sentence_segments or []
    speaker_stats = speaker_stats or []
    quantitative_metrics = python_quantitative_metrics(transcript, measured_pace, sentence_segments, speaker_stats)
    base["quantitative_metrics"] = quantitative_metrics
    if sentence_segments:
        base["sentence_segments"] = sentence_segments
        base["slide_rows"] = section_rows_from_segments(sentence_segments, measured_pace)
    if speaker_stats:
        base["speaker_stats"] = speaker_stats
    if measured_pace:
        base["pace_series"] = measured_pace
        base["wpm"] = overall_wpm_from_pace(measured_pace, base["wpm"])
    return base


def llm_analysis(transcript: str, audio_name: str, measured_pace: list[dict[str, Any]] | None = None, sentence_segments: list[dict[str, Any]] | None = None, speaker_stats: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    sentence_segments = sentence_segments or []
    speaker_stats = speaker_stats or []
    base = measured_analysis(transcript, audio_name, measured_pace, sentence_segments, speaker_stats)
    quantitative_metrics = base["quantitative_metrics"]
    if not HAS_CLAUDE:
        raise RuntimeError("Claude API 키가 설정되어 있지 않아 AI 분석을 진행할 수 없습니다. .env의 CLAUDE_API_KEY를 확인해 주세요.")
    if not transcript.strip():
        raise RuntimeError("전사문이 비어 있어 분석할 수 없습니다. 음성 전사 결과를 확인해 주세요.")

    system_prompt = "You are a Korean IR presentation reviewer. Return JSON only."
    user_prompt = (
        "Evaluate this Korean presentation. Use Python metrics as the source of truth for WPM, filler counts, pauses, and timestamps.\n"
        "Return JSON with keys: score, grade, status, wpm, vocab_issues, voice_scores, pace_series, filler_words, vocab_suggestions, slide_rows, problems, questions, improvement_priorities, summary.\n"
        "Generate exactly 10 questions.\n\n"
        f"[Python metrics]\n{json.dumps(quantitative_metrics, ensure_ascii=False)}\n\n"
        f"[Sentence timeline]\n{json.dumps(sentence_segments[:160], ensure_ascii=False)}\n\n"
        f"[Speaker stats]\n{json.dumps(speaker_stats, ensure_ascii=False)}\n\n"
        f"[STT transcript]\n{transcript[:7000]}"
    )
    try:
        judged = call_claude(system_prompt, user_prompt, max_tokens=5000, purpose="발표 종합 평가")
    except Exception as exc:
        raise RuntimeError(f"Claude API 분석 호출에 실패했습니다: {exc}") from exc
    result = normalize_analysis(judged, base)
    result["pace_series"] = base.get("pace_series", result.get("pace_series", []))
    result["wpm"] = base.get("wpm", result.get("wpm", 0))
    result["sentence_segments"] = sentence_segments
    result["speaker_stats"] = speaker_stats
    result["slide_rows"] = section_rows_from_segments(sentence_segments, measured_pace) or result.get("slide_rows", [])
    result["quantitative_metrics"] = quantitative_metrics
    return sync_consistent_counts(result)


def evaluate_qa_answer(question: dict[str, Any], answer: str, transcript: str) -> dict[str, Any]:
    if not HAS_CLAUDE:
        raise RuntimeError("Claude API 키가 설정되어 있지 않아 답변 평가를 사용할 수 없습니다. .env의 CLAUDE_API_KEY를 확인해 주세요.")
    system_prompt = "너는 한국어 IR 발표 Q&A 심사위원이다. 설명 문장 없이 JSON 객체만 반환한다."
    user_prompt = (
        "예상 질문에 대한 발표자의 답변을 평가하라. JSON 형식: "
        "{score:number, logic:number, specificity:number, confidence:number, time_control:number, strengths:[string], improvements:[string], model_answer:string, tags:[string]}\n\n"
        f"[발표 전사]\n{transcript[:3000]}\n\n[질문]\n{question.get('question', '')}\n\n[답변]\n{answer[:3000]}"
    )
    try:
        judged = call_claude(system_prompt, user_prompt, max_tokens=2500, purpose="Q&A 답변 평가")
    except Exception as exc:
        raise RuntimeError(f"Claude API 답변 평가 호출에 실패했습니다: {exc}") from exc
    return {
        "score": normalize_score(judged.get("score"), 0),
        "logic": normalize_score(judged.get("logic"), 0),
        "specificity": normalize_score(judged.get("specificity"), 0),
        "confidence": normalize_score(judged.get("confidence"), 0),
        "time_control": normalize_score(judged.get("time_control"), 0),
        "strengths": judged.get("strengths") if isinstance(judged.get("strengths"), list) else [],
        "improvements": judged.get("improvements") if isinstance(judged.get("improvements"), list) else [],
        "model_answer": str(judged.get("model_answer", "")),
        "tags": judged.get("tags") if isinstance(judged.get("tags"), list) else [],
    }
