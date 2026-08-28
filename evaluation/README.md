# STT Model Evaluation

STT 엔진별 한국어 전사 정확도를 CER 기준으로 비교하는 평가 폴더입니다. 회의 음성 데이터와 성우 음성 데이터를 평가 대상으로 두고, 정답 전사문이 있는 파일은 모델별 CER을 계산합니다.

## 구성

```text
evaluation/
  create_evaluation_manifest.py
  run_stt_model_cer_benchmark.py
  verify_cer_summary.py

  speech_audio_reference_manifest.csv
  speech_audio_reference_manifest.template.csv
  voice_actor_audio_missing_references.csv

  results/
    stt_model_cer_by_audio_file.csv
    stt_model_average_cer_summary.csv
```

## 파일 역할

- `create_evaluation_manifest.py`
  - 회의 음성 폴더에서 오디오 파일과 정답 TXT를 매칭합니다.
  - `--seed`를 기준으로 샘플을 뽑아 같은 조건으로 반복 실험할 수 있게 합니다.
- `run_stt_model_cer_benchmark.py`
  - CLOVA, Azure, Whisper, Google, AssemblyAI 전사를 실행합니다.
  - 모델별 전사문과 정답 전사문을 비교해서 파일별 CER을 계산합니다.
- `verify_cer_summary.py`
  - 파일별 CER 평균과 summary CSV의 모델 평균이 맞는지 확인합니다.
- `speech_audio_reference_manifest.csv`
  - 실제 평가에 들어가는 오디오 파일과 정답 전사문 목록입니다.
- `voice_actor_audio_missing_references.csv`
  - 정답 전사문이 없어 CER 계산에 바로 넣기 어려운 성우 음성 목록입니다.

## 실행 순서

1. 평가 목록 생성

```powershell
python evaluation\create_evaluation_manifest.py --limit 20 --voice-limit 20 --seed 42
```

2. 모델별 STT 실행 및 CER 계산

```powershell
python evaluation\run_stt_model_cer_benchmark.py --engines clova,azure,whisper,google,assemblyai
```

3. 평균 CER 검증

```powershell
python evaluation\verify_cer_summary.py
```

## 결과 파일

- `results/stt_model_cer_by_audio_file.csv`
  - 오디오 파일명 × STT 엔진별 CER 값이 들어갑니다.
- `results/stt_model_average_cer_summary.csv`
  - 엔진별 평균 CER 요약입니다.

## CER 계산

```text
CER = (Substitution + Deletion + Insertion) / Reference Characters * 100
```

전처리 후 정답 전사문과 모델 전사문을 문자 단위로 비교합니다. 파일별 CER을 먼저 계산하고, 그 결과를 평균 내서 모델별 평균 CER을 만듭니다.
