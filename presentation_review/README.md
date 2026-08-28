# presentation_review

발표 분석에 쓰는 Python 모듈을 기능별로 나눠둔 폴더입니다.  
STT, 정량 분석, 자료 비교, LLM 평가, 리포트 생성으로 분리했습니다.

## 폴더 역할

```text
presentation_review/
  config/
  speech_to_text/
  speech_analysis/
  materials/
  llm/
  reports/
  pipeline/
  shared/
```

- `config/`
  - `.env` 값과 기본 설정을 읽습니다.
- `speech_to_text/`
  - CLOVA Speech 호출, 음성 길이 계산, 문장 구간 정리를 담당합니다.
- `speech_analysis/`
  - WPM, 추임새, 화자별 통계 같은 정량 지표를 계산합니다.
- `materials/`
  - PPT/PDF 텍스트를 추출하고 발표 음성과 자료 내용을 비교합니다.
- `llm/`
  - Claude 기반 평가와 질문/피드백 생성을 담당합니다.
- `reports/`
  - PDF 리포트를 만듭니다.
- `pipeline/`
  - 위 기능들을 하나의 분석 흐름으로 묶습니다.
- `shared/`
  - 여러 모듈에서 같이 쓰는 유틸 함수가 들어 있습니다.
