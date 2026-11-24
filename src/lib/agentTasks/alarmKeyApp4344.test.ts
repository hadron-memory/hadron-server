/**
 * #4344 (Holger's ruling A, 2026-11-23): the one-alarm-per-episode key carries the App. A stall alarm row of App A that
 * names a task of App B, with the real alarm's type and episode start, used to block App B's real alarm twice over: the
 * pass's read of raised episodes found it and skipped the candidate, and the insert's `ON CONFLICT (task_id, type,
 * episode_start) DO NOTHING` would have refused it anyway. The key is now (app_id, task_id, type, episode_start) in the
 * read and in the conflict target. Migration shape (expand): the four-column unique index is added and the three-column
 * one is KEPT until the image writing the four-column target has deployed (an old image's three-column ON CONFLICT
 * raises 42P10 once that index is gone); the drop is a later contract migration (cor:agt:050:11, :13).
 *
 * No write path makes the forced row today (#4202); the pin plants it, as the issue's acceptance asks.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { evaluateStalls, loadStallInputs, stallCandidates, STALL_EVENT_TYPE, STALL_WINDOW_DEFAULTS } from './stall.js';

const at = (hhmm: string): Date => new Date(`2026-10-09T${hhmm}:00Z`);
const OLD_INDEX = 'agent_team_events_episode_uniq';

let appA: string;
let appB: string;
let taskB: string;

async function mkApp(tag: string): Promise<{ appId: string; worker: string }> {
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: `K${tag}`, urn: `key4344-${tag}-${n}.example` } });
  const admin = await db.user.create({ data: { githubId: 434_000 + n, githubUsername: `k4344-${tag}-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const ctx: Context = { db, userId: admin.id, roles: ['READER'] };
  const agentId = ((await (resolvers.Mutation as any).createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx)) as { id: string }).id;
  const app = await db.app.create({ data: { organizationId: org.id, name: `Team ${tag}`, urn: `${org.urn}:team` }, select: { id: true } });
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: `W${tag}`, slug: `w${tag}` }, select: { id: true } });
  return { appId: app.id, worker: w.id };
}

/** The not-started candidate's episode start for task B at `now`, as the evaluator itself computes it. */
async function episodeOf(now: Date): Promise<Date> {
  const inputs = await loadStallInputs(db, { id: taskB }, now);
  const c = stallCandidates(inputs[0], STALL_WINDOW_DEFAULTS, now).find((x) => x.rule === 'not-started');
  if (!c) throw new Error('no candidate');
  return c.episodeStart;
}

/** Plant the forced row: an alarm of App A naming App B's task, with the real alarm's type and episode start. */
async function plantForeign(episodeStart: Date): Promise<void> {
  await db.agentTeamEvent.create({
    data: { appId: appA, type: STALL_EVENT_TYPE['not-started'], taskId: taskB, severity: 'alarm', chain: [{ userId: 'x' }] as never, episodeStart },
  });
}

const alarmsOfB = () => db.agentTeamEvent.findMany({ where: { appId: appB, taskId: taskB, severity: 'alarm' } });

beforeEach(async () => {
  await cleanDb(db);
  const a = await mkApp('a');
  const b = await mkApp('b');
  appA = a.appId;
  appB = b.appId;
  taskB = (await db.agentTask.create({ data: { appId: appB, title: 'T', createdAt: at('09:00'), ownerWorkerId: b.worker, assigneeWorkerId: b.worker, assignedAt: at('10:00') }, select: { id: true } })).id;
});

describe('#4344 — a foreign alarm row does not block App B\'s real alarm', () => {
  it('with the App in the key, the pass raises App B\'s alarm beside the foreign row', async () => {
    const ep = await episodeOf(at('10:15'));
    await plantForeign(ep);
    const raised = await evaluateStalls(db, at('10:15'));
    expect(raised).toHaveLength(1);
    expect(await alarmsOfB()).toHaveLength(1);
  });

  it('control: the same episode of the same App is still one alarm (a second pass inserts nothing)', async () => {
    const ep = await episodeOf(at('10:15'));
    await plantForeign(ep);
    expect(await evaluateStalls(db, at('10:15'))).toHaveLength(1);
    expect(await evaluateStalls(db, at('10:16'))).toHaveLength(0);
    expect(await alarmsOfB()).toHaveLength(1);
  });
});

describe('#4344 — the contract migration', () => {
  it('only the four-column unique index remains, with the App first', async () => {
    const rows = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'agent_team_events' AND indexdef ILIKE '%UNIQUE%' AND indexname LIKE 'agent_team_events_episode%'`;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.has(OLD_INDEX)).toBe(false);
    const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'agent_team_events' AND indexname = 'agent_team_events_task_id_type_idx'`;
    expect(Number(n), 'the (task_id, type) index the progress/queued reads use').toBe(1);
    const [{ m }] = await db.$queryRaw<{ m: bigint }[]>`SELECT count(*) AS m FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'agent_team_events' AND indexname = 'agent_team_events_task_id_idx'`;
    expect(Number(m), 'the redundant single-column index is gone').toBe(0);
    expect(byName.get('agent_team_events_episode_app_uniq')).toMatch(/\(app_id, task_id, type, episode_start\)/);
  });

  it('the expand migration only adds; a LATER migration drops the three-column index', () => {
    const dir = new URL('../../../prisma/migrations/', import.meta.url);
    const names = readdirSync(dir).sort();
    const expand = names.find((d) => d.endsWith('_agent_team_events_episode_app_key'));
    const contract = names.find((d) => d.endsWith('_agent_team_events_episode_contract'));
    expect(expand, 'the expand migration').toBeTruthy();
    expect(contract, 'the contract migration').toBeTruthy();
    expect(contract! > expand!).toBe(true);
    expect(readFileSync(new URL(`${expand}/migration.sql`, dir), 'utf8')).not.toMatch(/DROP INDEX[^;]*agent_team_events_episode_uniq/);
    expect(readFileSync(new URL(`${contract}/migration.sql`, dir), 'utf8')).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS "agent_team_events_episode_uniq";/);
    // Each CONCURRENTLY file holds exactly one statement (a multi-statement file runs in one transaction and refuses).
    const concurrent = names.filter((d) => /_agent_team_events_(task_type_idx|episode_contract|task_id_idx_drop)$/.test(d));
    expect(concurrent.map((d) => d.replace(/^\d+_/, '')).sort(), 'all three CONCURRENTLY migrations were found, so none is skipped').toEqual(['agent_team_events_episode_contract', 'agent_team_events_task_id_idx_drop', 'agent_team_events_task_type_idx']);
    for (const n of concurrent) {
      const sql = readFileSync(new URL(`${n}/migration.sql`, dir), 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n');
      expect(sql.match(/;/g), n).toHaveLength(1);
      expect(sql, n).toMatch(/CONCURRENTLY/);
    }
  });

  it('the foreign row no longer refuses App B\'s insert', async () => {
    const ep = await episodeOf(at('10:15'));
    await plantForeign(ep);
    expect(await evaluateStalls(db, at('10:15'))).toHaveLength(1);
    expect(await alarmsOfB()).toHaveLength(1);
  });
});
