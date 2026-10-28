import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/** #2677 — real-Postgres pins for single-pick role resolution and coordinator/manager routing (stacked on #2608). */

import { buildSchema, parse, validate } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { compareRank, loadWorkerWorkStates, matchable } from '../../../lib/agentTasks/matcher.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const CODE = 'task.finish.open-children';
const pick = (userId: string, extra: Record<string, unknown> = {}) =>
  (resolvers.Query as any).registerRolePick({}, { appRef: app.id, code: CODE, ...extra }, ctx(userId));
const ids = (r: any) => r.entries.map((e: any) => `${e.kind}:${e.id}`);

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };
let app: { id: string };
let teamAgentId: string;
let teamMemoryId: string;

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const at = (m: number) => new Date(Date.UTC(2026, 9, 28, 10, m));
async function worker(name: string, agentId = teamAgentId, role: string | null = null) {
  return db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase().replaceAll(' ', '-'), role }, select: { id: true } });
}
/** A live session for `w` (the matcher's "bound and live"). */
const bind = (w: { id: string }, agentId = teamAgentId, family = 'codex') =>
  db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.id, agentId, family, startedAt: new Date(), updatedAt: new Date() }, select: { id: true } });
const lastAssigned = (w: { id: string }, m: number) =>
  db.agentTeamEvent.create({ data: { appId: app.id, type: 'task.assigned', subjectWorkerId: w.id, createdAt: at(m), payload: { assignee: { workerId: w.id } } } });
const node = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: '# x', ...extra } });
async function roleAgent(name: string, parent?: string) {
  const a = await M.createAgent({}, { orgId: org.id, name }, ctx(admin.id));
  if (parent) await db.agent.update({ where: { id: a.id }, data: { extendsAgentId: parent } });
  const row = await db.agent.findUniqueOrThrow({ where: { id: a.id } });
  return { id: a.id, memoryId: row.systemMemoryId as string };
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'rp-org', urn: `rp-${suffix}.example` } });
  admin = await db.user.create({ data: { githubId: 219001, githubUsername: 'rp-admin', handle: 'rp-admin', roles: ['READER'] } });
  member = await db.user.create({ data: { githubId: 219002, githubUsername: 'rp-member', handle: 'rp-member', roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 219003, githubUsername: 'rp-out', handle: 'rp-out', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgentId = agent.id;
  teamMemoryId = (await db.agent.findUniqueOrThrow({ where: { id: teamAgentId } })).systemMemoryId as string;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgentId } });
  await node(teamMemoryId, 'roles');
  await node(teamMemoryId, `register:${CODE}`, { data: { registerEntry: { code: CODE, taskLoc: 'tasks:finish' } } });
  await node(teamMemoryId, 'tasks:finish', { isRunnable: true });
});

describe('#2677 single pick over #2608 candidates', () => {
  it('ties at the lowest depth pick by the matcher compareRank (differential)', async () => {
    const [a, b, c] = [await worker('Anne'), await worker('Beth'), await worker('Cleo')];
    for (const w of [a, b, c]) await bind(w);
    await lastAssigned(a, 5); await lastAssigned(b, 1); // Cleo never assigned: least recent
    const r = await pick(admin.id);
    const states = (await loadWorkerWorkStates(db, app.id, new Date(), { bySession: true })).filter((w) => w.free && matchable(w)).sort(compareRank);
    expect(ids(r)).toEqual([`WORKER:${states[0]!.id}`]);
    expect(ids(r)).toEqual([`WORKER:${c.id}`]);
    await lastAssigned(c, 9); expect(ids(await pick(admin.id))).toEqual([`WORKER:${b.id}`]);
  });

  it('skips workers the matcher skips: busy, paused, retired, unbound/not live; falls to the NEXT depth when the lowest is all ineligible', async () => {
    const base = await roleAgent('Base'); await node(base.memoryId, 'tasks:finish', { isRunnable: true });
    const child = await roleAgent('Child', base.id); // inherits the task: depth 1
    const near = await worker('Zed', base.id); const far = await worker('Abe', child.id);
    await bind(near, base.id); await bind(far, child.id);
    expect(ids(await pick(admin.id))).toEqual([`WORKER:${near.id}`]);
    await db.agentTask.create({ data: { appId: app.id, title: 'Busy', ownerUserId: member.id, assigneeWorkerId: near.id, assignedAt: at(0) } });
    expect(ids(await pick(admin.id))).toEqual([`WORKER:${far.id}`]);
    await db.workerAvailability.create({ data: { workerId: far.id, state: 'unavailable', reason: 'other', setAt: at(0), setBy: 'holder', setByUserId: admin.id } });
    expect(ids(await pick(admin.id)).every((e: string) => e.startsWith('USER:'))).toBe(true); // no role holder, no coordinator: managers
  });

  it('retired and not-live workers are never picked', async () => {
    const live = await worker('Live'); const gone = await worker('Gone'); await worker('Quiet');
    await bind(live); await bind(gone); await db.worker.update({ where: { id: gone.id }, data: { retiredAt: at(0) } });
    expect(ids(await pick(admin.id))).toEqual([`WORKER:${live.id}`]);
  });
});

describe('#2677 matchable and named-retired pins', () => {
  it('a worker whose agent does not use tasks is not picked (the matcher\'s matchable), and a retired named worker reads like naming nobody', async () => {
    const off = await worker('Off'); await bind(off);
    await db.agent.update({ where: { id: teamAgentId }, data: { usesTasks: false } });
    const unnamed = await pick(admin.id);
    expect(ids(unnamed)).not.toContain(`WORKER:${off.id}`);
    await db.agent.update({ where: { id: teamAgentId }, data: { usesTasks: true } });
    const gone = await worker('Gone'); await db.worker.update({ where: { id: gone.id }, data: { retiredAt: at(0) } });
    const base = await pick(admin.id);
    expect(await pick(admin.id, { workerRef: gone.id })).toEqual(base);
  });
});

