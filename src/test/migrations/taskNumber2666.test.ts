/** #2666: real runners, private worker DB / uniquely named disposable DB only. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Client } from 'pg';
import { describe, it, expect } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { maintenanceUrl, withDbName } from '../dbWorkers.js';
import { generateId } from '../../lib/id.js';

const run = promisify(execFile);
const original = resolve('prisma/migrations/20261027100000_agent_task_number/migration.sql');
const psqlUrl = () => { const u = new URL(process.env.DATABASE_URL!); u.search = ''; return u.toString(); };
const postPush = () => run('psql', [psqlUrl(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', resolve('prisma/post-push.sql')], { timeout: 60_000 });

async function fixture() {
  await cleanDb(db);
  const u = await db.user.create({ data: { id: generateId(), roles: ['READER'] } });
  const a = await db.app.create({ data: { id: generateId(), name: 'Legacy2666', urn: `legacy-${generateId()}:app`, ownerUserId: u.id } });
  return { u, a };
}

describe('#2666 task-number SQL', () => {
  it('refuses a direct INSERT of AT0 outside backlog (and keeps its counter unchanged)', async () => {
    const { u, a } = await fixture();
    await expect(db.$executeRaw`INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, task_number, handle, close_session_when_done)
      VALUES (${generateId()}, ${a.id}, 'Bad zero', 'pending', ${u.id}, 0, 'AT0', false)`).rejects.toThrow(/chk_agent_tasks_zero_backlog/);
    expect(await db.agentTaskCounter.count({ where: { appId: a.id } })).toBe(0);
    await expect(db.agentTask.create({ data: { appId: a.id, title: 'No project', ownerUserId: u.id, status: 'backlog', taskNumber: 0n, handle: 'AT0' } })).resolves.toMatchObject({ handle: 'AT0' });
  });

  it('full post-push backfills a populated legacy tree, preserves numbered rows, sets NOT NULL and reruns unchanged', async () => {
    const { u, a } = await fixture();
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      // Simulate the pre-numbering schema after db push: nullable new columns, no numbering triggers.
      // No authorization constraints or gates are changed.
      await c.query(`DROP TRIGGER trg_agent_tasks_assign_number ON agent_tasks;
        DROP TRIGGER trg_agent_tasks_number_immutable ON agent_tasks;
        ALTER TABLE agent_tasks ALTER COLUMN task_number DROP NOT NULL;
        ALTER TABLE agent_tasks ALTER COLUMN handle DROP NOT NULL;`);
      for (const [id, parent] of [['legacy-root', null], ['legacy-child', 'legacy-root'], ['legacy-leaf', 'legacy-child']] as const) {
        await c.query(`INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, parent_task_id, close_session_when_done, created_at)
          VALUES ($1,$2,$1,'pending',$3,$4,false,'2026-01-01')`, [id, a.id, u.id, parent]);
      }
      await c.query(`INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, task_number, handle, close_session_when_done)
        VALUES ('numbered',$1,'Existing project','pending',$2,7,'AT7',false)`, [a.id, u.id]);
      await postPush();
      const snapshot = async () => ({
        tasks: (await c.query('SELECT id,parent_task_id,task_number::text,handle FROM agent_tasks ORDER BY id')).rows,
        counters: (await c.query('SELECT * FROM agent_task_counters ORDER BY id')).rows,
      });
      const once = await snapshot();
      expect(Object.fromEntries(once.tasks.map(t => [t.id, t.handle]))).toMatchObject({ 'legacy-root': 'AT0.1', 'legacy-child': 'AT0.1.1', 'legacy-leaf': 'AT0.1.1.1', numbered: 'AT7' });
      expect(once.tasks.filter(t => t.handle === 'AT0')).toHaveLength(1);
      expect((await c.query(`SELECT column_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='agent_tasks' AND column_name IN ('task_number','handle') ORDER BY column_name`)).rows)
        .toEqual([{ column_name: 'handle', is_nullable: 'NO' }, { column_name: 'task_number', is_nullable: 'NO' }]);
      await postPush();
      expect(await snapshot()).toEqual(once);
    } finally {
      // The failed red run may leave legacy NULLs: remove synthetic tasks with their App, then restore current SQL.
      await db.app.delete({ where: { id: a.id } });
      await postPush();
      await c.end();
    }
  }, 120_000);

  it('real prisma migrate deploy rolls the entire original over-length migration back without an outer BEGIN', async () => {
    const name = `task2666_${generateId().toLowerCase()}`;
    const admin = new Client({ connectionString: maintenanceUrl() });
    const url = withDbName(maintenanceUrl(), name);
    const dir = mkdtempSync(join(tmpdir(), 'task2666-'));
    const schema = join(dir, 'schema.prisma');
    const migrations = join(dir, 'migrations');
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      mkdirSync(join(migrations, '000_baseline'), { recursive: true });
      writeFileSync(schema, 'datasource db {\n provider = "postgresql"\n url = env("DATABASE_URL")\n}\n');
      writeFileSync(join(migrations, 'migration_lock.toml'), 'provider = "postgresql"\n');
      const baseline = `CREATE TABLE users (id text PRIMARY KEY);
        CREATE TABLE apps (id text PRIMARY KEY, owner_user_id text, created_by text);
        CREATE TABLE agent_tasks (id text PRIMARY KEY, app_id text NOT NULL, title text NOT NULL, status text NOT NULL,
          owner_user_id text, owner_worker_id text, parent_task_id text, close_session_when_done boolean, created_at timestamp);
        INSERT INTO users VALUES ('owner'); INSERT INTO apps VALUES ('app','owner',NULL);\n` +
        Array.from({ length: 16 }, (_, i) => `INSERT INTO agent_tasks VALUES ('deep${i}','app','legacy','pending','owner',NULL,${i ? `'deep${i - 1}'` : 'NULL'},false,'2026-01-01');`).join('\n');
      writeFileSync(join(migrations, '000_baseline/migration.sql'), baseline);
      const deploy = () => run(resolve('node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', schema], { cwd: dir, env: { ...process.env, DATABASE_URL: url }, timeout: 60_000 });
      await deploy();
      mkdirSync(join(migrations, '20261027100000_agent_task_number'));
      writeFileSync(join(migrations, '20261027100000_agent_task_number/migration.sql'), readFileSync(original));
      await expect(deploy()).rejects.toThrow(/would get handle.*16 levels/);
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        const rows = (await c.query('SELECT * FROM agent_tasks ORDER BY id')).rows;
        expect(rows).toHaveLength(16);
        expect(rows.find(t => t.id === 'deep0')?.parent_task_id).toBeNull();
        expect(rows.some(t => t.title === 'No project')).toBe(false);
        expect((await c.query(`SELECT to_regclass('agent_task_counters') AS counters`)).rows[0].counters).toBeNull();
        expect((await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='agent_tasks' AND column_name IN ('handle','task_number')`)).rows).toEqual([]);
      } finally { await c.end(); }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
