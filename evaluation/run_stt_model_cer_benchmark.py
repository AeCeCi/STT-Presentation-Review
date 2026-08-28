"""STT 5엔진 CER 벤치마크.

- 매니페스트(CSV)의 음성마다 CLOVA / Azure / Whisper / Google / AssemblyAI 를 호출해 문자 오류율(CER)을 계산한다.
- 엔진별 원시 응답 JSON 을 `results[/<run-name>]/raw/<audio_id>/<engine>.json` 에 호출 메타(일시·엔드포인트·모델·소요시간)와 함께 저장한다.
- 정답 전사(reference)가 아직 없는 음성도 STT 호출·저장은 수행한다(status=NO_REFERENCE). 이후 정답을 채운 뒤
  `--reuse-raw` 로 다시 실행하면 API 재호출 없이 저장된 원시 응답으로 CER 만 계산한다.
- `normalize_text` / `levenshtein_counts` / `cer` 는 논문(Table 2) 수치 재현에 쓰인 원본 로직 그대로다.

사용 예:
  python evaluation/run_stt_model_cer_benchmark.py                                  # 논문 매니페스트, 5엔진
  python evaluation/run_stt_model_cer_benchmark.py --manifest evaluation/voice_actor_manifest.csv --run-name voice_actor
  python evaluation/run_stt_model_cer_benchmark.py --manifest ... --run-name voice_actor --reuse-raw   # 정답 채운 뒤 CER 재계산
  python evaluation/run_stt_model_cer_benchmark.py --manifest ... --engines clova,whisper --limit 1     # 소량 점검
"""

import argparse
import base64
import csv
import json
import os
import platform
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from urllib import error, parse, request

from dotenv import dotenv_values, load_dotenv


ROOT = Path(__file__).resolve().parents[1]
EVALUATION_DIR = ROOT / "evaluation"
DEFAULT_MANIFEST = EVALUATION_DIR / "speech_audio_reference_manifest.csv"
RESULT_DIR = EVALUATION_DIR / "results"

ENGINES = ["clova", "azure", "whisper", "google", "assemblyai"]
CER_COLUMNS = {engine: f"{engine}_cer" for engine in ENGINES}

# 호출 옵션 (논문 조건: 엔진/모델은 고정, 타임스탬프·화자분리는 응답에 추가 정보로만 요청)
WHISPER_MODEL_DEFAULT = "whisper-1"
GOOGLE_MODEL = "latest_long"
AZURE_LANGUAGE = "ko-KR"
DIARIZATION_MIN, DIARIZATION_MAX = 1, 4
RETRY_STATUS = {408, 429, 500, 502, 503, 504}
RETRY_ATTEMPTS = 3


ENV_PATH = ROOT / ".env.private"
if not ENV_PATH.exists():
    ENV_PATH = ROOT / ".env"

load_dotenv(ENV_PATH, override=True)
RAW_DOTENV = {key.lstrip("\ufeff"): value for key, value in dotenv_values(ENV_PATH).items() if key}


def env_value(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name) or RAW_DOTENV.get(name)
        if value:
            return value.strip()
    return default


# ---------------------------------------------------------------------------
# CER (원본 로직 — 변경 금지)
# ---------------------------------------------------------------------------

def normalize_text(text: str) -> str:
    text = (text or "").lower()
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"[^0-9a-z가-힣]", "", text)
    return text


def levenshtein_counts(reference: str, hypothesis: str) -> tuple[int, int, int]:
    ref = list(reference)
    hyp = list(hypothesis)
    dp: list[list[tuple[int, int, int, int]]] = [[(0, 0, 0, 0) for _ in range(len(hyp) + 1)] for _ in range(len(ref) + 1)]
    for i in range(1, len(ref) + 1):
        cost, s, d, ins = dp[i - 1][0]
        dp[i][0] = (cost + 1, s, d + 1, ins)
    for j in range(1, len(hyp) + 1):
        cost, s, d, ins = dp[0][j - 1]
        dp[0][j] = (cost + 1, s, d, ins + 1)
    for i in range(1, len(ref) + 1):
        for j in range(1, len(hyp) + 1):
            if ref[i - 1] == hyp[j - 1]:
                same = dp[i - 1][j - 1]
            else:
                cost, s, d, ins = dp[i - 1][j - 1]
                same = (cost + 1, s + 1, d, ins)
            cost, s, d, ins = dp[i - 1][j]
            delete = (cost + 1, s, d + 1, ins)
            cost, s, d, ins = dp[i][j - 1]
            insert = (cost + 1, s, d, ins + 1)
            dp[i][j] = min(same, delete, insert, key=lambda item: (item[0], item[1] + item[2] + item[3]))
    _, substitutions, deletions, insertions = dp[-1][-1]
    return substitutions, deletions, insertions


