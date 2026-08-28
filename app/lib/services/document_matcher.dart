import 'dart:math';

import '../models/material_info.dart';

class DocumentMatcher {
  static const _stopwords = {
    '그리고',
    '그러나',
    '그래서',
    '저희',
    '저는',
    '우리',
    '이것',
    '그것',
    '있는',
    '하는',
    '합니다',
    '입니다',
    '됩니다',
    '대한',
    '통해',
    '위해',
    '경우',
    '같은',
    '이번',
    '일단',
    '이제',
    '그냥',
  };

  DocumentMatch build(String transcript, MaterialInfo material) {
    if (!material.hasText) {
      return DocumentMatch.unavailable(
        name: material.name,
        type: material.type,
        summary: material.error.isEmpty ? '비교할 발표자료가 없습니다.' : material.error,
      );
    }

    final documentTokens = _contentTokens(material.text);
    final transcriptTokens = _contentTokens(transcript);
    final documentSet = documentTokens.toSet();
    final transcriptSet = transcriptTokens.toSet();
    final documentCoverage = _coverageRatio(documentSet, transcriptSet);
    final speechToDocument = _coverageRatio(transcriptSet, documentSet);
    final score = (documentCoverage * 0.7 + speechToDocument * 0.3)
        .round()
        .clamp(0, 100);

    final sections = material.sections.take(40).map((section) {
      final sectionTokens = _contentTokens(section.text);
      final sectionSet = sectionTokens.toSet();
      final sectionScore = _coverageRatio(sectionSet, transcriptSet);
      return DocumentSectionMatch(
        page: section.page,
        title: section.title,
        score: sectionScore,
        status: sectionScore >= 55
            ? '발표 반영'
            : sectionScore >= 25
            ? '일부 누락'
            : '누락 가능',
        missing: _topMissingTerms(sectionTokens, transcriptSet, 5),
      );
    }).toList();

    return DocumentMatch(
      available: true,
      name: material.name,
      type: material.type,
      score: score,
      summary: '발표자료 핵심어 기준 약 $documentCoverage%가 음성 전사에 반영되었습니다.',
      documentCoverage: documentCoverage,
      speechExtraRatio: max(0, 100 - speechToDocument),
      missingTerms: _topMissingTerms(documentTokens, transcriptSet, 12),
      extraTerms: _topMissingTerms(transcriptTokens, documentSet, 12),
      sections: sections,
    );
  }

  int _coverageRatio(Set<String> source, Set<String> target) {
    if (source.isEmpty || target.isEmpty) return 0;
    return (source.intersection(target).length / source.length * 100)
        .round()
        .clamp(0, 100);
  }

  List<String> _topMissingTerms(
    List<String> source,
    Set<String> target,
    int limit,
  ) {
    final counts = <String, int>{};
    for (final token in source) {
      if (!target.contains(token)) counts[token] = (counts[token] ?? 0) + 1;
    }
    final entries = counts.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    return entries.take(limit).map((entry) => entry.key).toList();
  }

  List<String> _contentTokens(String text) {
    return RegExp(r'[0-9A-Za-z가-힣]{2,}')
        .allMatches(text)
        .map((match) => (match.group(0) ?? '').toLowerCase())
        .where((token) => token.isNotEmpty && !_stopwords.contains(token))
        .toList();
  }
}
