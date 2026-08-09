import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The env module validates once at import and throws on a bad configuration,
 * so a misconfigured server refuses to start instead of running half-broken.
 * Each case re-imports it with a different environment.
 */

const BASE: Record<string, string> = {
  NODE_ENV: 'test',
  JWT_ACCESS_SECRET: 'a-sufficiently-long-access-secret',
  JWT_REFRESH_PEPPER: 'a-sufficiently-long-refresh-pepper',
  WG_MOCK: 'true',
};

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
  vi.resetModules();
});

async function loadEnv(overrides: Record<string, string | undefined>) {
  process.env = {};
  for (const [key, value] of Object.entries({ ...BASE, ...overrides })) {
    if (value !== undefined) process.env[key] = value;
  }
  vi.resetModules();
  return (await import('../src/config/env.js')).env;
}

describe('valid configuration', () => {
  it('applies documented defaults', async () => {
    const env = await loadEnv({});

    expect(env.PORT).toBe(3000);
    expect(env.MAX_PEERS_PER_USER).toBe(5);
    expect(env.WG_INTERFACE).toBe('wg0');
    expect(env.WG_CLIENT_MTU).toBe(1420);
    expect(env.REFRESH_TTL_DAYS).toBe(30);
    // 0 = trust nothing. Assuming a proxy that is not there is the unsafe
    // direction, so it must not be the default.
    expect(env.TRUST_PROXY).toBe(0);
  });

  it('coerces numbers and booleans from strings', async () => {
    const env = await loadEnv({
      PORT: '8080',
      MAX_PEERS_PER_USER: '3',
      WG_SUDO: 'true',
      WG_SYNC_ON_BOOT: 'false',
    });

    expect(env.PORT).toBe(8080);
    expect(env.MAX_PEERS_PER_USER).toBe(3);
    expect(env.WG_SUDO).toBe(true);
    expect(env.WG_SYNC_ON_BOOT).toBe(false);
  });

  it('parses CORS_ORIGINS into a trimmed list', async () => {
    expect((await loadEnv({ CORS_ORIGINS: '' })).CORS_ORIGINS).toEqual([]);
    expect(
      (await loadEnv({ CORS_ORIGINS: 'https://a.com, https://b.com ,' })).CORS_ORIGINS,
    ).toEqual(['https://a.com', 'https://b.com']);
  });
});

describe('rejected configuration', () => {
  it('refuses a missing or short signing secret', async () => {
    await expect(loadEnv({ JWT_ACCESS_SECRET: undefined })).rejects.toThrow(/JWT_ACCESS_SECRET/);
    await expect(loadEnv({ JWT_ACCESS_SECRET: 'tooshort' })).rejects.toThrow(/JWT_ACCESS_SECRET/);
  });

  it('refuses an out-of-range port', async () => {
    await expect(loadEnv({ PORT: '70000' })).rejects.toThrow(/PORT/);
    await expect(loadEnv({ PORT: 'http' })).rejects.toThrow(/PORT/);
  });

  it('requires a server public key once the mock is off', async () => {
    await expect(loadEnv({ WG_MOCK: 'false' })).rejects.toThrow(/WG_SERVER_PUBLIC_KEY/);
  });

  it('requires a 32-byte encryption key when preshared keys are enabled', async () => {
    await expect(loadEnv({ WG_ENABLE_PRESHARED_KEY: 'true' })).rejects.toThrow(
      /PSK_ENCRYPTION_KEY/,
    );
    await expect(
      loadEnv({ WG_ENABLE_PRESHARED_KEY: 'true', PSK_ENCRYPTION_KEY: 'abc' }),
    ).rejects.toThrow(/PSK_ENCRYPTION_KEY/);
    await expect(
      loadEnv({ WG_ENABLE_PRESHARED_KEY: 'true', PSK_ENCRYPTION_KEY: 'a'.repeat(64) }),
    ).resolves.toMatchObject({ WG_ENABLE_PRESHARED_KEY: true });
  });

  it('rejects a boolean written as anything but true/false', async () => {
    await expect(loadEnv({ WG_SUDO: 'yes' })).rejects.toThrow(/WG_SUDO/);
    await expect(loadEnv({ WG_SUDO: '1' })).rejects.toThrow(/WG_SUDO/);
  });
});

describe('production guard rails', () => {
  const PROD = {
    NODE_ENV: 'production',
    WG_MOCK: 'false',
    WG_SERVER_PUBLIC_KEY: 'c2VydmVycHVibGlja2V5c2VydmVycHVibGlja2V5c2VydmU=',
  };

  it('refuses to start with the mock backend', async () => {
    await expect(loadEnv({ ...PROD, WG_MOCK: 'true' })).rejects.toThrow(/WG_MOCK must be false/);
  });

  it('refuses placeholder secrets copied from .env.example', async () => {
    await expect(
      loadEnv({ ...PROD, JWT_ACCESS_SECRET: 'CHANGE_ME_generate_with_npm_run_keygen' }),
    ).rejects.toThrow(/JWT_ACCESS_SECRET still holds the placeholder/);

    await expect(
      loadEnv({ ...PROD, JWT_REFRESH_PEPPER: 'CHANGE_ME_generate_with_npm_run_keygen' }),
    ).rejects.toThrow(/JWT_REFRESH_PEPPER still holds the placeholder/);
  });

  it('starts, but warns, when no proxy is trusted', async () => {
    const warnings: string[] = [];
    const listener = (warning: Error) => warnings.push(warning.message);
    process.on('warning', listener);

    await expect(loadEnv({ ...PROD, TRUST_PROXY: '0' })).resolves.toBeTruthy();
    await new Promise((resolve) => setImmediate(resolve));
    process.off('warning', listener);

    expect(warnings.join(' ')).toMatch(/TRUST_PROXY=0 in production/);
  });

  it('accepts a fully configured production environment', async () => {
    const env = await loadEnv({ ...PROD, TRUST_PROXY: '1' });

    expect(env.NODE_ENV).toBe('production');
    expect(env.WG_MOCK).toBe(false);
    expect(env.TRUST_PROXY).toBe(1);
  });
});
