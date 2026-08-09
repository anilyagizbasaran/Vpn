/// Where a tunnel is in its lifecycle.
///
/// This is our own vocabulary, not the mobile plugin's. Mapping the plugin's
/// stages onto these means a plugin upgrade — or a fork, or the desktop daemon
/// reporting something different — cannot ripple up into the controllers.
enum TunnelStage {
  disconnected,
  preparing,
  connecting,
  waitingForServer,
  authenticating,
  connected,
  reconnecting,
  disconnecting,

  /// The user declined the system VPN profile. Recoverable, but only by the
  /// user, so it is a distinct stage rather than a generic failure.
  permissionDenied,

  /// The tunnel is configured but the device has no usable network.
  noConnection,

  /// The last attempt failed and nothing is running. Distinct from
  /// [disconnected], which means "off because nobody asked for it": the
  /// desktop daemon reports this state after a tunnel it was managing dies,
  /// and showing that as a plain disconnect would hide a real problem.
  failed,

  exiting,
}

/// True while the tunnel is mid-transition and a new command would race.
bool isBusyStage(TunnelStage stage) => switch (stage) {
  TunnelStage.preparing ||
  TunnelStage.connecting ||
  TunnelStage.waitingForServer ||
  TunnelStage.authenticating ||
  TunnelStage.reconnecting ||
  TunnelStage.disconnecting ||
  TunnelStage.exiting => true,
  _ => false,
};

/// Human-readable label. Lives here rather than in the UI so every surface —
/// mobile, desktop, browser extension — says the same thing.
String describeStage(TunnelStage stage) => switch (stage) {
  TunnelStage.disconnected => 'Not connected',
  TunnelStage.preparing => 'Preparing…',
  TunnelStage.connecting => 'Connecting…',
  TunnelStage.waitingForServer => 'Waiting for the server…',
  TunnelStage.authenticating => 'Authenticating…',
  TunnelStage.connected => 'Connected',
  TunnelStage.reconnecting => 'Reconnecting…',
  TunnelStage.disconnecting => 'Disconnecting…',
  TunnelStage.permissionDenied => 'VPN permission denied',
  TunnelStage.noConnection => 'No connection',
  TunnelStage.failed => 'Connection failed',
  TunnelStage.exiting => 'Shutting down…',
};

/// Raised when the platform layer fails. Carries a message already fit to show
/// a user, so callers never have to interpret a platform error code.
class TunnelException implements Exception {
  const TunnelException(this.message, {this.cause});

  final String message;
  final Object? cause;

  @override
  String toString() => 'TunnelException: $message';
}

/// Drives one WireGuard tunnel on this device.
abstract interface class Tunnel {
  /// Emits on every stage change. Broadcast: several widgets may listen.
  Stream<TunnelStage> get stages;

  /// Prepares the platform tunnel. Idempotent, but not free — call it once
  /// per launch, before anything else.
  Future<void> initialize();

  Future<TunnelStage> currentStage();

  /// Whether the OS has already granted the VPN profile.
  Future<bool> hasPermission();

  /// [wgQuickConfig] is a complete config with a real private key in it.
  /// [serverAddress] is `host:port`, used for reachability checks.
  Future<void> start({
    required String wgQuickConfig,
    required String serverAddress,
  });

  Future<void> stop();

  /// Releases the stage stream. Called when the app shuts down.
  Future<void> dispose();
}
