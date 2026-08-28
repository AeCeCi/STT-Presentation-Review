class SecureSettingKeys {
  static const clovaKey = 'clova_key';
  static const clovaUrl = 'clova_url';
  static const claudeKey = 'claude_key';
  static const claudeModel = 'claude_model';
}

class ProjectApiConfig {
  static const clovaKey = String.fromEnvironment('CLOVA_SPEECH_SECRET_KEY');
  static const clovaInvokeUrl = String.fromEnvironment(
    'CLOVA_SPEECH_INVOKE_URL',
  );
  static const claudeKey = String.fromEnvironment('CLAUDE_API_KEY');
  static const claudeModel = String.fromEnvironment(
    'CLAUDE_MODEL',
    defaultValue: AppSettings.defaultClaudeModel,
  );

  static bool get hasClova => clovaKey.isNotEmpty && clovaInvokeUrl.isNotEmpty;
  static bool get hasClaude => claudeKey.isNotEmpty;
}

class AppSettings {
  const AppSettings({
    required this.clovaKey,
    required this.clovaInvokeUrl,
    required this.claudeKey,
    required this.claudeModel,
  });

  static const defaultClaudeModel = 'claude-3-5-haiku-latest';

  factory AppSettings.fromProjectConfig() {
    return const AppSettings(
      clovaKey: ProjectApiConfig.clovaKey,
      clovaInvokeUrl: ProjectApiConfig.clovaInvokeUrl,
      claudeKey: ProjectApiConfig.claudeKey,
      claudeModel: ProjectApiConfig.claudeModel,
    );
  }

  final String clovaKey;
  final String clovaInvokeUrl;
  final String claudeKey;
  final String claudeModel;

  bool get hasClova => clovaKey.isNotEmpty && clovaInvokeUrl.isNotEmpty;
  bool get hasClaude => claudeKey.isNotEmpty;
}
