/**
 * Runs before any source module is imported, so `src/config/env.ts` sees a
 * complete configuration. Rate limiting is skipped under NODE_ENV=test.
 */
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_PATH'] = ':memory:';
process.env['LOG_LEVEL'] = 'error';

process.env['JWT_ACCESS_SECRET'] = 'test-access-secret-not-used-in-production';
process.env['JWT_REFRESH_PEPPER'] = 'test-refresh-pepper-not-used-in-production';
process.env['JWT_ACCESS_TTL'] = '15m';

process.env['MAX_DEVICES_PER_USER'] = '2';
process.env['WG_ENABLE_PRESHARED_KEY'] = 'true';
process.env['PSK_ENCRYPTION_KEY'] = 'a'.repeat(64);
process.env['NODE_POLL_SECONDS'] = '10';

// Tests define their own nodes; the bootstrap-from-env path is exercised
// separately so it cannot silently create a server the assertions did not
// expect.
process.env['WG_SKIP_BOOTSTRAP_NODE'] = 'true';
process.env['WG_INTERFACE'] = 'wgtest0';
process.env['WG_ENDPOINT'] = 'vpn.test:51820';
process.env['WG_ADDRESS_POOL'] = '10.8.0.0/24';
process.env['WG_SERVER_ADDRESS'] = '10.8.0.1';
process.env['WG_REGION'] = 'test-region';
process.env['WG_DNS'] = '1.1.1.1, 1.0.0.1';
process.env['WG_CLIENT_ALLOWED_IPS'] = '0.0.0.0/0,::/0';
