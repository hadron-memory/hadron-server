/**
 * #4280 (S12b of #4229) — QA links a post-merge defect to the PR it escaped from: `linkDefectToPullRequest` records one
 * `review.defect-linked` event on the PR's build task (Proposed cor:agt:130:05, Victor's draft on #4235).
 *
 * Who (Peter's ruling on the issue, team chat #110416): a person who manages the App; a worker through its bound
 * session whose CURRENT Worker.role is qa-engineer or coordinator (read at request time, never Session.role); or a
 * worker whose holder manages the App, with an instruction. The App's key and a run may not. A caller who may not read
 * the App is answered as for a task that does not exist (cor:agt:050:21); one who may read but not link gets
 * DEFECT_LINK_FORBIDDEN, with nothing written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { pendingTaskWakes } from '../../../lib/agentTasks/taskWakes.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
// #4286: whether a run may read its App's team (a run, its root trigger and a team-snapshot grant); false unless a pin sets it.
const runGrant = vi.hoisted(() => ({ value: false }));
vi.mock('../../../lib/auth/runTeamRead.js', () => ({ runMayReadTeam: vi.fn(async () => runGrant.value) }));

const M = resolvers.Mutation as Record<string, (...args: any[]) => Promise<any>>;
const H1 = 'a'.repeat(40), H2 = 'b'.repeat(40), NEVER = 'c'.repeat(40);
const DEFECT = 'https://github.com/example/project/issues/9001';
const live = { kind: 'LIVE_CHAT', ref: 'client-chat:turn-4280' };

let f: any;
const person = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;
type Bound = { id: string; agentId: string; session: { id: string }; holderId: string };
/** A worker acting through its bound session: the request's user is its holder, and the request actor is the worker. */
const asWorker = (w: Bound): Context & { worker: Bound } => ({ ...person(w.holderId, { sessionId: w.session.id }), worker: w }) as Context & { worker: Bound };
const call = (c: Context, args: Record<string, unknown>) => {
  const run = () => M.linkDefectToPullRequest!({}, { defectRef: DEFECT, prTaskRef: f.build.id, ...args }, c);
  const w = (c as { worker?: Bound }).worker;
  return w ? runAsActor({ workerId: w.id, agentId: w.agentId, userId: w.holderId }, run) : run();
};
const link = (c: Context, args: Record<string, unknown> = {}) => call(c, args);
const linkEvents = (taskId = f.build.id) => db.agentTeamEvent.findMany({ where: { taskId, type: 'review.defect-linked' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e.extensions?.code ?? String(e); } };
/** The whole refusal, so two refusals can be compared byte for byte. */
const refusal = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return JSON.stringify({ message: e.message, extensions: e.extensions }); } };

