import 'package:flutter_test/flutter_test.dart';
import 'package:stt_project/models/analysis_result.dart';
import 'package:stt_project/models/speech_models.dart';
import 'package:stt_project/services/report_builder.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('calculates Korean speaking pace from speech segments', () {
    final result = AnalysisResult.fallback(
      transcript: '저희는 오늘 새로운 발표 평가 앱의 전사 속도 측정 방식을 설명하겠습니다',
      audioName: 'sample.m4a',
      materialName: null,
      segments: const [
        SpeechSegment(
          start: 0,
          end: 10,
          speaker: '화자 1',
          text: '저희는 오늘 새로운 발표 평가 앱의 전사 속도 측정 방식을 설명하겠습니다',
        ),
      ],
    );

    expect(result.wpm, greaterThan(60));
  });

  test('does not force very slow speaking pace to 60 wpm', () {
    final result = AnalysisResult.fallback(
      transcript: '천천히 말합니다',
      audioName: 'slow.m4a',
      materialName: null,
      segments: const [
        SpeechSegment(start: 0, end: 10, speaker: '화자 1', text: '천천히 말합니다'),
      ],
    );

    expect(result.wpm, lessThan(60));
  });

  test('pace series spans the full recording timeline', () {
    final result = AnalysisResult.fallback(
      transcript: '첫 구간 발표입니다 마지막 구간 발표입니다',
      audioName: 'long.m4a',
      materialName: null,
      segments: const [
        SpeechSegment(start: 0, end: 2, speaker: '화자 1', text: '첫 구간 발표입니다'),
        SpeechSegment(
          start: 590,
          end: 595,
          speaker: '화자 1',
          text: '마지막 구간 발표입니다',
        ),
      ],
    );

    expect(result.paceSeries.last['time'], contains('09:55'));
  });

  test('builds a PDF report for long Korean transcripts', () async {
    final transcript = List.filled(
      180,
      '저희는오늘발표자료의핵심내용과고객검증결과그리고향후개선방향을설명하겠습니다.',
    ).join();
    final result = AnalysisResult.fallback(
      transcript: transcript,
      audioName: 'long.m4a',
      materialName: 'slides.pdf',
      segments: [
        for (var i = 0; i < 60; i++)
          SpeechSegment(
            start: i * 10,
            end: i * 10 + 8,
            speaker: '화자 1',
            text: '저희는 오늘 발표자료의 핵심 내용을 설명하겠습니다.',
          ),
      ],
    );

    final bytes = await ReportBuilder().build(result);

    expect(bytes.length, greaterThan(1000));
  });
}
