/**
 * #3689 (Grants S3, cor:agt:010:01 rev 45): every run names an existing Agent.
 *
 * What this file pins:
 *   - The database refuses an `app_runs` row with no Agent (NOT NULL, 23502) or with an Agent that does not exist (the
 *     foreign key, 23503). An Agent hard delete removes its runs (ON DELETE CASCADE, gate R4), served records included.
 *   - The data transition, executed from the real files: the migration carries the pre-push block byte for byte; a run
 *     whose App has exactly one live ROW-installed Agent is filled; every other agentless run (two installs, none, only a
 *     soft-deleted one, App gone) and every run naming a missing Agent is deleted with its children; a valid run and its
 *     served record are untouched; a second run changes nothing; an empty schema is a no-op; a child that refuses the
 *     delete stops the block with SQLSTATE HDPRF and changes nothing.
 *   - Gate R2: a webhook or schedule whose trigger names no Agent gets the typed boot-prompt refusal (webhook: 409
 *     `{error: code}`, schedule: a logged denial), not a 500 / "mint failed", and writes no run.
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import express from 'express';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { serveAgentBootPrompt } from '../servedBootPrompt.js';

vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

import { mintAppRun } from '../../jobs/appRuns.js';
import { schedulerTick } from '../../jobs/scheduler.js';
import { generateWebhookSecret, mintWebhookPlatformToken, mountWebhookRoutes } from '../../api/webhooks.js';

const read = (path: string) => readFileSync(new URL(`../../../prisma/${path}`, import.meta.url), 'utf8');
const BLOCK_FILE = 'app-run-agent-pre-push.sql';
const MIGRATION_FILE = 'migrations/20261111020000_app_run_agent_required/migration.sql';
const blockOf = (sql: string) => sql.match(/^DO \$\$[\s\S]*?^END \$\$;/m)?.[0];

/** Run SQL on a dedicated connection (the per-worker DB), so a statement's SQLSTATE is visible as `code`. */
async function withPg<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const sqlError = (c: pg.Client, sql: string, params: unknown[] = []) =>
  c.query(sql, params).then(() => null, (err: { code?: string; message: string }) => err);

/** Put app_runs back in its pre-#3689 shape (nullable, no FK, no index), as a database the migration finds. */
const RELAX = `
  ALTER TABLE app_runs DROP CONSTRAINT IF EXISTS app_runs_agent_id_fkey;
  DROP INDEX IF EXISTS app_runs_agent_id_idx;
  ALTER TABLE app_runs ALTER COLUMN agent_id DROP NOT NULL;`;
const RESTORE = `
  ALTER TABLE app_runs ALTER COLUMN agent_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS app_runs_agent_id_idx ON app_runs (agent_id);
  ALTER TABLE app_runs DROP CONSTRAINT IF EXISTS app_runs_agent_id_fkey;
  ALTER TABLE app_runs ADD CONSTRAINT app_runs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE ON UPDATE CASCADE;`;

let orgId: string;

async function app(name: string, agents: Array<{ live: boolean }> = []) {
  const a = await db.app.create({ data: { id: generateId(), organizationId: orgId, name, urn: `ra-org:${name}` } });
  const ids: string[] = [];
  for (const [i, spec] of agents.entries()) {
    const agent = await db.agent.create({ data: {
      id: generateId(), organizationId: orgId, urn: `ra-org:${name}-agent-${i}`, name: `${name}-agent-${i}`,
      ...(spec.live ? {} : { deletedAt: new Date() }),
    } });
    await db.appAgent.create({ data: { appId: a.id, agentId: agent.id } });
    ids.push(agent.id);
  }
  return { id: a.id, agentIds: ids };
}

async function insertRun(c: pg.Client, appId: string, agentId: string | null): Promise<string> {
  const id = generateId();
  await c.query(
    `INSERT INTO app_runs (id, organization_id, app_id, agent_id, trigger_kind, entry_node_urn) VALUES ($1, $2, $3, $4, 'MANUAL', 'ra-org:mem:entry')`,
    [id, orgId, appId, agentId],
  );
  return id;
}