beforeEach(async () => {
  runGrant.value = false;
  await cleanDb(db);
  const [manager, member, outsider, stranger] = await Promise.all(['dl-manager', 'dl-member', 'dl-outsider', 'dl-stranger'].map((handle) => db.user.create({ data: { handle, roles: ['READER'] } })));
  const org = await db.organization.create({ data: { name: 'Defects', urn: `defects-${generateId()}.test` } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  const otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  await db.appMember.create({ data: { appId: app.id, userId: manager.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  // Quinn's holder belongs only to the other App, so App A is not readable to that caller.
  await db.appMember.create({ data: { appId: otherApp.id, userId: stranger.id, role: 'member' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:agent`, name: 'Agent' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appAgent.create({ data: { appId: otherApp.id, agentId: agent.id } });
  const worker = async (appId: string, name: string, role: string, holderId: string) => {
    const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name, slug: name.toLowerCase(), role, heldByUserId: holderId } });
    const session = await db.session.create({ data: { id: generateId(), appId, agentId: agent.id, workerId: w.id, userId: holderId, tool: 'vitest', role } });
    return { ...w, session, holderId };
  };
  const colin = await worker(app.id, 'Colin', 'qa-engineer', member.id);
  const peter = await worker(app.id, 'Peter', 'coordinator', member.id);
  const sam = await worker(app.id, 'Sam', 'server-engineer', member.id);
  const mo = await worker(app.id, 'Mo', 'server-engineer', manager.id);
  const quinn = await worker(otherApp.id, 'Quinn', 'qa-engineer', stranger.id);
  const create = (input: Record<string, unknown>, by = manager.id) => M.createAgentTask!({}, { input: { appRef: app.id, source: 'synthetic', ...input } }, person(by));
  const build = await create({ title: 'Build', assignee: { user: member.id }, references: [{ kind: 'PULL_REQUEST', target: 'https://github.com/example/project/pull/8000' }] });
  for (const head of [H1, H2]) await M.freezePullRequestHead!({}, { taskRef: build.id, head }, person(member.id));
  const plain = await create({ title: 'Not a PR' });
  const key = await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'abcd', label: 'K' } });
  f = { manager, member, outsider, org, app, otherApp, agent, colin, peter, sam, mo, quinn, build, plain, key };
});

describe('#4280: who may link a defect to a PR', () => {
  it('a QA worker through its session records one review.defect-linked event on the build task, as itself', async () => {
    const r = await link(asWorker(f.colin), { introducedAtHead: H2 });
    expect(r).toMatchObject({ taskId: f.build.id, defect: DEFECT, introducedAtHead: H2, created: true });
    const [e, ...rest] = await linkEvents();
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ appId: f.app.id, actorWorkerId: f.colin.id, actorUserId: f.member.id });
    expect(e!.payload).toEqual({ defect: DEFECT, introducedAtHead: H2 });
  });

  it('a coordinator worker may link; a person who manages the App may link with no session', async () => {
    expect((await link(asWorker(f.peter))).created).toBe(true);
    expect((await link(person(f.manager.id), { defectRef: `${DEFECT}0` })).created).toBe(true);
    expect(await linkEvents()).toHaveLength(2);
  });

  it('a worker in another role is refused DEFECT_LINK_FORBIDDEN, and nothing is written', async () => {
    expect(await code(link(asWorker(f.sam)))).toBe('DEFECT_LINK_FORBIDDEN');
    expect(await linkEvents()).toHaveLength(0);
  });

  it('a recast worker (coordinator, now server-engineer) is refused though its session still says coordinator', async () => {
    await db.worker.update({ where: { id: f.peter.id }, data: { role: 'server-engineer' } });
    expect((await db.session.findUniqueOrThrow({ where: { id: f.peter.session.id } })).role).toBe('coordinator');
    expect(await code(link(asWorker(f.peter))), 'the bind-time Session.role authorized a recast worker').toBe('DEFECT_LINK_FORBIDDEN');
    expect(await linkEvents()).toHaveLength(0);
  });

  it('with no session, a QA worker\'s holder acts as a person: a member who does not manage the App is refused', async () => {
    expect(await code(link(person(f.member.id)))).toBe('DEFECT_LINK_FORBIDDEN');
    expect(await linkEvents()).toHaveLength(0);
  });

  it('a worker whose holder manages the App may link with an instruction, and one manager-act record names it; without one it is refused', async () => {
    expect(await code(link(asWorker(f.mo)))).toBe('DEFECT_LINK_FORBIDDEN');
    expect((await link(asWorker(f.mo), { instruction: live })).created).toBe(true);
    const acts = (await db.agentTeamEvent.findMany({ where: { appId: f.app.id } })).filter((e) => (e.payload as any)?.instruction);
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ actorWorkerId: f.mo.id });
  });

  it('the App\'s own key may not link: DEFECT_LINK_FORBIDDEN, nothing written', async () => {
    expect(await code(link({ db, appId: f.app.id, appKeyId: f.key.id, roles: [] } as unknown as Context))).toBe('DEFECT_LINK_FORBIDDEN');
    expect(await linkEvents()).toHaveLength(0);
  });

  it('a run may not link, even one started by a person who manages the App: DEFECT_LINK_FORBIDDEN, nothing written', async () => {
    const run = { db, appId: f.app.id, userId: f.manager.id, organizationId: f.org.id, clientId: `run:${generateId()}`, roles: [] } as unknown as Context;
    expect(await code(link(run))).toBe('DEFECT_LINK_FORBIDDEN');
    expect(await linkEvents()).toHaveLength(0);
  });

  it('#4286: a userless run of the App that may read its team is refused DEFECT_LINK_FORBIDDEN; one that may not, as a missing task', async () => {
    const run = { db, appId: f.app.id, organizationId: f.org.id, clientId: `run:${generateId()}`, roles: [] } as unknown as Context;
    runGrant.value = true;
    expect(await code(link(run)), 'a userless run that may read the task got another answer').toBe('DEFECT_LINK_FORBIDDEN');
    runGrant.value = false;
    expect(await code(link(run))).toBe('TASK_NOT_FOUND');
    expect(await linkEvents()).toHaveLength(0);
  });
});

describe('#4280: a caller who may not read the App is answered as for a task that does not exist (cor:agt:050:21)', () => {
  it('a worker of another App: byte-identical to linking a nonexistent task', async () => {
    const missing = generateId();
    const foreign = await refusal(link(asWorker(f.quinn)));
    const absent = await refusal(call(asWorker(f.quinn), { prTaskRef: missing }));
    expect(foreign).not.toBe('RESOLVED');
    expect(foreign.replaceAll(f.build.id, '<ref>')).toBe(absent.replaceAll(missing, '<ref>'));
    expect(await linkEvents()).toHaveLength(0);
  });

  it('another App\'s key, and a run of another App: byte-identical to a nonexistent task, not DEFECT_LINK_FORBIDDEN', async () => {
    const otherKey = await db.appKey.create({ data: { appId: f.otherApp.id, keyHash: generateId(), keyPreview: 'efgh', label: 'K2' } });
    const missing = generateId();
    for (const c of [
      { db, appId: f.otherApp.id, appKeyId: otherKey.id, roles: [] },
      { db, appId: f.otherApp.id, organizationId: f.org.id, clientId: `run:${generateId()}`, roles: [] },
    ] as unknown as Context[]) {
      const foreign = await refusal(link(c));
      const absent = await refusal(call(c, { prTaskRef: missing }));
      expect(foreign).toContain('TASK_NOT_FOUND');
      expect(foreign.replaceAll(f.build.id, '<ref>')).toBe(absent.replaceAll(missing, '<ref>'));
    }
    expect(await linkEvents()).toHaveLength(0);
  });

  it('a person who is not in the App: byte-identical to a nonexistent task', async () => {
    const missing = generateId();
    const foreign = await refusal(link(person(f.outsider.id)));
    const absent = await refusal(M.linkDefectToPullRequest!({}, { defectRef: DEFECT, prTaskRef: missing }, person(f.outsider.id)));
    expect(foreign.replaceAll(f.build.id, '<ref>')).toBe(absent.replaceAll(missing, '<ref>'));
  });
});

describe('#4280: the link itself', () => {
  it('one link per (defect, PR): re-linking returns the existing link and writes no second event', async () => {
    const first = await link(asWorker(f.colin), { introducedAtHead: H1 });
    const again = await link(asWorker(f.peter), { introducedAtHead: H2 });
    expect(again).toMatchObject({ eventId: first.eventId, introducedAtHead: H1, created: false });
    expect(await linkEvents()).toHaveLength(1);
  });

  it('#4286: two concurrent links of one pair write one event; exactly one call says created', async () => {
    const [a, b] = await Promise.all([link(asWorker(f.colin), { introducedAtHead: H1 }), link(asWorker(f.peter), { introducedAtHead: H1 })]);
    expect(await linkEvents()).toHaveLength(1);
    expect(a.eventId).toBe(b.eventId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it('#4286: a retry of a linked pair still validates its head: an unfrozen introducedAtHead is refused, not answered with the link', async () => {
    await link(asWorker(f.colin), { introducedAtHead: H1 });
    expect(await code(link(asWorker(f.colin), { introducedAtHead: NEVER }))).toBe('DEFECT_HEAD_NOT_FROZEN');
    expect(await linkEvents()).toHaveLength(1);
  });

  it('#4286: a link is not the assignee acting on its task: it leaves the assignee\'s assignment wake pending', async () => {
    const t = await M.createAgentTask!({}, { input: { appRef: f.app.id, source: 'synthetic', title: 'QA-held build', assignee: { worker: f.colin.id },
      references: [{ kind: 'PULL_REQUEST', target: 'https://github.com/example/project/pull/8001' }] } }, person(f.manager.id));
    const wakes = async () => ((await pendingTaskWakes(db, [f.colin.id], new Date())).get(f.colin.id) ?? []).filter((w) => w.taskId === t.id);
    expect(await wakes()).toHaveLength(1);
    await link(asWorker(f.colin), { prTaskRef: t.id });
    expect(await wakes(), 'the defect link cleared the assignee\'s assignment wake').toHaveLength(1);
  });

  it('a task with no pull_request reference is refused, nothing written', async () => {
    expect(await code(link(asWorker(f.colin), { prTaskRef: f.plain.id }))).toBe('PR_REFERENCE_MISSING');
    expect(await linkEvents(f.plain.id)).toHaveLength(0);
  });

  it('introducedAtHead must have been frozen on that PR task (DEFECT_HEAD_NOT_FROZEN), and must be a full SHA', async () => {
    expect(await code(link(asWorker(f.colin), { introducedAtHead: NEVER }))).toBe('DEFECT_HEAD_NOT_FROZEN');
    expect(await code(link(asWorker(f.colin), { introducedAtHead: 'abc123' }))).toBe('BAD_USER_INPUT');
    expect(await linkEvents()).toHaveLength(0);
    expect((await link(asWorker(f.colin), { introducedAtHead: H1.toUpperCase() })).introducedAtHead).toBe(H1);
  });

  it('defectRef is an issue URL with the task-reference rules, stored as given', async () => {
    for (const bad of ['http://github.com/x/y/issues/1', 'https://user@github.com/x/y/issues/1', 'https://github.com/x/y/issues/1 ', 'not a url', 'https://github.com/x/​y']) {
      expect(await code(link(asWorker(f.colin), { defectRef: bad })), JSON.stringify(bad)).toBe('BAD_USER_INPUT');
    }
    expect(await linkEvents()).toHaveLength(0);
    const odd = 'https://GitHub.com/example/project/issues/9001#frag';
    expect((await link(asWorker(f.colin), { defectRef: odd })).defect).toBe(odd);
  });

  it('a merged (finished) PR task can be linked', async () => {
    await M.startAgentTask!({}, { taskId: f.build.id }, person(f.member.id));
    await M.finishAgentTask!({}, { taskId: f.build.id, result: { outcome: 'merged' } }, person(f.member.id));
    expect((await link(asWorker(f.colin))).created).toBe(true);
  });

  it('a link changes nothing else: the task row, its properties and its other events are as before', async () => {
    const row = await db.agentTask.findUniqueOrThrow({ where: { id: f.build.id } });
    const others = await db.agentTeamEvent.count({ where: { taskId: f.build.id, NOT: { type: 'review.defect-linked' } } });
    await link(asWorker(f.colin), { introducedAtHead: H1 });
    expect(await db.agentTask.findUniqueOrThrow({ where: { id: f.build.id } })).toEqual(row);
    expect(await db.agentTeamEvent.count({ where: { taskId: f.build.id, NOT: { type: 'review.defect-linked' } } })).toBe(others);
  });
});
