import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// A WireGuard keypair, base64-encoded exactly as `wg genkey` / `wg pubkey`
/// would print it.
class WireGuardKeyPair {
  const WireGuardKeyPair({required this.privateKey, required this.publicKey});

  final String privateKey;
  final String publicKey;
}

/// Generates WireGuard keypairs on the device.
///
/// This is what keeps the private key out of the control plane entirely: the
/// client sends only [WireGuardKeyPair.publicKey] to `POST /peers`, so the
/// server never has the private half in memory, in a response body, or in a
/// log.
class WireGuardKeys {
  const WireGuardKeys._();

  static final _x25519 = X25519();

  static Future<WireGuardKeyPair> generate() async {
    final keyPair = await _x25519.newKeyPair();
    final private = Uint8List.fromList(await keyPair.extractPrivateKeyBytes());

    // Clamp before storing, so the stored key is byte-identical to what
    // `wg genkey` produces. WireGuard clamps on load anyway, but an unclamped
    // key would not round-trip through `wg pubkey` comparisons.
    clamp(private);

    final public = await publicKeyFor(private);
    return WireGuardKeyPair(
      privateKey: base64.encode(private),
      publicKey: base64.encode(public),
    );
  }

  /// RFC 7748 clamping: zero the low three bits, clear bit 255, set bit 254.
  /// Mutates [privateKey] in place.
  static void clamp(Uint8List privateKey) {
    if (privateKey.length != 32) {
      throw ArgumentError('WireGuard private keys are 32 bytes');
    }
    privateKey[0] &= 248;
    privateKey[31] &= 127;
    privateKey[31] |= 64;
  }

  /// Derives the public key by multiplying the Curve25519 base point.
  static Future<Uint8List> publicKeyFor(Uint8List privateKey) async {
    final keyPair = await _x25519.newKeyPairFromSeed(privateKey);
    final public = await keyPair.extractPublicKey();
    return Uint8List.fromList(public.bytes);
  }

  /// True for a base64-encoded 32-byte key — the same shape the API enforces.
  static bool isValidKey(String value) {
    if (!RegExp(r'^[A-Za-z0-9+/]{43}=$').hasMatch(value)) return false;
    try {
      return base64.decode(value).length == 32;
    } on FormatException {
      return false;
    }
  }
}
