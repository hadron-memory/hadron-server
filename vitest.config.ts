import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { PARALLEL_DBS, testMaxWorkers } from './src/test/dbWorkers.js';

// Production runs under plain Node ESM, where `import 'graphql'` resolves to the package's CommonJS entry (it has no
// `exports` map, so Node ignores its `module` field). Vite prefers `module` (index.mjs): a second copy of graphql, whose
// classes fail `instanceof` against the schema Apollo builds and against `graphql-query-complexity`. Pin tests to the
// entry production uses so a graphql type means the same thing in both.
const GRAPHQL_ENTRY = fileURLToPath(new URL('./node_modules/graphql/index.js', import.meta.url));

export default defineConfig({
  resolve: { alias: [{ find: /^graphql$/, replacement: GRAPHQL_ENTRY }] },
  test: {
    globals: true,
    // Each test file runs in its own subprocess so the PrismaClient singleton
    // (created at module load time) is fresh per file and sees the env vars below.
    // .claude/worktrees holds sibling agent worktrees — full repo copies whose
    // test files would otherwise be collected into THIS run (and race on the
    // shared hadron_test DB; see findings:parallel-vitest-shared-test-db).
    // Disposable-stack and passkey-spike regressions use node:test, not Vitest.
    exclude: ['dist/**', '**/node_modules/**', '.claude/**', 'scripts/e2e/**', 'scripts/passkey-spike/**'],
    pool: 'forks',
    // Parallel by default: perWorkerDb.ts points each worker at its own cloned
    // DB (hadron_test_<VITEST_POOL_ID>), so files no longer race and can run
    // concurrently at vitest's default fork concurrency (~cores-2).
    // HADRON_TEST_PARALLEL=0 restores the old single-DB serial behavior.
    fileParallelism: PARALLEL_DBS,
    // HADRON_TEST_MAX_WORKERS caps the fork count on a shared host; unset keeps vitest's default.
    maxWorkers: testMaxWorkers(process.env.HADRON_TEST_MAX_WORKERS),
    setupFiles: ['./src/test/perWorkerDb.ts', './src/test/graphRootSetup.ts', './src/test/drainUsage.ts'],
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
      // GRAPHS_PATH is NOT pinned here: it is per run (#1951), set by
      // src/test/graphRootSetup.ts from the run id globalSetup stamps.
      // Prisma auto-loads .env into every worker, so a dev machine's real
      // endpoints leak into tests that CI (no .env) never sees — e.g. the
      // llama.cpp EMBEDDING_API_URL caused knowledge-class fixtures (vector-
      // indexed by default) to fire real prompt-drains whose async
      // embeddingError landed as [embed-failed] noise in later assertions.
      // Pin the outbound-service vars OFF ('' is falsy for every configured-
      // predicate); tests that need one set it explicitly.
      // #881 — the portal origin is a FORMATTING input now (node reads carry a
      // portal URL), so a dev machine's .env would make projections differ from
      // CI's. Pinned off; tests that assert the link set it explicitly.
      FRONTEND_URL: '',
      // #2990 — the graph-view queries are OFF by default in production; the suite runs them ON (flag lifted) so the
      // existing graph tests keep reading rows. The #2990 pins set the variable explicitly, so the default is still pinned.
      GRAPH_VIEW_DISABLED: 'false',
      EMBEDDING_API_URL: '',
      EMBEDDING_SAGEMAKER_ENDPOINT_NAME: '',
      NATS_URL: '',
      PDF_SERVICE_URL: '',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/index.ts'],
    },
  },
});
