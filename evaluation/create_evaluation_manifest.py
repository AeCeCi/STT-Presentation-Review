import argparse
import csv
import random
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EVALUATION_DIR = ROOT / "evaluation"
DEFAULT_OUTPUT = EVALUATION_DIR / "speech_audio_reference_manifest.csv"
VOICE_ACTOR_OUTPUT = EVALUATION_DIR / "voice_actor_audio_missing_references.csv"


def relative_key(path: Path, suffix: str) -> str | None:
    parts = list(path.parts)
    try:
        start = parts.index("D20")
    except ValueError:
        return None
    return str(Path(*parts[start:]).with_suffix(suffix)).replace("\\", "/")


def write_csv(path: Path, rows: list[dict[str, str]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def apply_sample_limit(rows: list[dict[str, str]], limit: int, seed: int) -> list[dict[str, str]]:
    shuffled = rows[:]
    random.Random(seed).shuffle(shuffled)
    return shuffled if limit == 0 else shuffled[:limit]


def build_speech_rows(speech_root: Path, limit: int, seed: int) -> list[dict[str, str]]:
    label_root = speech_root / "라벨링데이터"
    audio_root = speech_root / "원천데이터"
    wav_by_key: dict[str, Path] = {}
    for wav in audio_root.rglob("*.wav"):
        key = relative_key(wav, ".txt")
        if key:
            wav_by_key[key] = wav

    rows: list[dict[str, str]] = []
    for label in sorted(label_root.rglob("*.txt")):
        key = relative_key(label, ".txt")
        if not key or key not in wav_by_key:
            continue
        session = label.parent.name
        stem = label.stem
        rows.append({
            "audio_id": f"speech_{session}_{stem}",
            "dataset": "KconfSpeech",
            "category": "meeting",
            "audio_path": str(wav_by_key[key]),
            "audio_url": "",
            "reference_path": str(label),
            "reference_text": "",
        })
    return apply_sample_limit(rows, limit, seed)


def build_voice_actor_rows(voice_root: Path, limit: int, seed: int) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for audio in sorted([*voice_root.rglob("*.wav"), *voice_root.rglob("*.mp3"), *voice_root.rglob("*.mp4")]):
        rows.append({
            "audio_id": audio.stem,
            "dataset": "VoiceActor",
            "category": "voice_actor",
            "audio_path": str(audio),
            "reference_required": "true",
        })
    return apply_sample_limit(rows, limit, seed)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a real STT CER manifest from local speech datasets.")
    parser.add_argument("--speech-root", required=True, help="Desktop speech_data folder.")
    parser.add_argument("--voice-root", required=True, help="Desktop voice actor_data folder.")
    parser.add_argument("--limit", type=int, default=20, help="Number of labeled speech files to include. Use 0 for all.")
    parser.add_argument("--voice-limit", type=int, default=20, help="Number of voice actor files to list. Use 0 for all.")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for reproducible sampling.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Output manifest CSV.")
    args = parser.parse_args()

    speech_root = Path(args.speech_root)
    voice_root = Path(args.voice_root)
    rows = build_speech_rows(speech_root, args.limit, args.seed)
    voice_rows = build_voice_actor_rows(voice_root, args.voice_limit, args.seed)

    write_csv(Path(args.output), rows, [
        "audio_id", "dataset", "category", "audio_path", "audio_url", "reference_path", "reference_text",
    ])
    write_csv(VOICE_ACTOR_OUTPUT, voice_rows, ["audio_id", "dataset", "category", "audio_path", "reference_required"])

    print(f"speech manifest rows: {len(rows)}")
    print(f"voice actor files without reference: {len(voice_rows)}")
    print(f"random seed: {args.seed}")
    print(f"wrote: {args.output}")
    print(f"wrote: {VOICE_ACTOR_OUTPUT}")


if __name__ == "__main__":
    main()
