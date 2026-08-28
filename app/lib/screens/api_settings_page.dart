import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../models/app_settings.dart';
import '../widgets/app_widgets.dart';

class ApiSettingsPage extends StatefulWidget {
  const ApiSettingsPage({
    super.key,
    required this.storage,
    required this.initialSettings,
  });

  final FlutterSecureStorage storage;
  final AppSettings initialSettings;

  @override
  State<ApiSettingsPage> createState() => _ApiSettingsPageState();
}

class _ApiSettingsPageState extends State<ApiSettingsPage> {
  late final TextEditingController _clovaKeyController;
  late final TextEditingController _clovaUrlController;
  late final TextEditingController _claudeKeyController;
  late final TextEditingController _claudeModelController;
  bool _saving = false;
  String? _status;

  @override
  void initState() {
    super.initState();
    final settings = widget.initialSettings;
    _clovaKeyController = TextEditingController(text: settings.clovaKey);
    _clovaUrlController = TextEditingController(text: settings.clovaInvokeUrl);
    _claudeKeyController = TextEditingController(text: settings.claudeKey);
    _claudeModelController = TextEditingController(text: settings.claudeModel);
  }

  @override
  void dispose() {
    _clovaKeyController.dispose();
    _clovaUrlController.dispose();
    _claudeKeyController.dispose();
    _claudeModelController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!mounted) return;
    setState(() {
      _saving = true;
      _status = null;
    });
    try {
      await widget.storage.write(
        key: SecureSettingKeys.clovaKey,
        value: _clovaKeyController.text.trim(),
      );
      await widget.storage.write(
        key: SecureSettingKeys.clovaUrl,
        value: _clovaUrlController.text.trim(),
      );
      await widget.storage.write(
        key: SecureSettingKeys.claudeKey,
        value: _claudeKeyController.text.trim(),
      );
      await widget.storage.write(
        key: SecureSettingKeys.claudeModel,
        value: _claudeModelController.text.trim().isEmpty
            ? AppSettings.defaultClaudeModel
            : _claudeModelController.text.trim(),
      );
      if (!mounted) return;
      Navigator.of(context).pop(true);
      return;
    } catch (error) {
      if (mounted) setState(() => _status = '오류: $error');
    }
    if (mounted) setState(() => _saving = false);
  }

  void _clear() {
    setState(() {
      _clovaKeyController.clear();
      _clovaUrlController.clear();
      _claudeKeyController.clear();
      _claudeModelController.text = AppSettings.defaultClaudeModel;
      _status = '입력값을 비웠습니다. 저장을 눌러 반영하세요.';
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        title: const Text('API 설정'),
        actions: [
          RoundIconButton(
            tooltip: '저장',
            onPressed: _saving ? null : _save,
            icon: CupertinoIcons.checkmark,
          ),
          const SizedBox(width: 10),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 28),
          children: [
            SectionCard(
              title: '보안 저장소',
              subtitle: '실제 API 키는 코드가 아니라 이 기기의 보안 저장소에 저장됩니다.',
              child: Column(
                children: [
                  TextField(
                    controller: _clovaKeyController,
                    obscureText: true,
                    decoration: const InputDecoration(
                      labelText: 'CLOVA Speech Secret Key',
                      prefixIcon: Icon(CupertinoIcons.lock_shield),
                    ),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _clovaUrlController,
                    decoration: const InputDecoration(
                      labelText: 'CLOVA Speech Invoke URL',
                      prefixIcon: Icon(CupertinoIcons.link),
                    ),
                    keyboardType: TextInputType.url,
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _claudeKeyController,
                    obscureText: true,
                    decoration: const InputDecoration(
                      labelText: 'Claude API Key',
                      prefixIcon: Icon(CupertinoIcons.sparkles),
                    ),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _claudeModelController,
                    decoration: const InputDecoration(
                      labelText: 'Claude Model',
                      prefixIcon: Icon(CupertinoIcons.slider_horizontal_3),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _saving ? null : _clear,
                          icon: const Icon(CupertinoIcons.trash),
                          label: const Text('비우기'),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: FilledButton.icon(
                          onPressed: _saving ? null : _save,
                          icon: const Icon(CupertinoIcons.checkmark),
                          label: const Text('저장'),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            if (_saving) ...[
              const SizedBox(height: 12),
              const ClipRRect(
                borderRadius: BorderRadius.all(Radius.circular(99)),
                child: LinearProgressIndicator(minHeight: 5),
              ),
            ],
            if (_status != null) ...[
              const SizedBox(height: 12),
              StatusBanner(text: _status!),
            ],
          ],
        ),
      ),
    );
  }
}
