import csv
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CSV_PATH = ROOT / "evaluation" / "results" / "stt_model_cer_by_audio_file.csv"
ENGINE_COLUMNS = [
    "clova_cer",
    "azure_cer",
    "whisper_cer",
    "google_cer",
    "assemblyai_cer",
]


def main() -> None:
    with CSV_PATH.open(newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))

    data_rows = [row for row in rows if row["audio_id"] != "AVERAGE"]
    average_row = next(row for row in rows if row["audio_id"] == "AVERAGE")

    print(f"source: {CSV_PATH}")
    print(f"audio files: {len(data_rows)}")
    for column in ENGINE_COLUMNS:
        values = [float(row[column]) for row in data_rows if row.get(column)]
        if not values:
            print(f"{column}: no values")
            continue
        calculated = round(sum(values) / len(values), 2)
        recorded = round(float(average_row[column]), 2) if average_row.get(column) else None
        status = "OK" if recorded is not None and calculated == recorded else "MISMATCH"
        print(f"{column}: calculated={calculated:.2f}, recorded={recorded}, {status}")


if __name__ == "__main__":
    main()
