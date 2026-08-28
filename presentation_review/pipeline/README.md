# pipeline

발표 분석 전체 흐름을 묶는 폴더입니다.

## 파일

- `analysis.py`
  - 음성 전사
  - 문장별 타임라인 구성
  - 발화 속도/추임새/화자별 지표 계산
  - 발표자료 비교
  - Claude 평가 호출
  - 화면과 리포트에서 사용할 최종 결과 dict 생성

## 흐름

```text
audio + optional material
  -> STT
  -> speech metrics
  -> material matching
  -> LLM evaluation
  -> final analysis result
```

서버 쪽 API에서는 이 모듈을 호출해서 한 번에 분석 결과를 받습니다.
