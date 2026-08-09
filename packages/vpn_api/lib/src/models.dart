// Wire models for the control plane API. Hand-written on purpose: the payload
// is small and stable, and this avoids a build_runner step.

class AuthTokens {
  const AuthTokens({
    required this.accessToken,
    required this.refreshToken,
    required this.expiresIn,
  });

  final String accessToken;
  final String refreshToken;
  final int expiresIn;

  factory AuthTokens.fromJson(Map<String, dynamic> json) => AuthTokens(
    accessToken: json['accessToken'] as String,
    refreshToken: json['refreshToken'] as String,
    expiresIn: (json['expiresIn'] as num?)?.toInt() ?? 900,
  );
}

class AccountUser {
  const AccountUser({required this.id, required this.email});

  final int id;
  final String email;

  factory AccountUser.fromJson(Map<String, dynamic> json) => AccountUser(
    id: (json['id'] as num).toInt(),
    email: json['email'] as String,
  );
}

class AuthSession {
  const AuthSession({required this.user, required this.tokens});

  final AccountUser user;
  final AuthTokens tokens;

  factory AuthSession.fromJson(Map<String, dynamic> json) => AuthSession(
    user: AccountUser.fromJson(json['user'] as Map<String, dynamic>),
    tokens: AuthTokens.fromJson(json['tokens'] as Map<String, dynamic>),
  );
}

class Peer {
  const Peer({
    required this.id,
    required this.deviceLabel,
    required this.platform,
    required this.publicKey,
    required this.allowedIp,
    required this.region,
    required this.endpoint,
    required this.createdAt,
    required this.keyRotatedAt,
  });

  final int id;
  final String deviceLabel;

  /// `android`, `ios`, `windows`, `macos`, `linux`, or `unknown` for peers
  /// created before the server recorded it.
  final String platform;

  final String publicKey;
  final String allowedIp;
  final String region;
  final String endpoint;
  final String createdAt;

  /// Null until the device has rotated its key at least once.
  final String? keyRotatedAt;

  factory Peer.fromJson(Map<String, dynamic> json) => Peer(
    id: (json['id'] as num).toInt(),
    deviceLabel: json['deviceLabel'] as String,
    platform: json['platform'] as String? ?? 'unknown',
    publicKey: json['publicKey'] as String,
    allowedIp: json['allowedIp'] as String,
    region: json['region'] as String? ?? '',
    endpoint: json['endpoint'] as String? ?? '',
    createdAt: json['createdAt'] as String? ?? '',
    keyRotatedAt: json['keyRotatedAt'] as String?,
  );
}

/// Response of `POST /peers`, `POST /peers/:id/rotate` and
/// `GET /peers/:id/config`.
///
/// [privateKey] is non-null only when the *server* generated the keypair,
/// which happens only if the client did not supply a public key. The apps
/// always supply one, so for them it is always null and [conf] carries the
/// `<PRIVATE_KEY>` placeholder to fill from local storage.
class PeerConfig {
  const PeerConfig({
    required this.peer,
    required this.conf,
    required this.endpoint,
    required this.privateKey,
    required this.privateKeyIncluded,
  });

  static const privateKeyPlaceholder = '<PRIVATE_KEY>';

  final Peer peer;
  final String conf;
  final String endpoint;
  final String? privateKey;
  final bool privateKeyIncluded;

  factory PeerConfig.fromJson(Map<String, dynamic> json) {
    final server = json['server'] as Map<String, dynamic>? ?? const {};
    return PeerConfig(
      peer: Peer.fromJson(json['peer'] as Map<String, dynamic>),
      conf: json['conf'] as String,
      endpoint: server['endpoint'] as String? ?? '',
      privateKey: json['privateKey'] as String?,
      privateKeyIncluded: json['privateKeyIncluded'] as bool? ?? false,
    );
  }

  /// Substitutes the locally held private key into the served config.
  String resolveConf(String privateKey) =>
      conf.replaceFirst(privateKeyPlaceholder, privateKey);
}
