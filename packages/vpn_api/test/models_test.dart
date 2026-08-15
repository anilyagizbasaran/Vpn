import 'dart:convert';

import 'package:test/test.dart';
import 'package:vpn_api/vpn_api.dart';

Map<String, dynamic> json(String source) =>
    jsonDecode(source) as Map<String, dynamic>;

const _deviceJson = '''
{
  "device": {
    "id": 7,
    "publicKey": "cGVlcnB1YmxpY2tleXBlZXJwdWJsaWNrZXlwZWVycHVia2U=",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "keyRotatedAt": null,
    "locations": [
      {
        "serverId": 1,
        "region": "de-fra",
        "displayName": "Frankfurt",
        "endpoint": "fra.example.com:51820",
        "allowedIp": "10.8.0.5/32",
        "online": true
      },
      {
        "serverId": 2,
        "region": "nl-ams",
        "displayName": "Amsterdam",
        "endpoint": "ams.example.com:51820",
        "allowedIp": "10.9.0.5/32",
        "online": false
      }
    ],
    "usage": {"rxBytes": 1024, "txBytes": 2048}
  },
  "server": {
    "id": 1,
    "region": "de-fra",
    "publicKey": "c2VydmVycHVibGlja2V5c2VydmVycHVibGlja2V5c2VydmU=",
    "endpoint": "fra.example.com:51820",
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

void main() {
  group('DeviceConfig', () {
    test('parses a device with an address in every region', () {
      final config = DeviceConfig.fromJson(json(_deviceJson));

      expect(config.device.id, 7);
      expect(config.device.locations, hasLength(2));
      expect(config.device.locations.first.displayName, 'Frankfurt');
      expect(config.device.locations.last.allowedIp, '10.9.0.5/32');
      // A node whose agent has gone quiet is reported so the UI can hide it.
      expect(config.device.locations.last.online, isFalse);
    });

    test('reports which region the config is for', () {
      final config = DeviceConfig.fromJson(json(_deviceJson));

      expect(config.serverId, 1);
      expect(config.region, 'de-fra');
      expect(config.endpoint, 'fra.example.com:51820');
    });

    test('carries the placeholder and no key', () {
      final config = DeviceConfig.fromJson(json(_deviceJson));

      expect(config.privateKey, isNull);
      expect(config.privateKeyIncluded, isFalse);
      expect(config.conf, contains(DeviceConfig.privateKeyPlaceholder));
    });

    test('substitutes the locally stored key', () {
      final resolved = DeviceConfig.fromJson(
        json(_deviceJson),
      ).resolveConf('LOCAL_KEY');

      expect(resolved, contains('PrivateKey = LOCAL_KEY'));
      expect(resolved, isNot(contains(DeviceConfig.privateKeyPlaceholder)));
      expect(resolved, contains('Address = 10.8.0.5/32'));
    });

    test('tolerates a server that omits optional fields', () {
      final config = DeviceConfig.fromJson(
        json('''
      {
        "device": {
          "id": 1,
          "publicKey": "cGVlcnB1YmxpY2tleXBlZXJwdWJsaWNrZXlwZWVycHVia2U="
        },
        "conf": "[Interface]\\n"
      }
      '''),
      );
      expect(config.device.locations, isEmpty);
      expect(config.endpoint, isEmpty);
      expect(config.privateKeyIncluded, isFalse);
    });
  });

  group('VpnServer', () {
    test('parses a region list entry', () {
      final server = VpnServer.fromJson(
        json('''
        {
          "id": 2,
          "region": "nl-ams",
          "displayName": "Amsterdam",
          "endpoint": "ams.example.com:51820",
          "isDefault": false,
          "online": true
        }
      '''),
      );

      expect(server.id, 2);
      expect(server.displayName, 'Amsterdam');
      expect(server.online, isTrue);
      expect(server.isDefault, isFalse);
    });

    test('falls back to the region slug when there is no display name', () {
      final server = VpnServer.fromJson(json('{"id":1,"region":"de-fra"}'));

      expect(server.displayName, 'de-fra');
      // Unknown liveness is treated as offline: claiming a node is up when we
      // cannot tell would strand whoever picks it.
      expect(server.online, isFalse);
    });
  });
}
