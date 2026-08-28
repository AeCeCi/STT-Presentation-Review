import re
from typing import Any

from ..shared.utils import clamp_number, format_seconds, normalize_speaker, parse_count_text, word_count
from ..speech_to_text.segments import split_segments_by_pause

FILLER_TERMS = ["네", "어", "아", "음", "그", "이게", "일단", "이제", "뭐랄까", "사실은", "약간", "좀", "저기", "그러니까", "그럴까요", "그러면"]
PREFIX_FILLERS = {"이게", "일단", "이제", "뭐랄까", "사실은", "약간", "저기", "그러니까", "그럴까요", "그러면"}


def direct_filler_words(transcript: str) -> list[dict[str, Any]]:
    tokens = re.findall(r"[0-9A-Za-z가-힣]+", transcript or "")
    result = []
    for term in FILLER_TERMS:
        if len(term) == 1:
            count = sum(len(token) for token in tokens if re.fullmatch(rf"{re.escape(term)}+", token))
        elif term in PREFIX_FILLERS:
            count = sum(1 for token in tokens if token == term or token.startswith(term))
        else:
            count = len(re.findall(rf"(?<![0-9A-Za-z가-힣]){re.escape(term)}(?![0-9A-Za-z가-힣])", transcript or ""))
        if count:
            result.append({"word": term, "count": count, "severity": "높음" if count >= 4 else "보통" if count >= 2 else "낮음"})
    return sorted(result, key=lambda item: item["count"], reverse=True)


def transcript_wpm(transcript: str) -> int:
    words = max(1, word_count(transcript))
    return clamp_number(round(words / max(1, words / 115)), 115, 60, 180)


def speaker_stats_from_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    stats: dict[str, dict[str, Any]] = {}
    for segment in segments:
        speaker = normalize_speaker(segment.get("speaker"))
        row = stats.setdefault(speaker, {"speaker": speaker, "sentences": 0, "seconds": 0.0, "words": 0, "fillers": 0})
        text = str(segment.get("text", ""))
        text = str(segment.get("text", ""))
        seconds = max(0.0, float(segment.get("end", 0) or 0) - float(segment.get("start", 0) or 0))
        row["sentences"] += 1
        row["seconds"] += seconds
        row["words"] += word_count(text)
        row["fillers"] += sum(item["count"] for item in direct_filler_words(text))
    rows = []
    for row in stats.values():
        row["seconds"] = round(row["seconds"], 1)
        row["wpm"] = clamp_number(round(row["words"] / max(1, row["seconds"]) * 60), 0, 0, 500)
        rows.append(row)
    return sorted(rows, key=lambda item: item["seconds"], reverse=True)


