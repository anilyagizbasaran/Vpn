/// Everything needed to talk to the control plane, and nothing else.
///
/// Layer 1: may import [vpn_crypto]. May not import Flutter, dart:io, or any
/// package above it — this is the layer the web dashboard shares with the
/// mobile and desktop apps.
library;

export 'src/api_client.dart';
export 'src/api_exception.dart';
export 'src/auth_repository.dart';
export 'src/models.dart';
export 'src/peer_repository.dart';
export 'src/session_store.dart';
