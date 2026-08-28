import 'dart:convert';
import 'dart:math';

import '../models/analysis_result.dart';
import '../models/app_picked_file.dart';
import '../models/app_settings.dart';
import '../models/speech_models.dart';
import '../utils/text_metrics.dart';
import 'claude_client.dart';
import 'document_matcher.dart';
import 'material_extractor.dart';

class StandaloneAnalyzer {
  const StandaloneAnalyzer(this.settings);

  final AppSettings settings;

  Future<AnalysisResult> analyze({
    required String transcript,
    required String audioName,
    required AppPickedFile? materialFile,
    required List<SpeechSegment> segments,
  }) async {
    final materialInfo = await MaterialExtractor().extract(materialFile);
    final documentMatch = DocumentMatcher().build(transcript, materialInfo);
    final base = AnalysisResult.fallback(
      transcript: transcript,
      audioName: audioName,
      materialName: materialFile?.name,
      segments: segments,
    ).withDocumentMatch(documentMatch);
    if (!settings.hasClaude || transcript.trim().isEmpty) return base;

    final metrics = {
      'wpm': base.wpm,
      'filler_total': base.fillerTotal,
      'filler_words': base.fillerWords,
      'pace_series': base.paceSeries,
      'sentence_segments': segments.map((s) => s.toJson()).toList(),
      'material_name': materialFile?.name ?? '',
      'document_match': {
        'available': documentMatch.available,
        'score': documentMatch.score,
        'document_coverage': documentMatch.documentCoverage,
        'missing_terms': documentMatch.missingTerms,
        'sections': documentMatch.sections
            .map(
              (section) => {
                'page': section.page,
                'title': section.title,
                'score': section.score,
                'status': section.status,
                'missing': section.missing,
              },
            )
            .toList(),
      },
    };
    final prompt =
        '''
Evaluate this Korean IR or presentation practice transcript.
Use the metrics as source of truth for WPM and filler counts.
Return JSON only with keys:
score, grade, status, voice_scores, vocab_suggestions, problems, questions, improvement_priorities, summary.
questions must contain exactly 10 Korean expected Q&A questions.

[Metrics]
${jsonEncode(metrics)}

[Transcript]
${transcript.substring(0, min(transcript.length, 7000))}
''';
    try {
      final judged = await ClaudeClient(settings).jsonMessage(
        system: 'You are a Korean IR presentation reviewer. Return JSON only.',
        prompt: prompt,
        maxTokens: 5000,
      );
      return base.mergeClaude(judged).withDocumentMatch(documentMatch);
    } catch (error) {
      return base.copyWith(
        summary: '${base.summary}\nAI 종합평가는 현재 사용할 수 없어 앱 내부 지표로 평가했습니다.',
        source: 'CLOVA Speech + 앱 내부 지표',
      );
    }
  }

  Future<Map<String, dynamic>> evaluateAnswer({
    required String question,
    required String answer,
    required String transcript,
  }) async {
    if (!settings.hasClaude) {
      return _fallbackAnswerEvaluation(question: question, answer: answer);
    }
    final prompt =
        '''
예상 질문에 대한 발표자의 답변을 평가하라. JSON 형식:
{score:number, logic:number, specificity:number, confidence:number, time_control:number, strengths:[string], improvements:[string], model_answer:string, tags:[string]}

[발표 전사]
${transcript.substring(0, min(transcript.length, 3000))}

[질문]
$question

[답변]
${answer.substring(0, min(answer.length, 3000))}
''';
    try {
      return await ClaudeClient(settings).jsonMessage(
        system: '너는 한국어 IR 발표 Q&A 심사위원이다. 설명 문장 없이 JSON 객체만 반환한다.',
        prompt: prompt,
        maxTokens: 2500,
      );
    } catch (_) {
      return _fallbackAnswerEvaluation(question: question, answer: answer);
    }
  }

  Map<String, dynamic> _fallbackAnswerEvaluation({
    required String question,
    required String answer,
  }) {
    final answerUnits = speechUnitCount(answer);
    final questionTokens = _tokens(question).toSet();
    final answerTokens = _tokens(answer).toSet();
    final overlap = questionTokens.intersection(answerTokens).length;
    final specificity = answer.contains(RegExp(r'[0-9%억만월명개]')) ? 76 : 58;
    final logic = (48 + min(28, answerUnits * 2) + min(14, overlap * 4)).clamp(
      0,
      100,
    );
    final confidence = answer.length >= 80 ? 72 : 55;
    final timeControl = answerUnits >= 25 && answerUnits <= 90 ? 78 : 62;
    final score = ((logic + specificity + confidence + timeControl) / 4)
        .round();
    return {
      'score': score,
      'logic': logic,
      'specificity': specificity,
      'confidence': confidence,
      'time_control': timeControl,
      'strengths': [
        if (answerUnits >= 20) '답변 분량이 질문 대응에 필요한 최소 길이를 충족합니다.',
        if (overlap > 0) '질문의 핵심 표현을 일부 반영했습니다.',
      ],
      'improvements': [
        if (!answer.contains(RegExp(r'[0-9%억만월명개]')))
          '수치, 기간, 고객 수, 매출 등 검증 가능한 근거를 한 가지 이상 넣으세요.',
        '답변 첫 문장에 결론을 먼저 말하고, 뒤에 근거를 붙이면 더 명확합니다.',
      ],
      'model_answer': '결론, 근거, 구체 사례, 다음 실행 계획 순서로 30초 안에 답변해보세요.',
      'tags': ['앱 내부 평가'],
      'source': '앱 내부 지표',
    };
  }

  List<String> _tokens(String text) {
    return RegExp(
      r'[0-9A-Za-z가-힣]+',
    ).allMatches(text).map((match) => match.group(0) ?? '').where((token) {
      return token.length >= 2;
    }).toList();
  }
}
