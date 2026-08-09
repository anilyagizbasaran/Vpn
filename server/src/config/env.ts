import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Tests get their configuration from the harness. Reading a developer's local
// .env here would make results depend on an untracked file.
// `quiet` keeps dotenv's banner out of stdout, which carries structured logs.
if (process.env['NODE_ENV'] !== 'test') loadDotenv({ quiet: true });

/** `"true"`/`"false"` strings -> boolean, with a default. */
const boolean = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true');

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Defaults to 0 (no proxy) on purpose. Trusting a hop that is not there lets
  // any client forge X-Forwarded-For and pick its own rate-limit bucket.
  // Getting it wrong the other way (0 behind Caddy) is loud and harmless:
  // every request buckets as 127.0.0.1 and hits the limit immediately.
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  CORS_ORIGINS: csv,

  DATABASE_PATH: z.string().min(1).default('./data/vpn.db'),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().min(1).default('15m'),
  JWT_REFRESH_PEPPER: z.string().min(16),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  JWT_ISSUER: z.string().min(1).default('vpn-control-plane'),

  MAX_PEERS_PER_USER: z.coerce.number().int().min(1).max(100).default(5),
  WG_ENABLE_PRESHARED_KEY: boolean(false),
  PSK_ENCRYPTION_KEY: z.string().default(''),

  WG_INTERFACE: z.string().min(1).default('wg0'),
  WG_SERVER_PUBLIC_KEY: z.string().default(''),
  WG_ENDPOINT: z.string().min(3).default('vpn.example.com:51820'),
  WG_LISTEN_PORT: z.coerce.number().int().min(1).max(65535).default(51820),
  WG_ADDRESS_POOL: z.string().min(9).default('10.8.0.0/24'),
  WG_SERVER_ADDRESS: z.string().min(7).default('10.8.0.1'),
  WG_DNS: z.string().default('1.1.1.1, 1.0.0.1'),
  WG_REGION: z.string().min(1).default('de-fra'),
  WG_CLIENT_ALLOWED_IPS: z.string().min(1).default('0.0.0.0/0,::/0'),
  WG_PERSISTENT_KEEPALIVE: z.coerce.number().int().min(0).max(3600).default(25),
  // Matches the server interface MTU. Without it the client picks its own,
  // which on some mobile networks silently blackholes large packets: ping
  // works, HTTPS stalls. 0 omits the line.
  WG_CLIENT_MTU: z.coerce.number().int().min(0).max(1500).default(1420),
  /** Revoked refresh tokens are kept this long for reuse-detection forensics. */
  REFRESH_REVOKED_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),

  WG_SUDO: boolean(false),
  WG_MOCK: boolean(false),
  WG_SYNC_ON_BOOT: boolean(true),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const env = parsed.data;
  const problems: string[] = [];

  // A real interface needs a real server key; the mock backend invents one.
  if (!env.WG_MOCK && env.WG_SERVER_PUBLIC_KEY.trim() === '') {
    problems.push('WG_SERVER_PUBLIC_KEY is required when WG_MOCK=false');
  }
  if (env.WG_ENABLE_PRESHARED_KEY && !/^[0-9a-fA-F]{64}$/.test(env.PSK_ENCRYPTION_KEY)) {
    problems.push(
      'PSK_ENCRYPTION_KEY must be 64 hex chars (32 bytes) when WG_ENABLE_PRESHARED_KEY=true',
    );
  }
  if (env.NODE_ENV === 'production') {
    if (env.JWT_ACCESS_SECRET.includes('CHANGE_ME')) {
      problems.push('JWT_ACCESS_SECRET still holds the placeholder value');
    }
    if (env.JWT_REFRESH_PEPPER.includes('CHANGE_ME')) {
      problems.push('JWT_REFRESH_PEPPER still holds the placeholder value');
    }
    if (env.WG_MOCK) {
      problems.push('WG_MOCK must be false in production');
    }
    if (env.TRUST_PROXY === 0) {
      // Not fatal: the API can legitimately be exposed directly. But behind
      // Caddy/nginx this collapses every client into one rate-limit bucket.
      process.emitWarning(
        'TRUST_PROXY=0 in production. Set it to the number of reverse proxies ' +
          '(Caddy/nginx = 1), or per-IP rate limiting will treat all traffic as one client.',
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  return env;
}

export const env: Env = parseEnv(process.env);

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
