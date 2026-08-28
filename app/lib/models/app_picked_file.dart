import 'dart:io';

import 'package:file_selector/file_selector.dart';

class AppPickedFile {
  const AppPickedFile({
    required this.name,
    required this.path,
    required this.size,
  });

  factory AppPickedFile.fromXFile(XFile file) {
    final localFile = File(file.path);
    return AppPickedFile(
      name: file.name,
      path: file.path,
      size: localFile.existsSync() ? localFile.lengthSync() : 0,
    );
  }

  final String name;
  final String path;
  final int size;
}
