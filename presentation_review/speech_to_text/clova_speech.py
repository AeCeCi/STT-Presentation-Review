import json
import time
from typing import Any
from urllib import request
from urllib.error import HTTPError

from ..config.settings import CLOVA_INVOKE_URL, CLOVA_SECRET, HAS_CLOVA
from ..shared.token_usage import log_external_api_call
from ..shared.utils import first_present, to_seconds, word_count
from ..speech_analysis.metrics import (
    cap_timings_to_duration,
    pace_from_timings,
    pace_timings_from_segments,
    speaker_stats_from_segments,
    timing_units_are_credible,
    transcript_wpm,
)
from .audio_duration import audio_duration_seconds
from .segments import (
    apply_fallback_speaker_diarization,
    build_sentence_segments,
    choose_total_end,
    find_first_text,
    full_text_from_response,
    raw_transcript_from_response,
    realistic_duration_for_transcript,
    response_duration_seconds,
    transcript_from_segments,
    transcript_segments_from_text,
)


def clova_upload_url() -> str:
    url = CLOVA_INVOKE_URL.strip().rstrip("/")
    if not url:
        return ""
    if url.endswith("/recognizer/upload"):
        return url
    return f"{url}/recognizer/upload"


def normalize_timing_scale(timings: list[tuple[float, float, int]]) -> list[tuple[float, float, int]]:
    if not timings:
        return []
    max_end = max(e for _, e, _ in timings)
    durations = sorted(max(0.0, e - s) for s, e, _ in timings if e >= s)
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
        return timings
    return [(round(s / scale, 3), round(e / scale, 3), count) for s, e, count in timings]


def collect_word_timings(data: Any) -> list[tuple[float, float, int]]:
    timings: list[tuple[float, float, int]] = []
    if isinstance(data, dict):
        start = first_present(data, "start", "startTime", "start_time")
        end = first_present(data, "end", "endTime", "end_time")
        word = first_present(data, "word", "text", "token")
        has_nested_words = any(key in data for key in ("words", "tokens", "wordAlignment", "word_alignment"))
        explicit_word = bool(data.get("word") or data.get("token"))
        short_text_unit = bool(word and not has_nested_words and word_count(word) <= 2)
        should_count_this_node = explicit_word or short_text_unit
        if word and start is not None and end is not None and should_count_this_node:
            s = to_seconds(start)
            e = to_seconds(end)
            if s is not None and e is not None and e >= s:
                timings.append((s, e, 1 if data.get("word") or data.get("token") else word_count(word)))
        for value in data.values():
            timings.extend(collect_word_timings(value))
    elif isinstance(data, list):
        for value in data:
            timings.extend(collect_word_timings(value))
    normalized = normalize_timing_scale(timings)
    return [
        (s, e, count)
        for s, e, count in normalized
        if e > s and 0.03 <= (e - s) <= 8 and count > 0
    ]


def clova_raw_params() -> dict[str, Any]:
    return {
        "language": "ko-KR",
        "completion": "sync",
        "wordAlignment": True,
        "fullText": True,
        "noiseFiltering": False,
        "enableNoiseFiltering": False,
        "forbidden": "",
        "boostings": [
            {"words": "어"},
            {"words": "어어"},
            {"words": "아"},
            {"words": "아아"},
            {"words": "음"},
            {"words": "으음"},
            {"words": "흐음"},
            {"words": "그"},
            {"words": "그그"},
            {"words": "이제"},
            {"words": "일단"},
            {"words": "저기"},
            {"words": "좀"},
            {"words": "그러니까"},
            {"words": "그럴까요"},
        ],
        "diarization": {"enable": True, "speakerCountMin": 1, "speakerCountMax": 2},
    }


def clova_safe_params() -> dict[str, Any]:
    return {
        "language": "ko-KR",
        "completion": "sync",
        "wordAlignment": True,
        "fullText": True,
        "diarization": {"enable": True, "speakerCountMin": 1, "speakerCountMax": 2},
    }


