/// Session, device and tunnel orchestration.
///
/// Layer 3. Every app surface — mobile, desktop, web dashboard, the browser
/// extension's companion — drives the product through these controllers, so a
/// policy change (rotation interval, sign-out semantics) lands in one place.
library;

export 'src/auth_controller.dart';
export 'src/device_store.dart';
export 'src/secure_store.dart';
export 'src/server_address.dart';
export 'src/session_end_reason.dart';
export 'src/system_settings.dart';
export 'src/vpn_controller.dart';
