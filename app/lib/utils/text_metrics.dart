class FillerCount {
  const FillerCount(this.word, this.count);

  final String word;
  final int count;

  Map<String, dynamic> toJson() => {
    'word': word,
    'count': count,
    'severity': count >= 4
        ? '높음'
        : count >= 2
        ? '보통'
        : '낮음',
  };
}

List<FillerCount> countFillerWords(String transcript) {
  const terms = [
    '네',
    '어',
    '아',
    '음',
    '그',
    '이게',
    '일단',
    '이제',
    '뭐랄까',
    '사실은',
    '약간',
    '좀',
    '저기',
    '그러니까',
  ];
  final tokens = RegExp(
    r'[0-9A-Za-z가-힣]+',
  ).allMatches(transcript).map((m) => m.group(0) ?? '').toList();
  final rows = <FillerCount>[];
  for (final term in terms) {
    final count = term.length == 1
        ? tokens
              .where(
                (token) => RegExp('^${RegExp.escape(term)}+\$').hasMatch(token),
              )
              .fold<int>(0, (sum, token) => sum + token.length)
        : tokens
              .where((token) => token == term || token.startsWith(term))
              .length;
    if (count > 0) rows.add(FillerCount(term, count));
  }
  rows.sort((a, b) => b.count.compareTo(a.count));
  return rows;
}

int wordCount(String text) {
  return RegExp(r'[0-9A-Za-z가-힣]+').allMatches(text).length;
}

int speechUnitCount(String text) {
  final tokens = RegExp(r'[0-9A-Za-z가-힣]+')
      .allMatches(text)
      .map((match) => match.group(0) ?? '')
      .where((token) {
        return token.trim().isNotEmpty;
      })
      .toList();
  if (tokens.isEmpty) return 0;

  var units = 0;
  for (final token in tokens) {
    final koreanSyllables = RegExp(r'[가-힣]').allMatches(token).length;
    if (koreanSyllables >= 8) {
      units += (koreanSyllables / 2.6).round().clamp(1, 9999);
    } else {
      units += 1;
    }
  }
  return units;
}
