// Answers one question: can Dart speak AF_UNIX on this host?
//
// It decides the desktop IPC design. If Dart cannot, the daemon needs a
// loopback listener with a token file instead, which is a materially weaker
// and more complicated arrangement — so it is worth measuring rather than
// assuming.
//
//   dart run packages/vpn_tunnel/tool/af_unix_probe.dart
import 'dart:async';
import 'dart:io';

Future<void> main() async {
  final path =
      '${Directory.systemTemp.path}${Platform.pathSeparator}af_unix_probe_${pid}.sock';

  try {
    final file = File(path);
    if (file.existsSync()) file.deleteSync();
  } catch (_) {}

  try {
    final address = InternetAddress(path, type: InternetAddressType.unix);

    final server = await ServerSocket.bind(address, 0).timeout(
      const Duration(seconds: 5),
    );
    server.listen((socket) {
      socket.write('pong');
      socket.close();
    });

    final client = await Socket.connect(
      address,
      0,
    ).timeout(const Duration(seconds: 5));

    final reply = await client
        .fold<List<int>>(<int>[], (acc, chunk) => acc..addAll(chunk))
        .timeout(const Duration(seconds: 5));

    await client.close();
    await server.close();
    try {
      File(path).deleteSync();
    } catch (_) {}

    stdout.writeln('SUPPORTED on ${Platform.operatingSystem}: '
        '${String.fromCharCodes(reply)}');
    exit(0);
  } on TimeoutException {
    stdout.writeln('UNSUPPORTED on ${Platform.operatingSystem}: timed out');
    exit(1);
  } catch (error) {
    stdout.writeln('UNSUPPORTED on ${Platform.operatingSystem}: $error');
    exit(1);
  }
}