def cer(reference: str, hypothesis: str) -> dict[str, Any]:
    ref_norm = normalize_text(reference)
    hyp_norm = normalize_text(hypothesis)
    substitutions, deletions, insertions = levenshtein_counts(ref_norm, hyp_norm)
    total = len(ref_norm)
    value = round((substitutions + deletions + insertions) / total * 100, 2) if total else 0.0
    return {
        "substitution": substitutions,
        "deletion": deletions,
        "insertion": insertions,
        "reference_chars": total,
        "cer": value,
    }


# ---------------------------------------------------------------------------
# 매니페스트 / 정답 전사 읽기
# ---------------------------------------------------------------------------

def read_reference(row: dict[str, str]) -> str:
    """정답 전사를 돌려준다. 파일이 없거나 비어 있으면 빈 문자열 (호출은 진행, CER 은 계산 안 함)."""
    if row.get("reference_text"):
        return extract_reference_text(row["reference_text"])
    path = (row.get("reference_path") or "").strip()
    if not path:
        return ""
    ref_path = Path(path)
    if not ref_path.is_absolute():
        ref_path = ROOT / ref_path
    if not ref_path.exists():
        return ""
    return extract_reference_text(read_text_any_encoding(ref_path))


def read_text_any_encoding(path: Path) -> str:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "cp949", "euc-kr"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


def flatten_json_text(value: Any) -> list[str]:
    text_keys = {
        "text", "transcript", "transcription", "sentence", "utterance", "script",
        "original", "normalized", "발화", "원문", "전사", "문장",
    }
    if isinstance(value, dict):
        texts: list[str] = []
        for key, child in value.items():
            if key in text_keys and isinstance(child, str):
                texts.append(child)
            else:
                texts.extend(flatten_json_text(child))
        return texts
    if isinstance(value, list):
        texts: list[str] = []
        for child in value:
            texts.extend(flatten_json_text(child))
        return texts
    return []


def extract_reference_text(text: str) -> str:
    stripped = (text or "").strip()
    if not stripped:
        return ""
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        return stripped
    extracted = [item.strip() for item in flatten_json_text(parsed) if item and item.strip()]
    return " ".join(extracted) if extracted else stripped


def ensure_audio(row: dict[str, str]) -> Path:
    audio_path = Path((row.get("audio_path") or "").strip())
    if not audio_path:
        raise ValueError(f"{row.get('audio_id')}: audio_path가 필요합니다.")
    if not audio_path.is_absolute():
        audio_path = ROOT / audio_path
    if audio_path.exists():
        return audio_path
    url = (row.get("audio_url") or "").strip()
    if not url:
        raise FileNotFoundError(f"audio file not found: {audio_path}")
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"download: {url} -> {audio_path}")
    request.urlretrieve(url, audio_path)
    return audio_path


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class HTTPStatusError(RuntimeError):
    def __init__(self, code: int, body: str):
        super().__init__(f"HTTP {code}: {body}")
        self.code = code
        self.body = body


def http_json(url: str, payload: dict[str, Any] | bytes | None = None, headers: dict[str, str] | None = None,
              method: str = "POST", timeout: int = 180) -> Any:
    data = payload
    if isinstance(payload, dict):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json", **(headers or {})}
    last_exc: Exception | None = None
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        req = request.Request(url, data=data, headers=headers or {}, method=method)
        try:
            with request.urlopen(req, timeout=timeout) as res:
                return json.loads(res.read().decode("utf-8"))
        except error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            last_exc = HTTPStatusError(exc.code, body)
            if exc.code not in RETRY_STATUS or attempt == RETRY_ATTEMPTS:
                raise last_exc from exc
        except (error.URLError, TimeoutError, ConnectionError) as exc:
            last_exc = exc
            if attempt == RETRY_ATTEMPTS:
                raise
        time.sleep(2 * attempt)
    raise last_exc  # pragma: no cover


