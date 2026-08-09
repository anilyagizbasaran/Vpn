import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vpn_client/core/wireguard_keys.dart';

/// If key derivation is wrong the tunnel simply never handshakes, with no
/// error anywhere — so this is pinned to the RFC 7748 test vector rather than
/// to self-consistency.
Uint8List hex(String value) => Uint8List.fromList([
  for (var i = 0; i < value.length; i += 2)
    int.parse(value.substring(i, i + 2), radix: 16),
]);

void main() {
  group('X25519 derivation', () {
    test('matches the RFC 7748 §6.1 test vector', () async {
      // Alice's scalar and the public key it must produce.
      final privateKey = hex(
        '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
      );
      final expected = hex(
        '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
      );

      expect(await WireGuardKeys.publicKeyFor(privateKey), equals(expected));
    });

    test('matches the vector for Bob as well', () async {
      final privateKey = hex(
        '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb',
      );
      final expected = hex(
        'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
      );

      expect(await WireGuardKeys.publicKeyFor(privateKey), equals(expected));
    });

    test('clamping is applied and is idempotent', () async {
      // All bits set: clamping must clear the low three and fix the top two.
      final key = Uint8List(32)..fillRange(0, 32, 0xFF);
      WireGuardKeys.clamp(key);

      expect(key[0] & 0x07, 0, reason: 'low three bits cleared');
      expect(key[31] & 0x80, 0, reason: 'bit 255 cleared');
      expect(key[31] & 0x40, 0x40, reason: 'bit 254 set');

      final again = Uint8List.fromList(key);
      WireGuardKeys.clamp(again);
      expect(again, equals(key));
    });

    test('rejects a key that is not 32 bytes', () {
      expect(() => WireGuardKeys.clamp(Uint8List(31)), throwsArgumentError);
    });
  });

  group('generate', () {
    test('produces keys in the format the API accepts', () async {
      final pair = await WireGuardKeys.generate();

      expect(pair.privateKey, matches(r'^[A-Za-z0-9+/]{43}=$'));
      expect(pair.publicKey, matches(r'^[A-Za-z0-9+/]{43}=$'));
      expect(base64.decode(pair.privateKey), hasLength(32));
      expect(base64.decode(pair.publicKey), hasLength(32));
      expect(WireGuardKeys.isValidKey(pair.privateKey), isTrue);
      expect(WireGuardKeys.isValidKey(pair.publicKey), isTrue);
    });

    test('stores the private key already clamped, like `wg genkey`', () async {
      final pair = await WireGuardKeys.generate();
      final private = base64.decode(pair.privateKey);

      expect(private[0] & 0x07, 0);
      expect(private[31] & 0xC0, 0x40);
    });

    test('the stored private key really derives the stored public key', () async {
      final pair = await WireGuardKeys.generate();

      final derived = await WireGuardKeys.publicKeyFor(
        Uint8List.fromList(base64.decode(pair.privateKey)),
      );
      expect(base64.encode(derived), pair.publicKey);
    });

    test('every call produces a different key', () async {
      final keys = <String>{};
      for (var i = 0; i < 20; i += 1) {
        keys.add((await WireGuardKeys.generate()).privateKey);
      }
      expect(keys, hasLength(20));
    });
  });

  group('isValidKey', () {
    test('rejects anything that is not a 32-byte base64 key', () {
      for (final bad in [
        '',
        'short=',
        'a' * 44,
        '${'A' * 43}=extra',
        '../../etc/passwd',
      ]) {
        expect(WireGuardKeys.isValidKey(bad), isFalse, reason: bad);
      }
    });
  });
}
