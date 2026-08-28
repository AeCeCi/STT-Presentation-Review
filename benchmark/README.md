# Benchmark Data and Verification (Paper Companion)

This folder accompanies the paper *"An Integrated STT-Based Multimodal Pre-Screening System for Korean Oral Presentations with an Analytics-Fitness Benchmark of Five Speech-to-Text Engines"* (Applied Sciences, manuscript applsci-4516784).

## Folder contents

- `data/per_file_results.csv` — per-file, per-engine results under the **pipeline-original normalization** (N = 20 recordings x 5 engines; raw CER, substitution/deletion/insertion counts, reference length). Transcript texts are excluded per source-corpus licensing (AIHub KconfSpeech).
- `data/per_file_results_corrected.csv` — per-file CER under the **corrected reference normalization described in Section 5 of the paper** (dual transcriptions resolved to orthographic forms, non-speech codes removed, interjection slashes resolved). **Engine means of this file match Table 2 of the paper exactly.**
- `data/per_file_results_whitespace_preserved.csv` — per-file CER under a **whitespace-preserving normalization** (spaces kept as characters; `cer_ws_preserved_pct`, `reference_chars_ws`), added in revision for Reviewer 3.
- `data/audio_file_metadata.csv` — measured metadata of the 20 benchmark recordings (duration, sample rate, channels, format, file size, corrected reference length, utterance speaker id, unique speakers per session), added in revision for Reviewers 1 and 2.
- `scripts/verify_paper_stats.py` — recomputes and checks every published statistic (CER means/SDs, Friedman/Wilcoxon/Holm, Kendall's W, ranks, FPR, error composition) against the paper's values. Requires the transcript-level CSV, which is not redistributed here; researchers can obtain the corpus via AIHub and regenerate it with `evaluation/run_stt_model_cer_benchmark.py`, then run this script for a full end-to-end check.
- `scripts/compute_cer.py` — standalone corrected-normalization CER/FPR computation kit (refs/hyps text-file layout; see script header).
- `verify_cer_summary.py` — legacy verifier for the pipeline-original summary values (kept for continuity with `evaluation/`).
- `results/` — pipeline-original summary outputs (numeric only).

## Quick verification without the corpus

Compare engine means of `data/per_file_results_corrected.csv` with Table 2 of the paper — they match exactly (CLOVA 4.65, Azure 5.76, Google 6.70, Whisper 7.89, AssemblyAI 8.70; mean CER %).

## Notes

- Benchmark calls were made on 2026-07-22 (KST) with: CLOVA Speech recognizer upload API, Azure Speech conversation v1 (ko-KR), OpenAI Whisper API `whisper-1`, Google Speech-to-Text v2 `latest_long`, AssemblyAI v2.
- Audio files and corpus transcripts are not redistributed owing to source licensing (professional voice recordings; AIHub corpus terms).