def multipart_body(fields: dict[str, str], file_field: str, file_path: Path, boundary: str) -> bytes:
    body: list[bytes] = []
    for name, value in fields.items():
        body.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            value.encode("utf-8"),
            b"\r\n",
        ])
    body.extend([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="{file_field}"; filename="{file_path.name}"\r\n'.encode(),
        b"Content-Type: application/octet-stream\r\n\r\n",
        file_path.read_bytes(),
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    return b"".join(body)


def multipart_upload(url: str, fields: dict[str, str], file_field: str, file_path: Path, headers: dict[str, str]) -> Any:
    boundary = "----STTCERBenchmarkBoundary"
    req_headers = {"Content-Type": f"multipart/form-data; boundary={boundary}", **headers}
    return http_json(url, multipart_body(fields, file_field, file_path, boundary), req_headers, timeout=240)


# ---------------------------------------------------------------------------
# 엔진 호출 — 각 함수는 TranscribeResult(text, raw, meta) 를 돌려준다
# ---------------------------------------------------------------------------

@dataclass
class TranscribeResult:
    text: str
    raw: Any
    meta: dict[str, Any] = field(default_factory=dict)


def transcribe_clova(audio_path: Path) -> TranscribeResult:
    secret = env_value("CLOVA_SPEECH_SECRET_KEY", "CLOVA_SECRET_KEY", "CLOVA_SECRET")
    invoke_url = env_value("CLOVA_SPEECH_INVOKE_URL", "CLOVA_INVOKE_URL", "CLOVA_INVOKE_KEY").rstrip("/")
    if not secret or not invoke_url:
        raise RuntimeError("missing CLOVA_SPEECH_SECRET_KEY or CLOVA_SPEECH_INVOKE_URL")
    url = invoke_url if invoke_url.endswith("/recognizer/upload") else f"{invoke_url}/recognizer/upload"
    params = {
        "language": "ko-KR",
        "completion": "sync",
        "wordAlignment": True,          # 단어 단위 타임스탬프
        "fullText": True,
        "diarization": {"enable": True, "speakerCountMin": DIARIZATION_MIN, "speakerCountMax": DIARIZATION_MAX},
    }
    data = multipart_upload(
        url,
        {"params": json.dumps(params, ensure_ascii=False)},
        "media",
        audio_path,
        {"Accept": "application/json;UTF-8", "X-CLOVASPEECH-API-KEY": secret},
    )
    if data.get("result") not in (None, "COMPLETED"):
        raise RuntimeError(f"CLOVA result={data.get('result')}: {data.get('message')}")
    text = data.get("text") or data.get("fullText") or " ".join(seg.get("text", "") for seg in data.get("segments", []))
    return TranscribeResult(text, data, {
        "endpoint": "CLOVA Speech (long sentence) recognizer/upload, host=" + parse.urlsplit(url).netloc,
        "model": "clova-speech-recognizer-upload",
        "request_params": params,
        "timestamps": "word (wordAlignment)",
        "diarization": "requested (segments[].speaker)",
    })


def transcribe_whisper(audio_path: Path) -> TranscribeResult:
    key = env_value("OPENAI_API_KEY")
    model = env_value("OPENAI_WHISPER_MODEL", default=WHISPER_MODEL_DEFAULT)
    if not key:
        raise RuntimeError("missing OPENAI_API_KEY")
    boundary = "----WhisperBoundary"
    fields = {
        "model": model,
        "language": "ko",
        "response_format": "verbose_json",           # segments + 타임스탬프
        "timestamp_granularities[]": "segment",
    }
    body = multipart_body(fields, "file", audio_path, boundary)
    # timestamp_granularities 는 배열 필드라 word 를 한 번 더 붙인다
    extra = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"timestamp_granularities[]\"\r\n\r\nword\r\n").encode()
    body = body.replace(f"--{boundary}--\r\n".encode(), extra + f"--{boundary}--\r\n".encode())
    data = http_json(
        "https://api.openai.com/v1/audio/transcriptions",
        body,
        {"Authorization": f"Bearer {key}", "Content-Type": f"multipart/form-data; boundary={boundary}"},
        timeout=240,
    )
    return TranscribeResult(data.get("text", ""), data, {
        "endpoint": "https://api.openai.com/v1/audio/transcriptions",
        "model": model,
        "request_params": fields | {"timestamp_granularities[]": ["segment", "word"]},
        "timestamps": "segment + word (verbose_json)",
        "diarization": "unsupported by endpoint",
    })


def transcribe_azure(audio_path: Path) -> TranscribeResult:
    key = env_value("AZURE_SPEECH_KEY")
    region = env_value("AZURE_SPEECH_REGION")
    if not key or not region:
        raise RuntimeError("missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION")
    query = {"language": AZURE_LANGUAGE, "format": "detailed"}   # detailed: NBest(Lexical/ITN/Display/Confidence)
    url = f"https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?{parse.urlencode(query)}"
    data = http_json(
        url,
        audio_path.read_bytes(),
        {
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
            "Accept": "application/json",
        },
        timeout=180,
    )
    if data.get("RecognitionStatus") not in (None, "Success"):
        raise RuntimeError(f"Azure RecognitionStatus={data.get('RecognitionStatus')}")
    text = data.get("DisplayText") or data.get("Text") or ""
    if not text and data.get("NBest"):
        text = data["NBest"][0].get("Display", "")
    return TranscribeResult(text, data, {
        "endpoint": f"https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1",
        "model": "azure-speech-conversation-v1 (short audio REST, <=60s)",
        "request_params": query,
        "timestamps": "utterance Offset/Duration only (100ns ticks)",
        "diarization": "unsupported by endpoint",
    })


def google_access_token(credentials_path: Path) -> str:
    try:
        from google.auth.transport.requests import Request as GoogleAuthRequest
        from google.oauth2 import service_account
    except ImportError as exc:
        raise RuntimeError("missing google-auth/requests package. Run: pip install google-auth requests") from exc
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    credentials = service_account.Credentials.from_service_account_file(str(credentials_path), scopes=scopes)
    credentials.refresh(GoogleAuthRequest())
    return credentials.token


def transcribe_google(audio_path: Path) -> TranscribeResult:
    credentials_path = env_value("GOOGLE_APPLICATION_CREDENTIALS")
    project_id = env_value("GOOGLE_CLOUD_PROJECT")
    if credentials_path and project_id:
        return transcribe_google_v2(audio_path, Path(credentials_path), project_id)
    api_key = env_value("GOOGLE_SPEECH_API_KEY")
    if not api_key:
        raise RuntimeError("missing GOOGLE_APPLICATION_CREDENTIALS/GOOGLE_CLOUD_PROJECT or GOOGLE_SPEECH_API_KEY")
    url = f"https://speech.googleapis.com/v1/speech:recognize?key={parse.quote(api_key)}"
    config = {"languageCode": "ko-KR", "enableAutomaticPunctuation": True, "enableWordTimeOffsets": True}
    payload = {"config": config, "audio": {"content": base64.b64encode(audio_path.read_bytes()).decode("ascii")}}
    data = http_json(url, payload, timeout=180)
    text = " ".join(alt.get("transcript", "") for result in data.get("results", []) for alt in result.get("alternatives", [])[:1])
    return TranscribeResult(text, data, {
        "endpoint": "https://speech.googleapis.com/v1/speech:recognize (API key fallback — 논문 조건 v2 아님)",
        "model": "v1 default",
        "request_params": config,
        "timestamps": "word (enableWordTimeOffsets)",
        "diarization": "not requested",
    })


def transcribe_google_v2(audio_path: Path, credentials_path: Path, project_id: str) -> TranscribeResult:
    if not credentials_path.is_absolute():
        credentials_path = ROOT / credentials_path
    if not credentials_path.exists():
        raise FileNotFoundError(f"Google service account JSON not found: {credentials_path}")
    location = env_value("GOOGLE_SPEECH_LOCATION", default="global")
    recognizer = env_value("GOOGLE_SPEECH_RECOGNIZER", default="_")
    token = google_access_token(credentials_path)
    url = (
        "https://speech.googleapis.com/v2/"
        f"projects/{parse.quote(project_id)}/locations/{parse.quote(location)}/"
        f"recognizers/{parse.quote(recognizer)}:recognize"
    )
    features_full = {
        "enableAutomaticPunctuation": True,
        "enableWordTimeOffsets": True,
        "enableWordConfidence": True,
        "diarizationConfig": {"minSpeakerCount": DIARIZATION_MIN, "maxSpeakerCount": DIARIZATION_MAX},
    }
    content = base64.b64encode(audio_path.read_bytes()).decode("ascii")

    def call(features: dict[str, Any]) -> Any:
        payload = {
            "config": {
                "autoDecodingConfig": {},
                "languageCodes": ["ko-KR"],
                "model": GOOGLE_MODEL,
                "features": features,
            },
            "content": content,
        }
        return http_json(url, payload, {"Authorization": f"Bearer {token}"}, timeout=180)

    diarization_note = "requested (results[].alternatives[].words[].speakerLabel)"
    try:
        data = call(features_full)
        features_used = features_full
    except HTTPStatusError as exc:
        # 모델/언어 조합이 화자분리를 지원하지 않으면 400 → 화자분리만 빼고 재호출
        if exc.code == 400 and "diariz" in exc.body.lower():
            features_used = {k: v for k, v in features_full.items() if k != "diarizationConfig"}
            data = call(features_used)
            diarization_note = f"unsupported for {GOOGLE_MODEL}/ko-KR (400) — retried without diarizationConfig"
        else:
            raise
    text = " ".join(
        alt.get("transcript", "")
        for result in data.get("results", [])
        for alt in result.get("alternatives", [])[:1]
    )
    return TranscribeResult(text, data, {
        "endpoint": url.replace(project_id, "<project>"),
        "model": f"speech-v2 {GOOGLE_MODEL} (location={location}, recognizer={recognizer})",
        "request_params": {"languageCodes": ["ko-KR"], "model": GOOGLE_MODEL, "features": features_used},
        "timestamps": "word (enableWordTimeOffsets)",
        "diarization": diarization_note,
    })


def transcribe_assemblyai(audio_path: Path) -> TranscribeResult:
    key = env_value("ASSEMBLYAI_API_KEY")
    if not key:
        raise RuntimeError("missing ASSEMBLYAI_API_KEY")
    upload = http_json("https://api.assemblyai.com/v2/upload", audio_path.read_bytes(), {"authorization": key}, timeout=240)
    upload_url = upload["upload_url"]
    base_params = {"audio_url": upload_url, "language_code": "ko"}
    params_full = base_params | {"speaker_labels": True}

    def submit(params: dict[str, Any]) -> Any:
        return http_json("https://api.assemblyai.com/v2/transcript", params, {"authorization": key}, timeout=180)

    diarization_note = "requested (utterances[].speaker, words[].speaker)"
    try:
        job = submit(params_full)
        params_used = params_full
    except HTTPStatusError as exc:
        if exc.code == 400 and "speaker" in exc.body.lower():
            job = submit(base_params)
            params_used = base_params
            diarization_note = "unsupported for ko (400) — retried without speaker_labels"
        else:
            raise
    transcript_id = job["id"]
    poll_url = f"https://api.assemblyai.com/v2/transcript/{transcript_id}"
    for _ in range(90):
        result = http_json(poll_url, None, {"authorization": key}, method="GET", timeout=60)
        status = result.get("status")
        if status == "completed":
            return TranscribeResult(result.get("text", "") or "", result, {
                "endpoint": "https://api.assemblyai.com/v2/transcript",
                "model": f"assemblyai-v2 speech_model={result.get('speech_model')} acoustic_model={result.get('acoustic_model')} language_model={result.get('language_model')}",
                "request_params": {k: v for k, v in params_used.items() if k != "audio_url"},
                "timestamps": "word (words[].start/end ms)",
                "diarization": diarization_note,
            })
        if status == "error":
            raise RuntimeError(result.get("error", "AssemblyAI transcription failed"))
        time.sleep(3)
    raise TimeoutError("AssemblyAI transcription timed out")


TRANSCRIBERS: dict[str, Callable[[Path], TranscribeResult]] = {
    "clova": transcribe_clova,
    "azure": transcribe_azure,
    "whisper": transcribe_whisper,
    "google": transcribe_google,
    "assemblyai": transcribe_assemblyai,
}


# ---------------------------------------------------------------------------
# 원시 응답 저장 / 재사용
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def git_commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=5).stdout.strip() or ""
    except Exception:
        return ""


