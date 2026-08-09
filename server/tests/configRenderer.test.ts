import { describe, expect, it } from 'vitest';
import {
  PRIVATE_KEY_PLACEHOLDER,
  renderWgQuickConfig,
  type ClientConfigInput,
} from '../src/services/configRenderer.js';

const PSK = 'cHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHM=';

const base: ClientConfigInput = {
  privateKey: 'cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5cHJpdmE=',
  address: '10.8.0.5/32',
  dns: '1.1.1.1, 1.0.0.1',
  serverPublicKey: 'c2VydmVycHVibGlja2V5c2VydmVycHVibGlja2V5c2VydmU=',
  presharedKey: null,
  allowedIps: '0.0.0.0/0,::/0',
  endpoint: 'vpn.example.com:51820',
  persistentKeepalive: 25,
  mtu: 1420,
};

const render = (overrides: Partial<ClientConfigInput> = {}) =>
  renderWgQuickConfig({ ...base, ...overrides });

/** Parses `Key = Value` lines into a map, per section. */
function parseConf(conf: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = '';
  for (const line of conf.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('[')) {
      section = trimmed.slice(1, -1);
      out[section] ??= {};
      continue;
    }
    const eq = trimmed.indexOf('=');
    out[section] = out[section] ?? {};
    (out[section] as Record<string, string>)[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim();
  }
  return out;
}

describe('renderWgQuickConfig', () => {
  it('emits a wg-quick config with both sections in order', () => {
    const conf = render();

    expect(conf.indexOf('[Interface]')).toBeLessThan(conf.indexOf('[Peer]'));
    expect(conf.endsWith('\n')).toBe(true);
    // LF only: a CRLF config is rejected by some wg-quick parsers.
    expect(conf).not.toContain('\r');
  });

  it('places every value in the right section', () => {
    const parsed = parseConf(render({ presharedKey: PSK }));

    expect(parsed['Interface']).toMatchObject({
      PrivateKey: base.privateKey,
      Address: '10.8.0.5/32',
      DNS: '1.1.1.1, 1.0.0.1',
      MTU: '1420',
    });
    expect(parsed['Peer']).toMatchObject({
      PublicKey: base.serverPublicKey,
      PresharedKey: PSK,
      AllowedIPs: '0.0.0.0/0, ::/0',
      Endpoint: 'vpn.example.com:51820',
      PersistentKeepalive: '25',
    });
  });

  it('substitutes the placeholder when no private key is available', () => {
    const conf = render({ privateKey: null });

    expect(conf).toContain(`PrivateKey = ${PRIVATE_KEY_PLACEHOLDER}`);
    expect(conf).not.toContain(base.privateKey as string);
    // The client swaps the placeholder for its stored key; exactly one match.
    expect(conf.split(PRIVATE_KEY_PLACEHOLDER)).toHaveLength(2);
  });

  it('omits optional lines rather than emitting empty values', () => {
    const conf = render({ dns: '', presharedKey: null, mtu: 0, persistentKeepalive: 0 });

    expect(conf).not.toContain('DNS');
    expect(conf).not.toContain('PresharedKey');
    expect(conf).not.toContain('MTU');
    expect(conf).not.toContain('PersistentKeepalive');
    // No `Key = ` line with an empty value; wg-quick rejects those outright.
    // (Matching a bare trailing `=` would false-positive on base64 padding.)
    expect(conf).not.toMatch(/^[A-Za-z]+\s*=\s*$/m);
  });

  it('normalises comma lists regardless of the spacing in env', () => {
    expect(render({ allowedIps: '0.0.0.0/0,::/0' })).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
    expect(render({ allowedIps: ' 0.0.0.0/0 ,  ::/0 , ' })).toContain(
      'AllowedIPs = 0.0.0.0/0, ::/0',
    );
    expect(render({ dns: '1.1.1.1,,  8.8.8.8' })).toContain('DNS = 1.1.1.1, 8.8.8.8');
  });

  it('supports a split-tunnel AllowedIPs without touching anything else', () => {
    const parsed = parseConf(render({ allowedIps: '10.8.0.0/24' }));
    expect(parsed['Peer']?.['AllowedIPs']).toBe('10.8.0.0/24');
    expect(parsed['Interface']?.['Address']).toBe('10.8.0.5/32');
  });
});
