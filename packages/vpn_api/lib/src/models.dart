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

/// One region a device can connect through.
class VpnServer {
  const VpnServer({
    required this.id,
    required this.region,
    required this.displayName,
    required this.endpoint,
    required this.isDefault,
    required this.online,
  });

  final int id;
  final String region;
  final String displayName;
  final String endpoint;
  final bool isDefault;

  /// False when the node's agent has stopped reporting. Sending a client
  /// there would strand it, so the UI hides or disables these.
  final bool online;

  factory VpnServer.fromJson(Map<String, dynamic> json) => VpnServer(
    id: (json['id'] as num).toInt(),
    region: json['region'] as String,
    displayName: json['displayName'] as String? ?? json['region'] as String,
    endpoint: json['endpoint'] as String? ?? '',
    isDefault: json['isDefault'] as bool? ?? false,
    online: json['online'] as bool? ?? false,
  );
}

/// Where a device holds an address. One per server it can reach.
class DeviceLocation {
  const DeviceLocation({
    required this.serverId,
    required this.region,
    required this.displayName,
    required this.endpoint,
    required this.allowedIp,
    required this.online,
  });

  final int serverId;
  final String region;
  final String displayName;
  final String endpoint;
  final String allowedIp;
  final bool online;

  factory DeviceLocation.fromJson(Map<String, dynamic> json) => DeviceLocation(
    serverId: (json['serverId'] as num).toInt(),
    region: json['region'] as String? ?? '',
    displayName: json['displayName'] as String? ?? '',
    endpoint: json['endpoint'] as String? ?? '',
    allowedIp: json['allowedIp'] as String? ?? '',
    online: json['online'] as bool? ?? false,
  );
}

class UsageTotals {
  const UsageTotals({required this.rxBytes, required this.txBytes});

  final int rxBytes;
  final int txBytes;

  factory UsageTotals.fromJson(Map<String, dynamic>? json) => UsageTotals(
    rxBytes: (json?['rxBytes'] as num?)?.toInt() ?? 0,
    txBytes: (json?['txBytes'] as num?)?.toInt() ?? 0,
  );
}

/// What the user manages and what the quota counts: one keypair, however many
/// regions it can reach.
class Device {
  const Device({
    required this.id,
    required this.label,
    required this.platform,
    required this.publicKey,
    required this.createdAt,
    required this.keyRotatedAt,
    required this.locations,
    required this.usage,
  });

  final int id;
  final String label;

  /// `android`, `ios`, `windows`, `macos`, `linux`, or `unknown`.
  final String platform;
  final String publicKey;
  final String createdAt;

  /// Null until the device has rotated its key at least once.
  final String? keyRotatedAt;

  final List<DeviceLocation> locations;
  final UsageTotals usage;

  factory Device.fromJson(Map<String, dynamic> json) => Device(
    id: (json['id'] as num).toInt(),
    label: json['label'] as String? ?? 'Device',
    platform: json['platform'] as String? ?? 'unknown',
    publicKey: json['publicKey'] as String,
    createdAt: json['createdAt'] as String? ?? '',
    keyRotatedAt: json['keyRotatedAt'] as String?,
    locations: ((json['locations'] as List<dynamic>?) ?? const [])
        .map((item) => DeviceLocation.fromJson(item as Map<String, dynamic>))
        .toList(growable: false),
    usage: UsageTotals.fromJson(json['usage'] as Map<String, dynamic>?),
  );
}

/// Response of `POST /devices`, `POST /devices/:id/rotate` and
/// `GET /devices/:id/config`.
///
/// [privateKey] is non-null only when the *server* generated the keypair,
/// which happens only if the client did not supply a public key. The apps
/// always supply one, so for them it is always null and [conf] carries the
/// `<PRIVATE_KEY>` placeholder to fill from local storage.
class DeviceConfig {
  const DeviceConfig({
    required this.device,
    required this.conf,
    required this.serverId,
    required this.region,
    required this.endpoint,
    required this.privateKey,
    required this.privateKeyIncluded,
  });

  static const privateKeyPlaceholder = '<PRIVATE_KEY>';

  final Device device;
  final String conf;

  /// Which region this config connects to.
  final int serverId;
  final String region;
  final String endpoint;

  final String? privateKey;
  final bool privateKeyIncluded;

  factory DeviceConfig.fromJson(Map<String, dynamic> json) {
    final server = json['server'] as Map<String, dynamic>? ?? const {};
    return DeviceConfig(
      device: Device.fromJson(json['device'] as Map<String, dynamic>),
      conf: json['conf'] as String,
      serverId: (server['id'] as num?)?.toInt() ?? 0,
      region: server['region'] as String? ?? '',
      endpoint: server['endpoint'] as String? ?? '',
      privateKey: json['privateKey'] as String?,
      privateKeyIncluded: json['privateKeyIncluded'] as bool? ?? false,
    );
  }

  /// Substitutes the locally held private key into the served config.
  String resolveConf(String privateKey) =>
      conf.replaceFirst(privateKeyPlaceholder, privateKey);
}
