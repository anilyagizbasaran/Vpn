import 'dart:convert';

import 'package:test/test.dart';
import 'package:vpn_api/vpn_api.dart';

const _createResponse = '''
{
  "peer": {
    "id": 7,
    "deviceLabel": "Pixel 8",
    "publicKey": "cGVlcnB1YmxpY2tleXBlZXJwdWJsaWNrZXlwZWVycHVia2U=",
    "allowedIp": "10.8.0.5/32",
    "serverId": 1,
    "region": "de-fra",
    "endpoint": "vpn.example.com:51820",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "keyRotatedAt": null
  },
  "server": {
    "publicKey": "c2VydmVycHVibGlja2V5c2VydmVycHVibGlja2V5c2VydmU=",
    "endpoint": "vpn.example.com:51820",
    "dns": "1.1.1.1",
    "allowedIps": "0.0.0.0/0,::/0",
    "persistentKeepalive": 25,
    "mtu": 1420
  },
  "presharedKey": null,
  "privateKey": "cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5cHJpdmE=",
  "conf": "[Interface]\\nPrivateKey = cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5cHJpdmE=\\nAddress = 10.8.0.5/32\\n",
  "privateKeyIncluded": true
}
''';

const _fetchResponse = '''
{
  "peer": {
    "id": 7,
    "deviceLabel": "Pixel 8",
    "publicKey": "cGVlcnB1YmxpY2tleXBlZXJwdWJsaWNrZXlwZWVycHVia2U=",
    "allowedIp": "10.8.0.5/32",
    "serverId": 1,
    "region": "de-fra",
    "endpoint": "vpn.example.com:51820",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "keyRotatedAt": "2026-02-01T00:00:00.000Z"
  },
  "server": {
    "publicKey": "c2VydmVycHVibGlja2V5c2VydmVycHVibGlja2V5c2VydmU=",
    "endpoint": "vpn.example.com:51820",
    "dns": "1.1.1.1",
    "allowedIps": "0.0.0.0/0,::/0",
    "persistentKeepalive": 25,
    "mtu": 1420
  },
  "presharedKey": null,
  "privateKey": null,
  "conf": "[Interface]\\nPrivateKey = <PRIVATE_KEY>\\nAddress = 10.8.0.5/32\\n",
  "privateKeyIncluded": false
}
''';

Map<String, dynamic> _json(String source) =>
    jsonDecode(source) as Map<String, dynamic>;

void main() {
  group('PeerConfig', () {
    test('parses a server-generated response including the one-time key', () {
      final config = PeerConfig.fromJson(_json(_createResponse));

      expect(config.peer.id, 7);
      expect(config.peer.allowedIp, '10.8.0.5/32');
      expect(config.peer.keyRotatedAt, isNull);
      expect(config.endpoint, 'vpn.example.com:51820');
      expect(config.privateKeyIncluded, isTrue);
      expect(config.privateKey, isNotNull);
      expect(config.conf, contains('PrivateKey = ${config.privateKey}'));
    });

    test('parses a fetched config with the placeholder and no key', () {
      final config = PeerConfig.fromJson(_json(_fetchResponse));

      expect(config.privateKey, isNull);
      expect(config.privateKeyIncluded, isFalse);
      expect(config.peer.keyRotatedAt, '2026-02-01T00:00:00.000Z');
      expect(config.conf, contains(PeerConfig.privateKeyPlaceholder));
    });

    test('substitutes the locally stored key into a fetched config', () {
      final config = PeerConfig.fromJson(_json(_fetchResponse));
      final resolved = config.resolveConf('LOCAL_KEY');

      expect(resolved, contains('PrivateKey = LOCAL_KEY'));
      expect(resolved, isNot(contains(PeerConfig.privateKeyPlaceholder)));
      expect(resolved, contains('Address = 10.8.0.5/32'));
    });

    test('tolerates a server that omits optional fields', () {
      final config = PeerConfig.fromJson(_json('''
      {
        "peer": {
          "id": 1,
          "deviceLabel": "Old",
          "publicKey": "cGVlcnB1YmxpY2tleXBlZXJwdWJsaWNrZXlwZWVycHVia2U=",
          "allowedIp": "10.8.0.2/32"
        },
        "conf": "[Interface]\\n"
      }
      '''));

      expect(config.peer.region, isEmpty);
      expect(config.peer.keyRotatedAt, isNull);
      expect(config.endpoint, isEmpty);
      expect(config.privateKeyIncluded, isFalse);
    });
  });

  group('AuthSession', () {
    test('parses user and tokens', () {
      final session = AuthSession.fromJson(_json('''
        {
          "user": {"id": 3, "email": "a@b.co", "createdAt": "2026-01-01T00:00:00.000Z"},
          "tokens": {
            "tokenType": "Bearer",
            "accessToken": "access",
            "expiresIn": 900,
            "refreshToken": "refresh",
            "refreshExpiresAt": "2026-02-01T00:00:00.000Z"
          }
        }
      '''));

      expect(session.user.id, 3);
      expect(session.user.email, 'a@b.co');
      expect(session.tokens.accessToken, 'access');
      expect(session.tokens.refreshToken, 'refresh');
      expect(session.tokens.expiresIn, 900);
    });
  });
}
