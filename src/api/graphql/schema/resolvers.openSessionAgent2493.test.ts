/**
 * #2493 (#2458 slice 2, cor:dmo:050:11): an open session finishes under the agent and role it was bound with. After
 * `changeWorkerAgent` the session's own reads (register, briefing, matcher and context-reset settings) still follow
 * agent A/role R; a new bind and every other reader (a manager, the portal) see B/R2.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { collectRegisterRows } from '../../../lib/resolveRegister.js';
import { loadWorkerWorkStates, matchQueuedTasks } from '../../../lib/agentTasks/matcher.js';
import { openSessionPlacement } from '../../../lib/sessionPlacement.js';
import { setUpResetFixture, M as ResetM, ctx as resetCtx } from '../../../test/contextResetFixture.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';
import { composeWorkerPrompt } from './resolvers.worker.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any, Q = resolvers.Query as any;
let org: any, app: any, agentA: any, agentB: any, admin: any, worker: any, memory: any;
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: admin.id, roles: ['READER'], ...extra });
const bind = () => M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id, workerRef: worker.id, force: true } }, ctx());
const change = () => M.changeWorkerAgent({}, { workerRef: worker.id, agentRef: agentB.id }, ctx());
const channelsOf = async (sessionId?: string) =>
  ((await collectRegisterRows(db, { workerId: worker.id }, sessionId))?.rows ?? []).map(r => r.channelId).sort();
let chanA: string, chanB: string;

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().toLowerCase();
  org = await db.organization.create({ data: { name: 'Open', urn: `open-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 93_000_000 + Math.floor(Math.random() * 1_000_000), githubUsername: `open-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  agentA = await M.createAgent({}, { orgId: org.id, name: 'Security', personaRole: 'security-engineer', systemPrompt: 'A-PROMPT {{worker.name}} {{worker.role}} {{agent.name}}' }, ctx());
  agentB = await M.createAgent({}, { orgId: org.id, name: 'Specs', personaRole: 'specs-engineer', systemPrompt: 'B-PROMPT {{worker.name}} {{worker.role}} {{agent.name}}' }, ctx());
  for (const a of [agentA, agentB]) await db.appAgent.create({ data: { appId: app.id, agentId: a.id } });
  const made = await M.castWorker({}, { appRef: app.id, agentRef: agentA.id, name: 'Ruin' }, ctx());
  worker = await db.worker.findUniqueOrThrow({ where: { id: made.id } });
  memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agentA.id } });
  const mk = async (loc: string, entry: Record<string, unknown>) => {
    const c = await ensureChannelWithRoot(db, { memoryId: memory.id, loc, name: loc, createdBy: admin.id });
    await db.registerEntry.create({ data: { id: generateId(), appId: app.id, channelId: c.channel.id, role: 'BOTH', ...entry } });
    return c.channel.id as string;
  };
  chanA = await mk('chats:a', { attendeeAgentId: agentA.id });
  chanB = await mk('chats:b', { attendeeAgentId: agentB.id });
});

describe('#2493 an open session finishes under its own agent and role', () => {
  it('(a)(d)(e) register: the open session reads A\'s entries, a new bind and a non-session reader read B\'s', async () => {
    const open = await bind();
    await change();
    expect(await channelsOf(open.id)).toEqual([chanA]);
    expect(await channelsOf()).toEqual([chanB]);
    await db.session.update({ where: { id: open.id }, data: { endedAt: new Date() } });
    const next = await bind();
    expect(await channelsOf(next.id)).toEqual([chanB]);
    expect(await channelsOf(open.id)).toEqual([chanB]);
  });

  it('(b)(e) briefing: Worker.prompt and the composition serve A to the open session, B to a manager', async () => {
    const open = await bind();
    await change();
    const live = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect((await composeWorkerPrompt(ctx({ sessionId: open.id }), live)).text).toContain('A-PROMPT Ruin security-engineer Security');
    expect(await (resolvers.Worker as any).prompt(live, {}, ctx({ sessionId: open.id }))).toContain('A-PROMPT Ruin security-engineer Security');
    expect((await composeWorkerPrompt(ctx(), live)).text).toContain('B-PROMPT Ruin specs-engineer Specs');
    expect((await Q.worker({}, { ref: worker.id }, ctx())).role).toBe('specs-engineer');
  });

  it('(b) another worker\'s session id never selects this worker\'s placement', async () => {
    await bind();
    await change();
    expect(await openSessionPlacement(db, worker.id, generateId())).toBeNull();
  });

  it('(g) a session with no stamped role falls back to the worker row without error', async () => {
    const open = await bind();
    await change();
    await db.session.update({ where: { id: open.id }, data: { role: null } });
    expect(await openSessionPlacement(db, worker.id, open.id)).toBeNull();
    expect(await channelsOf(open.id)).toEqual([chanB]);
    const live = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect((await composeWorkerPrompt(ctx({ sessionId: open.id }), live)).text).toContain('B-PROMPT');
  });

  it('(c) matcher: role and uses_tasks come from the open session\'s agent; a new bind uses the new agent', async () => {
    const open = await bind();
    await db.agent.update({ where: { id: agentB.id }, data: { usesTasks: false } });
    await change();
    const states = () => loadWorkerWorkStates(db, app.id, new Date(), { bySession: true });
    expect(await states()).toMatchObject([{ id: worker.id, role: 'security-engineer', usesTasks: true }]);
    // (e) the roster, a manager-facing read of the same loader, shows the live row.
    expect(await loadWorkerWorkStates(db, app.id, new Date())).toMatchObject([{ id: worker.id, role: 'specs-engineer', usesTasks: false }]);
    await db.session.update({ where: { id: open.id }, data: { endedAt: new Date() } });
    expect(await states()).toMatchObject([{ id: worker.id, role: 'specs-engineer', usesTasks: false }]);
  });

  it('(c) matcher assignment: a task for the old role goes to the open session, not to the new role', async () => {
    const open = await bind();
    await change();
    await db.session.update({ where: { id: open.id }, data: { family: 'claude' } });
    const task = (role: string) => db.agentTask.create({ data: { appId: app.id, title: role, ownerUserId: admin.id, requirements: { role } }, select: { id: true } });
    const old = await task('security-engineer');
    const fresh = await task('specs-engineer');
    expect(await matchQueuedTasks(db, new Date(), { appId: app.id })).toEqual([{ taskId: old.id, workerId: worker.id, family: 'claude' }]);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: fresh.id } })).assigneeWorkerId).toBeNull();
  });

  it('(f) a change, a matcher pass and a bind racing do not deadlock', async () => {
    const open = await bind();
    await db.session.update({ where: { id: open.id }, data: { family: 'claude' } });
    await db.agentTask.create({ data: { appId: app.id, title: 't', ownerUserId: admin.id }, select: { id: true } });
    const outcomes = await Promise.allSettled([change(), matchQueuedTasks(db, new Date(), { appId: app.id }), matchQueuedTasks(db, new Date(), { appId: app.id })]);
    expect(outcomes.map(o => o.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    // And the task was assigned exactly once, to the open session's worker.
    expect(await db.agentTask.count({ where: { appId: app.id, assigneeWorkerId: worker.id } })).toBe(1);
    expect(await db.agentTask.count({ where: { appId: app.id, assigneeWorkerId: { not: null } } })).toBe(1);
  });
});

describe('#2493 context reset reads the open session\'s agent (c)', () => {
  it.each([[true, false, 'requested'], [false, true, null]] as const)('session agent on=%s, live agent on=%s: reset %s', async (sessionOn, liveOn, phase) => {
    const f = await setUpResetFixture();
    const other = await ResetM.createAgent({}, { orgId: f.orgId, name: 'Other', personaRole: 'other' }, resetCtx(f.manager.id));
    await db.appAgent.create({ data: { appId: f.app.id, agentId: other.id } });
    await db.agent.update({ where: { id: f.agentId }, data: { resetContextAfterTask: sessionOn } });
    await db.agent.update({ where: { id: other.id }, data: { resetContextAfterTask: liveOn } });
    await db.session.update({ where: { id: f.session.id }, data: { role: 'reviewer' } });
    const t = await f.startedTask();
    await db.worker.update({ where: { id: f.kit.id }, data: { agentId: other.id, role: 'other' } });
    await f.finish(t.id);
    expect((await db.contextReset.findUnique({ where: { taskId: t.id } }))?.phase ?? null).toBe(phase);
  });
});

describe('#2493 hadron_get_worker recovery: the explicit session argument selects the placement', () => {
  const asUser = (u: { id: string }) => createTestableMcpServer({ userId: u.id, appId: app.id, roles: ['READER'], clientId: `user:${u.id}` } as any);
  const read = (u: { id: string }, session: string) => asUser(u).callToolText('hadron_get_worker', { workerRef: worker.id, session });

  it('the owner of the open session, reconnected with no session id, gets A\'s briefing and register', async () => {
    const open = await bind();
    await change();
    const text = await read(admin, open.id);
    expect(text).toContain('A-PROMPT Ruin security-engineer Security');
    expect(text).not.toContain('B-PROMPT');
  });

  it('a bare id is never trusted: another admin naming that session, an ended session and an unknown id read the live row', async () => {
    const open = await bind();
    await change();
    const other = await db.user.create({ data: { githubId: 94_000_000 + Math.floor(Math.random() * 1_000_000), githubUsername: `other-${generateId()}`, roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: other.id, role: 'ADMIN' } });
    expect(await read(other, open.id)).toContain('B-PROMPT Ruin specs-engineer Specs');
    expect(await read(admin, generateId())).toContain('B-PROMPT');
    await db.session.update({ where: { id: open.id }, data: { endedAt: new Date() } });
    expect(await read(admin, open.id)).toContain('B-PROMPT');
  });

  it('the binding rule is the shared one: a hard-expired and a dormant session read the live row (each pinned on its own)', async () => {
    const open = await bind();
    await change();
    await db.session.update({ where: { id: open.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    expect(await read(admin, open.id)).toContain('B-PROMPT');
    // Dormant: no hard expiry, nobody drove it for longer than the App's threshold.
    const old = new Date(Date.now() - 400 * 24 * 3600 * 1000);
    await db.session.update({ where: { id: open.id }, data: { expiresAt: null, startedAt: old, updatedAt: old } });
    await db.app.update({ where: { id: app.id }, data: { sessionDormancyDays: 30 } });
    expect(await read(admin, open.id)).toContain('B-PROMPT');
    await db.session.update({ where: { id: open.id }, data: { startedAt: new Date(), updatedAt: new Date() } });
    expect(await read(admin, open.id)).toContain('A-PROMPT');
  });

  it('impersonation never names a session; an App key of ANOTHER App does not own it (each pinned on its own)', async () => {
    const open = await bind();
    await change();
    const imp = createTestableMcpServer({ userId: admin.id, appId: app.id, roles: [], clientId: `user:${admin.id}`, impersonation: { sessionId: generateId(), actorUserId: admin.id, orgId: org.id, expiresAt: new Date(Date.now() + 60_000) } } as any);
    expect(await imp.callToolText('hadron_get_worker', { workerRef: worker.id, session: open.id })).not.toContain('A-PROMPT');
    const other = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
    const foreign = createTestableMcpServer({ appId: other.id, roles: [] } as any);
    expect(await foreign.callToolText('hadron_get_worker', { workerRef: worker.id, session: open.id })).not.toContain('A-PROMPT');
  });

  it('a user who owns the session but is no longer a participant of its App reads the live row (callerStillDrives, on its own)', async () => {
    const open = await bind();
    await change();
    await db.orgMember.deleteMany({ where: { organizationId: org.id, userId: admin.id } });
    expect(await read(admin, open.id)).not.toContain('A-PROMPT');
  });
});
