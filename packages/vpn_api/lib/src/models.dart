// Wire models for the control plane API. Hand-written on purpose: the payload
// is small and stable, and this avoids a build_runner step.

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

/// What the internet sees for this device right now.
///
/// [throughTunnel] is the part worth showing: it is the server saying "this
/// request reached me through the tunnel", which is the only confirmation
/// that the VPN is actually carrying traffic rather than merely reporting
/// itself as connected.
class PublicAddress {
  const PublicAddress({
    required this.ip,
    required this.throughTunnel,
    required this.region,
  });

  final String ip;
  final bool throughTunnel;

  /// The node the traffic left from, or null when not tunnelled.
  final String? region;

  factory PublicAddress.fromJson(Map<String, dynamic> json) => PublicAddress(
    ip: json['ip'] as String? ?? '',
    throughTunnel: json['throughTunnel'] as bool? ?? false,
    region: json['region'] as String?,
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

/// One keypair, however many regions it can reach.
///
/// Three fields, because three is all the server has. It used to carry a
/// label, a platform, a created-at date and byte counters; none of that was
/// needed to build a tunnel, and all of it was a record of somebody's device
/// and habits sitting in a database. The server does not keep it any more, so
/// there is nothing here to parse.
class Device {
  const Device({
    required this.id,
    required this.publicKey,
    required this.locations,
  });

  final int id;
  final String publicKey;
  final List<DeviceLocation> locations;

  factory Device.fromJson(Map<String, dynamic> json) => Device(
    id: (json['id'] as num).toInt(),
    publicKey: json['publicKey'] as String,
    locations: ((json['locations'] as List<dynamic>?) ?? const [])
        .map((item) => DeviceLocation.fromJson(item as Map<String, dynamic>))
        .toList(growable: false),
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
