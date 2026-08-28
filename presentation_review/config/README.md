# config

프로젝트 실행에 필요한 환경값을 읽는 폴더입니다.

## 파일

- `settings.py`
  - `.env`에서 CLOVA, Claude 같은 API 설정을 읽습니다.
  - 기본 timeout, 모델명, 키 이름을 한곳에서 관리합니다.

## 참고

일반 서비스 실행은 `.env`를 사용합니다.  
STT 모델 비교 실험은 `evaluation/run_stt_model_cer_benchmark.py`에서 `.env.private`를 우선 읽습니다.
