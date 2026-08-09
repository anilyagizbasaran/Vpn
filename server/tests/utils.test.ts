import { describe, expect, it } from 'vitest';
import { hostRange, intToIp, ipToInt, isInCidr, parseCidr, stripPrefix } from '../src/utils/ip.js';
import {
  assertWireGuardKey,
  isEmail,
  isWireGuardKey,
  normalizeEmail,
} from '../src/utils/validation.js';

describe('ipToInt / intToIp', () => {
  it('round-trips the ends of the address space', () => {
    for (const ip of ['0.0.0.0', '10.8.0.1', '192.168.1.255', '255.255.255.255']) {
      expect(intToIp(ipToInt(ip))).toBe(ip);
    }
  });

  it('treats the top of the range as unsigned', () => {
    // A signed 32-bit shift here would produce a negative number and break
    // every comparison in the allocator.
    expect(ipToInt('255.255.255.255')).toBe(4294967295);
    expect(ipToInt('128.0.0.0')).toBeGreaterThan(0);
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['10.8.0', '10.8.0.1.2', '10.8.0.256', '10.8.0.-1', 'a.b.c.d', '']) {
      expect(() => ipToInt(bad)).toThrow(/invalid IPv4/);
    }
  });
});

describe('parseCidr', () => {
  it('masks the address down to the network', () => {
    expect(parseCidr('10.8.0.37/24').network).toBe(ipToInt('10.8.0.0'));
    expect(parseCidr('10.8.0.0/16').network).toBe(ipToInt('10.8.0.0'));
  });

  it('computes block size from the prefix', () => {
    expect(parseCidr('10.8.0.0/24').size).toBe(256);
    expect(parseCidr('10.8.0.0/30').size).toBe(4);
  });

  it('rejects prefixes with no usable host range', () => {
    // /31 and /32 have no room for peers; /7 would be a 33M-address pool.
    for (const bad of ['10.8.0.0/31', '10.8.0.0/32', '10.0.0.0/7', '10.8.0.0/x', '10.8.0.0']) {
      expect(() => parseCidr(bad)).toThrow();
    }
  });
});

describe('hostRange', () => {
  it('excludes network and broadcast addresses', () => {
    const { first, last } = hostRange(parseCidr('10.8.0.0/24'));
    expect(intToIp(first)).toBe('10.8.0.1');
    expect(intToIp(last)).toBe('10.8.0.254');
  });

  it('spans subnet boundaries for larger blocks', () => {
    const { first, last } = hostRange(parseCidr('10.8.0.0/22'));
    expect(intToIp(first)).toBe('10.8.0.1');
    expect(intToIp(last)).toBe('10.8.3.254');
  });
});

describe('isInCidr / stripPrefix', () => {
  it('detects membership at both edges', () => {
    const cidr = parseCidr('10.8.0.0/24');
    expect(isInCidr('10.8.0.0', cidr)).toBe(true);
    expect(isInCidr('10.8.0.255', cidr)).toBe(true);
    expect(isInCidr('10.8.1.0', cidr)).toBe(false);
    expect(isInCidr('10.7.255.255', cidr)).toBe(false);
  });

  it('drops a prefix suffix if present', () => {
    expect(stripPrefix('10.8.0.5/32')).toBe('10.8.0.5');
    expect(stripPrefix('10.8.0.5')).toBe('10.8.0.5');
  });
});

describe('isWireGuardKey', () => {
  it('accepts a real 32-byte base64 key', () => {
    expect(isWireGuardKey('aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkMTI=')).toBe(true);
  });

  it('rejects anything that could reach argv as something else', () => {
    const rejected = [
      '', // empty
      'short=',
      'aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkMTI', // no padding
      'aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkMTI==', // over-padded
      '../../etc/passwd',
      '; rm -rf /',
      'aGVsbG8 d29ybGRoZWxsb3dvcmxkaGVsbG93b3JsZDE=', // embedded space
      '$(whoami)',
    ];
    for (const key of rejected) expect(isWireGuardKey(key)).toBe(false);
  });

  it('assertWireGuardKey throws with the label of the offending value', () => {
    expect(() => assertWireGuardKey('nope', 'peer public key')).toThrow(
      /peer public key is not a valid WireGuard key/,
    );
  });
});

describe('isEmail / normalizeEmail', () => {
  it('accepts addresses real mail servers accept', () => {
    for (const email of [
      'a@b.co',
      'first.last@example.com',
      'user+tag@sub.example.co.uk',
      "o'brien@example.com",
    ]) {
      expect(isEmail(email)).toBe(true);
    }
  });

  it('rejects junk, header-injection attempts and over-long input', () => {
    for (const email of [
      '',
      'no-at-sign',
      'no@domain',
      'a@b@c.com',
      'spaces in@example.com',
      'a@example.com, b@evil.com',
      'a@example.com\nBcc: b@evil.com',
      `${'x'.repeat(250)}@example.com`,
    ]) {
      expect(isEmail(email)).toBe(false);
    }
  });

  it('normalises so case and padding cannot create duplicate accounts', () => {
    expect(normalizeEmail('  Alice@Example.COM  ')).toBe('alice@example.com');
  });
});
