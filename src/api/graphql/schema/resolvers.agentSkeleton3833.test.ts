/**
 * #3833 — skeleton parent nodes (boot, boot:rules, processes, tasks) in an Agent's system memory.
 * Pins: create-time seeding; option B (only locs the effective base chain lacks); never overwrite;
 * system memories only (never install memories); index refs untouched; retrofit idempotent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import { AGENT_SKELETON, retrofitAgentSkeletons } from '../../../lib/agentSkeleton.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const LOCS = ['boot', 'boot:rules', 'processes', 'tasks'];
let orgId: string;
let adminId: string;

const locsOf = async (memoryId: string) =>
  (await db.node.findMany({ where: { memoryId, deletedAt: null }, select: { loc: true } })).map((n) => n.loc).sort();
const nodeAt = (memoryId: string, loc: string) => db.node.findFirst({ where: { memoryId, loc } });

async function createAgent(name: string): Promise<{ id: string; systemMemoryId: string }> {
  const a = await resolvers.Mutation.createAgent({}, { orgId, name, visibility: 'ORGANIZATION' }, { db, roles: ['ADMIN'], userId: adminId });
  return a as unknown as { id: string; systemMemoryId: string };
}

/** An Agent made without the resolver, so its system memory starts empty (the pre-#3833 shape). */
async function bareAgent(name: string, extendsAgentId?: string): Promise<{ id: string; memoryId: string }> {
  const m = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: `${name}-sys`, name: `${name} System`, class: 'system', acceptsUploads: false } });
  const a = await db.agent.create({ data: { organizationId: orgId, name, urn: `org-3833:${name}`, systemMemoryId: m.id, visibility: 'ORGANIZATION', ...(extendsAgentId ? { extendsAgentId } : {}) } });
  return { id: a.id, memoryId: m.id };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'org-3833', urn: 'org-3833' } });
  orgId = org.id;
  const admin = await db.user.create({ data: { githubId: 38330, githubUsername: 'admin-3833', roles: ['ADMIN'] } });
  adminId = admin.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
});

describe('#3833 create-time seeding', () => {
  it('a new Agent\'s system memory gains boot, boot:rules, processes and tasks, named per the gate', async () => {
    const a = await createAgent('fresh');
    expect(await locsOf(a.systemMemoryId)).toEqual(LOCS.slice().sort());
    expect((await nodeAt(a.systemMemoryId, 'boot'))!.name).toBe('Boot Instructions');
    expect((await nodeAt(a.systemMemoryId, 'boot:rules'))!.name).toBe('Boot Prompt Rules');
    const agent = await db.agent.findUniqueOrThrow({ where: { id: a.id } });
    expect(agent.tasksIndexRef).toBeNull();
    expect(agent.processesIndexRef).toBeNull();
  });

  it('promoting an existing memory keeps its nodes untouched and adds only the absent locs', async () => {
    const m = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: 'promo-3833', name: 'promo', class: 'knowledge' } });
    await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'tasks', name: 'My Tasks', content: 'keep me' } });
    const a = await resolvers.Mutation.createAgent({}, { orgId, name: 'promoted', visibility: 'ORGANIZATION', systemMemoryId: m.id }, { db, roles: ['ADMIN'], userId: adminId }) as unknown as { systemMemoryId: string };
    const t = await nodeAt(a.systemMemoryId, 'tasks');
    expect(t!.name).toBe('My Tasks');
    expect(t!.content).toBe('keep me');
    expect(await locsOf(a.systemMemoryId)).toEqual(LOCS.slice().sort());
  });
});

