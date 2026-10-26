# STT Presentation Review

발표 음성을 STT로 전사하고, 발표 속도/추임새/문장 구간/자료 반영률을 같이 보는 발표 평가 프로젝트입니다.
기본 기능은 발표 자료와 음성을 올려 분석하는 쪽이고, `evaluation/`에는 STT 모델 5개를 따로 비교한 CER 실험 파일을 모아뒀습니다.

## Reviewer / Data Availability

논문 심사용 공개 자료는 저장소 루트의 `benchmark/` 폴더에 정리했습니다. 전사 원문과 음성을 제외한 파일별 CER 수치 CSV(원본·교정 정규화 2종), 논문 수치 검증 스크립트, 상세 설명 README가 포함됩니다. 교정판 CSV의 엔진 평균은 논문 Table 2와 일치합니다.

벤치마크 호출 기록: `2026-07-22 17:29:04 +0900` 생성 결과 기준이며, 사용 STT 엔진은 CLOVA Speech recognizer upload API, Azure Speech conversation recognition v1 (`ko-KR`), OpenAI Whisper API `whisper-1`, Google Speech-to-Text v2 `latest_long`, AssemblyAI v2 transcript API입니다.

## 주요 기능

- 발표 음성 업로드 후 STT 전사
- 문장별 타임라인, 공백 시간, 화자 정보 정리
- WPM 기준 발화 속도 계산
- 추임새, 어휘 개선, 발표 흐름 분석
- PPT/PDF 발표자료와 실제 발화 내용 비교
- 발표 연습 탭에서 자료 페이지별 체류 시간 기록
- 실시간 한국어 STT 및 번역
- 분석 결과 PDF 리포트 다운로드
- STT 모델별 CER 비교 실험

## 실행 방법

```
pip install -r requirements.txt
python3 server.py
```

브라우저에서 아래 주소로 접속합니다.

```
http://127.0.0.1:8502
```

## 환경 변수

실행용 키는 `.env`에 둡니다.

```
CLOVA_SPEECH_SECRET_KEY
CLOVA_SPEECH_INVOKE_URL
CLAUDE_API_KEY
CLAUDE_MODEL
ADMIN_LOGIN_ID
ADMIN_LOGIN_PASSWORD
```

모든 `/api/*` 기능(발표 분석·텍스트 분석·번역·답변 평가·PDF 리포트·자료 미리보기·녹음 저장)과 관리자 화면은 로그인(세션 쿠키 `stt_session`, 7일 슬라이딩 만료)이 필요합니다. 정적 파일(`/`, `/app.js`, `/styles.css`, `/assets/*`)만 공개입니다.

- `ADMIN_LOGIN_ID` / `ADMIN_LOGIN_PASSWORD`: 서버 시작 시 **admin 역할 사용자가 하나도 없을 때만** 이 값으로 관리자 계정을 만듭니다. 이후에는 `output/auth/users.json`이 기준이라 `.env` 값을 바꿔도 기존 관리자 비밀번호는 바뀌지 않습니다. 설정이 없고 관리자도 없으면 경고만 남기고 서비스는 계속되며, 로그인은 모두 실패합니다. 비밀번호는 10자 이상.
- 계정은 `output/auth/users.json`(PBKDF2-SHA256 해시만 저장), 세션은 `output/auth/sessions.json`(토큰의 SHA-256만 저장)에 보관됩니다. 둘 다 `output/`이라 저장소에 올라가지 않습니다.
- 로그인한 사용자의 기능 호출은 `output/api_usage.jsonl`에 한 줄씩 기록됩니다(사용자·기능·성공 여부·상태 코드·소요 시간·파일명/크기 같은 메타데이터만, 전사문·답변 내용은 기록하지 않음). 관리자는 `/api/admin/usage-log`, `/api/admin/usage-summary`로 조회합니다.
- 일반 사용자 계정은 관리자 로그인 후 `POST /api/admin/users`로 만들거나 CLI로 관리합니다.
- (선택) `PORT`(기본 8502), `STT_OUTPUT_DIR`(기본 `output`), 테스트용 `STT_SKIP_DOTENV=1`(`.env`를 읽지 않음).

```
.venv\Scripts\python.exe -X utf8 -m presentation_review.auth.manage create-user <id> --name <이름> [--role user|admin] [--password-env VAR]
.venv\Scripts\python.exe -X utf8 -m presentation_review.auth.manage list-users
.venv\Scripts\python.exe -X utf8 -m presentation_review.auth.manage set-password <id> [--password-env VAR]
.venv\Scripts\python.exe -X utf8 -m presentation_review.auth.manage disable <id> | enable <id> | delete <id>
```

비밀번호는 `--password-env`로 지정한 환경 변수에서 읽거나 프롬프트로 입력합니다(명령행 인자로는 받지 않음). 로그인 API는 IP당 10분에 20회, 같은 아이디로 5회 연속 실패하면 10분간 잠깁니다. 서버 테스트는 `.venv\Scripts\python.exe -X utf8 -m unittest tests.test_auth_server -v`로 실행합니다(포트 8512, 임시 `output` 폴더 사용).

STT 모델 비교 실험용 키는 `.env.private`에 둡니다.

```
AZURE_SPEECH_KEY
OPENAI_API_KEY
GOOGLE_APPLICATION_CREDENTIALS
GOOGLE_CLOUD_PROJECT
ASSEMBLYAI_API_KEY
```

`.env.example`은 어떤 값을 넣어야 하는지 보는 샘플 파일입니다. 실제 키는 넣지 않습니다.

공개 저장소에는 `.env`, `.env.private`, `secrets/`, 원본 음성 데이터, 원문 전사 파일을 올리지 않습니다. CLOVA Speech 또는 Claude API 호출이 실패하면 대체(fallback) 결과 없이, 어떤 API가 실패했는지 명시한 에러 메시지가 화면에 표시됩니다.

## 폴더 구조

```
stt-presentation-review/
  server.py
  index.html
  app.js
  styles.css
  requirements.txt
  .env.example

  presentation_review/
    config/
    speech_to_text/
    speech_analysis/
    materials/
    llm/
    reports/
    pipeline/
    shared/

  evaluation/
    create_evaluation_manifest.py
    run_stt_model_cer_benchmark.py
    verify_cer_summary.py
    results/

  benchmark/
    README.md
    verify_cer_summary.py
    results/
    data/
      per_file_results.csv
      per_file_results_corrected.csv
    scripts/
      verify_paper_stats.py
      compute_cer.py
```

## 모델 비교 실험

STT 모델 비교는 `evaluation/` 폴더에서 따로 관리합니다.

```
python evaluation\create_evaluation_manifest.py --limit 20 --voice-limit 20 --seed 42
python evaluation\run_stt_model_cer_benchmark.py --engines clova,azure,whisper,google,assemblyai
python evaluation\verify_cer_summary.py
```

결과 파일은 아래에 생성됩니다.

```
evaluation/results/stt_model_cer_by_audio_file.csv
evaluation/results/stt_model_average_cer_summary.csv
```

논문 공개용 `benchmark/` 폴더에는 라이선스 이슈가 있는 전사 원문 CSV를 포함하지 않습니다.

## CER 계산 방식

CER은 직접 값을 넣은 게 아니라 실제 전사 결과로 계산합니다.

```
CER = (Substitution + Deletion + Insertion) / Reference Characters * 100
```

정답 전사문과 각 STT 모델 전사문을 문자 단위로 비교하고, 공백/문장부호는 제거한 뒤 계산합니다.
