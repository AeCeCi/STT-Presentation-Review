# speech_to_text

음성을 텍스트로 바꾸고, STT 결과에서 시간 정보를 정리하는 폴더입니다.

## 파일

- `clova_speech.py`
  - Naver CLOVA Speech API를 호출합니다.
  - 전사문, segment, word timestamp, 화자 정보를 가져옵니다.
- `audio_duration.py`
  - 업로드한 음성 파일의 전체 길이를 계산합니다.
- `segments.py`
  - CLOVA 결과를 문장별 타임라인으로 정리합니다.
  - 문장 시작/종료 시간, 공백 시간, 화자 정보를 다룹니다.

## 흐름

```text
audio file
  -> CLOVA Speech
  -> raw STT result
  -> sentence timeline
  -> speech analysis
```
