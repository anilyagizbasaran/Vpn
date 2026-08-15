import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:vpn_tunnel/vpn_tunnel.dart';
import 'package:vpn_tunnel_desktop/vpn_tunnel_desktop.dart';

/// A stand-in for vpnd, speaking the real protocol over a real AF_UNIX socket.
///
/// Testing against a fake socket server rather than a mocked client is the
/// point: the framing, the response/event split and the reconnect behaviour
/// are the parts that break, and none of them are exercised by a mock.
class FakeDaemon {
  FakeDaemon({this.protocolVersion = kProtocolVersion});

  final int protocolVersion;

  late final ServerSocket _server;
  late final String path;

  final List<Map<String, dynamic>> requests = [];
  final List<Socket> _clients = [];

  /// Stage the daemon reports, and returns from `up`/`down`.
  String stage = DaemonStage.disconnected;

  /// When set, every `up` fails with this message.
  String? upError;

  /// Delays the reply to `up`, so a slow daemon can be simulated.
  Duration upDelay = Duration.zero;

  Future<void> start() async {
    final dir = await Directory.systemTemp.createTemp('vpnd_test');
    path = '${dir.path}${Platform.pathSeparator}vpnd.sock';
    _server = await ServerSocket.bind(
      InternetAddress(path, type: InternetAddressType.unix),
      0,
    );
    _server.listen(_handle);
  }

  void _handle(Socket socket) {
    _clients.add(socket);
    socket
        .cast<List<int>>()
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
          (line) async {
            if (line.trim().isEmpty) return;
            final request = jsonDecode(line) as Map<String, dynamic>;
            requests.add(request);
            await _reply(socket, request);
          },
          onError: (_) {},
          cancelOnError: true,
        );
  }

  Future<void> _reply(Socket socket, Map<String, dynamic> request) async {
    final id = request['id'];
    void ok(Object? result) => socket.write(
      '${jsonEncode({'id': id, 'ok': true, 'result': result})}\n',
    );
    void fail(String code, String message) => socket.write(
      '${jsonEncode({
        'id': id,
        'ok': false,
        'error': {'code': code, 'message': message},
      })}\n',
    );

    switch (request['method']) {
      case 'version':
        ok({
          'version': 'test',
          'platform': 'test',
          'protocol': protocolVersion,
        });
      case 'status':
      case 'subscribe':
        ok({'stage': stage, 'interface': 'vpn0'});
      case 'up':
        if (upDelay > Duration.zero) await Future<void>.delayed(upDelay);
        if (upError != null) {
          stage = DaemonStage.failed;
          fail('tunnel_failure', upError!);
          return;
        }
        emit(DaemonStage.connecting);
        stage = DaemonStage.connected;
        emit(DaemonStage.connected);
        ok({'stage': stage, 'interface': 'vpn0'});
      case 'down':
        stage = DaemonStage.disconnected;
        emit(DaemonStage.disconnected);
        ok({'stage': stage, 'interface': 'vpn0'});
      default:
        fail('bad_request', 'unknown method');
    }
  }

  /// Pushes an unsolicited stage event, as the daemon does for subscribers.
  void emit(String value) {
    for (final socket in _clients) {
      socket.write('${jsonEncode({'event': 'stage', 'stage': value})}\n');
    }
  }

  /// Simulates the service being stopped or crashing.
  Future<void> killConnections() async {
    for (final socket in _clients) {
      socket.destroy();
    }
    _clients.clear();
  }

  Future<void> stop() async {
    await killConnections();
    await _server.close();
  }
}