def filler_occurrences_by_sentence(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    occurrences = []
    for idx, segment in enumerate(segments, 1):
        for filler in direct_filler_words(str(segment.get("text", ""))):
            occurrences.append({
                "sentence_index": idx,
                "time": segment.get("time", ""),
                "speaker": segment.get("speaker", ""),
                "word": filler["word"],
                "count": filler["count"],
            })
    return occurrences


def pause_segments_from_sentences(segments: list[dict[str, Any]], threshold: float = 2.0) -> list[dict[str, Any]]:
    pauses = []
    ordered = sorted(segments, key=lambda item: (float(item.get("start", 0) or 0), float(item.get("end", 0) or 0)))
    for prev, current in zip(ordered, ordered[1:]):
        gap = float(current.get("start", 0) or 0) - float(prev.get("end", 0) or 0)
        if gap >= threshold:
            pauses.append({
                "start": round(float(prev.get("end", 0) or 0), 2),
                "end": round(float(current.get("start", 0) or 0), 2),
                "seconds": round(gap, 2),
            })
    return pauses


def seconds_from_time_range(value: Any) -> float:
    match = re.match(r"(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})", str(value or ""))
    if not match:
        return 0.0
    sm, ss, em, es = [int(part) for part in match.groups()]
    return max(0.0, (em * 60 + es) - (sm * 60 + ss))


def overall_wpm_from_pace(pace_series: list[dict[str, Any]] | None, fallback: int = 0) -> int:
    total_words = 0.0
    total_seconds = 0.0
    for item in pace_series or []:
        words = float(item.get("words", 0) or 0)
        seconds = float(item.get("seconds", 0) or 0) or seconds_from_time_range(item.get("time", ""))
        if seconds > 0:
            total_words += words
            total_seconds += seconds
    if total_words <= 0 or total_seconds <= 0:
        return fallback
    return clamp_number(round(total_words / total_seconds * 60), fallback, 0, 500)


def python_quantitative_metrics(transcript: str, pace_series: list[dict[str, Any]] | None, sentence_segments: list[dict[str, Any]] | None, speaker_stats: list[dict[str, Any]] | None) -> dict[str, Any]:
    sentence_segments = sentence_segments or []
    pace_series = pace_series or []
    wpms = [clamp_number(item.get("wpm"), 0, 0, 500) for item in pace_series if item.get("wpm")]
    return {
        "pipeline": "audio -> CLOVA Speech(STT+timestamp) -> Python quantitative metrics -> Claude interpretation/report",
        "pace_rule": "발표 길이에 따라 20초(90초 이하)/30초(90~180초)/45초(180초 초과) 구간으로 나눠 구간 단어 수 / 구간 초 * 60으로 WPM 계산",
        "filler_rule": "전사 문장별 추임새 후보 단어 카운트",
        "pause_rule": "앞 문장 종료와 다음 문장 시작 사이가 2초 이상이면 멈춤으로 판단",
        "pace_buckets": pace_series,
        "pace_summary": {
            "bucket_count": len(pace_series),
            "valid_bucket_count": len(wpms),
            "average_wpm": overall_wpm_from_pace(pace_series, 0),
            "min_wpm": min(wpms) if wpms else 0,
            "max_wpm": max(wpms) if wpms else 0,
        },
        "filler_words": direct_filler_words(transcript),
        "filler_occurrences": filler_occurrences_by_sentence(sentence_segments)[:80],
        "pause_segments": pause_segments_from_sentences(sentence_segments)[:80],
        "speaker_stats": speaker_stats or [],
    }


def section_rows_from_segments(segments: list[dict[str, Any]], pace_series: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    if not segments:
        return []
    grouped = split_segments_by_pause(segments, pause_threshold=0.8)
    buckets: dict[int, list[dict[str, Any]]] = {}
    for segment in grouped:
        buckets.setdefault(int(segment.get("section", 1) or 1), []).append(segment)

    if len(buckets) <= 1 and len(grouped) >= 3:
        buckets = {}
        current: list[dict[str, Any]] = []
        section = 1
        start = float(grouped[0].get("start", 0) or 0)
        words = 0
        for segment in grouped:
            current.append(segment)
            words += word_count(segment.get("text", ""))
            elapsed = float(segment.get("end", 0) or 0) - start
            if elapsed >= 45 or len(current) >= 8 or words >= 70:
                buckets[section] = current
                section += 1
                current = []
                start = float(segment.get("end", 0) or 0)
                words = 0
        if current:
            buckets[section] = current

    rows = []
    pace_values = [clamp_number(item.get("wpm"), 0, 0, 500) for item in (pace_series or []) if item.get("wpm")]
    for idx, (section, items) in enumerate(sorted(buckets.items())):
        start = min(float(item.get("start", 0) or 0) for item in items)
        end = max(float(item.get("end", 0) or 0) for item in items)
        elapsed = max(1.0, end - start)
        words = sum(word_count(item.get("text", "")) for item in items)
        fillers = sum(sum(f["count"] for f in direct_filler_words(item.get("text", ""))) for item in items)
        wpm = pace_values[min(idx, len(pace_values) - 1)] if pace_values else clamp_number(round(words / elapsed * 60), 0, 0, 500)
        if wpm > 155:
            feedback = "발화 속도가 빠른 구간입니다. 핵심 문장 뒤에 1초 정도 멈춤을 넣어보세요."
        elif wpm < 95:
            feedback = "발화 속도가 느린 구간입니다. 불필요한 공백과 반복 표현을 줄이세요."
        elif fillers >= 4:
            feedback = "속도는 무난하지만 추임새가 전달력을 떨어뜨립니다."
        else:
            feedback = "속도와 문장 구성이 비교적 안정적입니다."
        first_text = str(items[0].get("text", "")).strip()
        label = first_text[:22] + ("..." if len(first_text) > 22 else "")
        rows.append({
            "slide": f"구간 {section}. {label or '발표 구간'}",
            "duration": f"약 {round(elapsed)}초",
            "recommended": "문장 단위 검토",
            "wpm": f"{wpm} WPM",
            "fillers": f"{fillers}회",
            "feedback": feedback,
        })
    return rows


def timing_units_from_segments(segments: list[dict[str, Any]]) -> list[tuple[float, float, int]]:
    return [(float(s["start"]), float(s["end"]), word_count(s.get("text", ""))) for s in segments if s.get("text") and s.get("end", 0) >= s.get("start", 0)]


def cap_timings_to_duration(timings: list[tuple[float, float, int]], duration: float | None) -> list[tuple[float, float, int]]:
    if not timings or not duration or duration <= 0:
        return timings
    capped = []
    for start, end, count in timings:
        if start > duration + 1.0:
            continue
        capped_end = min(end, duration)
        if capped_end > start:
            capped.append((start, capped_end, count))
    return capped


def speaking_wpm_from_timings(timings: list[tuple[float, float, int]], fallback_wpm: int = 140) -> int:
    valid = [(s, e, count) for s, e, count in timings if e >= s and count > 0]
    if not valid:
        return fallback_wpm
    seconds = sum(max(0.25, e - s) for s, e, _ in valid)
    words = sum(count for _, _, count in valid)
    return clamp_number(round(words / max(1, seconds) * 60), fallback_wpm, 20, 260)


def pace_from_timings(timings: list[tuple[float, float, int]], fallback_wpm: int = 140, total_end: float | None = None) -> list[dict[str, Any]]:
    valid = sorted((s, e, c) for s, e, c in timings if e >= s and c > 0)
    if not valid:
        return []
    start_time = valid[0][0]
    end_time = max(max(e for _, e, _ in valid), float(total_end or 0))
    total_seconds = max(1, end_time - start_time)
    bucket_seconds = 45 if total_seconds > 180 else 30 if total_seconds > 90 else 20
    bucket_count = max(1, int((total_seconds + bucket_seconds - 1) // bucket_seconds))
    rows = []
    for idx in range(bucket_count):
        bucket_start = start_time + idx * bucket_seconds
        bucket_end = min(start_time + (idx + 1) * bucket_seconds, end_time)
        count = 0.0
        for s, e, words in valid:
            duration = max(0.1, e - s)
            overlap = max(0, min(e, bucket_end) - max(s, bucket_start))
            if overlap:
                count += words * (overlap / duration)
        seconds = max(1, bucket_end - bucket_start)
        wpm = clamp_number(round(count / seconds * 60), 0, 0, 500) if count >= 0.5 else None
        rel_start = idx * bucket_seconds
        rel_end = rel_start + seconds
        rows.append({
            "time": f"{int(rel_start // 60):02d}:{int(rel_start % 60):02d}-{int(rel_end // 60):02d}:{int(rel_end % 60):02d}",
            "wpm": wpm,
            "words": round(count, 1),
            "seconds": round(seconds, 2),
        })
    return rows


def pace_timings_from_segments(segments: list[dict[str, Any]]) -> list[tuple[float, float, int]]:
    timings = []
    for segment in segments:
        start = float(segment.get("start", 0) or 0)
        end = float(segment.get("end", start) or start)
        words = word_count(segment.get("text", ""))
        if end <= start and words:
            end = start + max(1.2, words / 1.55)
        timings.append((start, end, words))
    return timings


def timing_units_are_credible(timings: list[tuple[float, float, int]], transcript: str) -> bool:
    if len(timings) < 8:
        return False
    transcript_words = word_count(transcript)
    timing_words = sum(count for _, _, count in timings)
    if transcript_words <= 0 or timing_words <= 0:
        return False
    ratio = timing_words / transcript_words
    return 0.65 <= ratio <= 1.35
