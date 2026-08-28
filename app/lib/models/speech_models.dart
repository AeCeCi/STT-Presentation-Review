class SttResult {
  const SttResult({required this.transcript, required this.segments});

  final String transcript;
  final List<SpeechSegment> segments;
}

class SpeechSegment {
  const SpeechSegment({
    required this.start,
    required this.end,
    required this.speaker,
    required this.text,
  });

  final double start;
  final double end;
  final String speaker;
  final String text;

  Map<String, dynamic> toJson() => {
    'time': timeLabel,
    'start': start,
    'end': end,
    'speaker': speaker,
    'text': text,
  };

  String get timeLabel => '${clockLabel(start)}-${clockLabel(end)}';

  static String clockLabel(double seconds) {
    final total = seconds.round().clamp(0, 99999);
    return '${(total ~/ 60).toString().padLeft(2, '0')}:${(total % 60).toString().padLeft(2, '0')}';
  }
}
