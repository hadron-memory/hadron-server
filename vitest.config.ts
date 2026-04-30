import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Each test file runs in its own subprocess so the PrismaClient singleton
    // (created at module load time) is fresh per file and sees the env vars below.
    // fileParallelism: false prevents concurrent DB access from parallel test files.
    exclude: ['dist/**', 'node_modules/**'],
    pool: 'forks',
    fileParallelism: false,
    // CHECK constraints declared in migrations don't survive `prisma db push`
    // (which is what tests use to set up a fresh schema). Apply them once
    // here, before any test file runs. Per spec 005-agent-subscription FR-014.
    globalSetup: ['./src/test/globalSetup.ts'],
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgresql://holger@localhost:5432/hadron_test',
      DB_PROVIDER: 'postgresql',
      JWT_SECRET: 'test-secret-at-least-32-characters-!!',
      // 64 hex chars = 32 bytes = AES-256 key. Fixed for test reproducibility.
      HADRON_ENCRYPTION_KEY: '0'.repeat(64),
      GRAPHS_PATH: '/tmp/hadron-test-graphs',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/index.ts'],
    },
  },
});
