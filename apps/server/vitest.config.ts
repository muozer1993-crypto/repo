import { defineConfig } from 'vitest/config';

/**
 * These are integration tests: every one of them boots a Fastify app on an
 * in-memory SQLite database and registers users through the real `/auth/register`,
 * which runs scrypt (N=16384) once per user. That is the point — the tests exercise
 * the production password path — but on a small CI box, with several test files
 * running in parallel, a handful of scrypt derivations is easily more than vitest's
 * 5-second default allows. The timeouts below are generous on purpose; nothing here
 * waits on wall-clock time, so a slow machine is the only reason to need them.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
