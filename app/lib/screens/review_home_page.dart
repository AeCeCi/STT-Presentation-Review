import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:share_plus/share_plus.dart';

import '../models/analysis_result.dart';
import '../models/app_picked_file.dart';
import '../models/app_settings.dart';
import '../models/practice_record.dart';
import '../services/clova_speech_client.dart';
import '../services/material_extractor.dart';
import '../services/report_builder.dart';
import '../services/standalone_analyzer.dart';
import '../widgets/app_widgets.dart';

const _appInk = Color(0xFF101828);
const _appMuted = Color(0xFF667085);
const _appBlue = Color(0xFF2563EB);
const _appMint = Color(0xFF14B8A6);
const _appCoral = Color(0xFFFF6B5F);
const _appVioletDot = Color(0xFF7C3AED);
const _appBg = Color(0xFFF7F8FB);
const _reportChannel = MethodChannel('stt_project/report_saver');

class ReviewHomePage extends StatefulWidget {
  const ReviewHomePage({super.key});

  @override
  State<ReviewHomePage> createState() => _ReviewHomePageState();
}

class _ReviewHomePageState extends State<ReviewHomePage> {
  final _recorder = AudioRecorder();
  final _appSettings = AppSettings.fromProjectConfig();
  final _transcriptController = TextEditingController();
  final _answerController = TextEditingController();

  AppPickedFile? _audioFile;
  AppPickedFile? _materialFile;
  AnalysisResult? _analysis;
  Map<String, dynamic>? _answerResult;
  Timer? _practiceTimer;
  DateTime? _practiceStartedAt;
  DateTime? _practicePageStartedAt;
  int _practiceCurrentPage = 1;
  int _practicePageCount = 1;
  int _practiceElapsedSeconds = 0;
  int _practicePageElapsedSeconds = 0;
  int _selectedPage = 0;
  int _selectedQuestionIndex = 0;
  final List<PracticeRecord> _practiceRecords = [];
  bool _busy = false;
  bool _recording = false;
  bool _practiceActive = false;
  String? _status;

  @override
  void initState() {
    super.initState();
  }

  @override
  void dispose() {
    _practiceTimer?.cancel();
    if (_recording) {
      _recorder.stop().catchError((_) => '');
    }
    _recorder.dispose();
    _transcriptController.dispose();
    _answerController.dispose();
    super.dispose();
  }

  void _safeSetState(VoidCallback update) {
    if (!mounted) return;
    setState(update);
  }

  Future<void> _pickAudio() async {
    final result = await openFile(
      acceptedTypeGroups: const [
        XTypeGroup(
          label: 'audio',
          extensions: ['mp3', 'm4a', 'wav', 'webm', 'aac'],
          mimeTypes: [
            'audio/mpeg',
            'audio/mp4',
            'audio/wav',
            'audio/webm',
            'audio/aac',
          ],
          uniformTypeIdentifiers: [
            'public.mp3',
            'com.apple.m4a-audio',
            'com.microsoft.waveform-audio',
            'org.webmproject.webm',
            'public.aac-audio',
          ],
        ),
      ],
    );
    if (result == null) return;
    _safeSetState(() => _audioFile = AppPickedFile.fromXFile(result));
  }

  Future<void> _pickMaterial() async {
    final result = await openFile(
      acceptedTypeGroups: const [
        XTypeGroup(
          label: 'presentation',
          extensions: ['pdf', 'pptx'],
          mimeTypes: [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          ],
          uniformTypeIdentifiers: [
            'com.adobe.pdf',
            'org.openxmlformats.presentationml.presentation',
          ],
        ),
      ],
    );
    if (result == null) return;
    final file = AppPickedFile.fromXFile(result);
    _safeSetState(() {
      _materialFile = file;
      _practiceCurrentPage = 1;
      _practicePageCount = 1;
      _practiceRecords.clear();
    });
    final info = await MaterialExtractor().extract(file);
    _safeSetState(() {
      _practicePageCount = info.sections.isEmpty ? 1 : info.sections.length;
      if (info.error.isNotEmpty) _status = info.error;
    });
  }

