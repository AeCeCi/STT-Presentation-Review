import re
from typing import Any

from ..shared.utils import first_present, format_seconds, normalize_speaker, to_seconds, word_count


SEGMENT_FILLERS = ["네", "어", "아", "음", "그", "이게", "일단", "이제", "좀", "저기", "그러니까"]


def segment_filler_count(text: str) -> int:
    tokens = re.findall(r"[0-9A-Za-z가-힣]+", text or "")
    total = 0
    for term in SEGMENT_FILLERS:
        if len(term) == 1:
            total += sum(len(token) for token in tokens if re.fullmatch(rf"{re.escape(term)}+", token))
        else:
            total += sum(1 for token in tokens if token == term or token.startswith(term))
    return total


def format_precise_seconds(seconds: float) -> str:
    value = max(0.0, float(seconds or 0))
    hours = int(value // 3600)
    value -= hours * 3600
    minutes = int(value // 60)
    value -= minutes * 60
    whole_seconds = int(value)
    milliseconds = int(round((value - whole_seconds) * 1000))
    if milliseconds >= 1000:
        whole_seconds += 1
        milliseconds -= 1000
    if whole_seconds >= 60:
        minutes += 1
        whole_seconds -= 60
    if minutes >= 60:
        hours += 1
        minutes -= 60
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{milliseconds:03d}"


def find_speaker_value(data: Any) -> Any:
    speaker_keys = (
        "speaker",
        "speakerLabel",
        "speaker_label",
        "speakerId",
        "speaker_id",
        "speakerNo",
        "speaker_no",
        "speakerName",
        "speaker_name",
        "speakerNumber",
        "speaker_number",
        "speakerTag",
        "speaker_tag",
        "spk",
        "spkId",
        "spk_id",
        "spkNo",
        "spk_no",
        "label",
        "channel",
    )
    if isinstance(data, dict):
        value = first_present(data, *speaker_keys)
        if value not in [None, ""]:
            return value
        for key in ("diarization", "speakerInfo", "speaker_info", "speakerTag", "speaker_tag", "speakerDiarization"):
            child = data.get(key)
            if isinstance(child, dict):
                value = first_present(child, *speaker_keys, "id", "name")
                if value not in [None, ""]:
                    return value
    return None


def find_first_text(data: Any) -> str:
    if isinstance(data, dict):
        for key in ("text", "fullText"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value
        for value in data.values():
            found = find_first_text(value)
            if found:
                return found
    if isinstance(data, list):
        for value in data:
            found = find_first_text(value)
            if found:
                return found
    return ""


def collect_all_texts(data: Any) -> list[str]:
    texts: list[str] = []
    if isinstance(data, dict):
        value = first_present(data, "fullText", "text", "sentence", "utterance", "transcript")
        if isinstance(value, str) and value.strip():
            texts.append(value.strip())
        for child in data.values():
            texts.extend(collect_all_texts(child))
    elif isinstance(data, list):
        for child in data:
            texts.extend(collect_all_texts(child))
    return texts


def full_text_from_response(data: Any) -> str:
    if isinstance(data, dict):
        for key in ("fullText", "text"):
            value = data.get(key)
            if isinstance(value, str) and len(value.strip()) > 30:
                return value.strip()
    seen = set()
    chunks = []
    for text in collect_all_texts(data):
        if text not in seen:
            seen.add(text)
            chunks.append(text)
    if not chunks:
        return ""
    longest = max(chunks, key=len)
    if len(longest) >= sum(len(item) for item in chunks) * 0.65:
        return longest
    return " ".join(chunks)


def collect_explicit_word_units(data: Any) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []
    def walk(value: Any) -> None:
        if isinstance(value, dict):
            word = first_present(value, "word", "token")
            if word is None and not any(key in value for key in ("words", "tokens", "segments", "result")):
                text_value = first_present(value, "text")
                if isinstance(text_value, str) and word_count(text_value) <= 3:
                    word = text_value
            start = first_present(value, "start", "startTime", "start_time")
            end = first_present(value, "end", "endTime", "end_time")
            s = to_seconds(start)
            e = to_seconds(end)
            if isinstance(word, str) and word.strip() and s is not None and e is not None and e >= s:
                units.append({"start": s, "end": e, "text": word.strip()})
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)
    walk(data)
    return normalize_text_unit_time_scale(units)


def normalize_text_unit_time_scale(units: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not units:
        return []
    max_end = max(float(unit.get("end", 0) or 0) for unit in units)
    durations = sorted(max(0.0, float(unit.get("end", 0) or 0) - float(unit.get("start", 0) or 0)) for unit in units)
    median_duration = durations[len(durations) // 2] if durations else 0
    if max_end > 10000:
        scale = 1000.0
    elif max_end > 600 and median_duration > 20:
        scale = 1000.0
    elif max_end > 600 and median_duration > 2:
        scale = 100.0
    else:
        scale = 1.0
    if scale == 1.0:
        return sorted(units, key=lambda item: (item["start"], item["end"]))
    normalized = []
    for unit in units:
        normalized.append({
            **unit,
            "start": round(float(unit["start"]) / scale, 3),
            "end": round(float(unit["end"]) / scale, 3),
        })
    return sorted(normalized, key=lambda item: (item["start"], item["end"]))


def join_raw_units(units: list[dict[str, Any]]) -> str:
    if not units:
        return ""
    chunks = []
    previous = ""
    seen: set[tuple[int, int, str]] = set()
    for unit in units:
        text = str(unit.get("text", "")).strip()
        if not text:
            continue
        key = (round(float(unit.get("start", 0)) * 100), round(float(unit.get("end", 0)) * 100), text)
        if key in seen:
            continue
        seen.add(key)
        if text in {".", ",", "?", "!"} and chunks:
            chunks[-1] += text
        elif len(text) == 1 and re.match(r"[,.!?]", text) and chunks:
            chunks[-1] += text
        elif previous and re.match(r"^[\uAC00-\uD7A3A-Za-z0-9]+$", previous) and re.match(r"^[\uAC00-\uD7A3A-Za-z0-9]+$", text):
            chunks.append(text)
        else:
            chunks.append(text)
        previous = text
    return " ".join(chunks).strip()


def raw_transcript_from_response(data: Any) -> str:
    word_units = collect_explicit_word_units(data)
    if len(word_units) >= 5:
        return join_raw_units(word_units)
    segment_units = [
        {"start": segment["start"], "end": segment["end"], "text": segment["text"]}
        for segment in collect_sentence_segments(data)
        if str(segment.get("text", "")).strip()
    ]
    raw = join_raw_units(segment_units)
    return raw


def timing_from_sequence(values: list[Any]) -> tuple[float, float, int] | None:
    if len(values) < 3:
        return None
    if any(isinstance(value, (dict, list)) for value in values):
        return None
    numeric = [(idx, to_seconds(value)) for idx, value in enumerate(values)]
    numeric = [(idx, value) for idx, value in numeric if value is not None]
    texts = [value for value in values if isinstance(value, str) and value.strip()]
    if len(numeric) < 2 or not texts:
        return None
    s = numeric[0][1]
    e = numeric[1][1]
    if s is None or e is None or e < s:
        return None
    return s, e, word_count(texts[-1])


def segment_from_sequence(values: list[Any]) -> dict[str, Any] | None:
    timing = timing_from_sequence(values)
    if not timing:
        return None
    s, e, _ = timing
    texts = [value for value in values if isinstance(value, str) and value.strip()]
    speaker = "화자 미상"
    if len(texts) >= 2 and len(texts[0]) <= 20:
        speaker = normalize_speaker(texts[0])
    return {"start": s, "end": e, "text": texts[-1].strip(), "speaker": speaker}


def collect_sentence_segments(data: Any) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    if isinstance(data, dict):
        start = first_present(data, "start", "startTime", "start_time")
        end = first_present(data, "end", "endTime", "end_time")
        text = first_present(data, "text", "sentence", "utterance", "transcript")
        speaker = find_speaker_value(data)
        s = to_seconds(start)
        e = to_seconds(end)
        is_word_unit = any(key in data for key in ("word", "token"))
        if text and not is_word_unit and s is not None and e is not None and e >= s:
            clean_text = str(text).strip()
            if clean_text:
                segments.append({
                    "start": s,
                    "end": e,
                    "text": clean_text,
                    "speaker": normalize_speaker(speaker),
                })
        for value in data.values():
            segments.extend(collect_sentence_segments(value))
    elif isinstance(data, list):
        sequence_segment = segment_from_sequence(data)
        if sequence_segment:
            segments.append(sequence_segment)
        for value in data:
            segments.extend(collect_sentence_segments(value))

    deduped: dict[tuple[int, int, str], dict[str, Any]] = {}
    for segment in segments:
        key = (
            round(segment["start"] * 100),
            round(segment["end"] * 100),
            segment["text"][:80],
        )
        existing = deduped.get(key)
        if (
            not existing
            or len(segment["text"]) > len(existing["text"])
            or ("미상" in str(existing.get("speaker", "")) and "미상" not in str(segment.get("speaker", "")))
        ):
            deduped[key] = segment
    normalized = normalize_segment_time_scale(sorted(deduped.values(), key=lambda item: (item["start"], item["end"])))
    return resolve_overlapping_segments(prune_contained_fragments(normalized))


def collect_primary_clova_segments(data: Any) -> list[dict[str, Any]]:
    if not isinstance(data, dict) or not isinstance(data.get("segments"), list):
        return []
    segments: list[dict[str, Any]] = []
    for item in data.get("segments", []):
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", "")).strip()
        start = to_seconds(first_present(item, "start", "startTime", "start_time"))
        end = to_seconds(first_present(item, "end", "endTime", "end_time"))
        if not text or start is None or end is None or end < start:
            continue
        segments.append({
            "start": start,
            "end": end,
            "text": text,
            "speaker": normalize_speaker(find_speaker_value(item)),
        })
    normalized = normalize_segment_time_scale(sorted(segments, key=lambda item: (item["start"], item["end"])))
    return normalized


def apply_fallback_speaker_diarization(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not segments:
        return []
    speakers = {str(segment.get("speaker", "")) for segment in segments if "미상" not in str(segment.get("speaker", ""))}
    if speakers:
        return segments
    return [{**segment, "speaker": "화자 1"} for segment in segments]


def normalize_segment_time_scale(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not segments:
        return []
    max_end = max(float(segment.get("end", 0) or 0) for segment in segments)
    durations = [
        max(0.0, float(segment.get("end", 0) or 0) - float(segment.get("start", 0) or 0))
        for segment in segments
        if float(segment.get("end", 0) or 0) >= float(segment.get("start", 0) or 0)
    ]
    positive_durations = [value for value in durations if value > 0]
    positive_durations.sort()
    median_duration = positive_durations[len(positive_durations) // 2] if positive_durations else 0

    if max_end > 10000:
        scale = 1000.0
    elif max_end > 600 and median_duration > 20:
        scale = 1000.0
    elif max_end > 600 and median_duration > 2:
        scale = 100.0
    else:
        scale = 1.0

    if scale == 1.0:
        return segments
    normalized = []
    for segment in segments:
        normalized.append({
            **segment,
            "start": round(float(segment["start"]) / scale, 3),
            "end": round(float(segment["end"]) / scale, 3),
        })
    return normalized


def prune_contained_fragments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(segments) < 2:
        return segments
    result = []
    for idx, segment in enumerate(segments):
        s = float(segment["start"])
        e = float(segment["end"])
        duration = max(0.0, e - s)
        text_words = word_count(segment.get("text", ""))
        if text_words <= 2 and duration > 15:
            continue
        contained_by_sentence = False
        for other_idx, other in enumerate(segments):
            if idx == other_idx:
                continue
            os = float(other["start"])
            oe = float(other["end"])
            other_words = word_count(other.get("text", ""))
            if other_words >= 3 and other_words > text_words and os <= s + 0.05 and oe >= e - 0.05:
                contained_by_sentence = True
                break
        if not contained_by_sentence:
            result.append(segment)
    return result


def resolve_overlapping_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(segments, key=lambda item: (float(item["start"]), float(item["end"]), -word_count(item.get("text", ""))))
    result: list[dict[str, Any]] = []

    def score(segment: dict[str, Any]) -> float:
        duration = max(0.0, float(segment.get("end", 0) or 0) - float(segment.get("start", 0) or 0))
        words = word_count(segment.get("text", ""))
        return words * 4 + min(duration, 30)

    for segment in ordered:
        if not result:
            result.append(segment)
            continue
        previous = result[-1]
        start = float(segment["start"])
        end = float(segment["end"])
        prev_start = float(previous["start"])
        prev_end = float(previous["end"])
        overlap = min(end, prev_end) - max(start, prev_start)
        min_duration = max(0.1, min(end - start, prev_end - prev_start))
        if overlap > 0.2 and overlap / min_duration >= 0.55:
            if score(segment) > score(previous):
                result[-1] = segment
            continue
        result.append(segment)
    return result


def sentence_end_hint(text: str) -> bool:
    stripped = str(text or "").strip()
    if not stripped:
        return False
    if re.search(r"[.!?。！？]$|[.!?。！？][\"')\]]$", stripped):
        return True
    return bool(re.search(r"(습니다|합니다|됩니다|입니다|인가요|나요|세요|어요|아요|죠|거죠|겠습니다|드리겠습니다)$", stripped))


def join_korean_fragments(parts: list[str]) -> str:
    text = " ".join(part.strip() for part in parts if str(part).strip())
    text = re.sub(r"\s+([,.!?。！？])", r"\1", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def merge_segments_into_sentences(
    segments: list[dict[str, Any]],
    pause_threshold: float = 1.15,
    max_sentence_seconds: float = 24.0,
    max_words: int = 42,
) -> list[dict[str, Any]]:
    if not segments:
        return []

    ordered = sorted(segments, key=lambda item: (item["start"], item["end"], len(item.get("text", ""))))
    pieces: list[dict[str, Any]] = []
    for segment in ordered:
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        duration = max(0.0, float(segment.get("end", 0)) - float(segment.get("start", 0)))
        if duration > 45 and word_count(text) > 80:
            continue
        if pieces and text == pieces[-1].get("text") and abs(float(segment["start"]) - float(pieces[-1]["start"])) < 0.05:
            continue
        pieces.append(segment)

    merged: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    texts: list[str] = []

    def flush() -> None:
        nonlocal current, texts
        if not current:
            return
        merged.append({
            "start": float(current["start"]),
            "end": float(current["end"]),
            "speaker": current.get("speaker") or normalize_speaker(None),
            "text": join_korean_fragments(texts),
        })
        current = None
        texts = []

    for piece in pieces:
        if current is None:
            current = dict(piece)
            texts = [str(piece.get("text", "")).strip()]
            continue

        gap = max(0.0, float(piece["start"]) - float(current["end"]))
        current_text = join_korean_fragments(texts)
        same_speaker = piece.get("speaker") == current.get("speaker") or "미상" in str(piece.get("speaker")) or "미상" in str(current.get("speaker"))
        projected_words = word_count(current_text) + word_count(piece.get("text", ""))
        projected_seconds = float(piece["end"]) - float(current["start"])
        should_merge = (
            same_speaker
            and gap < pause_threshold
            and projected_words <= max_words
            and projected_seconds <= max_sentence_seconds
            and (not sentence_end_hint(current_text) or word_count(current_text) < 7)
        )

        if should_merge:
            current["end"] = max(float(current["end"]), float(piece["end"]))
            texts.append(str(piece.get("text", "")).strip())
        else:
            flush()
            current = dict(piece)
            texts = [str(piece.get("text", "")).strip()]
    flush()
    return merged


def build_sentence_segments(data: Any, max_duration: float | None = None) -> list[dict[str, Any]]:
    primary_segments = collect_primary_clova_segments(data)
    if primary_segments:
        return split_segments_by_pause(primary_segments)
    return split_segments_by_pause(stabilize_sentence_timings(merge_segments_into_sentences(collect_sentence_segments(data)), max_duration))


def transcript_sentences_from_text(text: str) -> list[str]:
    source = str(text or "").strip()
    if not source:
        return []
    line_parts = [line.strip() for line in re.split(r"[\r\n]+", source) if line.strip()]
    if len(line_parts) >= 2:
        return line_parts
    pattern = r".+?(?:[.!?。！？]+|습니다|합니다|됩니다|입니다|인가요|나요|세요|어요|아요)(?=\s+|$)"
    found = list(re.finditer(pattern, source))
    matches = [match.group(0).strip() for match in found]
    if matches:
        tail = source[found[-1].end():].strip()
        if tail:
            matches.append(tail)
        return matches
    parts = [part.strip() for part in re.split(r"\s{2,}", source) if part.strip()]
    return parts or [source]


def transcript_segments_from_text(text: str, duration: float | None, speaker: str = "화자 1") -> list[dict[str, Any]]:
    sentences = transcript_sentences_from_text(text)
    if not sentences:
        return []
    total_words = sum(word_count(sentence) for sentence in sentences)
    total_duration = float(duration or max(8.0, total_words / 1.7))
    cursor = 0.0
    segments: list[dict[str, Any]] = []
    for idx, sentence in enumerate(sentences, start=1):
        if idx == len(sentences):
            end = total_duration
        else:
            share = word_count(sentence) / max(1, total_words)
            end = min(total_duration, cursor + max(1.2, total_duration * share))
        if end <= cursor:
            end = cursor + 1.2
        segments.append({
            "start": round(cursor, 2),
            "end": round(end, 2),
            "text": sentence,
            "speaker": speaker,
        })
        cursor = end
    return split_segments_by_pause(stabilize_sentence_timings(segments, total_duration))


def should_rebuild_segments_from_transcript(transcript: str, segments: list[dict[str, Any]]) -> bool:
    transcript_sentences = transcript_sentences_from_text(transcript)
    if len(transcript_sentences) <= 1:
        return False
    if len(segments) < max(2, len(transcript_sentences) // 2):
        return True
    segment_text_len = len(re.sub(r"\s+", "", " ".join(str(item.get("text", "")) for item in segments)))
    transcript_len = len(re.sub(r"\s+", "", transcript))
    return bool(transcript_len and segment_text_len < transcript_len * 0.65)


def realistic_duration_for_transcript(transcript: str, actual_duration: float | None, response_duration: float | None, segments: list[dict[str, Any]]) -> float | None:
    if actual_duration and actual_duration > 0:
        return actual_duration
    words = word_count(transcript)
    estimated = max(6.0, words / 95 * 60)
    segment_end = choose_total_end(response_duration, segments)
    if segment_end and segment_end > 0:
        if words >= 8 and segment_end > estimated * 1.35:
            return round(estimated, 2)
        return segment_end
    return round(estimated, 2) if words else None


def stabilize_sentence_timings(segments: list[dict[str, Any]], max_duration: float | None = None) -> list[dict[str, Any]]:
    if not segments:
        return []
    stabilized = []
    cursor = 0.0
    for idx, segment in enumerate(sorted(segments, key=lambda item: (item["start"], item["end"]))):
        text = segment.get("text", "")
        words = word_count(text)
        fillers = segment_filler_count(text)
        start = max(0.0, float(segment.get("start", 0) or 0))
        end = max(start, float(segment.get("end", start) or start))
        actual_duration = end - start
        words_per_second = 1.65 + ((idx % 6) * 0.18)
        if fillers:
            words_per_second = max(1.25, words_per_second - min(0.45, fillers * 0.05))
        estimated_duration = max(1.2, min(22.0, words / words_per_second))
        timestamp_missing_or_broken = actual_duration < 0.15
        overlaps_previous = start < cursor - 0.05

        if overlaps_previous:
            previous = stabilized[-1] if stabilized else None
            previous_text = str(previous.get("text", "")) if previous else ""
            same_or_nested = bool(previous and (text in previous_text or previous_text in text))
            nearly_same_time = bool(previous and abs(start - float(previous.get("start", 0))) < 0.5)
            if same_or_nested or nearly_same_time:
                continue
            end = max(end, start + min(estimated_duration, max(0.8, actual_duration)))
        elif timestamp_missing_or_broken and start <= cursor + 0.2:
            end = start + estimated_duration
        elif timestamp_missing_or_broken:
            end = start + estimated_duration

        if max_duration and max_duration > 0:
            if start > max_duration + 1.0:
                continue
            end = min(end, max_duration)
            if end <= start:
                end = min(max_duration, start + 0.8)

        final_end = max(end, start + 0.8)
        if max_duration and max_duration > 0:
            final_end = min(final_end, max_duration)
        if final_end <= start:
            continue

        stabilized.append({
            **segment,
            "start": round(start, 2),
            "end": round(final_end, 2),
        })
        cursor = max(cursor, stabilized[-1]["end"])
    return stabilized


def split_segments_by_pause(segments: list[dict[str, Any]], pause_threshold: float = 0.8) -> list[dict[str, Any]]:
    if not segments:
        return []
    result = []
    current_section = 1
    previous_end: float | None = None
    section_start: float | None = None
    section_sentence_count = 0
    for segment in sorted(segments, key=lambda item: (item["start"], item["end"])):
        start = float(segment["start"])
        end = float(segment["end"])
        gap = 0.0 if previous_end is None else max(0.0, start - previous_end)
        new_section = False
        if previous_end is not None:
            elapsed = start - (section_start if section_start is not None else start)
            new_section = gap >= pause_threshold or elapsed >= 45 or section_sentence_count >= 8
        if new_section:
            current_section += 1
            section_start = start
            section_sentence_count = 0
        if section_start is None:
            section_start = start
        section_sentence_count += 1
        enriched = {
            **segment,
            "section": current_section,
            "gap_before": round(gap, 2),
            "duration": round(max(0.1, end - start), 2),
            "start_seconds": round(start, 2),
            "end_seconds": round(end, 2),
            "time": f"{format_precise_seconds(start)}-{format_precise_seconds(end)}",
        }
        result.append(enriched)
        previous_end = max(previous_end or 0.0, end)
    return result


def transcript_from_segments(segments: list[dict[str, Any]], fallback: str) -> str:
    if not segments:
        return fallback
    return "\n".join(f"[{segment['time']}] {segment['speaker']}: {segment['text']}" for segment in segments)


def response_duration_seconds(data: Any) -> float | None:
    values: list[float] = []
    duration_keys = {"duration", "mediaDuration", "audioDuration", "totalDuration", "recordingDuration", "playTime"}
    if isinstance(data, dict):
        for key, value in data.items():
            if key in duration_keys:
                seconds = to_seconds(value)
                if seconds and seconds > 0:
                    values.append(seconds)
            child = response_duration_seconds(value)
            if child:
                values.append(child)
    elif isinstance(data, list):
        for child in data:
            seconds = response_duration_seconds(child)
            if seconds:
                values.append(seconds)
    return max(values) if values else None


def choose_total_end(raw_duration: float | None, segments: list[dict[str, Any]]) -> float | None:
    last_segment_end = max((float(segment.get("end", 0) or 0) for segment in segments), default=0)
    if not raw_duration:
        return last_segment_end or None
    duration = float(raw_duration)
    if last_segment_end and duration > last_segment_end * 10:
        if duration / 1000 >= last_segment_end * 0.8:
            duration /= 1000
        elif duration / 100 >= last_segment_end * 0.8:
            duration /= 100
        else:
            duration = last_segment_end
    return max(duration, last_segment_end) if last_segment_end else duration

