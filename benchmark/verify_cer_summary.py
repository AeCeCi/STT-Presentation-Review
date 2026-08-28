import csv
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MATRIX_CSV = ROOT / "results" / "stt_model_cer_by_audio_file.csv"
SUMMARY_CSV = ROOT / "results" / "stt_model_average_cer_summary.csv"
ENGINES = ["clova", "azure", "whisper", "google", "assemblyai"]


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def main() -> None:
    matrix_rows = [row for row in read_rows(MATRIX_CSV) if row.get("audio_id") != "AVERAGE"]
    summary_rows = {row["engine"]: row for row in read_rows(SUMMARY_CSV)}

    print(f"source: {MATRIX_CSV}")
    print(f"audio files: {len(matrix_rows)}")
    for engine in ENGINES:
        column = f"{engine}_cer"
        values = [float(row[column]) for row in matrix_rows if row.get(column)]
        calculated = round(sum(values) / len(values), 2) if values else None
        recorded_row = summary_rows.get(engine, {})
        recorded = round(float(recorded_row["average_cer"]), 2) if recorded_row.get("average_cer") else None
        status = "OK" if calculated == recorded else "MISMATCH"
        print(f"{engine}: calculated={calculated:.2f}, recorded={recorded:.2f}, {status}")


if __name__ == "__main__":
    main()