def raw_path(raw_dir: Path, audio_id: str, engine: str) -> Path:
    return raw_dir / audio_id / f"{engine}.json"


def save_raw(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")


def load_raw(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return record if record.get("status") == "OK" else None


# ---------------------------------------------------------------------------
# 실행
# ---------------------------------------------------------------------------

def load_manifest(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def run(manifest_path: Path, engines: list[str], run_name: str, reuse_raw: bool, limit: int) -> None:
    out_dir = RESULT_DIR / run_name if run_name else RESULT_DIR
    raw_dir = out_dir / "raw"
    long_csv = out_dir / "stt_model_transcripts_and_cer_details.csv"
    matrix_csv = out_dir / "stt_model_cer_by_audio_file.csv"
    summary_csv = out_dir / "stt_model_average_cer_summary.csv"
    per_file_csv = out_dir / "per_file_results.csv"          # benchmark/data/per_file_results.csv 와 동일 포맷 (전사문 제외)
    call_log_csv = out_dir / "call_log.csv"

    rows = [row for row in load_manifest(manifest_path) if row.get("audio_id")]
    if limit > 0:
        rows = rows[:limit]
    run_meta = {
        "run_started_at": now_iso(),
        "manifest": display_path(manifest_path),
        "engines": engines,
        "script_commit": git_commit(),
        "python": platform.python_version(),
        "platform": platform.platform(),
    }
    print(f"run: {len(rows)} audio × {len(engines)} engines → {display_path(out_dir)}  (reuse_raw={reuse_raw})")

    long_rows: list[dict[str, Any]] = []
    matrix_rows: list[dict[str, Any]] = []
    per_file_rows: list[dict[str, Any]] = []
    call_rows: list[dict[str, Any]] = []
    missing_reference = 0

    for row in rows:
        audio_id = row["audio_id"]
        audio_path = ensure_audio(row)
        reference = read_reference(row)
        if not reference:
            missing_reference += 1
        matrix = {
            "audio_id": audio_id,
            "dataset": row.get("dataset", ""),
            "category": row.get("category", ""),
            "audio_file": display_path(audio_path),
        }
        for engine in engines:
            record_path = raw_path(raw_dir, audio_id, engine)
            cached = load_raw(record_path) if reuse_raw else None
            if cached:
                transcript = cached.get("text", "")
                call_status, error_message, elapsed, source = "OK", "", cached.get("elapsed_seconds", ""), "raw-cache"
                meta = cached.get("meta", {})
                called_at = cached.get("called_at", "")
            else:
                called_at = now_iso()
                started = time.perf_counter()
                try:
                    result = TRANSCRIBERS[engine](audio_path)
                    transcript, call_status, error_message, meta = result.text, "OK", "", result.meta
                    raw_response: Any = result.raw
                except Exception as exc:
                    transcript, meta, raw_response = "", {}, None
                    call_status = "SKIPPED" if "missing" in str(exc).lower() else "ERROR"
                    error_message = str(exc)
                elapsed = round(time.perf_counter() - started, 3)
                source = "api"
                save_raw(record_path, {
                    "audio_id": audio_id,
                    "engine": engine,
                    "audio_file": matrix["audio_file"],
                    "called_at": called_at,
                    "elapsed_seconds": elapsed,
                    "status": call_status,
                    "error": error_message,
                    "text": transcript,
                    "meta": meta,
                    "run": run_meta,
                    "response": raw_response,
                })

            if call_status == "OK" and reference:
                scores = cer(reference, transcript)
                status = "OK"
            elif call_status == "OK":
                scores = {"substitution": "", "deletion": "", "insertion": "", "reference_chars": 0, "cer": ""}
                status = "NO_REFERENCE"
            else:
                scores = {"substitution": "", "deletion": "", "insertion": "", "reference_chars": len(normalize_text(reference)), "cer": ""}
                status = call_status

            matrix[CER_COLUMNS[engine]] = scores["cer"]
            base = {
                "audio_id": audio_id,
                "dataset": row.get("dataset", ""),
                "category": row.get("category", ""),
            }
            per_file_rows.append(base | {
                "engine": engine, "status": status, "cer": scores["cer"],
                "substitution": scores["substitution"], "deletion": scores["deletion"], "insertion": scores["insertion"],
                "reference_chars": scores["reference_chars"],
            })
            long_rows.append(base | {
                "audio_file": matrix["audio_file"],
                "engine": engine,
                "status": status,
                "cer": scores["cer"],
                "substitution": scores["substitution"],
                "deletion": scores["deletion"],
                "insertion": scores["insertion"],
                "reference_chars": scores["reference_chars"],
                "reference_text": reference,
                "hypothesis_text": transcript,
                "error": error_message,
            })
            call_rows.append(base | {
                "engine": engine,
                "called_at": called_at,
                "source": source,
                "elapsed_seconds": elapsed,
                "call_status": call_status,
                "endpoint": meta.get("endpoint", ""),
                "model": meta.get("model", ""),
                "timestamps": meta.get("timestamps", ""),
                "diarization": meta.get("diarization", ""),
                "error": error_message,
            })
            cer_text = f"CER {scores['cer']}" if scores["cer"] != "" else ""
            print(f"{audio_id} / {engine:<10} {status:<12} {cer_text:<10} {elapsed}s [{source}]" + (f"  {error_message[:120]}" if error_message else ""))
        matrix_rows.append(matrix)

    average_row = {"audio_id": "AVERAGE", "dataset": "", "category": "", "audio_file": ""}
    summary_rows: list[dict[str, Any]] = []
    for engine in engines:
        values = [float(r[CER_COLUMNS[engine]]) for r in matrix_rows if r.get(CER_COLUMNS[engine]) not in ("", None)]
        average = round(sum(values) / len(values), 2) if values else ""
        average_row[CER_COLUMNS[engine]] = average
        summary_rows.append({"engine": engine, "audio_count": len(values), "average_cer": average})
    matrix_rows.append(average_row)

    write_csv(long_csv, long_rows, [
        "audio_id", "dataset", "category", "audio_file", "engine", "status", "cer",
        "substitution", "deletion", "insertion", "reference_chars", "reference_text", "hypothesis_text", "error",
    ])
    write_csv(matrix_csv, matrix_rows, ["audio_id", "dataset", "category", "audio_file", *[CER_COLUMNS[e] for e in engines]])
    write_csv(summary_csv, summary_rows, ["engine", "audio_count", "average_cer"])
    write_csv(per_file_csv, per_file_rows, [
        "audio_id", "dataset", "category", "engine", "status", "cer", "substitution", "deletion", "insertion", "reference_chars",
    ])
    write_csv(call_log_csv, call_rows, [
        "audio_id", "dataset", "category", "engine", "called_at", "source", "elapsed_seconds", "call_status",
        "endpoint", "model", "timestamps", "diarization", "error",
    ])
    (out_dir / "run_meta.json").write_text(json.dumps(run_meta | {"run_finished_at": now_iso()}, ensure_ascii=False, indent=2), encoding="utf-8")

    for path in (long_csv, matrix_csv, summary_csv, per_file_csv, call_log_csv):
        print(f"wrote: {display_path(path)}")
    print(f"raw responses: {display_path(raw_dir)}")
    if missing_reference:
        print(f"주의: 정답 전사가 없는 음성 {missing_reference}개 → CER 미계산(NO_REFERENCE). 정답을 채운 뒤 --reuse-raw 로 다시 실행하면 재호출 없이 CER 만 계산합니다.")


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Run STT engines, save raw responses, and calculate per-file CER.")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST), help="CSV manifest with audio and reference transcript paths.")
    parser.add_argument("--engines", default=",".join(ENGINES), help="Comma-separated engines: clova,azure,whisper,google,assemblyai")
    parser.add_argument("--run-name", default="", help="결과를 evaluation/results/<run-name>/ 아래에 저장 (미지정 시 evaluation/results/).")
    parser.add_argument("--reuse-raw", action="store_true", help="저장된 원시 응답(raw/<audio_id>/<engine>.json)이 있으면 API 를 다시 호출하지 않고 재사용.")
    parser.add_argument("--limit", type=int, default=0, help="매니페스트 앞 N개만 실행 (점검용). 0=전체.")
    args = parser.parse_args()
    engines = [engine.strip() for engine in args.engines.split(",") if engine.strip()]
    unknown = [engine for engine in engines if engine not in TRANSCRIBERS]
    if unknown:
        raise SystemExit(f"unknown engines: {', '.join(unknown)}")
    run(Path(args.manifest), engines, args.run_name.strip(), args.reuse_raw, args.limit)


if __name__ == "__main__":
    main()
