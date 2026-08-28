# llm

Claude 모델을 이용해서 발표 내용을 해석하고 피드백을 만드는 폴더입니다.

## 파일

- `evaluator.py`
  - STT 전사문, 정량 지표, 자료 일치율을 Claude에 전달합니다.
  - 문제점, 보완 사항, 예상 질문, 어휘 개선 제안, 종합 의견을 생성합니다.

## 역할

정량 계산은 Python에서 먼저 끝냅니다.  
LLM은 그 숫자를 근거로 해석과 문장형 피드백을 붙이는 역할로 사용합니다.

```text
transcript + metrics + material match
  -> Claude
  -> feedback / questions / summary
```
