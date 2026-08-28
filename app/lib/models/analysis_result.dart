import 'dart:math';

import '../utils/text_metrics.dart';
import 'material_info.dart';
import 'speech_models.dart';

class AnalysisResult {
  const AnalysisResult({
    required this.audioName,
    required this.materialName,
    required this.transcript,
    required this.segments,
    required this.score,
    required this.grade,
    required this.status,
    required this.wpm,
    required this.fillerTotal,
    required this.fillerWords,
    required this.voiceScores,
    required this.paceSeries,
    required this.vocabSuggestions,
    required this.problems,
    required this.questions,
    required this.priorities,
    required this.summary,
    required this.source,
    required this.documentMatch,
  });

  final String audioName;
  final String? materialName;
  final String transcript;
  final List<SpeechSegment> segments;
  final int score;
  final String grade;
  final String status;
  final int wpm;
  final int fillerTotal;
  final List<Map<String, dynamic>> fillerWords;
  final Map<String, int> voiceScores;
  final List<Map<String, dynamic>> paceSeries;
  final List<String> vocabSuggestions;
  final List<String> problems;
  final List<String> questions;
  final List<String> priorities;
  final String summary;
  final String source;
  final DocumentMatch documentMatch;

  factory AnalysisResult.fallback({
    required String transcript,
    required String audioName,
    required String? materialName,
    required List<SpeechSegment> segments,
  }) {
    final fillers = countFillerWords(transcript);
    final fillerTotal = fillers.fold<int>(0, (sum, item) => sum + item.count);
    final wpm = _wpm(transcript, segments);
    final score =
        (82 - min(24, (wpm - 135).abs() ~/ 3) - min(18, fillerTotal ~/ 2))
            .clamp(35, 88)
            .toInt();
    return AnalysisResult(
      audioName: audioName,
      materialName: materialName,
      transcript: transcript,
      segments: segments,
      score: score,
      grade: score >= 82
          ? 'A-'
          : score >= 76
          ? 'B+'
          : score >= 65
          ? 'B'
          : 'C',
      status: score >= 76 ? '통과 예상' : '보완 필요',
      wpm: wpm,
      fillerTotal: fillerTotal,
      fillerWords: fillers.map((f) => f.toJson()).toList(),
      voiceScores: {
        '발표 흐름': (score + (wpm >= 110 && wpm <= 150 ? 3 : -8))
            .clamp(0, 100)
            .toInt(),
        '내용 전달력': (score - min(14, fillerTotal ~/ 4)).clamp(0, 100).toInt(),
        'Q&A 대응': (score - 8).clamp(0, 100).toInt(),
        '시간 관리': (90 - (wpm - 135).abs() ~/ 2).clamp(0, 100).toInt(),
      },
      paceSeries: _paceSeries(transcript, segments, wpm),
      vocabSuggestions: _vocabSuggestions(transcript),
      problems: _problems(transcript, wpm, fillerTotal),
      questions: _questions(),
      priorities: const [
        '추임새가 반복되는 지점을 표시하고 문장 시작 전 0.5초 침묵으로 바꾸세요.',
        '핵심 수치와 결론 뒤에는 1초 정도 멈춰 심사위원이 받아쓸 시간을 주세요.',
        '문제, 해결책, 고객 검증, 수익모델을 각각 두 문장 이상으로 보강하세요.',
      ],
      summary: '앱 내부 지표로 기본 발표 평가를 생성했습니다.',
      source: '앱 내부 지표',
      documentMatch: DocumentMatch.unavailable(name: materialName ?? ''),
    );
  }

  AnalysisResult mergeClaude(Map<String, dynamic> judged) {
    final mergedScore = _score(judged['score'], score);
    return copyWith(
      score: mergedScore,
      grade: _string(judged['grade'], grade),
      status: _string(judged['status'], status),
      voiceScores: _voiceScores(
        judged['voice_scores'],
        mergedScore,
        wpm,
        fillerTotal,
      ),
      vocabSuggestions: _stringList(
        judged['vocab_suggestions'],
        vocabSuggestions,
      ),
      problems: _stringList(judged['problems'], problems),
      questions: _stringList(judged['questions'], questions).take(10).toList(),
      priorities: _stringList(judged['improvement_priorities'], priorities),
      summary: _string(judged['summary'], summary),
      source: 'CLOVA Speech + Claude + 앱 내부 지표',
    );
  }

