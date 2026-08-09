import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Each file gets its own process, so the env module (read once at import)
    // stays isolated between suites.
    pool: 'forks',
  },
});
