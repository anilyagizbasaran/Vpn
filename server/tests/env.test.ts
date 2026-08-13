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
  WG_SKIP_BOOTSTRAP_NODE: 'true',
};

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
  vi.resetModules();
});

let tokenPepper: (source: {
  TOKEN_PEPPER?: string | undefined;
  JWT_REFRESH_PEPPER?: string | undefined;
}) => string;

async function loadEnv(overrides: Record<string, string | undefined>) {
  process.env = {};
  for (const [key, value] of Object.entries({ ...BASE, ...overrides })) {
    if (value !== undefined) process.env[key] = value;
  }
  vi.resetModules();
  const module = await import('../src/config/env.js');
  tokenPepper = module.tokenPepper;
  return module.env;
}

describe('valid configuration', () => {
  it('applies documented defaults', async () => {
    const env = await loadEnv({});

    expect(env.PORT).toBe(3000);
    expect(env.WG_INTERFACE).toBe('wg0');
    expect(env.WG_CLIENT_MTU).toBe(1420);
    // 0 = trust nothing. Assuming a proxy that is not there is the unsafe
    // direction, so it must not be the default.
    expect(env.TRUST_PROXY).toBe(0);
  });

  it('coerces numbers and booleans from strings', async () => {
    const env = await loadEnv({
      PORT: '8080',
      NODE_POLL_SECONDS: '10',
    });

    expect(env.PORT).toBe(8080);
    expect(env.NODE_POLL_SECONDS).toBe(10);
    expect(env.WG_ENABLE_PRESHARED_KEY).toBe(false);
  });

  it('parses CORS_ORIGINS into a trimmed list', async () => {
    expect((await loadEnv({ CORS_ORIGINS: '' })).CORS_ORIGINS).toEqual([]);
    expect(
      (await loadEnv({ CORS_ORIGINS: 'https://a.com, https://b.com ,' })).CORS_ORIGINS,
    ).toEqual(['https://a.com', 'https://b.com']);
  });
});

describe('rejected configuration', () => {
  it('refuses a pepper too short to be worth hashing with', async () => {
    await expect(loadEnv({ TOKEN_PEPPER: 'tooshort' })).rejects.toThrow(/TOKEN_PEPPER/);
  });

  it('refuses an out-of-range port', async () => {
    await expect(loadEnv({ PORT: '70000' })).rejects.toThrow(/PORT/);
    await expect(loadEnv({ PORT: 'http' })).rejects.toThrow(/PORT/);
  });

  it('requires a public key for the bootstrap node it is asked to define', async () => {
    await expect(loadEnv({ WG_SKIP_BOOTSTRAP_NODE: 'false' })).rejects.toThrow(
      /WG_SERVER_PUBLIC_KEY/,
    );
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
    await expect(loadEnv({ WG_ENABLE_PRESHARED_KEY: 'yes' })).rejects.toThrow(/WG_ENABLE_PRESHARED_KEY/);
    await expect(loadEnv({ WG_ENABLE_PRESHARED_KEY: '1' })).rejects.toThrow(/WG_ENABLE_PRESHARED_KEY/);
  });
});

describe('production guard rails', () => {
  const PROD = {
    NODE_ENV: 'production',
    WG_SKIP_BOOTSTRAP_NODE: 'false',
    WG_SERVER_PUBLIC_KEY: 'c2VydmVycHVibGlja2V5c2VydmVycHVibGlja2V5c2VydmU=',
  };

  it('allows production to define no node from the environment', async () => {
    // A fleet is provisioned with `npm run node:add`, so the env-defined
    // bootstrap node is a single-install convenience rather than a
    // requirement — refusing to start without one would be wrong.
    await expect(
      loadEnv({ ...PROD, WG_SKIP_BOOTSTRAP_NODE: 'true', WG_SERVER_PUBLIC_KEY: undefined }),
    ).resolves.toMatchObject({ WG_SKIP_BOOTSTRAP_NODE: true });
  });

  it('refuses a placeholder secret copied from .env.example', async () => {
    await expect(
      loadEnv({ ...PROD, TOKEN_PEPPER: 'CHANGE_ME_generate_with_npm_run_keygen' }),
    ).rejects.toThrow(/TOKEN_PEPPER still holds the placeholder/);
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
    expect(env.WG_SKIP_BOOTSTRAP_NODE).toBe(false);
    expect(env.TRUST_PROXY).toBe(1);
  });
});

describe('the pepper rename', () => {
  it('still accepts the name a deployed .env already uses', async () => {
    // Renaming it outright would rehash every invite, device token and node
    // token at once. Every credential would stop working, and nothing would
    // say why — so the old name keeps working.
    const env = await loadEnv({
      TOKEN_PEPPER: undefined,
      JWT_REFRESH_PEPPER: 'a-sufficiently-long-refresh-pepper',
    });

    expect(tokenPepper(env)).toBe('a-sufficiently-long-refresh-pepper');
  });

  it('prefers the new name when both are set', async () => {
    const env = await loadEnv({
      TOKEN_PEPPER: 'the-new-name-pepper-value',
      JWT_REFRESH_PEPPER: 'a-sufficiently-long-refresh-pepper',
    });

    expect(tokenPepper(env)).toBe('the-new-name-pepper-value');
  });

  it('refuses to start when neither is set', async () => {
    await loadEnv({});

    // A literal rather than a loaded env: dotenv repopulates process.env from
    // the developer's own .env, so "neither is set" is not a state loadEnv can
    // reach on a machine that has one. The function is pure; test it that way.
    expect(() => tokenPepper({})).toThrow(/TOKEN_PEPPER is required/);
  });
});