  AnalysisResult withDocumentMatch(DocumentMatch match) {
    return copyWith(documentMatch: match);
  }

  AnalysisResult copyWith({
    int? score,
    String? grade,
    String? status,
    Map<String, int>? voiceScores,
    List<String>? vocabSuggestions,
    List<String>? problems,
    List<String>? questions,
    List<String>? priorities,
    String? summary,
    String? source,
    DocumentMatch? documentMatch,
  }) {
    return AnalysisResult(
      audioName: audioName,
      materialName: materialName,
      transcript: transcript,
      segments: segments,
      score: score ?? this.score,
      grade: grade ?? this.grade,
      status: status ?? this.status,
      wpm: wpm,
      fillerTotal: fillerTotal,
      fillerWords: fillerWords,
      voiceScores: voiceScores ?? this.voiceScores,
      paceSeries: paceSeries,
      vocabSuggestions: vocabSuggestions ?? this.vocabSuggestions,
      problems: problems ?? this.problems,
      questions: questions ?? this.questions,
      priorities: priorities ?? this.priorities,
      summary: summary ?? this.summary,
      source: source ?? this.source,
      documentMatch: documentMatch ?? this.documentMatch,
    );
  }

  static int _wpm(String transcript, List<SpeechSegment> segments) {
    final units = max(1, speechUnitCount(transcript));
    if (segments.isNotEmpty) {
      final activeSeconds = segments.fold<double>(0, (sum, segment) {
        return sum + max(0.0, segment.end - segment.start);
      });
      final seconds = activeSeconds > 0
          ? activeSeconds
          : max(
              1.0,
              segments.map((s) => s.end).reduce(max) -
                  segments.map((s) => s.start).reduce(min),
            );
      return (units / max(1.0, seconds) * 60).round().clamp(20, 260);
    }
    return 115;
  }

  static List<Map<String, dynamic>> _paceSeries(
    String transcript,
    List<SpeechSegment> segments,
    int fallbackWpm,
  ) {
    if (segments.isEmpty) {
      return [
        {'time': '00:00-00:30', 'wpm': fallbackWpm},
      ];
    }
    final start = segments.map((s) => s.start).reduce(min);
    final end = segments.map((s) => s.end).reduce(max);
    final duration = max(1.0, end - start);
    final bucketCount = min(12, max(1, (duration / 30).ceil()));
    final bucketSize = duration / bucketCount;
    final segmentUnits = {
      for (final segment in segments) segment: speechUnitCount(segment.text),
    };
    final rows = <Map<String, dynamic>>[];
    for (var i = 0; i < bucketCount; i++) {
      final bucketStart = start + bucketSize * i;
      final bucketEnd = i == bucketCount - 1 ? end : bucketStart + bucketSize;
      var activeSeconds = 0.0;
      var units = 0;
      for (final segment in segments) {
        final overlapStart = max(segment.start, bucketStart);
        final overlapEnd = min(segment.end, bucketEnd);
        final overlapSeconds = overlapEnd - overlapStart;
        if (overlapSeconds <= 0) continue;
        final segmentSeconds = max(1.0, segment.end - segment.start);
        activeSeconds += overlapSeconds;
        units +=
            ((segmentUnits[segment] ?? 0) * overlapSeconds / segmentSeconds)
                .round();
      }
      final wpm = activeSeconds <= 0
          ? 0
          : (units / activeSeconds * 60).round().clamp(0, 500);
      rows.add({
        'time':
            '${SpeechSegment.clockLabel(bucketStart)}-${SpeechSegment.clockLabel(bucketEnd)}',
        'wpm': wpm,
      });
    }
    return rows;
  }