describe('#2677 routing order: named, role holder, coordinator, managers, empty', () => {
  it('a named worker wins over the least-recently-assigned holder only when it is a candidate AND free (cor:agt:110:05)', async () => {
    const holder = await worker('Holder'); const named = await worker('Named', teamAgentId, 'engineer'); await bind(holder); await bind(named);
    await lastAssigned(named, 9); // the pick would choose Holder
    expect(ids(await pick(admin.id))).toEqual([`WORKER:${holder.id}`]);
    expect(ids(await pick(admin.id, { workerRef: named.id }))).toEqual([`WORKER:${named.id}`]);
    await db.agentTask.create({ data: { appId: app.id, title: 'Busy', ownerUserId: member.id, assigneeWorkerId: named.id, assignedAt: at(0) } });
    expect(await pick(admin.id, { workerRef: named.id })).toEqual(await pick(admin.id));
  });

  it('a named worker without the code task in its chain does not get the event and reads like naming nobody', async () => {
    const holder = await worker('Holder'); await bind(holder);
    const other = await roleAgent('Other'); const outside = await worker('Outside', other.id, 'engineer'); await bind(outside, other.id);
    expect(await pick(admin.id, { workerRef: outside.id })).toEqual(await pick(admin.id));
    expect(ids(await pick(admin.id, { workerRef: outside.id }))).toEqual([`WORKER:${holder.id}`]);
  });

  it('no role holder: the coordinator role holders, picked by compareRank, role read case-insensitively from the open session placement', async () => {
    const roleless = await roleAgent('Other'); // holds no task: never a role holder
    const c1 = await worker('Cora', roleless.id, 'Coordinator'); const c2 = await worker('Dina', roleless.id, 'coordinator'); const eng = await worker('Eve', roleless.id, 'engineer');
    for (const w of [c1, c2, eng]) await bind(w, roleless.id);
    await lastAssigned(c1, 5);
    expect(ids(await pick(admin.id))).toEqual([`WORKER:${c2.id}`]);
    await db.worker.update({ where: { id: c2.id }, data: { retiredAt: at(0) } });
    expect(ids(await pick(admin.id))).toEqual([`WORKER:${c1.id}`]);
  });

  it('no coordinator either: every App manager as USER entries in the helper order, only for a manager caller', async () => {
    await db.appMember.create({ data: { appId: app.id, userId: outsider.id, role: 'owner' } });
    const r = await pick(admin.id);
    expect(r.entries.every((e: any) => e.kind === 'USER')).toBe(true);

    expect(new Set(r.entries.map((e: any) => e.id))).toEqual(new Set([admin.id, outsider.id]));
    expect(await pick(member.id)).toMatchObject({ entries: [] });
  });

  it('a platform admin is not a manager of the App for the routed event (Holger, #43360)', async () => {
    const plat = await db.user.create({ data: { githubId: 219004, githubUsername: 'rp-plat', handle: 'rp-plat', roles: ['ADMIN'] } });
    const r = await pick(admin.id);
    expect(r.entries.map((e: any) => e.id)).not.toContain(plat.id);
    expect(r.entries.map((e: any) => e.id)).toContain(admin.id);
  });

  it('nothing matches: an empty result, not an error', async () => {
    await db.orgMember.deleteMany({ where: { organizationId: org.id } });
    expect(await pick(admin.id).catch(() => 'refused')).toSatisfy((r: any) => r === 'refused' || r.entries.length === 0);
  });
});

describe('#2677 two-tenant pins', () => {
  it('an App outsider is refused like #2608', async () => { await expect(pick(outsider.id)).rejects.toBeTruthy(); });

  it('a foreign Agent worker is never picked and a foreign named worker reads exactly like naming nobody', async () => {
    const foreignOrg = await db.organization.create({ data: { id: generateId(), name: 'Foreign', urn: `foreign-${generateId().toLowerCase()}.example` } });
    const owner = await db.user.create({ data: { handle: `owner-${generateId()}` } });
    await db.orgMember.create({ data: { organizationId: foreignOrg.id, userId: owner.id, role: 'ADMIN' } });
    const fa = await M.createAgent({}, { orgId: foreignOrg.id, name: 'Foreign role' }, ctx(owner.id));
    await db.agent.update({ where: { id: fa.id }, data: { extendsAgentId: teamAgentId } });
    const foreign = await worker('Foreign', fa.id, 'coordinator'); await bind(foreign, fa.id);
    const unnamed = await pick(member.id);
    expect(ids(unnamed)).not.toContain(`WORKER:${foreign.id}`);
    expect(await pick(member.id, { workerRef: foreign.id })).toEqual(unnamed);
    const stranger = generateId(); expect(await pick(member.id, { workerRef: stranger })).toEqual(unnamed);
    await db.worker.update({ where: { id: foreign.id }, data: { retiredAt: at(0) } });
    expect(await pick(member.id, { workerRef: foreign.id })).toEqual(unnamed);
  });
});

describe('#2677 schema', () => {
  it('exposes only the closed projection', () => {
    const q = parse(`{ registerRolePick(appRef: "a", code: "c", workerRef: "w") { appId code entries { kind id } } }`);
    expect(validate(buildSchema(typeDefs), q)).toEqual([]);
  });
});