  Future<void> _toggleRecording() async {
    if (_recording) {
      final path = await _recorder.stop();
      _safeSetState(() {
        _recording = false;
        if (path != null) {
          _audioFile = AppPickedFile(
            name: path.split(Platform.pathSeparator).last,
            path: path,
            size: File(path).lengthSync(),
          );
          _status = '녹음 파일이 선택되었습니다.';
        }
      });
      return;
    }

    if (!await _recorder.hasPermission()) {
      _safeSetState(() => _status = '마이크 권한이 필요합니다.');
      return;
    }
    final dir = await getTemporaryDirectory();
    final path =
        '${dir.path}/presentation-${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _recorder.start(
      const RecordConfig(encoder: AudioEncoder.aacLc),
      path: path,
    );
    _safeSetState(() {
      _recording = true;
      _status = '녹음 중입니다.';
    });
  }

  Future<void> _startPractice() async {
    if (_materialFile == null) {
      _safeSetState(() => _status = '먼저 발표자료를 선택하세요.');
      return;
    }
    if (_recording) {
      _safeSetState(() => _status = '이미 녹음 중입니다. 녹음을 종료한 뒤 발표 연습을 시작하세요.');
      return;
    }
    if (!await _recorder.hasPermission()) {
      _safeSetState(() => _status = '마이크 권한이 필요합니다.');
      return;
    }
    final dir = await getTemporaryDirectory();
    final path =
        '${dir.path}/practice-${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _recorder.start(
      const RecordConfig(encoder: AudioEncoder.aacLc),
      path: path,
    );
    final now = DateTime.now();
    _practiceTimer?.cancel();
    _practiceTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      final startedAt = _practiceStartedAt;
      final pageStartedAt = _practicePageStartedAt;
      if (startedAt == null || pageStartedAt == null) return;
      _safeSetState(() {
        _practiceElapsedSeconds = DateTime.now()
            .difference(startedAt)
            .inSeconds;
        _practicePageElapsedSeconds = DateTime.now()
            .difference(pageStartedAt)
            .inSeconds;
      });
    });
    _safeSetState(() {
      _practiceActive = true;
      _recording = true;
      _practiceStartedAt = now;
      _practicePageStartedAt = now;
      _practiceCurrentPage = 1;
      _practiceElapsedSeconds = 0;
      _practicePageElapsedSeconds = 0;
      _practiceRecords.clear();
      _status = '발표 연습과 녹음을 시작했습니다.';
    });
  }

  Future<void> _finishPractice() async {
    if (!_practiceActive) return;
    _recordCurrentPracticePage();
    _practiceTimer?.cancel();
    final path = await _recorder.stop();
    _safeSetState(() {
      _practiceActive = false;
      _recording = false;
      _practiceStartedAt = null;
      _practicePageStartedAt = null;
      if (path != null) {
        _audioFile = AppPickedFile(
          name: path.split(Platform.pathSeparator).last,
          path: path,
          size: File(path).lengthSync(),
        );
      }
      _status = '발표 연습을 종료했습니다. 녹음 파일이 분석 대상으로 선택되었습니다.';
    });
  }

  void _nextPracticePage() {
    if (!_practiceActive) return;
    _recordCurrentPracticePage();
    if (_practiceCurrentPage >= _practicePageCount) {
      _finishPractice();
      return;
    }
    _safeSetState(() {
      _practiceCurrentPage += 1;
      _practicePageStartedAt = DateTime.now();
      _practicePageElapsedSeconds = 0;
    });
  }

  void _recordCurrentPracticePage() {
    final startedAt = _practiceStartedAt;
    final pageStartedAt = _practicePageStartedAt;
    if (startedAt == null || pageStartedAt == null) return;
    final start = pageStartedAt.difference(startedAt).inSeconds;
    final end = DateTime.now().difference(startedAt).inSeconds;
    if (end <= start) return;
    _practiceRecords.add(
      PracticeRecord(
        page: _practiceCurrentPage,
        startSeconds: start,
        endSeconds: end,
      ),
    );
  }

  Future<void> _analyzeAudio() async {
    if (_audioFile == null) {
      _safeSetState(() => _status = '분석할 음성 파일을 선택하거나 녹음하세요.');
      return;
    }
    await _runBusy(() async {
      final settings = _settings();
      if (!settings.hasClova) {
        throw Exception(
          'env.json에 CLOVA Speech 키와 Invoke URL을 넣고 --dart-define-from-file=env.json으로 실행하세요.',
        );
      }
      final stt = await ClovaSpeechClient(settings).transcribe(_audioFile!);
      final result = await StandaloneAnalyzer(settings).analyze(
        transcript: stt.transcript,
        audioName: _audioFile!.name,
        materialFile: _materialFile,
        segments: stt.segments,
      );
      _safeSetState(() {
        _analysis = result;
        _answerResult = null;
        _selectedQuestionIndex = 0;
        _transcriptController.text = result.transcript;
        _status = '앱에서 직접 전사와 분석을 완료했습니다.';
      });
    });
  }

  Future<void> _evaluateAnswer() async {
    final analysis = _analysis;
    final answer = _answerController.text.trim();
    if (analysis == null || analysis.questions.isEmpty) {
      _safeSetState(() => _status = '먼저 발표 분석을 완료하세요.');
      return;
    }
    if (answer.isEmpty) {
      _safeSetState(() => _status = '답변을 입력하세요.');
      return;
    }
    await _runBusy(() async {
      final result = await StandaloneAnalyzer(_settings()).evaluateAnswer(
        question:
            analysis.questions[_selectedQuestionIndex.clamp(
              0,
              analysis.questions.length - 1,
            )],
        answer: answer,
        transcript: analysis.transcript,
      );
      _safeSetState(() {
        _answerResult = result;
        _status = '답변 평가가 완료되었습니다.';
      });
    });
  }

  Future<void> _downloadReport() async {
    final analysis = _analysis;
    if (analysis == null) return;
    _showSnack('PDF 리포트를 만드는 중입니다.');
    _safeSetState(() {
      _busy = true;
      _status = 'PDF 리포트를 만드는 중입니다.';
    });
    try {
      final bytes = await ReportBuilder().build(analysis);
      _safeSetState(() => _status = 'PDF 파일을 앱 내부에 저장하는 중입니다.');
      final fileName =
          'presentation-review-${DateTime.now().millisecondsSinceEpoch}.pdf';
      final dir = await getApplicationDocumentsDirectory();
      final backupPath = '${dir.path}/$fileName';
      final reportFile = await File(
        backupPath,
      ).writeAsBytes(bytes, flush: true);

      if (Platform.isAndroid) {
        await _saveAndroidReport(reportFile.path, fileName, backupPath);
      } else {
        await _shareReport(reportFile.path, fileName);
      }
    } catch (error, stackTrace) {
      debugPrint('PDF report save failed: $error\n$stackTrace');
      _safeSetState(() {
        _status = '오류: PDF 저장 실패 - $error';
      });
      _showSnack('PDF 저장 실패: $error');
    } finally {
      _safeSetState(() => _busy = false);
    }
  }

  Future<void> _saveAndroidReport(
    String filePath,
    String fileName,
    String backupPath,
  ) async {
    _safeSetState(() => _status = 'PDF를 Downloads에 저장하는 중입니다.');
    try {
      final result = await _reportChannel.invokeMapMethod<String, dynamic>(
        'savePdf',
        {'filePath': filePath, 'fileName': fileName},
      );
      final opened = result?['opened'] == true;
      _safeSetState(() {
        _status = opened
            ? 'PDF 리포트를 Downloads에 저장하고 열었습니다.'
            : 'PDF 리포트를 Downloads에 저장했습니다. PDF 뷰어 앱이 없으면 파일 앱에서 열어주세요.';
      });
      _showSnack(
        opened ? 'Downloads에 저장했고 PDF 열기를 실행했습니다.' : 'Downloads에 PDF를 저장했습니다.',
      );
    } on MissingPluginException catch (error) {
      _safeSetState(() {
        _status =
            '오류: Android 저장 기능이 현재 실행 중인 앱에 반영되지 않았습니다. 앱을 완전히 종료 후 다시 실행하세요. 앱 내부 백업: $backupPath ($error)';
      });
      _showSnack('앱 내부에는 PDF가 저장됐습니다. 앱을 완전히 종료 후 다시 실행하세요.');
    } catch (error) {
      _safeSetState(() {
        _status =
            '오류: Downloads 저장 실패 - 앱 내부 백업은 완료되었습니다: $backupPath ($error)';
      });
      _showSnack('Downloads 저장 실패. 앱 내부 백업은 완료됐습니다.');
    }
  }

  Future<void> _shareReport(String filePath, String fileName) async {
    _safeSetState(() => _status = 'PDF 저장/공유 창을 여는 중입니다.');
    try {
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(filePath, mimeType: 'application/pdf', name: fileName)],
          fileNameOverrides: [fileName],
          subject: 'STT Presentation Review 리포트',
          title: 'PDF 리포트 저장',
          text: '분석 리포트 PDF입니다.',
        ),
      );
      _safeSetState(() {
        _status = 'PDF 저장/공유 창을 열었습니다.';
      });
      _showSnack('PDF 저장/공유 창을 열었습니다.');
    } catch (error) {
      _safeSetState(() => _status = '오류: PDF 공유/저장 창을 열지 못했습니다. $error');
      _showSnack('PDF 공유/저장 창을 열지 못했습니다.');
    }
  }

  void _showSnack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(message),
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 3),
        ),
      );
  }

  AppSettings _settings() {
    return _appSettings;
  }

  Future<void> _runBusy(Future<void> Function() task) async {
    _safeSetState(() {
      _busy = true;
      _status = null;
    });
    try {
      await task();
    } catch (error) {
      _safeSetState(() => _status = _friendlyError(error));
    } finally {
      _safeSetState(() => _busy = false);
    }
  }

  String _friendlyError(Object error) {
    final text = '$error';
    if (text.contains('save_failed') ||
        text.contains('PDF') ||
        text.contains('MediaStore') ||
        text.contains('Downloads')) {
      return '오류: PDF 저장에 실패했습니다. 저장소 접근 또는 PDF 생성 상태를 확인하세요. ($text)';
    }
    if (text.contains('Claude API') ||
        text.contains('Anthropic') ||
        text.contains('credit balance') ||
        text.contains('invalid_request_error')) {
      return '오류: AI 종합평가를 사용할 수 없어 앱 내부 지표로 평가했습니다. API 크레딧 또는 모델 설정을 확인하세요.';
    }
    if (text.contains('CLOVA') || text.contains('CLOVASPEECH')) {
      return '오류: 음성 전사에 실패했습니다. CLOVA 설정과 음성 파일 형식을 확인하세요.';
    }
    return '오류: 요청을 처리하지 못했습니다. 설정과 입력 파일을 확인하세요.';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _appBg,
      appBar: AppBar(
        toolbarHeight: 66,
        backgroundColor: _appBg,
        foregroundColor: _appInk,
        centerTitle: false,
        title: const Text(
          '발표 코치',
          style: TextStyle(
            color: _appInk,
            fontSize: 24,
            fontWeight: FontWeight.w900,
          ),
        ),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 14),
            child: RoundIconButton(
              tooltip: 'PDF 리포트',
              onPressed: _analysis == null || _busy ? null : _downloadReport,
              icon: CupertinoIcons.arrow_down_doc,
            ),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
          children: _selectedPageWidgets(),
        ),
      ),
      bottomNavigationBar: _bottomCourseBar(),
    );
  }

  List<Widget> _selectedPageWidgets() {
    final pages = switch (_selectedPage) {
      0 => [_heroPanel(), _inputCard()],
      1 => [_practiceCard()],
      2 => [_questionsPage()],
      3 => [_analysisResultsPage()],
      _ => [_summaryResultsPage()],
    };
    return [
      for (var i = 0; i < pages.length; i++) ...[
        if (i > 0) const SizedBox(height: 14),
        pages[i],
      ],
      const SizedBox(height: 14),
      ..._statusWidgets(),
    ];
  }

  List<Widget> _statusWidgets() {
    return [
      if (_busy)
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 2),
          child: ClipRRect(
            borderRadius: BorderRadius.all(Radius.circular(99)),
            child: LinearProgressIndicator(minHeight: 5, color: _appBlue),
          ),
        ),
      if (_status != null) ...[
        const SizedBox(height: 12),
        StatusBanner(text: _status!),
      ],
    ];
  }

  Widget _bottomCourseBar() {
    return SafeArea(
      top: false,
      minimum: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      child: Container(
        height: 70,
        padding: const EdgeInsets.all(6),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(26),
          border: Border.all(color: const Color(0xFFE5E7EB)),
          boxShadow: const [
            BoxShadow(
              color: Color(0x16000000),
              blurRadius: 24,
              offset: Offset(0, 10),
            ),
          ],
        ),
        child: Row(
          children: [
            _CourseBottomItem(
              icon: CupertinoIcons.folder_badge_plus,
              label: '등록\n발표자료',
              selected: _selectedPage == 0,
              onTap: () => _openPage(0),
            ),
            _CourseBottomItem(
              icon: CupertinoIcons.timer,
              label: '발표\n연습',
              selected: _selectedPage == 1,
              onTap: () => _openPage(1),
            ),
            _CourseBottomItem(
              icon: CupertinoIcons.question_circle,
              label: '예상질문\n준비',
              selected: _selectedPage == 2,
              onTap: () => _openPage(2),
            ),
            _CourseBottomItem(
              icon: CupertinoIcons.chart_bar_alt_fill,
              label: '분석\n결과',
              selected: _selectedPage == 3,
              onTap: () => _openPage(3),
            ),
            _CourseBottomItem(
              icon: CupertinoIcons.doc_text_search,
              label: '종합\n결과',
              selected: _selectedPage == 4,
              onTap: () => _openPage(4),
            ),
          ],
        ),
      ),
    );
  }

  void _openPage(int index) {
    _safeSetState(() {
      _selectedPage = index;
      _status = null;
    });
  }

  Widget _heroMetric(String label, String value, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: 0.78),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: Colors.white.withValues(alpha: 0.7)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: color,
                fontSize: 12,
                fontWeight: FontWeight.w900,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: _appInk,
                fontSize: 18,
                fontWeight: FontWeight.w900,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _heroPanel() {
    final analysis = _analysis;
    final readyText = _audioFile != null
        ? '음성 준비됨'
        : _transcriptController.text.trim().isNotEmpty
        ? '전사문 준비됨'
        : '분석 대기';
    return Container(
      constraints: const BoxConstraints(minHeight: 236),
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 18),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(28),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFFFFFFFF), Color(0xFFEAF2FF), Color(0xFFE8FBF7)],
        ),
        border: Border.all(color: Colors.white),
        boxShadow: const [
          BoxShadow(
            color: Color(0x140F172A),
            blurRadius: 28,
            offset: Offset(0, 14),
          ),
        ],
      ),
      child: Stack(
        children: [
          Positioned(
            right: -28,
            top: -18,
            child: Container(
              width: 120,
              height: 120,
              decoration: BoxDecoration(
                color: _appBlue.withValues(alpha: 0.10),
                shape: BoxShape.circle,
              ),
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.72),
                  borderRadius: BorderRadius.circular(99),
                ),
                child: Text(
                  analysis == null ? readyText : '분석 완료',
                  style: const TextStyle(
                    color: _appBlue,
                    fontSize: 14,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                analysis == null
                    ? '발표를 더 정확하게'
                    : '${analysis.grade} · ${analysis.score}점',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: _appInk,
                  fontSize: 34,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 0,
                  height: 1.05,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                analysis == null
                    ? '녹음부터 STT, 속도, 추임새, 발표자료 반영률, Q&A까지 한 화면에서 확인하세요.'
                    : analysis.summary,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: _appMuted,
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  height: 1.38,
                ),
              ),
              const SizedBox(height: 18),
              Row(
                children: [
                  _heroMetric(
                    'WPM',
                    analysis == null ? '-' : '${analysis.wpm}',
                    _appBlue,
                  ),
                  const SizedBox(width: 10),
                  _heroMetric(
                    '추임새',
                    analysis == null ? '-' : '${analysis.fillerTotal}',
                    _appCoral,
                  ),
                  const SizedBox(width: 10),
                  _heroMetric(
                    '등급',
                    analysis == null ? '-' : analysis.grade,
                    _appMint,
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _inputCard() {
    return SectionCard(
      title: '음성 및 발표자료',
      subtitle: '녹음하거나 파일을 선택해 분석을 시작하세요.',
      child: Column(
        children: [
          FileRow(
            icon: CupertinoIcons.mic,
            label: '음성',
            value: _audioFile?.name ?? '선택된 파일 없음',
            onPressed: _busy ? null : _pickAudio,
          ),
          const InsetDivider(),
          FileRow(
            icon: CupertinoIcons.doc,
            label: '자료',
            value: _materialFile?.name ?? '선택 사항: PDF 또는 PPTX',
            onPressed: _busy ? null : _pickMaterial,
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: _busy || _practiceActive ? null : _toggleRecording,
                  icon: Icon(
                    _recording
                        ? CupertinoIcons.stop_fill
                        : CupertinoIcons.recordingtape,
                  ),
                  label: Text(_recording ? '녹음 종료' : '앱에서 녹음'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: FilledButton.tonalIcon(
                  onPressed: _busy || _recording || _practiceActive
                      ? null
                      : _analyzeAudio,
                  icon: const Icon(CupertinoIcons.chart_bar_alt_fill),
                  label: const Text('음성 분석'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _practiceCard() {
    return SectionCard(
      title: '발표 연습',
      subtitle: '자료 페이지별 체류 시간을 기록하고 녹음 파일을 분석에 연결합니다.',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              MetricChip(
                label: '페이지',
                value: '$_practiceCurrentPage/$_practicePageCount',
              ),
              MetricChip(label: '전체', value: _clock(_practiceElapsedSeconds)),
              MetricChip(
                label: '현재',
                value: _clock(_practicePageElapsedSeconds),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: _busy || _practiceActive || _materialFile == null
                      ? null
                      : _startPractice,
                  icon: const Icon(CupertinoIcons.play_fill),
                  label: const Text('연습 시작'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _practiceActive ? _nextPracticePage : null,
                  icon: const Icon(CupertinoIcons.forward_fill),
                  label: Text(
                    _practiceCurrentPage >= _practicePageCount ? '종료' : '다음',
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _practiceActive ? _finishPractice : null,
                  icon: const Icon(CupertinoIcons.stop_fill),
                  label: const Text('종료'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (_practiceRecords.isEmpty)
            const Text('아직 기록된 발표 구간이 없습니다.')
          else
            Column(
              children: [
                for (final record in _practiceRecords.reversed.take(6))
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: CircleAvatar(
                      radius: 17,
                      backgroundColor: const Color(0xFFEFF6FF),
                      child: Text(
                        '${record.page}',
                        style: const TextStyle(
                          color: Color(0xFF007AFF),
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                    title: Text('Page ${record.page}'),
                    subtitle: Text(
                      '${_clock(record.startSeconds)}-${_clock(record.endSeconds)}',
                    ),
                    trailing: Text(
                      '${record.durationSeconds}초',
                      style: const TextStyle(fontWeight: FontWeight.w800),
                    ),
                  ),
              ],
            ),
        ],
      ),
    );
  }

  Widget _emptyAnalysisCard({
    required String title,
    required String message,
    String actionText = '발표자료 등록',
  }) {
    return SectionCard(
      title: title,
      subtitle: message,
      child: SizedBox(
        width: double.infinity,
        child: FilledButton.icon(
          onPressed: () => _openPage(0),
          icon: const Icon(CupertinoIcons.folder_badge_plus),
          label: Text(actionText),
        ),
      ),
    );
  }

  Widget _questionsPage() {
    final analysis = _analysis;
    if (analysis == null) {
      return _emptyAnalysisCard(
        title: '예상질문 준비',
        message: '분석을 완료하면 발표 내용 기반 예상 질문과 답변 평가를 사용할 수 있습니다.',
      );
    }
    if (analysis.questions.isEmpty) {
      return _emptyAnalysisCard(
        title: '예상질문 준비',
        message: '생성된 예상 질문이 없습니다. 전사문을 보강한 뒤 다시 분석해보세요.',
        actionText: '전사문 보강',
      );
    }
    final index = _selectedQuestionIndex.clamp(
      0,
      analysis.questions.length - 1,
    );
    final selectedQuestion = analysis.questions[index];
    return SectionCard(
      title: '예상질문 준비',
      subtitle: '질문을 선택하고 답변을 연습하세요.',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (var i = 0; i < analysis.questions.length; i++)
                ChoiceChip(
                  label: Text('Q${i + 1}'),
                  selected: i == index,
                  onSelected: (_) => _safeSetState(() {
                    _selectedQuestionIndex = i;
                    _answerResult = null;
                  }),
                ),
            ],
          ),
          const SizedBox(height: 14),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: const Color(0xFFEAF2FF),
              borderRadius: BorderRadius.circular(18),
            ),
            child: Text(
              selectedQuestion,
              style: const TextStyle(
                color: _appInk,
                fontSize: 16,
                height: 1.35,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _answerController,
            enabled: !_busy,
            minLines: 4,
            maxLines: 7,
            decoration: const InputDecoration(hintText: '이 질문에 대한 답변을 입력하세요.'),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: _busy ? null : _evaluateAnswer,
              icon: const Icon(CupertinoIcons.chat_bubble_2_fill),
              label: const Text('답변 평가'),
            ),
          ),
          if (_answerResult != null) ...[
            const Divider(height: 28),
            _answerEvaluationView(_answerResult!),
          ],
        ],
      ),
    );
  }

  Widget _analysisResultsPage() {
    final analysis = _analysis;
    if (analysis == null) {
      return _emptyAnalysisCard(
        title: '분석 결과',
        message: '음성 분석 또는 전사문 분석을 완료하면 속도, 추임새, 전사문을 확인할 수 있습니다.',
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _scoreCard(analysis),
        const SizedBox(height: 12),
        _paceChartCard(analysis),
        const SizedBox(height: 12),
        _transcriptCard(analysis),
      ],
    );
  }

  Widget _summaryResultsPage() {
    final analysis = _analysis;
    if (analysis == null) {
      return _emptyAnalysisCard(
        title: '종합 결과',
        message: '분석을 완료하면 자료 반영률, 개선 우선순위, 문제점, 어휘 제안을 종합해서 보여줍니다.',
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _documentMatchCard(analysis),
        const SizedBox(height: 12),
        _feedbackCard('개선 우선순위', analysis.priorities),
        const SizedBox(height: 12),
        _feedbackCard('문제점', analysis.problems),
        const SizedBox(height: 12),
        _vocabularyImprovementCard(analysis),
        const SizedBox(height: 12),
        _qaCard(analysis),
      ],
    );
  }

  Widget _paceChartCard(AnalysisResult analysis) {
    final rows = analysis.paceSeries
        .map(
          (row) => (
            time: '${row['time'] ?? ''}',
            wpm: (row['wpm'] is num) ? (row['wpm'] as num).round() : 0,
          ),
        )
        .where((row) => row.time.isNotEmpty)
        .toList();
    return SectionCard(
      title: '발화 속도 분석',
      child: rows.isEmpty
          ? const Text('표시할 발화 속도 구간이 없습니다.')
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  height: 270,
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: const Color(0xFFE5EAF3)),
                  ),
                  child: RepaintBoundary(
                    child: CustomPaint(
                      painter: _PaceLineChartPainter(rows),
                      child: const SizedBox.expand(),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                const Text(
                  '권장 범위: 120-150 WPM',
                  style: TextStyle(
                    color: _appMuted,
                    fontSize: 16,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ],
            ),
    );
  }

  Widget _vocabularyImprovementCard(AnalysisResult analysis) {
    final fillers = analysis.fillerWords
        .map(
          (item) => (
            word: '${item['word'] ?? ''}',
            count: (item['count'] is num) ? (item['count'] as num).round() : 0,
            severity: '${item['severity'] ?? ''}',
          ),
        )
        .where((item) => item.word.isNotEmpty && item.count > 0)
        .toList();
    return SectionCard(
      title: '어휘 개선',
      subtitle: '추임새 빈도와 표현 개선 제안',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (fillers.isEmpty)
            const Text('감지된 추임새가 없습니다. 현재 발화는 비교적 깔끔합니다.')
          else ...[
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final filler in fillers)
                  MetricChip(
                    label: filler.word,
                    value: '${filler.count}회 · ${filler.severity}',
                  ),
              ],
            ),
            const SizedBox(height: 14),
            for (final filler in fillers.take(5))
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(
                      CupertinoIcons.arrow_right_circle_fill,
                      size: 18,
                      color: _appBlue,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        '\'${filler.word}\' 표현은 짧은 침묵이나 다음 문장으로 바로 전환해 줄여보세요.',
                        style: const TextStyle(height: 1.35),
                      ),
                    ),
                  ],
                ),
              ),
          ],
          if (analysis.vocabSuggestions.isNotEmpty) ...[
            const Divider(height: 24),
            for (final suggestion in analysis.vocabSuggestions)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: const Icon(CupertinoIcons.sparkles, color: _appMint),
                title: Text(suggestion),
              ),
          ],
        ],
      ),
    );
  }

  Widget _scoreCard(AnalysisResult analysis) {
    return SectionCard(
      title: '분석 결과',
      subtitle: analysis.source,
      trailing: RoundIconButton(
        tooltip: 'PDF 리포트',
        onPressed: _busy ? null : _downloadReport,
        icon: CupertinoIcons.arrow_down_doc,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              MetricChip(label: '총점', value: '${analysis.score}점'),
              MetricChip(label: '등급', value: analysis.grade),
              MetricChip(label: '속도', value: '${analysis.wpm} WPM'),
              MetricChip(label: '추임새', value: '${analysis.fillerTotal}회'),
            ],
          ),
          const SizedBox(height: 14),
          for (final entry in analysis.voiceScores.entries)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: ScoreBar(label: entry.key, value: entry.value),
            ),
          const Divider(height: 24),
          Text(analysis.summary),
          if (analysis.materialName != null) ...[
            const SizedBox(height: 8),
            Text('첨부자료: ${analysis.materialName}'),
          ],
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            height: 52,
            child: FilledButton.icon(
              onPressed: _busy ? null : _downloadReport,
              icon: const Icon(CupertinoIcons.arrow_down_doc),
              label: const Text(
                'PDF 리포트 저장',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _documentMatchCard(AnalysisResult analysis) {
    final match = analysis.documentMatch;
    return SectionCard(
      title: '발표자료 반영률',
      subtitle: match.name.isEmpty
          ? 'PPTX 자료를 첨부하면 비교합니다.'
          : '${match.name} · ${match.type}',
      child: match.available
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    MetricChip(label: '일치율', value: '${match.score}점'),
                    MetricChip(
                      label: '자료 반영',
                      value: '${match.documentCoverage}%',
                    ),
                    MetricChip(
                      label: '추가 발화',
                      value: '${match.speechExtraRatio}%',
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(match.summary),
                if (match.missingTerms.isNotEmpty) ...[
                  const SizedBox(height: 10),
                  Text(
                    '누락 가능 핵심어',
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      for (final term in match.missingTerms)
                        MetricChip(label: '누락', value: term),
                    ],
                  ),
                ],
                if (match.sections.isNotEmpty) ...[
                  const Divider(height: 24),
                  for (final section in match.sections.take(8))
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      leading: CircleAvatar(
                        radius: 17,
                        backgroundColor: const Color(0xFFEFF6FF),
                        child: Text(
                          '${section.page}',
                          style: const TextStyle(
                            color: Color(0xFF007AFF),
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),
                      title: Text(
                        section.title.isEmpty
                            ? 'Slide ${section.page}'
                            : section.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        section.missing.isEmpty
                            ? section.status
                            : '${section.status} · 누락: ${section.missing.join(', ')}',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: Text(
                        '${section.score}%',
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                    ),
                ],
              ],
            )
          : Text(match.summary),
    );
  }

  Widget _feedbackCard(String title, List<String> items) {
    return SectionCard(
      title: title,
      child: items.isEmpty
          ? const Text('표시할 내용이 없습니다.')
          : Column(
              children: [
                for (final item in items)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(
                      CupertinoIcons.checkmark_circle,
                      color: Color(0xFF34C759),
                    ),
                    title: Text(item),
                  ),
              ],
            ),
    );
  }

  Widget _transcriptCard(AnalysisResult analysis) {
    final transcript = analysis.transcript;
    final segments = analysis.segments;
    final displayedSegments = segments.take(12).toList();
    final hiddenSegmentCount = math.max(
      0,
      segments.length - displayedSegments.length,
    );
    final transcriptPreview = transcript.length > 4500
        ? '${transcript.substring(0, 1800)}\n\n... 전사문이 길어 앱 속도를 위해 일부만 표시합니다.'
        : transcript;
    return SectionCard(
      title: '전사문',
      subtitle: segments.length > 1 ? '시간대별 발화 구간' : null,
      child: segments.isEmpty
          ? Text(
              transcriptPreview.isEmpty ? '전사문이 없습니다.' : transcriptPreview,
              style: const TextStyle(height: 1.45),
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final segment in displayedSegments)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          width: 92,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 6,
                          ),
                          decoration: BoxDecoration(
                            color: const Color(0xFFEAF2FF),
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Text(
                            segment.timeLabel,
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              color: _appBlue,
                              fontSize: 11,
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            segment.text,
                            maxLines: 5,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: _appInk,
                              fontSize: 15,
                              height: 1.42,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                if (hiddenSegmentCount > 0)
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF2F4F7),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Text(
                      '나머지 $hiddenSegmentCount개 구간은 PDF 리포트에 포함됩니다.',
                      style: const TextStyle(
                        color: _appMuted,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
              ],
            ),
    );
  }

  Widget _qaCard(AnalysisResult analysis) {
    final question = analysis.questions.isEmpty
        ? null
        : analysis.questions[_selectedQuestionIndex.clamp(
            0,
            analysis.questions.length - 1,
          )];
    return SectionCard(
      title: 'Q&A 연습',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            question ?? '생성된 예상 질문이 없습니다.',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _answerController,
            enabled: question != null && !_busy,
            minLines: 3,
            maxLines: 6,
            decoration: const InputDecoration(hintText: '질문에 대한 답변을 입력하세요.'),
          ),
          const SizedBox(height: 10),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: question == null || _busy ? null : _evaluateAnswer,
              icon: const Icon(CupertinoIcons.chat_bubble_2),
              label: const Text('답변 평가'),
            ),
          ),
          if (_answerResult != null) ...[
            const Divider(height: 24),
            _answerEvaluationView(_answerResult!),
          ],
        ],
      ),
    );
  }

  Widget _answerEvaluationView(Map<String, dynamic> result) {
    final score = _resultInt(result['score']);
    final rows = [
      ('논리', _resultInt(result['logic'])),
      ('구체성', _resultInt(result['specificity'])),
      ('자신감', _resultInt(result['confidence'])),
      ('시간', _resultInt(result['time_control'])),
    ];
    final improvements = _resultStringList(result['improvements']);
    final strengths = _resultStringList(result['strengths']);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFF7F8FB),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFE5E7EB)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '답변 평가 결과',
                  style: const TextStyle(
                    color: _appInk,
                    fontSize: 16,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
              Text(
                '$score점',
                style: const TextStyle(
                  color: _appBlue,
                  fontSize: 22,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final row in rows)
                MetricChip(label: row.$1, value: '${row.$2}'),
            ],
          ),
          if (strengths.isNotEmpty) ...[
            const SizedBox(height: 14),
            const Text('강점', style: TextStyle(fontWeight: FontWeight.w900)),
            const SizedBox(height: 6),
            for (final item in strengths)
              Text('• $item', style: const TextStyle(height: 1.35)),
          ],
          if (improvements.isNotEmpty) ...[
            const SizedBox(height: 14),
            const Text('개선점', style: TextStyle(fontWeight: FontWeight.w900)),
            const SizedBox(height: 6),
            for (final item in improvements)
              Text('• $item', style: const TextStyle(height: 1.35)),
          ],
        ],
      ),
    );
  }

  int _resultInt(dynamic value) {
    if (value is num) return value.round().clamp(0, 100);
    return int.tryParse('$value')?.clamp(0, 100) ?? 0;
  }

  List<String> _resultStringList(dynamic value) {
    if (value is List) {
      return value.map((item) => '$item'.trim()).where((item) {
        return item.isNotEmpty;
      }).toList();
    }
    return const [];
  }

  String _clock(int seconds) {
    final safe = seconds.clamp(0, 99999);
    final minutes = safe ~/ 60;
    final secs = safe % 60;
    return '${minutes.toString().padLeft(2, '0')}:${secs.toString().padLeft(2, '0')}';
  }
}