/** Mint a valid run through the real path (served record included), off a real schedule naming `agentId`. */
async function mintValid(appId: string, agentId: string) {
  const schedule = await db.agentSchedule.create({ data: { id: generateId(), organizationId: orgId, appId, agentId, name: `s-${generateId().slice(-6)}`, cron: '0 0 1 1 *', entryNodeUrn: 'ra-org:mem:entry' } });
  return mintAppRun(db, { organizationId: orgId, appId, agentId, triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: 'ra-org:mem:entry', publish: false });
}

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'ra-org', urn: 'ra-org' } })).id;
});

describe('#3689 the database requires a real Agent on every run', () => {
  it('refuses a run with no Agent (23502) and one naming a missing Agent (23503); accepts a real one', async () => {
    const one = await app('one', [{ live: true }]);
    await withPg(async (c) => {
      expect((await sqlError(c, `INSERT INTO app_runs (id, organization_id, app_id, agent_id, trigger_kind, entry_node_urn) VALUES ($1, $2, $3, NULL, 'MANUAL', 'x')`, [generateId(), orgId, one.id]))?.code).toBe('23502');
      expect((await sqlError(c, `INSERT INTO app_runs (id, organization_id, app_id, agent_id, trigger_kind, entry_node_urn) VALUES ($1, $2, $3, 'no-such-agent', 'MANUAL', 'x')`, [generateId(), orgId, one.id]))?.code).toBe('23503');
      await insertRun(c, one.id, one.agentIds[0]);
    });
    expect(await db.appRun.count()).toBe(1);
  });

  it('an Agent hard delete removes its runs and their served records (ON DELETE CASCADE)', async () => {
    const one = await app('cascade', [{ live: true }]);
    await serveAgentBootPrompt(db, one.agentIds[0], 'Cascade prompt.');
    const run = await mintValid(one.id, one.agentIds[0]);
    expect(await db.servedPrompt.count({ where: { runId: run.id } })).toBe(1);
    await withPg(c => c.query('DELETE FROM agents WHERE id = $1', [one.agentIds[0]]));
    expect(await db.appRun.count({ where: { id: run.id } })).toBe(0);
    expect(await db.servedPrompt.count({ where: { runId: run.id } })).toBe(0);
  });
});