describe('#3833 retrofit', () => {
  it('gives an existing empty system memory the four parents, and a second pass creates nothing', async () => {
    const a = await bareAgent('old');
    const first = await retrofitAgentSkeletons(db);
    expect(first.find((r) => r.memoryId === a.memoryId)!.created.sort()).toEqual(LOCS.slice().sort());
    const second = await retrofitAgentSkeletons(db);
    expect(second.every((r) => r.created.length === 0)).toBe(true);
  });

  it('never overwrites an existing node\'s name or content, including a tombstone', async () => {
    const a = await bareAgent('has-nodes');
    await db.node.create({ data: { id: generateId(), memoryId: a.memoryId, loc: 'boot', name: 'Custom Boot', content: 'mine' } });
    await db.node.create({ data: { id: generateId(), memoryId: a.memoryId, loc: 'tasks', name: 'Gone', deletedAt: new Date() } });
    await retrofitAgentSkeletons(db);
    const boot = await nodeAt(a.memoryId, 'boot');
    expect([boot!.name, boot!.content]).toEqual(['Custom Boot', 'mine']);
    const tomb = await nodeAt(a.memoryId, 'tasks');
    expect([tomb!.name, tomb!.deletedAt === null]).toEqual(['Gone', false]);
  });

  it('option B: a derived Agent gets no node at a loc its base chain already provides', async () => {
    const base = await bareAgent('base');
    await db.node.create({ data: { id: generateId(), memoryId: base.memoryId, loc: 'boot:rules', name: 'Base Rules', content: 'base text' } });
    const child = await bareAgent('child', base.id);
    await retrofitAgentSkeletons(db);
    expect(await nodeAt(child.memoryId, 'boot:rules')).toBeNull();
    expect(await locsOf(child.memoryId)).toEqual([]);
  });

  it('option B: a base with no skeleton is seeded first, so its child skips what the base gained', async () => {
    const base = await bareAgent('base2');
    const child = await bareAgent('child2', base.id);
    await retrofitAgentSkeletons(db);
    expect(await locsOf(base.memoryId)).toEqual(LOCS.slice().sort());
    expect(await locsOf(child.memoryId)).toEqual([]);
  });

  it('a base\'s boot-prompt node is not inherited, so it does not count as provided', async () => {
    const base = await bareAgent('base3');
    await db.node.create({ data: { id: generateId(), memoryId: base.memoryId, loc: 'boot', name: 'Boot', role: 'boot-prompt' } });
    const child = await bareAgent('child3', base.id);
    await retrofitAgentSkeletons(db);
    expect((await nodeAt(child.memoryId, 'boot'))).not.toBeNull();
  });

  it('never touches an install memory or a non-system memory', async () => {
    const agent = await bareAgent('inst');
    const app = await db.app.create({ data: { id: generateId(), name: 'app-3833', urn: 'org-3833:app-3833', organizationId: orgId } });
    const install = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: 'inst-install', name: 'install', class: 'system', isInstallMemory: true, appId: app.id, installOfAgentId: agent.id, acceptsUploads: false } });
    // Defense in depth: even an Agent row pointing straight at an install memory (or a non-system one) is skipped.
    await db.agent.create({ data: { organizationId: orgId, name: 'points-at-install', urn: 'org-3833:points-at-install', systemMemoryId: install.id, visibility: 'ORGANIZATION' } });
    const other = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: 'plain-3833', name: 'plain', class: 'knowledge' } });
    await db.agent.create({ data: { organizationId: orgId, name: 'points-at-plain', urn: 'org-3833:points-at-plain', systemMemoryId: other.id, visibility: 'ORGANIZATION' } });
    await retrofitAgentSkeletons(db);
    expect(await locsOf(install.id)).toEqual([]);
    expect(await locsOf(other.id)).toEqual([]);
    expect(await locsOf(agent.memoryId)).toEqual(LOCS.slice().sort());
  });

  it('F1: a memory that stopped being a system memory after selection is skipped under the lock', async () => {
    const a = await bareAgent('stale');
    // Change class inside the window between selection and the per-Agent transaction.
    const realTx = db.$transaction.bind(db);
    const spy = vi.spyOn(db, '$transaction').mockImplementationOnce(((fn: never, o: never) => {
      return db.memory.update({ where: { id: a.memoryId }, data: { class: 'knowledge' } }).then(() => realTx(fn, o));
    }) as never);
    await retrofitAgentSkeletons(db);
    spy.mockRestore();
    expect(await locsOf(a.memoryId)).toEqual([]);
  });

  it('F2: a dry run reports exactly what apply then creates, children included', async () => {
    const base = await bareAgent('dbase');
    const child = await bareAgent('dchild', base.id);
    const dry = await retrofitAgentSkeletons(db, { dryRun: true });
    expect(dry.find((r) => r.memoryId === child.memoryId)!.created).toEqual([]);
    expect(await locsOf(base.memoryId)).toEqual([]);
    const applied = await retrofitAgentSkeletons(db);
    expect(applied.map((r) => [r.agentUrn, r.created.slice().sort()]))
      .toEqual(dry.map((r) => [r.agentUrn, r.created.slice().sort()]));
  });

  it('N1: a dry run takes no row lock on the memories, an apply does', async () => {
    await bareAgent('lockwatch');
    const seen = async (dryRun: boolean) => {
      const sqls: string[] = [];
      const realTx = db.$transaction.bind(db);
      const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: (tx: unknown) => Promise<unknown>, o: never) =>
        realTx((tx) => fn(new Proxy(tx, { get(t, k) {
          const v = Reflect.get(t, k, t);
          if (k !== '$queryRaw') return typeof v === 'function' ? v.bind(t) : v;
          return (q: readonly string[], ...r: unknown[]) => { sqls.push(Array.from(q).join('?')); return (v as (...a: unknown[]) => unknown).call(t, q, ...r); };
        } })), o)) as never);
      await retrofitAgentSkeletons(db, { dryRun });
      spy.mockRestore();
      return sqls.some((x) => /FOR UPDATE/.test(x));
    };
    expect(await seen(true)).toBe(false);
    expect(await seen(false)).toBe(true);
  });

  it('dry run writes nothing but reports what it would create', async () => {
    const a = await bareAgent('dry');
    const rows = await retrofitAgentSkeletons(db, { dryRun: true });
    expect(rows.find((r) => r.memoryId === a.memoryId)!.created.sort()).toEqual(LOCS.slice().sort());
    expect(await locsOf(a.memoryId)).toEqual([]);
  });

  it('the skeleton constant is exactly the four gate locs', () => {
    expect(AGENT_SKELETON.map((n) => n.loc)).toEqual(LOCS);
  });
});