class BigActionTile extends StatelessWidget {
  const BigActionTile({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.accent,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final Color accent;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(24),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: enabled ? Colors.white : const Color(0xFFF1F3F7),
            borderRadius: BorderRadius.circular(24),
            border: Border.all(
              color: enabled ? Colors.white : const Color(0xFFE5E7EB),
            ),
            boxShadow: enabled
                ? const [
                    BoxShadow(
                      color: Color(0x100F172A),
                      blurRadius: 22,
                      offset: Offset(0, 10),
                    ),
                  ]
                : null,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: enabled ? 0.13 : 0.07),
                  borderRadius: BorderRadius.circular(17),
                ),
                child: Icon(
                  icon,
                  size: 24,
                  color: enabled ? accent : const Color(0xFF98A2B3),
                ),
              ),
              const Spacer(),
              Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: enabled ? _appInk : const Color(0xFF98A2B3),
                  fontSize: 20,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 0,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                subtitle,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: enabled ? _appMuted : const Color(0xFFA5ADB9),
                  fontSize: 13,
                  height: 1.25,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CourseBottomItem extends StatelessWidget {
  const _CourseBottomItem({
    required this.icon,
    required this.label,
    required this.onTap,
    this.selected = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(20),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          height: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          decoration: BoxDecoration(
            color: selected ? _appInk : Colors.transparent,
            borderRadius: BorderRadius.circular(20),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                icon,
                size: 17,
                color: selected ? Colors.white : const Color(0xFF98A2B3),
              ),
              const SizedBox(height: 3),
              Text(
                label,
                textAlign: TextAlign.center,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: selected ? Colors.white : const Color(0xFF667085),
                  fontSize: 10,
                  fontWeight: FontWeight.w900,
                  height: 1.05,
                  letterSpacing: 0,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PaceLineChartPainter extends CustomPainter {
  const _PaceLineChartPainter(this.rows);

  final List<({String time, int wpm})> rows;

  static const _minY = 40.0;
  static const _maxY = 180.0;
  static const _recommendedMin = 120.0;
  static const _recommendedMax = 150.0;

  @override
  void paint(Canvas canvas, Size size) {
    const left = 48.0;
    const right = 20.0;
    const top = 34.0;
    const bottom = 38.0;
    final chart = Rect.fromLTWH(
      left,
      top,
      math.max(1, size.width - left - right),
      math.max(1, size.height - top - bottom),
    );

    final gridPaint = Paint()
      ..color = const Color(0xFFE9EDF5)
      ..strokeWidth = 1;
    final bandPaint = Paint()..color = const Color(0xFFEAF2FF);
    final axisTextStyle = const TextStyle(
      color: _appMuted,
      fontSize: 12,
      fontWeight: FontWeight.w800,
    );

    final bandTop = _y(chart, _recommendedMax);
    final bandBottom = _y(chart, _recommendedMin);
    canvas.drawRect(
      Rect.fromLTRB(chart.left, bandTop, chart.right, bandBottom),
      bandPaint,
    );

    for (final tick in [40, 70, 100, 130, 160]) {
      final y = _y(chart, tick.toDouble());
      canvas.drawLine(Offset(chart.left, y), Offset(chart.right, y), gridPaint);
      _drawText(canvas, '$tick', Offset(8, y - 8), axisTextStyle, maxWidth: 34);
    }

    _drawText(
      canvas,
      'WPM',
      Offset(chart.left, 10),
      const TextStyle(
        color: _appInk,
        fontSize: 13,
        fontWeight: FontWeight.w900,
      ),
      maxWidth: 70,
    );

    if (rows.isEmpty) return;
    final points = <Offset>[];
    for (var i = 0; i < rows.length; i++) {
      final x = rows.length == 1
          ? chart.center.dx
          : chart.left + chart.width * (i / (rows.length - 1));
      final y = _y(chart, rows[i].wpm.toDouble().clamp(_minY, _maxY));
      points.add(Offset(x, y));
    }

    if (points.length > 1) {
      final path = Path()..moveTo(points.first.dx, points.first.dy);
      for (var i = 1; i < points.length; i++) {
        path.lineTo(points[i].dx, points[i].dy);
      }
      canvas.drawPath(
        path,
        Paint()
          ..color = _appBlue
          ..style = PaintingStyle.stroke
          ..strokeWidth = 3
          ..strokeCap = StrokeCap.round
          ..strokeJoin = StrokeJoin.round,
      );
    }

    final dotPaint = Paint()..color = _appVioletDot;
    final dotBorderPaint = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    for (final point in points) {
      canvas.drawCircle(point, 5.5, dotPaint);
      canvas.drawCircle(point, 5.5, dotBorderPaint);
    }

    _drawText(
      canvas,
      rows.first.time,
      Offset(chart.left - 4, chart.bottom + 12),
      axisTextStyle,
      maxWidth: chart.width / 2,
    );
    final lastPainter = _textPainter(rows.last.time, axisTextStyle);
    lastPainter.layout(maxWidth: chart.width / 2);
    lastPainter.paint(
      canvas,
      Offset(chart.right - lastPainter.width + 4, chart.bottom + 12),
    );
  }

  double _y(Rect chart, double value) {
    final normalized = ((value - _minY) / (_maxY - _minY)).clamp(0.0, 1.0);
    return chart.bottom - chart.height * normalized;
  }

  void _drawText(
    Canvas canvas,
    String text,
    Offset offset,
    TextStyle style, {
    required double maxWidth,
  }) {
    final painter = _textPainter(text, style);
    painter.layout(maxWidth: maxWidth);
    painter.paint(canvas, offset);
  }

  TextPainter _textPainter(String text, TextStyle style) {
    return TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: TextDirection.ltr,
      maxLines: 1,
      ellipsis: '...',
    );
  }

  @override
  bool shouldRepaint(covariant _PaceLineChartPainter oldDelegate) {
    return oldDelegate.rows != rows;
  }
}
