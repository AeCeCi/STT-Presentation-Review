import re
from typing import Any


def word_count(text: Any) -> int:
    source = str(text or "").strip()
    if not source:
        return 0
    tokens = re.findall(r"[0-9A-Za-z\uAC00-\uD7A3]+", source)
    if tokens:
        return len(tokens)
    rough = [part for part in re.split(r"\s+", source) if part.strip(".,!?。！？?")]
    if rough:
        return len(rough)
    return max(1, round(len(source) / 4))


def to_seconds(value: Any) -> float | None:
    if isinstance(value, str):
        text = value.strip().replace(",", ".")
        if ":" in text:
            parts = text.split(":")
            try:
                numbers = [float(part) for part in parts]
            except ValueError:
                return None
            total = 0.0
            for number in numbers:
                total = total * 60 + number
            return total
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def first_present(data: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in data and data[key] is not None:
            return data[key]
    return None


def format_seconds(seconds: float) -> str:
    seconds = max(0, float(seconds or 0))
    return f"{int(seconds // 60):02d}:{int(seconds % 60):02d}"


def normalize_speaker(value: Any) -> str:
    if isinstance(value, dict):
        value = first_present(value, "label", "name", "id", "speaker", "speakerId", "speakerLabel", "speaker_id")
    if value in [None, ""]:
        return "화자 미상"
    text = str(value).strip()
    digit = re.search(r"\d+", text)
    if digit:
        return f"화자 {digit.group(0)}"
    if not text or re.search(r"[^0-9A-Za-z가-힣_\-\s]", text):
        return "화자 미상"
    if text.lower().startswith("speaker"):
        suffix = re.sub(r"[^0-9A-Za-z]+", "", text.split("speaker", 1)[-1], flags=re.I)
        return f"화자 {suffix or '1'}"
    if text.isdigit():
        return f"화자 {text}"
    return f"화자 {text}"


def clamp_number(value: Any, default: int, low: int = 0, high: int = 100) -> int:
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        number = default
    return max(low, min(high, number))


def normalize_score(value: Any, default: int = 0) -> int:
    score = clamp_number(value, default, 0, 100)
    if 0 < score <= 10:
        return score * 10
    return score


def parse_count_text(value: Any) -> int:
    match = re.search(r"\d+", str(value or ""))
    return int(match.group(0)) if match else 0

