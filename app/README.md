# STT 발표평가 Flutter App

기존 웹 프로젝트를 바탕으로 만든 Android/iOS용 단독 Flutter 앱입니다. Python 서버를 실행하지 않고 앱이 직접 CLOVA Speech와 Claude API를 호출합니다.

## 실행

```bash
cd /Users/seungwoolee/StudioProjects/STT_Project
flutter pub get
flutter run --dart-define-from-file=env.json
```

## 프로젝트 API 설정

API 키를 Dart 코드나 앱 화면에 직접 넣지 않습니다. 프로젝트 루트의 로컬 파일 `env.json`에 넣고 빌드할 때 주입합니다.

`env.example.json`을 복사해 `env.json`을 만들고 실제 키를 넣습니다.

```bash
cp env.example.json env.json
```

필요한 값:

- `CLOVA Speech Secret Key`
- `CLOVA Speech Invoke URL`
- `Claude API Key`
- `Claude Model`

실행:

```bash
flutter run --dart-define-from-file=env.json
```

APK를 만들 때도 같은 방식으로 주입합니다.

```bash
flutter build apk --debug --dart-define-from-file=env.json
```

iOS도 동일하게 주입합니다.

```bash
flutter run --dart-define-from-file=env.json
flutter build ios --debug --no-codesign --dart-define-from-file=env.json
```

## 현재 지원 기능

- 음성 파일 선택
- 앱에서 음성 녹음
- CLOVA Speech 직접 전사
- Claude 직접 발표 분석
- Claude Key가 없을 때 앱 내부 지표 기반 기본 분석
- 전사문 붙여넣기 분석
- 발표 점수, WPM, 추임새, 개선점, 문제점, 예상 질문 표시
- 예상 질문 기반 Q&A 답변 평가
- 앱 내부 PDF 리포트 생성 및 열기
- PPTX 발표자료 텍스트 추출
- 발표자료 반영률, 누락 핵심어, 슬라이드별 반영 상태 표시
- 발표 연습 페이지별 체류 시간 기록

## 제한 사항

PPTX 자료는 앱 내부에서 텍스트를 추출해 반영률을 계산합니다. PDF 텍스트 추출과 실제 PDF 페이지 렌더링/확대축소는 아직 별도 구현이 필요합니다.

`--dart-define-from-file`은 코드에 키를 쓰지 않게 해주지만, 빌드된 앱 안에는 값이 포함될 수 있습니다. 실제 배포 앱에서 서비스 소유자 API 키를 완전히 보호하려면 앱이 직접 AI API를 호출하지 않고 별도 인증 서버를 거쳐야 합니다.
