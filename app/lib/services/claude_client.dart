import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/app_settings.dart';

class ClaudeClient {
  const ClaudeClient(this.settings);

  final AppSettings settings;

  Future<Map<String, dynamic>> jsonMessage({
    required String system,
    required String prompt,
    required int maxTokens,
  }) async {
    final response = await http
        .post(
          Uri.parse('https://api.anthropic.com/v1/messages'),
          headers: {
            'x-api-key': settings.claudeKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({
            'model': settings.claudeModel,
            'max_tokens': maxTokens,
            'system': system,
            'messages': [
              {'role': 'user', 'content': prompt},
            ],
          }),
        )
        .timeout(const Duration(seconds: 180));
    if (response.statusCode >= 400) {
      throw Exception('Claude API ${response.statusCode}: ${response.body}');
    }
    final data = jsonDecode(utf8.decode(response.bodyBytes));
    if (data is! Map<String, dynamic>) {
      throw Exception('Claude 응답 형식이 올바르지 않습니다.');
    }
    final text = (data['content'] as List? ?? [])
        .whereType<Map>()
        .where((item) => item['type'] == 'text')
        .map((item) => '${item['text']}')
        .join('\n')
        .trim();
    return _parseJsonObject(text);
  }

  Map<String, dynamic> _parseJsonObject(String raw) {
    var text = raw.trim();
    text = text.replaceAll(RegExp(r'^```(?:json)?', multiLine: true), '');
    text = text.replaceAll(RegExp(r'```$', multiLine: true), '').trim();
    try {
      final decoded = jsonDecode(text);
      if (decoded is Map<String, dynamic>) return decoded;
    } catch (_) {
      final start = text.indexOf('{');
      final end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        final decoded = jsonDecode(text.substring(start, end + 1));
        if (decoded is Map<String, dynamic>) return decoded;
      }
    }
    throw Exception('Claude JSON 파싱 실패');
  }
}
