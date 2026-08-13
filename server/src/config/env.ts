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

  /**
   * HMAC key for every credential the server stores hashed: invite codes,
   * device tokens, node agent tokens. Losing it invalidates all of them at
   * once, which is a mass logout rather than a breach.
   *
   * `JWT_REFRESH_PEPPER` is the name it had when there were accounts. Still
   * accepted, because renaming it in a deployed .env would silently rehash
   * every credential and cut every device off with no message that says why.
   */
  TOKEN_PEPPER: z.string().min(16).optional(),
  JWT_REFRESH_PEPPER: z.string().min(16).optional(),
  WG_ENABLE_PRESHARED_KEY: boolean(false),
  PSK_ENCRYPTION_KEY: z.string().default(''),

  /**
   * How often node agents sync, and so the worst-case delay before a revoked
   * device stops working anywhere. The control plane never pushes.
   */
  NODE_POLL_SECONDS: z.coerce.number().int().min(2).max(300).default(10),

  // The bootstrap node. Defining a server here is a convenience for a
  // single-node install; more nodes are added with `npm run node:add`.
  WG_REGION: z.string().min(1).default('de-fra'),
  WG_DISPLAY_NAME: z.string().default(''),
  WG_INTERFACE: z.string().min(1).default('wg0'),
  WG_SERVER_PUBLIC_KEY: z.string().default(''),
  WG_ENDPOINT: z.string().min(3).default('vpn.example.com:51820'),
  WG_LISTEN_PORT: z.coerce.number().int().min(1).max(65535).default(51820),
  WG_ADDRESS_POOL: z.string().min(9).default('10.8.0.0/24'),
  WG_SERVER_ADDRESS: z.string().min(7).default('10.8.0.1'),
  WG_DNS: z.string().default('1.1.1.1, 1.0.0.1'),
  /** What the client routes into the tunnel. `0.0.0.0/0,::/0` = full tunnel. */
  WG_CLIENT_ALLOWED_IPS: z.string().min(1).default('0.0.0.0/0,::/0'),
  WG_PERSISTENT_KEEPALIVE: z.coerce.number().int().min(0).max(3600).default(25),
  // Matches the server interface MTU. Without it the client picks its own,
  // which on some mobile networks silently blackholes large packets: ping
  // works, HTTPS stalls. 0 omits the line.
  WG_CLIENT_MTU: z.coerce.number().int().min(0).max(1500).default(1420),
  /** Skip defining a bootstrap node; every node is added with the CLI. */
  WG_SKIP_BOOTSTRAP_NODE: boolean(false),
});

export type Env = z.infer<typeof envSchema>;

/**
 * The HMAC key, under whichever name the deployment happens to use.
 *
 * Reading it through one function rather than at every call site is what keeps
 * the two names from drifting apart — a service that read only the new one
 * would hash differently from a service that read only the old one, and the
 * symptom would be "some credentials stopped working".
 */
export function tokenPepper(source: Pick<Env, 'TOKEN_PEPPER' | 'JWT_REFRESH_PEPPER'>): string {
  const pepper = source.TOKEN_PEPPER ?? source.JWT_REFRESH_PEPPER;
  if (!pepper) {
    throw new Error(
      'Invalid environment configuration:\n' +
        '  - TOKEN_PEPPER is required (generate one with `npm run keygen`)',
    );
  }
  return pepper;
}

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

  if (!env.WG_SKIP_BOOTSTRAP_NODE && env.WG_SERVER_PUBLIC_KEY.trim() === '') {
    problems.push(
      'WG_SERVER_PUBLIC_KEY is required to define the bootstrap node ' +
        '(set WG_SKIP_BOOTSTRAP_NODE=true to add every node with the CLI instead)',
    );
  }
  if (env.WG_ENABLE_PRESHARED_KEY && !/^[0-9a-fA-F]{64}$/.test(env.PSK_ENCRYPTION_KEY)) {
    problems.push(
      'PSK_ENCRYPTION_KEY must be 64 hex chars (32 bytes) when WG_ENABLE_PRESHARED_KEY=true',
    );
  }
  if (env.NODE_ENV === 'production') {
    if (tokenPepper(env).includes('CHANGE_ME')) {
      problems.push('TOKEN_PEPPER still holds the placeholder value');
    }
    if (env.TRUST_PROXY === 0) {
      // Not fatal: the API can legitimately be exposed directly. But behind
      // Caddy this collapses every client into one rate-limit bucket.
      process.emitWarning(
        'TRUST_PROXY=0 in production. Set it to the number of reverse proxies ' +
          '(Caddy/nginx = 1), or per-IP rate limiting will treat all traffic as one client.',
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }

  return env;
}

export const env: Env = parseEnv(process.env);

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
