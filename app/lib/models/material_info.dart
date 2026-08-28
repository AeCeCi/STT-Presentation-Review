class MaterialInfo {
  const MaterialInfo({
    required this.name,
    required this.type,
    required this.text,
    required this.sections,
    this.error = '',
  });

  final String name;
  final String type;
  final String text;
  final List<MaterialSection> sections;
  final String error;

  bool get hasText => text.trim().isNotEmpty;
}

class MaterialSection {
  const MaterialSection({
    required this.page,
    required this.title,
    required this.text,
  });

  final int page;
  final String title;
  final String text;
}

class DocumentMatch {
  const DocumentMatch({
    required this.available,
    required this.name,
    required this.type,
    required this.score,
    required this.summary,
    required this.documentCoverage,
    required this.speechExtraRatio,
    required this.missingTerms,
    required this.extraTerms,
    required this.sections,
  });

  factory DocumentMatch.unavailable({
    String name = '',
    String type = '',
    String summary = '비교할 발표자료가 없습니다.',
  }) {
    return DocumentMatch(
      available: false,
      name: name,
      type: type,
      score: 0,
      summary: summary,
      documentCoverage: 0,
      speechExtraRatio: 0,
      missingTerms: const [],
      extraTerms: const [],
      sections: const [],
    );
  }

  final bool available;
  final String name;
  final String type;
  final int score;
  final String summary;
  final int documentCoverage;
  final int speechExtraRatio;
  final List<String> missingTerms;
  final List<String> extraTerms;
  final List<DocumentSectionMatch> sections;
}

class DocumentSectionMatch {
  const DocumentSectionMatch({
    required this.page,
    required this.title,
    required this.score,
    required this.status,
    required this.missing,
  });

  final int page;
  final String title;
  final int score;
  final String status;
  final List<String> missing;
}