void main() {
  late FakeDaemon daemon;
  late DesktopTunnel tunnel;

  Future<void> startWith(FakeDaemon d) async {
    daemon = d;
    await daemon.start();
    tunnel = DesktopTunnel(socketPath: daemon.path);
  }

  setUp(() => startWith(FakeDaemon()));

  tearDown(() async {
    await tunnel.dispose();
    await daemon.stop();
  });

  group('connecting to the daemon', () {
    test('handshakes the protocol version before anything else', () async {
      await tunnel.initialize();

      expect(daemon.requests.first['method'], 'version');
      // Subscribing second means no stage change can be missed between the
      // handshake and the first event.
      expect(daemon.requests[1]['method'], 'subscribe');
    });

    test('refuses a daemon speaking a different protocol', () async {
      await tunnel.dispose();
      await daemon.stop();
      await startWith(FakeDaemon(protocolVersion: kProtocolVersion + 1));

      await expectLater(
        tunnel.initialize(),
        throwsA(
          isA<TunnelException>().having(
            (e) => e.message,
            'message',
            allOf(contains('out of date'), contains('Reinstall')),
          ),
        ),
      );
    });

    test('explains that the service is not running when it is not', () async {
      final missing = DesktopTunnel(
        socketPath:
            '${Directory.systemTemp.path}${Platform.pathSeparator}nope.sock',
      );

      await expectLater(
        missing.initialize(),
        throwsA(
          isA<TunnelException>().having(
            (e) => e.message,
            'message',
            contains('VPN service is not running'),
          ),
        ),
      );
      await missing.dispose();
    });

    test('opens exactly one connection when calls race', () async {
      await Future.wait([
        tunnel.initialize(),
        tunnel.currentStage(),
        tunnel.hasPermission(),
      ]);

      // Two sockets would mean two subscriptions and every event delivered
      // twice.
      expect(daemon.requests.where((r) => r['method'] == 'version').length, 1);
    });
  });

  group('start and stop', () {
    test('sends the config and reports connected', () async {
      await tunnel.initialize();

      await tunnel.start(
        wgQuickConfig: '[Interface]\nPrivateKey = k\n',
        serverAddress: 'vpn.test:51820',
      );

      final up = daemon.requests.firstWhere((r) => r['method'] == 'up');
      final params = up['params'] as Map<String, dynamic>;
      expect(params['config'], contains('PrivateKey = k'));
      expect(params['serverAddress'], 'vpn.test:51820');
      await expectLater(
        tunnel.currentStage(),
        completion(TunnelStage.connected),
      );
    });

    test('surfaces the daemon rejection message verbatim', () async {
      daemon.upError = 'The tunnel configuration was rejected at line 3.';
      await tunnel.initialize();

      await expectLater(
        tunnel.start(wgQuickConfig: 'bad', serverAddress: 'vpn.test:51820'),
        throwsA(
          isA<TunnelException>().having(
            (e) => e.message,
            'message',
            'The tunnel configuration was rejected at line 3.',
          ),
        ),
      );
    });

    test('stop brings the daemon back to disconnected', () async {
      await tunnel.initialize();
      await tunnel.start(wgQuickConfig: 'c', serverAddress: 's');

      await tunnel.stop();

      expect(daemon.stage, DaemonStage.disconnected);
      await expectLater(
        tunnel.currentStage(),
        completion(TunnelStage.disconnected),
      );
    });

    test('reports a daemon that stops answering', () async {
      daemon.upDelay = const Duration(seconds: 30);
      await tunnel.initialize();

      // The GUI must not hang forever on a wedged service.
      await expectLater(
        tunnel
            .start(wgQuickConfig: 'c', serverAddress: 's')
            .timeout(const Duration(seconds: 2)),
        throwsA(anything),
      );
    });
  });

  group('stage stream', () {
    test('forwards the daemon events', () async {
      final seen = <TunnelStage>[];
      tunnel.stages.listen(seen.add);

      await tunnel.initialize();
      await tunnel.start(wgQuickConfig: 'c', serverAddress: 's');
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(seen, contains(TunnelStage.connecting));
      expect(seen, contains(TunnelStage.connected));
    });

    test('reports disconnected when the service dies mid-session', () async {
      await tunnel.initialize();
      await tunnel.start(wgQuickConfig: 'c', serverAddress: 's');

      final seen = <TunnelStage>[];
      tunnel.stages.listen(seen.add);

      await daemon.killConnections();
      await Future<void>.delayed(const Duration(milliseconds: 100));

      // Leaving the UI on "connected" after the service died would tell the
      // user they are protected when nothing is running.
      expect(seen, contains(TunnelStage.disconnected));
    });

    test('reconnects to the daemon on the next command', () async {
      await tunnel.initialize();
      await daemon.killConnections();
      await Future<void>.delayed(const Duration(milliseconds: 50));

      await tunnel.start(wgQuickConfig: 'c', serverAddress: 's');

      expect(
        daemon.requests.where((r) => r['method'] == 'version').length,
        2,
        reason: 'a second handshake means the client reconnected',
      );
    });
  });

  group('stageFromDaemon', () {
    test('maps every stage the daemon can report', () {
      expect(
        stageFromDaemon(DaemonStage.disconnected),
        TunnelStage.disconnected,
      );
      expect(stageFromDaemon(DaemonStage.preparing), TunnelStage.preparing);
      expect(stageFromDaemon(DaemonStage.connecting), TunnelStage.connecting);
      expect(stageFromDaemon(DaemonStage.connected), TunnelStage.connected);
      expect(
        stageFromDaemon(DaemonStage.disconnecting),
        TunnelStage.disconnecting,
      );
      expect(stageFromDaemon(DaemonStage.failed), TunnelStage.failed);
    });

    test('treats an unknown stage as disconnected rather than crashing', () {
      // A newer daemon must not break an older app, and "off" is the safe
      // thing to claim when the answer is not understood.
      expect(stageFromDaemon('teleporting'), TunnelStage.disconnected);
      expect(stageFromDaemon(null), TunnelStage.disconnected);
    });
  });
}
