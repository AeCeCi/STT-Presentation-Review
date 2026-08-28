class PracticeRecord {
  const PracticeRecord({
    required this.page,
    required this.startSeconds,
    required this.endSeconds,
  });

  final int page;
  final int startSeconds;
  final int endSeconds;

  int get durationSeconds => endSeconds - startSeconds;
}