  static List<String> _vocabSuggestions(String transcript) {
    final rules = {
      '이제': '이제 -> 다음으로: 문장 전환 습관어를 줄이세요.',
      '그': '그 -> 해당/이: 지시어 반복을 줄이세요.',
      '사실은': '사실은 -> 핵심은: 결론형 표현으로 바꾸세요.',
      '좀': '좀 -> 다소/약간: 모호한 구어체 표현을 줄이세요.',
      '어': '어 -> 짧은 침묵: 불필요한 발성을 줄이세요.',
      '음': '음 -> 짧은 침묵: 생각을 정리한 뒤 말하세요.',
    };
    return rules.entries
        .where((entry) => transcript.contains(entry.key))
        .map((entry) => entry.value)
        .take(5)
        .toList();
  }

  static List<String> _problems(String transcript, int wpm, int fillerTotal) {
    final rows = <String>[];
    if (wpm < 100) rows.add('발화 속도가 느립니다. 불필요한 공백과 반복 표현을 줄이세요.');
    if (wpm > 155) rows.add('발화 속도가 빠릅니다. 핵심 문장 뒤에 1초 정도 멈추세요.');
    if (fillerTotal >= 10) rows.add('추임새가 반복되어 발표 전문성이 약해 보일 수 있습니다.');
    if (transcript.length < 500) rows.add('전사된 발표 내용이 짧아 심사 근거가 충분하지 않습니다.');
    if (rows.isEmpty) rows.add('발표 구조를 도입, 문제, 해결책, 근거, 요청사항 순서로 더 명확히 나누세요.');
    return rows;
  }

  static List<String> _questions() => const [
    '현재 제시한 문제가 실제 고객에게 얼마나 자주 발생하나요?',
    '초기 핵심 고객군은 누구이며 왜 지금 구매해야 하나요?',
    '시장 규모 산정 근거와 출처는 무엇인가요?',
    '기존 대안이나 경쟁사 대비 명확한 차별점은 무엇인가요?',
    '가격 정책과 원가 구조를 고려했을 때 수익성은 어떻게 확보하나요?',
    '지원금 또는 투자금이 들어오면 가장 먼저 실행할 항목은 무엇인가요?',
    '현재까지 고객 검증이나 파일럿 결과가 있나요?',
    '가장 큰 사업 리스크와 대응 계획은 무엇인가요?',
    '팀이 이 문제를 가장 잘 해결할 수 있는 근거는 무엇인가요?',
    '6개월 안에 달성할 핵심 지표는 무엇인가요?',
  ];

  static int _score(dynamic value, int fallback) {
    if (value is num) return value.round().clamp(0, 100);
    return int.tryParse('$value')?.clamp(0, 100) ?? fallback;
  }

  static String _string(dynamic value, String fallback) {
    final text = value == null ? '' : '$value'.trim();
    return text.isEmpty ? fallback : text;
  }

  static Map<String, int> _voiceScores(
    dynamic value,
    int score,
    int wpm,
    int fillerTotal,
  ) {
    final fallback = <String, int>{
      '발표 흐름': (score + (wpm >= 110 && wpm <= 150 ? 3 : -8))
          .clamp(0, 100)
          .toInt(),
      '내용 전달력': (score - min(14, fillerTotal ~/ 4)).clamp(0, 100).toInt(),
      'Q&A 대응': (score - 8).clamp(0, 100).toInt(),
      '시간 관리': (90 - (wpm - 135).abs() ~/ 2).clamp(0, 100).toInt(),
    };
    if (value is! Map) return fallback;
    return {
      for (final key in fallback.keys)
        key: value[key] is num
            ? (value[key] as num).round().clamp(0, 100).toInt()
            : fallback[key]!,
    };
  }

  static List<String> _stringList(dynamic value, List<String> fallback) {
    if (value is! List) return fallback;
    final rows = value
        .map(_compactText)
        .where((text) => text.isNotEmpty)
        .toList();
    return rows.isEmpty ? fallback : rows;
  }

  static String _compactText(dynamic value) {
    if (value == null) return '';
    if (value is String) return value.trim();
    if (value is Map) {
      final first =
          value['title'] ??
          value['question'] ??
          value['problem'] ??
          value['original'] ??
          value['category'];
      final second =
          value['detail'] ??
          value['fix'] ??
          value['reason'] ??
          value['replacement'];
      return [
        first,
        second,
      ].where((item) => item != null && '$item'.trim().isNotEmpty).join(' - ');
    }
    return '$value'.trim();
  }
}
