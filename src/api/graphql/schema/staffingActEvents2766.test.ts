/**
 * #2766 (S2a of #2483) — the five member and staffing doors RECORD the act: `ensureAppMember`, `removeAppMember`,
 * `castWorker` (GraphQL and MCP), `retireWorker`, `deleteWorker`. One `AgentTeamEvent` per successful act, written
 * in the act's own transaction, ids and role words only. No admission changes: the existing door tests pass untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const STAFFING_EVENT_TYPES = ['member.added', 'member.role-changed', 'member.removed', 'worker.cast', 'worker.retired', 'worker.deleted'] as const;

const ctxOf = (userId: string): Context => ({ db, userId, roles: ['READER'], clientId: `user:${userId}` });
const events = (type?: string) => db.agentTeamEvent.findMany({
  where: { appId: app.id, type: type ?? { in: [...STAFFING_EVENT_TYPES] } }, orderBy: { createdAt: 'asc' },
});

let orgId: string;
let app: { id: string };
let agentId: string;
let roleAgent: { id: string };
let admin: { id: string; email: string | null };
let outsider: { id: string };
let target: { id: string; email: string | null; name: string | null };
let holder: { id: string };
let caster: { id: string };

/** Run as `caster` acting through its session, with `holder` (the person who holds it) behind the request. */
const asWorker = (fn: () => Promise<any>): Promise<any> => runAsActor({ workerId: caster.id, agentId }, fn);

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'sa-org', urn: 'sa-org' } })).id;
  const user = (name: string, email: string) => db.user.create({ data: { id: generateId(), name, email }, select: { id: true, email: true, name: true } });
  admin = await user('Alma Admin', 'alma.admin@example.test');
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  holder = admin;
  outsider = await user('Otto Outsider', 'otto@example.test');
  target = await user('Tess Target', 'tess.target@example.test');
  const teamAgent = await db.agent.create({ data: { id: generateId(), name: 'Team Agent', urn: `${orgId}:team-agent`, organizationId: orgId } });
  agentId = teamAgent.id;
  ({ app } = await createDbAppWithKey(db, 'sa-app', orgId));
  await createDbAppAgent(db, app.id, agentId);
  const role = await M.createAgent({}, { orgId, name: 'Backend Engineer', personaRole: 'backend-engineer', systemPrompt: 'You are {{name}}, a {{role}}.' }, ctxOf(admin.id));
  roleAgent = { id: role.id };
  await db.appAgent.create({ data: { appId: app.id, agentId: roleAgent.id } });
  caster = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name: 'Caster', slug: 'caster', heldByUserId: holder.id } });
});