def clova_transcribe(uploaded_file: Any) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    if not uploaded_file:
        return "", [], [], []
    if not HAS_CLOVA:
        raise RuntimeError("CLOVA Speech API 키가 설정되어 있지 않아 음성 전사를 진행할 수 없습니다. .env의 CLOVA_SPEECH_SECRET_KEY와 CLOVA_SPEECH_INVOKE_URL을 확인해 주세요.")

    actual_duration = audio_duration_seconds(uploaded_file)
    boundary = "----AIClovaBoundary"

    def request_clova(params: dict[str, Any]) -> dict[str, Any]:
        body = [
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="params"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n',
            json.dumps(params, ensure_ascii=False).encode("utf-8"),
            f"\r\n--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="media"; filename="{uploaded_file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode(),
            uploaded_file.getvalue(),
            f"\r\n--{boundary}--\r\n".encode(),
        ]
        req = request.Request(
            clova_upload_url(),
            data=b"".join(body),
            headers={
                "Accept": "application/json;UTF-8",
                "X-CLOVASPEECH-API-KEY": CLOVA_SECRET,
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            method="POST",
        )
        started = time.perf_counter()
        try:
            with request.urlopen(req, timeout=120) as res:
                data = json.loads(res.read().decode("utf-8"))
        except Exception as exc:
            log_external_api_call(
                provider="NAVER CLOVA", model="clova-speech(upload)", purpose="STT 전사",
                request_format="REST multipart(sync)", secret=CLOVA_SECRET,
                duration_sec=time.perf_counter() - started, success=False,
                failure_type=f"HTTP {exc.code}" if isinstance(exc, HTTPError) else type(exc).__name__,
                target=uploaded_file.name,
            )
            raise
        log_external_api_call(
            provider="NAVER CLOVA", model="clova-speech(upload)", purpose="STT 전사",
            request_format="REST multipart(sync)", secret=CLOVA_SECRET,
            duration_sec=time.perf_counter() - started, success=True,
            target=uploaded_file.name,
        )
        return data

    try:
        try:
            data = request_clova(clova_raw_params())
        except Exception:
            data = request_clova(clova_safe_params())

        raw_transcript = raw_transcript_from_response(data) or full_text_from_response(data) or find_first_text(data)
        sentence_segments = apply_fallback_speaker_diarization(build_sentence_segments(data, actual_duration))
        response_duration = response_duration_seconds(data)
        fallback_duration = realistic_duration_for_transcript(raw_transcript, actual_duration, response_duration, sentence_segments)

        if raw_transcript and not sentence_segments:
            sentence_segments = transcript_segments_from_text(raw_transcript, fallback_duration, "화자 1")
        sentence_segments = apply_fallback_speaker_diarization(sentence_segments)

        timeline_transcript = transcript_from_segments(sentence_segments, raw_transcript)
        transcript = raw_transcript or timeline_transcript
        if not transcript.strip():
            raise RuntimeError("CLOVA Speech 전사 결과가 비어 있습니다. 음량, 파일 형식, API 응답을 확인해 주세요.")

        word_timing_units = collect_word_timings(data)
        timing_units = word_timing_units if len(word_timing_units) >= 8 else pace_timings_from_segments(sentence_segments)
        total_end = fallback_duration or choose_total_end(response_duration, sentence_segments)
        timing_units = cap_timings_to_duration(timing_units, total_end)
        if not timing_units_are_credible(timing_units, raw_transcript or transcript):
            timing_units = pace_timings_from_segments(sentence_segments)

        pace_series = pace_from_timings(timing_units, transcript_wpm(raw_transcript or transcript), total_end)
        if not pace_series and sentence_segments:
            pace_series = pace_from_timings(pace_timings_from_segments(sentence_segments), transcript_wpm(transcript), total_end)
        speaker_stats = speaker_stats_from_segments(sentence_segments)
        return transcript, pace_series, sentence_segments, speaker_stats
    except Exception as exc:
        raise RuntimeError(f"CLOVA Speech 전사 실패: {exc}") from exc
