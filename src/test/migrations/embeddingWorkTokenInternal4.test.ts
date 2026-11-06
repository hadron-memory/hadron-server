/** Actual Prisma deploy + post-push replay, only in this run's owned worker DB. */
import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../helpers.js';
import { PARALLEL_DBS, workerDbName } from '../dbWorkers.js';
import { generateId } from '../../lib/id.js';
import { assertEmbeddingObligationsReconciled } from '../../jobs/embedNodes.js';

const run = promisify(execFile);
const migration = '20261021190000_embedding_work_tokens';

it.skipIf(!PARALLEL_DBS)('internal#4 deploy, post-push and replay preserve legacy state and durable UUIDs', async () => {
  const url = new URL(process.env.DATABASE_URL!);
  const expected = workerDbName(process.env.VITEST_POOL_ID ?? '1');
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(url.hostname);
  expect(url.pathname).toBe(`/${expected}`);
  const actual = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  expect(actual[0].name).toBe(expected);
  const history = await db.$queryRaw<{ name: string | null }[]>`SELECT to_regclass('public._prisma_migrations')::text AS name`;
  expect(history[0].name).toBeNull(); // never replace pre-existing migration custody

  await cleanDb(db);
  const { graph } = await createDbOrgAndGraph(db, { orgName: 'migration-obligation', graphName: 'migration/obligation' });
  await db.memory.update({ where: { id: graph.id }, data: { vectorIndexEnabled: true } });
  const old = new Date('2026-01-01T00:00:00Z');
  const future = new Date('2099-01-01T00:00:00Z');
  const ids = ['due', 'backoff', 'idle', 'terminal'].map(() => generateId());
  await db.node.createMany({ data: ids.map((id, i) => ({
    id, memoryId: graph.id, loc: `fixture${i}`, name: 'synthetic',
    content: 'synthetic unchanged body', abstract: 'synthetic unchanged summary',
    embeddingPendingAt: i === 0 ? old : i === 1 ? future : null,
    embeddingFailedAt: i === 1 || i === 3 ? old : null,
    embeddingAttempts: i === 1 ? 9 : i === 3 ? 1 : 0,
    embeddingError: i === 1 ? 'synthetic retry' : i === 3 ? 'synthetic terminal' : null,
  })) });
  const before = await db.node.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
  let baselineCreated = false;
  try {
    // This isolated clone otherwise matches main. Remove only our own additive field
    // to reconstruct the predecessor schema; no dev/shared/template database is touched.
    await db.$executeRawUnsafe('ALTER TABLE nodes DROP COLUMN embedding_work_token');
    await db.$executeRawUnsafe(`CREATE TABLE _prisma_migrations (
      id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
      migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
      started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)`);
    baselineCreated = true;
    const migrations = resolve('prisma/migrations');
    for (const entry of readdirSync(migrations, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === migration) continue;
      const checksum = createHash('sha256').update(readFileSync(resolve(migrations, entry.name, 'migration.sql'))).digest('hex');
      await db.$executeRaw`INSERT INTO _prisma_migrations
        (id, checksum, finished_at, migration_name, applied_steps_count)
        VALUES (${randomUUID()}, ${checksum}, now(), ${entry.name}, 1)`;
    }
    const env = { ...process.env, DATABASE_URL: url.toString() };
    const first = await run('pnpm', ['-s', 'prisma', 'migrate', 'deploy'], { env, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
    expect(first.stdout).toContain(migration);
    const psqlEnv = {
      ...env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: expected,
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    };
    await run('psql', ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-f', resolve('prisma/post-push.sql')], { env: psqlEnv, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });

    const after = await db.node.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    for (let i = 0; i < after.length; i++) {
      const { embeddingWorkToken: token, ...rest } = after[i];
      const { embeddingWorkToken: _priorToken, ...prior } = before[i];
      expect(rest).toEqual(prior);
      if (rest.id === ids[0] || rest.id === ids[1]) expect(token).toBeTypeOf('string');
      else expect(token).toBeNull();
    }
    expect(after.find(n => n.id === ids[0])!.embeddingWorkToken)
      .not.toBe(after.find(n => n.id === ids[1])!.embeddingWorkToken);
    await expect(assertEmbeddingObligationsReconciled(db)).resolves.toBeUndefined();
    const second = await run('pnpm', ['-s', 'prisma', 'migrate', 'deploy'], { env, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
    expect(second.stdout).toContain('No pending migrations');
    await run('psql', ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-f', resolve('prisma/post-push.sql')], { env: psqlEnv, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
    expect(await db.node.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } })).toEqual(after);
    const applied = await db.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM _prisma_migrations WHERE migration_name = ${migration} AND finished_at IS NOT NULL`;
    expect(Number(applied[0].count)).toBe(1);

    // Abruptly exit a child only after its synthetic endpoint is reached. No
    // shutdown callback clears the durable obligation. A separate fresh process
    // then re-enters normal admission and recovers the same ordinary work.
    const child = (crash: boolean) => `
      import { PrismaClient } from ${JSON.stringify(resolve('src/generated/prisma/index.js'))};
      import { embedNode, embeddingDispatcher, assertEmbeddingObligationsReconciled }
        from ${JSON.stringify(resolve('src/jobs/embedNodes.ts'))};
      const db = new PrismaClient();
      void (async () => {
        try {
          await assertEmbeddingObligationsReconciled(db);
          const client = { provider: 'synthetic', model: 'restart-control', dim: 768,
            embed: async (texts) => {
              ${crash ? "console.log('SYNTHETIC_ENDPOINT_REACHED'); process.exit(0);" :
                "return texts.map(() => Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0));"}
            } };
          let outcome;
          const dispatcher = embeddingDispatcher(db);
          if (!dispatcher.tryRun(${JSON.stringify(ids[0])}, async () => {
            outcome = await embedNode(db, ${JSON.stringify(ids[0])}, undefined, client);
          })) throw new Error('synthetic admission refused');
          if (!(await dispatcher.stop(10000))) throw new Error('synthetic grace elapsed');
          console.log(JSON.stringify({ outcome }));
        } finally { await db.$disconnect(); }
      })().catch(() => { console.error('synthetic restart control failed'); process.exitCode = 1; });`;
    const crashed = await run('pnpm', ['-s', 'tsx', '-e', child(true)], { env, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
    expect(crashed.stdout).toContain('SYNTHETIC_ENDPOINT_REACHED');
    expect(await db.node.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } })).toEqual(after);
    const restarted = await run('pnpm', ['-s', 'tsx', '-e', child(false)], { env, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
    expect(restarted.stdout).toContain('"outcome":"embedded"');
    const recovered = await db.node.findUniqueOrThrow({ where: { id: ids[0] } });
    expect(recovered.embeddingPendingAt).toBeNull();
    expect(recovered.embeddingWorkToken).toBeNull();
    // Backoff and terminal states do not get re-driven by the restart control.
    for (const id of ids.slice(1)) {
      expect(await db.node.findUniqueOrThrow({ where: { id } })).toEqual(after.find(n => n.id === id));
    }
  } finally {
    // Restore this worker's own schema even if the engine probe fails. Never drop
    // obligations or another run's resources as cleanup; this DB is framework-owned.
    await db.$executeRawUnsafe('ALTER TABLE nodes ADD COLUMN IF NOT EXISTS embedding_work_token uuid');
    if (baselineCreated) await db.$executeRawUnsafe('DROP TABLE _prisma_migrations');
  }
}, 120_000);
