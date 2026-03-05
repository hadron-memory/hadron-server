import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Each test file runs in its own subprocess so the PrismaClient singleton
    // (created at module load time) is fresh per file and sees the env vars below.
    // fileParallelism: false prevents concurrent DB access from parallel test files.
    pool: 'forks',
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgresql://holger@localhost:5432/hadron_test',
      DB_PROVIDER: 'postgresql',
      JWT_SECRET: 'test-secret-at-least-32-characters-!!',
      SOURCES_PATH: '/tmp/hadron-test-sources',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/index.ts'],
    },
  },
});
