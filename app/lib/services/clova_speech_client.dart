import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import '../models/app_picked_file.dart';
import '../models/app_settings.dart';
import '../models/speech_models.dart';
import '../utils/text_metrics.dart';

class ClovaSpeechClient {
  const ClovaSpeechClient(this.settings);

  final AppSettings settings;

  Future<SttResult> transcribe(AppPickedFile file) async {
    final path = file.path;
    final uri = Uri.parse(_uploadUrl(settings.clovaInvokeUrl));
    final request = http.MultipartRequest('POST', uri)
      ..headers['Accept'] = 'application/json;UTF-8'
      ..headers['X-CLOVASPEECH-API-KEY'] = settings.clovaKey
      ..fields['params'] = jsonEncode({
        'language': 'ko-KR',
        'completion': 'sync',
        'wordAlignment': true,
        'fullText': true,
        'diarization': {
          'enable': true,
          'speakerCountMin': 1,
          'speakerCountMax': 2,
        },
      })
      ..files.add(await http.MultipartFile.fromPath('media', path));
    final streamed = await request.send().timeout(const Duration(seconds: 180));
    final response = await http.Response.fromStream(streamed);
    if (response.statusCode >= 400) {
      throw Exception(
        'CLOVA Speech 오류 ${response.statusCode}: ${response.body}',
      );
    }
    final data = jsonDecode(utf8.decode(response.bodyBytes));
    if (data is! Map<String, dynamic>) {
      throw Exception('CLOVA 응답 형식이 올바르지 않습니다.');
    }
    final transcript = _transcriptFromClova(data);
    if (transcript.trim().isEmpty) {
      throw Exception('CLOVA 전사 결과가 비어 있습니다.');
    }
    return SttResult(
      transcript: transcript,
      segments: _segmentsFromClova(data, transcript),
    );
  }

  String _uploadUrl(String raw) {
    final trimmed = raw.trim().replaceFirst(RegExp(r'/+$'), '');
    if (trimmed.endsWith('/recognizer/upload')) return trimmed;
    return '$trimmed/recognizer/upload';
  }

  String _transcriptFromClova(Map<String, dynamic> data) {
    for (final key in ['text', 'fullText', 'transcript']) {
      final value = data[key];
      if (value is String && value.trim().isNotEmpty) return value.trim();
    }
    final segments = data['segments'];
    if (segments is List) {
      final parts = segments
          .map((item) => item is Map ? item['text'] ?? item['utterance'] : null)
          .whereType<String>()
          .where((text) => text.trim().isNotEmpty);
      return parts.join(' ').trim();
    }
    return _findFirstLongText(data);
  }

  String _findFirstLongText(dynamic value) {
    if (value is String && value.trim().length > 20) return value.trim();
    if (value is List) {
      for (final item in value) {
        final found = _findFirstLongText(item);
        if (found.isNotEmpty) return found;
      }
    }
    if (value is Map) {
      for (final item in value.values) {
        final found = _findFirstLongText(item);
        if (found.isNotEmpty) return found;
      }
    }
    return '';
  }

  List<SpeechSegment> _segmentsFromClova(
    Map<String, dynamic> data,
    String transcript,
  ) {
    final raw = data['segments'];
    if (raw is List) {
      final rawRows = <_RawSpeechSegment>[];
      for (final item in raw) {
        if (item is! Map) continue;
        final text = '${item['text'] ?? item['utterance'] ?? ''}'.trim();
        if (text.isEmpty) continue;
        rawRows.add(
          _RawSpeechSegment(
            start: _timeNumber(item['start'] ?? item['startTime']),
            end: _timeNumber(item['end'] ?? item['endTime']),
            speaker: '${item['speaker'] ?? item['speakerLabel'] ?? '화자 1'}',
            text: text,
          ),
        );
      }
      if (rawRows.isNotEmpty) {
        final divisor = _timelineDivisor(rawRows);
        return rawRows.map((row) {
          final start = row.start / divisor;
          final end = row.end / divisor;
          return SpeechSegment(
            start: start,
            end: end <= start ? start + max(1, wordCount(row.text) / 1.6) : end,
            speaker: row.speaker,
            text: row.text,
          );
        }).toList();
      }
    }
    final words = transcript.split(RegExp(r'\s+')).where((w) => w.isNotEmpty);
    final duration = max(20.0, words.length / 1.7);
    return [
      SpeechSegment(start: 0, end: duration, speaker: '화자 1', text: transcript),
    ];
  }

  double _timelineDivisor(List<_RawSpeechSegment> rows) {
    final durations =
        rows
            .map((row) => row.end - row.start)
            .where((value) => value > 0)
            .toList()
          ..sort();
    if (durations.isEmpty) return 1;
    final median = durations[durations.length ~/ 2];
    final longest = durations.last;
    return median >= 100 || longest >= 1000 ? 1000 : 1;
  }

  double _timeNumber(dynamic value) {
    if (value is num) return value.toDouble();
    final text = '$value'.trim();
    if (text.contains(':')) return _clockSeconds(text);
    return double.tryParse(text) ?? 0;
  }

  double _clockSeconds(String text) {
    final parts = text.split(':').map((part) => part.trim()).toList();
    if (parts.length < 2 || parts.length > 3) return 0;
    final seconds = double.tryParse(parts.last) ?? 0;
    final minutes = int.tryParse(parts[parts.length - 2]) ?? 0;
    final hours = parts.length == 3 ? int.tryParse(parts.first) ?? 0 : 0;
    return hours * 3600 + minutes * 60 + seconds;
  }
}

class _RawSpeechSegment {
  const _RawSpeechSegment({
    required this.start,
    required this.end,
    required this.speaker,
    required this.text,
  });

  final double start;
  final double end;
  final String speaker;
  final String text;
}
