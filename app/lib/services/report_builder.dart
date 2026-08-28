import 'package:flutter/services.dart';
import 'package:pdf/widgets.dart' as pw;

import '../models/analysis_result.dart';

class ReportBuilder {
  static const _maxTextBlockLength = 650;
  static const _maxTranscriptBlocks = 80;

  Future<List<int>> build(AnalysisResult analysis) async {
    final fontData = await rootBundle.load(
      'assets/fonts/NotoSansKR-Regular.ttf',
    );
    final koreanFont = pw.Font.ttf(fontData);
    final doc = pw.Document();
    final transcriptBlocks = _splitText(analysis.transcript);
    doc.addPage(
      pw.MultiPage(
        theme: pw.ThemeData.withFont(
          base: koreanFont,
          bold: koreanFont,
          italic: koreanFont,
          boldItalic: koreanFont,
        ),
        build: (_) => [
          pw.Text('STT Presentation Review', style: pw.TextStyle(fontSize: 22)),
          pw.SizedBox(height: 12),
          pw.Text('Score: ${analysis.score} / Grade: ${analysis.grade}'),
          pw.Text('WPM: ${analysis.wpm} / Fillers: ${analysis.fillerTotal}'),
          pw.Text('Source: ${analysis.source}'),
          pw.SizedBox(height: 12),
          pw.Text('Summary', style: pw.TextStyle(fontSize: 16)),
          pw.Text(analysis.summary),
          pw.SizedBox(height: 12),
          pw.Text('Document Match', style: pw.TextStyle(fontSize: 16)),
          if (analysis.documentMatch.available) ...[
            pw.Text(
              'Score: ${analysis.documentMatch.score} / Coverage: ${analysis.documentMatch.documentCoverage}%',
            ),
            pw.Text(analysis.documentMatch.summary),
            if (analysis.documentMatch.missingTerms.isNotEmpty)
              pw.Text(
                'Missing terms: ${analysis.documentMatch.missingTerms.join(', ')}',
              ),
            for (final section in analysis.documentMatch.sections.take(12))
              pw.Bullet(
                text:
                    'Slide ${section.page}: ${section.score}% / ${section.status}',
              ),
          ] else
            pw.Text(analysis.documentMatch.summary),
          pw.SizedBox(height: 12),
          pw.Text('Priorities', style: pw.TextStyle(fontSize: 16)),
          for (final item in analysis.priorities) pw.Bullet(text: item),
          pw.SizedBox(height: 12),
          pw.Text('Problems', style: pw.TextStyle(fontSize: 16)),
          for (final item in analysis.problems) pw.Bullet(text: item),
          pw.SizedBox(height: 12),
          pw.Text('Transcript', style: pw.TextStyle(fontSize: 16)),
          ...transcriptBlocks
              .take(_maxTranscriptBlocks)
              .map(
                (chunk) => pw.Padding(
                  padding: const pw.EdgeInsets.only(bottom: 6),
                  child: pw.Text(
                    chunk,
                    style: const pw.TextStyle(fontSize: 10),
                  ),
                ),
              ),
          if (transcriptBlocks.length > _maxTranscriptBlocks)
            pw.Text(
              'Transcript truncated in PDF for performance.',
              style: const pw.TextStyle(fontSize: 9),
            ),
        ],
      ),
    );
    return doc.save();
  }

  List<String> _splitText(String text) {
    final normalized = text.trim();
    if (normalized.isEmpty) return ['전사문이 없습니다.'];
    final chunks = <String>[];
    var start = 0;
    while (start < normalized.length) {
      var end = (start + _maxTextBlockLength).clamp(0, normalized.length);
      if (end < normalized.length) {
        final sentenceEnd = normalized.lastIndexOf(RegExp(r'[.!?。！？\n]'), end);
        if (sentenceEnd > start + 120) end = sentenceEnd + 1;
      }
      chunks.add(normalized.substring(start, end).trim());
      start = end;
    }
    return chunks.where((chunk) => chunk.isNotEmpty).toList();
  }
}