afterEach(async () => {
  for (const t of ['app_members', 'workers']) await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS sa_fail_commit ON ${t}`);
  await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS sa_fail_commit()');
});

/**
 * Fail the COMMIT of the transaction that makes the act's own write (`op` on `table`). The write and the event were then
 * both made in it: an event appended outside that transaction would survive the failure and the pin would see it.
 */
async function failCommitOn(table: 'app_members' | 'workers', op: 'INSERT' | 'UPDATE' | 'DELETE') {
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION sa_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced commit failure'; END $$`);
  await db.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER sa_fail_commit AFTER ${op} ON ${table} DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION sa_fail_commit()`);
}

const ensure = (c: Context, userId: string, role: string) => M.ensureAppMember({}, { appRef: app.id, userRef: userId, role }, c);
const removeMember = (c: Context, userId: string) => M.removeAppMember({}, { appRef: app.id, userRef: userId }, c);
const cast = (c: Context, name = 'Iris') => M.castWorker({}, { appRef: app.id, agentRef: roleAgent.id, name }, c);

type Door = { name: string; setup?: () => Promise<unknown>; act: (c: Context) => Promise<unknown>; type: string; written: () => Promise<boolean> };

describe('#2766 a successful act records one event, with its actor', () => {
  it.each([
    ['person', (fn: () => Promise<unknown>) => fn(), null],
    ['worker session', (fn: () => Promise<unknown>) => asWorker(fn), 'caster'],
  ] as const)('member.added and member.role-changed by a %s', async (_who, run, actorWorker) => {
    const c = ctxOf(admin.id);
    await run(() => ensure(c, target.id, 'member'));
    await run(() => ensure(c, target.id, 'owner'));
    await run(() => ensure(c, target.id, 'owner')); // unchanged role: nothing to record
    const rows = await events();
    expect(rows.map((r) => r.type)).toEqual(['member.added', 'member.role-changed']);
    for (const r of rows) {
      expect(r).toMatchObject({ appId: app.id, actorUserId: admin.id, actorWorkerId: actorWorker ? caster.id : null, actorAgentId: actorWorker ? agentId : null });
    }
    expect(rows[0]!.payload).toEqual({ userId: target.id, role: 'member' });
    expect(rows[1]!.payload).toEqual({ userId: target.id, fromRole: 'member', toRole: 'owner' });
  });

  it('member.removed by a worker session; removing a non-member is a no-op that records nothing', async () => {
    await db.appMember.create({ data: { appId: app.id, userId: target.id, role: 'member' } });
    await asWorker(() => removeMember(ctxOf(admin.id), target.id));
    await asWorker(() => removeMember(ctxOf(admin.id), target.id));
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'member.removed', actorUserId: admin.id, actorWorkerId: caster.id, actorAgentId: agentId });
    expect(rows[0]!.payload).toEqual({ userId: target.id, role: 'member' });
  });

  it('worker.cast by worker and person sessions records the same event shape', async () => {
    const viaGraphql = await asWorker(() => cast(ctxOf(admin.id), 'Iris'));
    const henry = await cast(ctxOf(admin.id), 'Henry');
    const rows = await events('worker.cast');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ appId: app.id, actorUserId: admin.id, actorWorkerId: caster.id, actorAgentId: agentId, subjectWorkerId: viaGraphql.id });
    expect(rows[0]!.payload).toEqual({ workerId: viaGraphql.id, agentId: roleAgent.id, role: 'backend-engineer', reportsToWorkerId: null });
    expect(rows[1]).toMatchObject({ appId: app.id, actorUserId: admin.id, subjectWorkerId: henry.id });
    expect(rows[1]!.payload).toEqual({ workerId: henry.id, agentId: roleAgent.id, role: 'backend-engineer', reportsToWorkerId: null });
  });

  it('worker.cast names the reports-to worker when one is named at cast', async () => {
    const head = await asWorker(() => cast(ctxOf(admin.id), 'Head'));
    const second = await M.castWorker({}, { appRef: app.id, agentRef: roleAgent.id, name: 'Second', reportsTo: head.id }, ctxOf(admin.id));
    const row = (await events('worker.cast')).find((r) => r.subjectWorkerId === second.id)!;
    expect((row.payload as any).reportsToWorkerId).toBe(head.id);
  });

  it('worker.retired once; a repeated retire records nothing more', async () => {
    const w = await cast(ctxOf(admin.id), 'Iris');
    await asWorker(() => M.retireWorker({}, { workerRef: w.id }, ctxOf(admin.id)));
    await asWorker(() => M.retireWorker({}, { workerRef: w.id }, ctxOf(admin.id)));
    const rows = await events('worker.retired');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: admin.id, actorWorkerId: caster.id, subjectWorkerId: w.id });
    expect(rows[0]!.payload).toEqual({ workerId: w.id });
  });

  it('worker.deleted carries the id in the payload (the row is gone, so the subject column stays empty)', async () => {
    const w = await cast(ctxOf(admin.id), 'Iris');
    await asWorker(() => M.deleteWorker({}, { workerRef: w.id, confirmNoExternalAttribution: true }, ctxOf(admin.id)));
    const rows = await events('worker.deleted');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: admin.id, actorWorkerId: caster.id, subjectWorkerId: null });
    expect(rows[0]!.payload).toEqual({ workerId: w.id });
  });
});

describe('#2766 a refused act records nothing, with the refusal unchanged', () => {
  const refusal = async (p: Promise<unknown>) => {
    try { await p; return 'NO_ERROR'; } catch (e) { return e instanceof GraphQLError ? `${e.extensions?.code ?? ''}|${e.message}` : (e as Error).message; }
  };

  it('a non-manager at each of the five doors', async () => {
    const w = await cast(ctxOf(admin.id), 'Iris');
    const w2 = await cast(ctxOf(admin.id), 'Henry');
    await db.appMember.create({ data: { appId: app.id, userId: target.id, role: 'member' } });
    const before = (await events()).length;
    const o = ctxOf(outsider.id);
    const got = [
      await refusal(ensure(o, outsider.id, 'owner')),
      await refusal(removeMember(o, target.id)),
      await refusal(cast(o, 'Nope')),
      await refusal(M.retireWorker({}, { workerRef: w.id }, o)),
      await refusal(M.deleteWorker({}, { workerRef: w2.id, confirmNoExternalAttribution: true }, o)),
    ];
    for (const g of got) expect(g).not.toBe('NO_ERROR');
    expect(got[0]).toBe('FORBIDDEN|Forbidden: only org admins or App owners can manage members');
    expect(got[1]).toBe('FORBIDDEN|Forbidden: only org admins, App owners, or the user themselves can remove members');
    expect((await events()).length).toBe(before);
    expect(await db.appMember.count({ where: { appId: app.id, userId: target.id } })).toBe(1);
    expect(await db.worker.count({ where: { id: { in: [w.id, w2.id] }, retiredAt: null } })).toBe(2);
  });

  it('an unconfirmed deleteWorker and a refused member role record nothing', async () => {
    const w = await cast(ctxOf(admin.id), 'Iris');
    const before = (await events()).length;
    await expect(M.deleteWorker({}, { workerRef: w.id }, ctxOf(admin.id))).rejects.toMatchObject({ extensions: { code: 'WORKER_EXTERNAL_ATTRIBUTION_UNCONFIRMED' } });
    await expect(ensure(ctxOf(admin.id), target.id, 'no-such-role')).rejects.toThrow();
    expect((await events()).length).toBe(before);
  });
});

describe('#2766 a rolled-back act leaves neither the write nor the event', () => {
  it('member.added', async () => {
    await failCommitOn('app_members', 'INSERT');
    await expect(ensure(ctxOf(admin.id), target.id, 'member')).rejects.toThrow();
    expect(await db.appMember.count({ where: { appId: app.id, userId: target.id } })).toBe(0);
    expect(await events()).toHaveLength(0);
  });
  it('member.removed', async () => {
    await db.appMember.create({ data: { appId: app.id, userId: target.id, role: 'member' } });
    await failCommitOn('app_members', 'DELETE');
    await expect(removeMember(ctxOf(admin.id), target.id)).rejects.toThrow();
    expect(await db.appMember.count({ where: { appId: app.id, userId: target.id } })).toBe(1);
    expect(await events()).toHaveLength(0);
  });
  it('worker.cast', async () => {
    await failCommitOn('workers', 'INSERT');
    await expect(cast(ctxOf(admin.id), 'Iris')).rejects.toThrow();
    expect(await db.worker.count({ where: { appId: app.id, name: 'Iris' } })).toBe(0);
    expect(await events()).toHaveLength(0);
  });
  it('worker.retired', async () => {
    const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name: 'Iris', slug: 'iris' } });
    await failCommitOn('workers', 'UPDATE');
    await expect(M.retireWorker({}, { workerRef: w.id }, ctxOf(admin.id))).rejects.toThrow();
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).retiredAt).toBeNull();
    expect(await events()).toHaveLength(0);
  });
  it('worker.deleted', async () => {
    const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name: 'Iris', slug: 'iris' } });
    await failCommitOn('workers', 'DELETE');
    await expect(M.deleteWorker({}, { workerRef: w.id, confirmNoExternalAttribution: true }, ctxOf(admin.id))).rejects.toThrow();
    expect(await db.worker.count({ where: { id: w.id } })).toBe(1);
    expect(await events()).toHaveLength(0);
  });
});

describe('#2766 admission is unchanged: the census treats the cast\'s own events as bookkeeping', () => {
  it('a worker whose only history is its own cast event (and a retirement) is still removable', async () => {
    const w = await cast(ctxOf(admin.id), 'Iris');
    expect(await events('worker.cast')).toHaveLength(1);
    await expect(M.deleteWorker({}, { workerRef: w.id, confirmNoExternalAttribution: true }, ctxOf(admin.id))).resolves.toBe(true);
    const r = await cast(ctxOf(admin.id), 'Henry');
    await M.retireWorker({}, { workerRef: r.id }, ctxOf(admin.id));
    await expect(M.deleteWorker({}, { workerRef: r.id, confirmNoExternalAttribution: true }, ctxOf(admin.id))).resolves.toBe(true);
  });

  it('a worker that ACTED through a door is still removable: acting adds no refusal main did not have', async () => {
    await asWorker(() => cast(ctxOf(admin.id), 'Iris'));
    await asWorker(() => ensure(ctxOf(admin.id), target.id, 'member'));
    await asWorker(() => removeMember(ctxOf(admin.id), target.id));
    expect((await events()).filter((e) => e.actorWorkerId === caster.id).length).toBeGreaterThan(0);
    await expect(M.deleteWorker({}, { workerRef: caster.id, confirmNoExternalAttribution: true }, ctxOf(admin.id))).resolves.toBe(true);
  });

  it('a NULL-subject staffing-typed event that names the worker in its payload still counts (null-safe exclusion)', async () => {
    const w = await cast(ctxOf(admin.id), 'Iris');
    await db.agentTeamEvent.create({ data: { appId: app.id, type: 'worker.cast', actorUserId: admin.id, subjectWorkerId: null, payload: { workerId: w.id } } });
    await expect(M.deleteWorker({}, { workerRef: w.id, confirmNoExternalAttribution: true }, ctxOf(admin.id)))
      .rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
  });
});

describe('#2766 payloads hold ids and role words only', () => {
  it('no name, email, signature or slug appears in any recorded event', async () => {
    await asWorker(() => ensure(ctxOf(admin.id), target.id, 'member'));
    await asWorker(() => ensure(ctxOf(admin.id), target.id, 'owner'));
    await asWorker(() => removeMember(ctxOf(admin.id), target.id));
    const w = await asWorker(() => cast(ctxOf(admin.id), 'Iris'));
    await asWorker(() => M.retireWorker({}, { workerRef: w.id }, ctxOf(admin.id)));
    await asWorker(() => M.deleteWorker({}, { workerRef: w.id, confirmNoExternalAttribution: true }, ctxOf(admin.id)));
    const rows = await events();
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(STAFFING_EVENT_TYPES));
    const text = JSON.stringify(rows.map((r) => r.payload));
    for (const secret of ['Tess', 'tess.target', 'example.test', 'Alma', 'Iris', 'iris', 'Caster', 'Backend', 'signature', 'Hadron-Worker']) {
      expect(text).not.toContain(secret);
    }
    const allowed = new Set(['userId', 'role', 'fromRole', 'toRole', 'workerId', 'agentId', 'reportsToWorkerId']);
    for (const r of rows) for (const k of Object.keys(r.payload as object)) expect(allowed.has(k)).toBe(true);
  });
});

describe('#2766 read surface: the new events ride hadron_team_events for the readers it has today', () => {
  it('a participant reads them; an outsider does not', async () => {
    await ensure(ctxOf(admin.id), target.id, 'member');
    const read = (userId: string) => (resolvers.Query as any).agentTeamEvents({}, { appRef: app.id, types: ['member.added'] }, ctxOf(userId));
    expect((await read(target.id)).map((row: any) => row.type)).toContain('member.added');
    await expect(read(outsider.id)).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
  });
});