describe('#3689 the data transition (migration + pre-push)', () => {
  it('the migration carries the pre-push block byte for byte, and pre-push.sql includes it', () => {
    const block = blockOf(read(BLOCK_FILE));
    expect(block).toBeTruthy();
    expect(blockOf(read(MIGRATION_FILE))).toBe(block);
    expect(read('pre-push.sql')).toMatch(new RegExp(`^\\\\ir ${BLOCK_FILE.replace('.', '\\.')}$`, 'm'));
  });

  it('fills a single-install run, deletes every other agentless or dangling run with its children, is idempotent, then the migration constrains', async () => {
    const single = await app('single', [{ live: true }]);
    const two = await app('two', [{ live: true }, { live: true }]);
    const none = await app('none');
    const soft = await app('soft', [{ live: false }]);
    const singleWithDeadSibling = await app('sibling', [{ live: true }, { live: false }]);
    // (f) a valid run with its served record, minted through the real path before the schema is relaxed.
    await serveAgentBootPrompt(db, single.agentIds[0], 'Valid prompt.');
    const valid = await mintValid(single.id, single.agentIds[0]);
    const servedBefore = await db.servedPrompt.findMany({ where: { runId: valid.id } });
    expect(servedBefore).toHaveLength(1);

    const ids = await withPg(async (c) => {
      await c.query(RELAX);
      const r = {
        filled: await insertRun(c, single.id, null),
        filledPastDeadSibling: await insertRun(c, singleWithDeadSibling.id, null),
        twoInstalls: await insertRun(c, two.id, null),
        noInstall: await insertRun(c, none.id, null),
        softOnly: await insertRun(c, soft.id, null),
        appGone: await insertRun(c, 'no-such-app', null),
        dangling: await insertRun(c, single.id, 'no-such-agent'),
      };
      // Children of a deleted run go with it (each is ON DELETE CASCADE from app_runs).
      await c.query(`INSERT INTO manual_automation_pins (run_id, pin) VALUES ($1, '{}'::jsonb)`, [r.twoInstalls]);
      await c.query(`INSERT INTO webfetch_poll_bindings (job_id, source_run_id, organization_id, app_id, entry_node_urn, url) VALUES ($1, $2, $3, $4, 'x', 'https://example.test')`, [generateId(), r.twoInstalls, orgId, two.id]);
      await c.query(`INSERT INTO webfetch_event_receipts (id, job_id, kind, routed_run_id) VALUES ($1, $2, 'change', $3)`, [generateId(), generateId(), r.twoInstalls]);
      return r;
    });

    const block = blockOf(read(BLOCK_FILE))!;
    const snapshot = async () => (await db.appRun.findMany({ select: { id: true, agentId: true }, orderBy: { id: 'asc' } }));
    await withPg(c => c.query(block));
    const after = await snapshot();
    expect(after).toEqual([
      { id: ids.filled, agentId: single.agentIds[0] },
      { id: ids.filledPastDeadSibling, agentId: singleWithDeadSibling.agentIds[0] },
      { id: valid.id, agentId: single.agentIds[0] },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)));
    expect(await db.manualAutomationPin.count()).toBe(0);
    expect(await db.webFetchPollBinding.count()).toBe(0);
    expect(await db.webFetchEventReceipt.count()).toBe(0);
    expect(await db.servedPrompt.findMany({ where: { runId: valid.id } })).toEqual(servedBefore);

    // Idempotent: a second run (column still nullable, so the block is not skipped) changes nothing.
    await withPg(c => c.query(block));
    expect(await snapshot()).toEqual(after);

    // The actual migration file then applies cleanly and leaves the constraint in Prisma's shape.
    await withPg(c => c.query(read(MIGRATION_FILE)));
    expect(await snapshot()).toEqual(after);
    const fk = await withPg(c => c.query(`SELECT confdeltype, confupdtype FROM pg_constraint WHERE conname = 'app_runs_agent_id_fkey'`));
    expect(fk.rows).toEqual([{ confdeltype: 'c', confupdtype: 'c' }]);
    const nullable = await withPg(c => c.query(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'app_runs' AND column_name = 'agent_id'`));
    expect(nullable.rows).toEqual([{ is_nullable: 'NO' }]);
  });

  it('is a no-op on a schema with no app_runs table (a fresh database)', async () => {
    const schema = `ra_empty_${generateId().replaceAll('-', '').toLowerCase()}`;
    await withPg(async (c) => {
      await c.query(`CREATE SCHEMA "${schema}"`);
      try {
        await c.query(`SET search_path TO "${schema}"`);
        expect(await sqlError(c, blockOf(read(BLOCK_FILE))!)).toBeNull();
      } finally {
        await c.query('RESET search_path');
        await c.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    });
  });

  it('a child that refuses the delete stops the block with SQLSTATE HDPRF and fills nothing', async () => {
    const single = await app('refuse-single', [{ live: true }]);
    const two = await app('refuse-two', [{ live: true }, { live: true }]);
    await withPg(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(RELAX);
        const filled = await insertRun(c, single.id, null);
        const doomed = await insertRun(c, two.id, null);
        await c.query(`INSERT INTO manual_automation_pins (run_id, pin) VALUES ($1, '{}'::jsonb)`, [doomed]);
        await c.query(`CREATE FUNCTION pg_temp.ra_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only'; END $$`);
        await c.query(`CREATE TRIGGER ra_refuse BEFORE DELETE ON manual_automation_pins FOR EACH ROW EXECUTE FUNCTION pg_temp.ra_refuse()`);
        await c.query('SAVEPOINT before_block');
        const err = await sqlError(c, blockOf(read(BLOCK_FILE))!);
        expect(err?.code).toBe('HDPRF');
        expect(err?.message).toMatch(/^app_runs agent backfill: a child table refused deleting run\(s\): append-only/);
        await c.query('ROLLBACK TO SAVEPOINT before_block');
        const rows = await c.query('SELECT id, agent_id FROM app_runs WHERE id = ANY($1) ORDER BY id', [[filled, doomed]]);
        expect(rows.rows.map(r => r.agent_id)).toEqual([null, null]);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });

  it('after an HDPRF refusal, the server reading the old schema can still read the retained agentless runs', async () => {
    // Boot (#3770) marks a refused migration rolled back and serves the schema that exists, under THIS build's generated
    // client. So the client must read a NULL-agent run: the Prisma field stays optional until the migration has applied
    // everywhere (the database column is what guarantees the Agent once it has).
    const two = await app('refused-read', [{ live: true }, { live: true }]);
    const one = await app('refused-read-one', [{ live: true }]);
    const ids = await withPg(async (c) => {
      await c.query(RELAX);
      const retained = await insertRun(c, two.id, null);
      const control = await insertRun(c, one.id, one.agentIds[0]);
      await c.query(`INSERT INTO manual_automation_pins (run_id, pin) VALUES ($1, '{}'::jsonb)`, [retained]);
      // The migration's own transaction: a child refuses, HDPRF, and boot rolls the whole migration back.
      await c.query('BEGIN');
      try {
        await c.query(`CREATE FUNCTION pg_temp.ra_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only'; END $$`);
        await c.query(`CREATE TRIGGER ra_refuse BEFORE DELETE ON manual_automation_pins FOR EACH ROW EXECUTE FUNCTION pg_temp.ra_refuse()`);
        expect((await sqlError(c, read(MIGRATION_FILE)))?.code).toBe('HDPRF');
      } finally {
        await c.query('ROLLBACK');
      }
      return { retained, control };
    });
    expect(await db.appRun.findUnique({ where: { id: ids.control } })).toMatchObject({ agentId: one.agentIds[0] });
    expect(await db.appRun.findUnique({ where: { id: ids.retained } })).toMatchObject({ id: ids.retained, agentId: null });
    expect((await db.appRun.findMany({ where: { appId: { in: [two.id, one.id] } } })).map(r => r.id).sort()).toEqual([ids.retained, ids.control].sort());
  });

  afterEach(async () => {
    // A failed assertion above can leave the schema relaxed; put the PR's shape back for the next file in this worker.
    await withPg(c => c.query(`DELETE FROM app_runs WHERE agent_id IS NULL OR NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = app_runs.agent_id)`).then(() => c.query(RESTORE))).catch(() => undefined);
  });
});

describe('#3689 R2: a trigger that names no Agent gets the typed refusal', () => {
  let server: Server | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('webhook: 409 {error: BOOT_PROMPT_NOT_SET}, no run (was a 500)', async () => {
    const a = await app('hook', [{ live: true }]);
    const secret = generateWebhookSecret();
    const hook = await db.agentWebhook.create({ data: { id: generateId(), organizationId: orgId, appId: a.id, agentId: null, name: 'notify', secret, entryNodeUrn: 'ra-org:mem:entry' } });
    const hpt = await mintWebhookPlatformToken(hook.id);
    const ex = express();
    ex.use(express.json());
    mountWebhookRoutes(ex, db);
    server = await new Promise<Server>((resolve) => { const s = ex.listen(0, () => resolve(s)); });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/hooks/${secret}/notify?hpt=${hpt}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'BOOT_PROMPT_NOT_SET' });
    expect(await db.appRun.count()).toBe(0);
  });

  it('schedule: logged as a launch denial (not "mint failed"), no run', async () => {
    const a = await app('sched', [{ live: true }]);
    await db.agentSchedule.create({ data: { id: generateId(), organizationId: orgId, appId: a.id, agentId: null, name: 'tick', cron: '* * * * *', nextRunAt: new Date(0), entryNodeUrn: 'ra-org:mem:entry' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await schedulerTick(db)).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(args => String(args[0]).includes('launch denied') && String(args[0]).includes('BOOT_PROMPT_NOT_SET'))).toBe(true);
    expect(await db.appRun.count()).toBe(0);
  });
});
