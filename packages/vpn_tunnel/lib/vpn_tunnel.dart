/// The contract every platform tunnel implementation satisfies.
///
/// Layer 2. Depends on nothing — not even the WireGuard plugin. That is the
/// point: `vpn_client` above talks only to [Tunnel], so the Android/iOS plugin
/// and the desktop daemon client are interchangeable from its perspective.
library;

export 'src/machine_enrolment.dart';
export 'src/tunnel.dart';
