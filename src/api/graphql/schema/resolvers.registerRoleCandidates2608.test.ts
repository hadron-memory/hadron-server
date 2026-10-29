import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/** #2608 — independent real-Postgres pins for register role picking. */

import { buildSchema, parse, validate } from 'graphql';
import { agentBaseChain, agentBaseChains } from '../../../lib/agentBase.js';
import { typeDefs } from './typeDefs.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const pick = (userId = admin.id, code = 'task.finish.open-children', extra = {}) => (resolvers.Query as any).registerRoleCandidates({}, { appRef: app.id, code, ...extra }, ctx(userId));

let org: { id: string; urn: string };
let admin: { id: string };
let outsider: { id: string };
let app: { id: string };
let teamAgentId: string;
let teamMemoryId: string;


const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const worker = (name: string, agentId = teamAgentId) =>
  db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase().replaceAll(' ', '-') }, select: { id: true } });

async function node(memoryId: string, loc: string, extra: Record<string, unknown> = {}) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: '# x', ...extra } });
}
const registerEntry = (memoryId: string, code: string, taskLoc: unknown, entryCode: string = code) =>
  node(memoryId, `register:${code}`, { data: { registerEntry: { code: entryCode, taskLoc } } });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'tw-org', urn: `tw-${suffix}.example` } });
  admin = await db.user.create({ data: { githubId: 218001, githubUsername: 'tw-admin', handle: 'tw-admin', roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 218003, githubUsername: 'tw-out', handle: 'tw-out', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgentId = agent.id;
  const row = await db.agent.findUniqueOrThrow({ where: { id: teamAgentId } });
  teamMemoryId = row.systemMemoryId as string;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgentId } });
  await node(teamMemoryId, 'roles'); // the Team Agent marker (locateTeamAgent)
  await worker('Anne');
  await worker('Liam');
  await worker('Rook');
});

async function roleAgent(name: string, parent?: string) {
  const a = await M.createAgent({}, { orgId: org.id, name }, ctx(admin.id));
  if (parent) await db.agent.update({ where: { id: a.id }, data: { extendsAgentId: parent } });
  const row = await db.agent.findUniqueOrThrow({ where: { id: a.id } });
  return { id: a.id, memoryId: row.systemMemoryId as string };
}

/** A second-tenant Agent, optionally PUBLIC so the caller-side Agent read gate passes. */
async function foreignAgent(visibility?: 'PUBLIC') {
  const o = await db.organization.create({ data: { id: generateId(), name: 'Foreign', urn: `foreign-${generateId().toLowerCase()}.example` } });
  const owner = await db.user.create({ data: { handle: `owner-${generateId()}` } });
  await db.orgMember.create({ data: { organizationId: o.id, userId: owner.id, role: 'ADMIN' } });
  const a = await M.createAgent({}, { orgId: o.id, name: 'Foreign role' }, ctx(owner.id));
  if (visibility) await db.agent.update({ where: { id: a.id }, data: { visibility } });
  const row = await db.agent.findUniqueOrThrow({ where: { id: a.id } });
  return { id: a.id, memoryId: row.systemMemoryId as string };
}
const mapTask = () => registerEntry(teamMemoryId, 'task.finish.open-children', 'tasks:finish');
describe('#2608 register role candidates', () => {
  it('returns every tied nearest candidate, never chooses among ties; child override has depth zero', async () => {
    await mapTask(); const base = await roleAgent('Base'); await node(base.memoryId, 'tasks:finish', { isRunnable: true });
    const child = await roleAgent('Child', base.id); const own = await roleAgent('Own', base.id);
    await node(own.memoryId, 'tasks:finish', { isRunnable: true });
    const inherited = await worker('Inherited', child.id), direct = await worker('Direct', own.id), tie = await worker('Tie', own.id);
    await db.worker.updateMany({ where: { id: { in: [direct.id, tie.id] } }, data: { role: 'qa-engineer' } });
    const r = await pick(); expect(r.depth).toBe(0); expect(r.total).toBe(2);
    expect(r.candidates.map((x: any) => x.worker.id)).toEqual([direct.id, tie.id]);
    expect(r.candidates.map((x: any) => x.role)).toEqual(['qa-engineer', 'qa-engineer']);
    expect(r.candidates.every((x: any) => x.worker.urn && x.depth === 0)).toBe(true);
    await db.worker.updateMany({ where: { id: { in: [direct.id, tie.id] } }, data: { retiredAt: new Date() } });
    const farther = await pick(); expect(farther.depth).toBe(1); expect(farther.candidates[0].worker.id).toBe(inherited.id);
  });
  it('returns empty for unmapped code, missing task and an install-memory-only task', async () => {
    expect((await pick()).candidates).toEqual([]); await mapTask();
    expect((await pick()).total).toBe(0);
    const install = await db.memory.create({ data: { id: generateId(), name: 'Install', urn: `${org.urn}:install`, class: 'system', appId: app.id, isInstallMemory: true, installOfAgentId: teamAgentId, organizationId: org.id } });
    await node(install.id, 'tasks:finish', { isRunnable: true }); expect((await pick()).candidates).toEqual([]);
  });
  it('omits a second-tenant unreadable agent even when it holds the exact task loc', async () => {
    await mapTask(); const foreignOrg = await db.organization.create({ data: { id: generateId(), name: 'Foreign', urn: `foreign-${generateId().toLowerCase()}.example` } });
    const owner = await db.user.create({ data: { handle: `owner-${generateId()}` } });
    await db.orgMember.create({ data: { organizationId: foreignOrg.id, userId: owner.id, role: 'ADMIN' } });
    const a = await M.createAgent({}, { orgId: foreignOrg.id, name: 'Foreign role' }, ctx(owner.id));
    // The foreign Agent inherits a task readable by this caller. The Agent gate must still omit it;
    // gating only the resolved task memory would disclose the foreign role holder.
    await node(teamMemoryId, 'tasks:finish', { isRunnable: true });
    await db.agent.update({ where: { id: a.id }, data: { extendsAgentId: teamAgentId } });
    await db.worker.updateMany({ where: { appId: app.id }, data: { retiredAt: new Date() } });
    await worker('Foreign', a.id); expect((await pick()).candidates).toEqual([]);
  });
  // #2672 seats: each of the two member gates is pinned as a SOLE defense — the pin above is
  // satisfied by either gate alone, so a single-gate-strip mutant survived it (Axel/Riana/Caspian).
  it('S1: a memory-less foreign Agent extending the readable Team Agent is omitted (Agent gate alone)', async () => {
    await mapTask(); await node(teamMemoryId, 'tasks:finish', { isRunnable: true });
    const f = await foreignAgent();
    await db.agent.update({ where: { id: f.id }, data: { extendsAgentId: teamAgentId, systemMemoryId: null } });
    await db.worker.updateMany({ where: { appId: app.id }, data: { retiredAt: new Date() } });
    await worker('Foreign', f.id); expect((await pick()).candidates).toEqual([]);
  });
  it('S2: a PUBLIC foreign Agent whose own unreadable memory holds the task is omitted (memory gate alone)', async () => {
    await mapTask(); const f = await foreignAgent('PUBLIC');
    await node(f.memoryId, 'tasks:finish', { isRunnable: true });
    await db.worker.updateMany({ where: { appId: app.id }, data: { retiredAt: new Date() } });
    await worker('Foreign', f.id); expect((await pick()).candidates).toEqual([]);
  });
  // #2724 seats, Axel P2 = Riana P3-1 (their shared M3): the Team-memory read gate as a
  // reachable sole defense. Riana's probe found no participant class that FAILS it on a live
  // memory (the App fold lets every admitted participant read the Team Agent's system
  // memory), so the one real unreadable state is the soft-deleted row — forced here past
  // the write gates, because a read gate must not depend on a writer having done its job
  // (#362 class). The state has a product writer (a merge soft-deletes its source,
  // mergeMemories.ts), so the pin is reachable, not #943-dead. Stripping the gate leaks the
  // register:<code> → taskLoc mapping through the empty page's echo; the agent/marker
  // lookups stay live, so nothing upstream masks it.
  it('S3: an admitted caller learns nothing when the Team memory is unreadable (deleted row)', async () => {
    await mapTask(); await node(teamMemoryId, 'tasks:finish', { isRunnable: true });
    await db.memory.update({ where: { id: teamMemoryId }, data: { deletedAt: new Date() } });
    await expect(pick()).resolves.toMatchObject({ taskLoc: null, depth: null, total: 0, candidates: [] });
  });
  // #2724 Riana P3-6 (her M16): the read gate checks the ROOT memory, not the hit's.
  // S2 covers an own-memory hit (root and hit coincide) and S1 a memory-less foreign
  // Agent (root is the Team memory); neither fixes WHICH memory `canRead` names. A
  // PUBLIC foreign Agent with its own unreadable memory, EXTENDING the readable Team
  // Agent that holds the task, inherits a readable hit — gating that instead of the
  // root returns a cross-tenant role holder.
  it('S4: the read gate names the root memory, never the inherited hit memory', async () => {
    await mapTask(); await node(teamMemoryId, 'tasks:finish', { isRunnable: true });
    const f = await foreignAgent('PUBLIC');
    await db.agent.update({ where: { id: f.id }, data: { extendsAgentId: teamAgentId } });
    await db.worker.updateMany({ where: { appId: app.id }, data: { retiredAt: new Date() } });
    await worker('Foreign', f.id); expect((await pick()).candidates).toEqual([]);
  });
  // Riana P3-2 (her M7): a resolved task sitting in a soft-deleted base memory is dropped.
  // The child's own live memory admits the lookup and the walk keys on agents and nodes,
  // never the memory row, so the deletedAt check on the resolved task is the sole drop;
  // un-deleting proves the fixture can show what it guards.
  it('drops a candidate whose resolved task lives in a deleted memory', async () => {
    await mapTask(); const base = await roleAgent('Base'); await node(base.memoryId, 'tasks:finish', { isRunnable: true });
    const child = await roleAgent('Child', base.id); await worker('Child worker', child.id);
    await db.memory.update({ where: { id: base.memoryId }, data: { deletedAt: new Date() } });
    expect((await pick()).total).toBe(0);
    await db.memory.update({ where: { id: base.memoryId }, data: { deletedAt: null } });
    expect((await pick()).depth).toBe(1);
  });
  it('refuses an App outsider through the roster gate and pages all ties without changing their minimum depth', async () => {
    await mapTask(); await node(teamMemoryId, 'tasks:finish', { isRunnable: true });
    // Riana P3-3: the concealment code, not just any refusal — a FORBIDDEN here would
    // reveal the App exists.
    await expect(pick(outsider.id)).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
    const all = await pick(); expect(all.total).toBe(3); const one = await pick(admin.id, undefined, { limit: 1 });
    expect(one.candidates).toHaveLength(1); expect(one.total).toBe(3); expect(one.depth).toBe(0);
    const rest = await pick(admin.id, undefined, { offset: 1, limit: 2 }); expect(rest.candidates).toHaveLength(2);
    expect([...one.candidates, ...rest.candidates].map((x: any) => x.worker.id)).toEqual(all.candidates.map((x: any) => x.worker.id));
  });
  it('does not inherit boot prompts or skip a non-runnable child override to select a base task', async () => {
    await mapTask(); const base = await roleAgent('Base'); const task = await node(base.memoryId, 'tasks:finish', { isRunnable: true, role: 'boot-prompt' });
    const child = await roleAgent('Child', base.id); await worker('Child worker', child.id);
    expect((await pick()).candidates).toEqual([]);
    await db.node.update({ where: { id: task.id }, data: { role: null } });
    expect((await pick()).depth).toBe(1);
    await node(child.memoryId, 'tasks:finish', { isRunnable: false }); expect((await pick()).candidates).toEqual([]);
  });
  it('missing or ambiguous Team Agent is empty, without publishing candidate Agent identities', async () => {
    await db.node.deleteMany({ where: { memoryId: teamMemoryId } }); expect((await pick()).total).toBe(0);
    await node(teamMemoryId, 'roles'); const second = await roleAgent('Second team');
    await db.appAgent.create({ data: { appId: app.id, agentId: second.id } }); await node(second.memoryId, 'roles');
    expect(await pick()).toMatchObject({ total: 0, candidates: [] });
  });

  it('counts Agent depth even when an intermediate Agent contributes no system memory', async () => {
    await mapTask(); const base = await roleAgent('Base'); await node(base.memoryId, 'tasks:finish', { isRunnable: true });
    const middle = await roleAgent('Middle', base.id); const child = await roleAgent('Child', middle.id);
    await db.agent.update({ where: { id: middle.id }, data: { systemMemoryId: null } });
    const w = await worker('Child worker', child.id); const r = await pick(); expect(r.depth).toBe(2); expect(r.candidates[0].worker.id).toBe(w.id);
  });
  // Axel P3 (#2724 LOCAL): depth counts Agent links, and the walk (agentBaseChain[s])
  // deliberately does NOT filter deleted rows — only memory contribution does. A
  // soft-deleted intermediate therefore still carries depth; pinned as intended behavior.
  it('counts depth through a soft-deleted intermediate Agent', async () => {
    await mapTask(); const base = await roleAgent('Base'); await node(base.memoryId, 'tasks:finish', { isRunnable: true });
    const middle = await roleAgent('Middle', base.id); const child = await roleAgent('Child', middle.id);
    await db.agent.update({ where: { id: middle.id }, data: { deletedAt: new Date() } });
    const w = await worker('Child worker', child.id); const r = await pick(); expect(r.depth).toBe(2); expect(r.candidates[0].worker.id).toBe(w.id);
  });
  // Atilla P2 (#2724 BLIND): the tie minimum needs every roster Agent evaluated, so the
  // WORK is bounded instead of the roster — 30 distinct memory-less Agents over one shared
  // base, 60 workers: the agent-row reads collapse to the two batched queries (gate rows +
  // chain-member memories) and the recursive walk fires once, whatever the roster size.
  // The per-Agent gate stays per-Agent by review (same semantics, S1/M1 covers it).
  // Masked mutant, documented: dropping `, depth` from the walk's ORDER BY survives —
  // the recursive CTE emits depth-ascending per root under every plan these fixtures
  // produce, so the sort key is unobservable today (the GraphQL arm's mutant-A class).
  it('evaluates a large roster set-wise: two agent-row queries, one chain walk', async () => {
    await mapTask(); const base = await roleAgent('Base'); await node(base.memoryId, 'tasks:finish', { isRunnable: true });
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const child = await roleAgent(`Child ${i}`, base.id);
      await db.agent.update({ where: { id: child.id }, data: { systemMemoryId: null } });
      ids.push(child.id);
      await worker(`W ${i}a`, child.id); await worker(`W ${i}b`, child.id);
    }
    // The batched walk is the singular walk per root, nearest first, roots kept apart.
    const batched = await agentBaseChains(db, ids);
    for (const id of ids) expect(batched.get(id)).toEqual(await agentBaseChain(db, id));
    const calls: string[] = [];
    const traced = db.$extends({ query: { $allOperations: async ({ model, operation, args, query }) => {
      calls.push(`${model ?? 'raw'}:${operation}:${model ? '' : JSON.stringify(args).includes('WITH RECURSIVE up') ? 'up' : ''}`);
      return query(args);
    } } }) as unknown as typeof db;
    const r = await (resolvers.Query as any).registerRoleCandidates({}, { appRef: app.id, code: 'task.finish.open-children' }, { db: traced, userId: admin.id, roles: ['READER'] } as Context);
    expect(r.total).toBe(60); expect(r.depth).toBe(1);
    // Prisma reports the model PascalCase. Four Agent reads total, all constant in roster
    // size: locateTeamAgent's nested agent select, the gate-row batch, the chain-member
    // memory batch, and one inside the shared memory-gate fold. The singular code ran two
    // MORE PER DISTINCT AGENT (60 here); what still scales per Agent is the reviewed
    // per-agent access predicate (OrgMember reads), not the roster walk.
    expect(calls.filter((c) => c.startsWith('Agent:')).length).toBeLessThanOrEqual(4);
    expect(calls.filter((c) => c === 'raw:$queryRaw:up')).toHaveLength(1);
  });

  // Atilla P2, residual (#2724 BLIND delta at df7e1da6): the shared-base fixture
  // above bounds nothing once every roster Agent contributes its OWN memory —
  // the effective-loc and hit reads were still one per DISTINCT root, sequential,
  // before pagination. This pin gives 30 Agents 30 distinct memories, each
  // holding its own runnable task: the set-wise rewrite answers every root with
  // ONE walk (memup) and every hit row with ONE read; the only singular effective
  // walk left in the request is the register entry's own lookup.
  it('resolves independent contributing memories set-wise: one effective walk, one hit read', async () => {
    await mapTask();
    for (let i = 0; i < 30; i++) {
      const a = await roleAgent(`Solo ${i}`);
      await node(a.memoryId, 'tasks:finish', { isRunnable: true });
      await worker(`Solo ${i}a`, a.id); await worker(`Solo ${i}b`, a.id);
    }
    const calls: string[] = [];
    const mark = (args: unknown): string => {
      const s = JSON.stringify(args) ?? '';
      return s.includes('WITH RECURSIVE memup') ? 'memup'
        : s.includes('WITH RECURSIVE chain') ? 'chain'
        : s.includes('WITH RECURSIVE up') ? 'up' : '';
    };
    const traced = db.$extends({ query: { $allOperations: async ({ model, operation, args, query }) => {
      calls.push(`${model ?? 'raw'}:${operation}:${model ? '' : mark(args)}`);
      return query(args);
    } } }) as unknown as typeof db;
    const r = await (resolvers.Query as any).registerRoleCandidates({}, { appRef: app.id, code: 'task.finish.open-children' }, { db: traced, userId: admin.id, roles: ['READER'] } as Context);
    expect(r.total).toBe(60); expect(r.depth).toBe(0);
    expect(calls.filter((c) => c === 'raw:$queryRaw:memup')).toHaveLength(1);
    expect(calls.filter((c) => c === 'raw:$queryRaw:chain')).toHaveLength(1);
    expect(calls.filter((c) => c === 'Node:findMany:')).toHaveLength(1);
    expect(calls.filter((c) => c === 'Node:findUnique:')).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('Agent:')).length).toBeLessThanOrEqual(4);
  });

  // Axel M9 (#2724 LOCAL delta): the root is keyed by its inheritRoot flag — one
  // memory can be its owner's OWN root and a memory-less child's INHERITED root
  // at once, and the two answers must not collapse into one. A boot-prompt task
  // at the shared memory decides it: an own pos-1 node is exempt from the role
  // filter, an inherited pos-1 node is not.
  it('keys a shared first memory by its inheritRoot flag: the owner sees a boot-prompt task, the memory-less child does not', async () => {
    await mapTask();
    const owner = await roleAgent('Owner');
    await node(owner.memoryId, 'tasks:finish', { isRunnable: true, role: 'boot-prompt' });
    const child = await roleAgent('Flag child', owner.id);
    await db.agent.update({ where: { id: child.id }, data: { systemMemoryId: null } });
    const ow = await worker('Aowner worker', owner.id);
    // Name-sorted AFTER the owner: a dropped flag lets whichever Agent the roster
    // reaches LAST win the shared key, and only this order makes the wrong answer
    // observable (the owner would silently inherit the child's filtered lookup).
    await worker('Zflag child worker', child.id);
    const r = await pick();
    expect(r.depth).toBe(0);
    expect(r.candidates.map((x: any) => x.worker.id)).toEqual([ow.id]);
  });

  // #2724 Riana P3-5 (her M10): the mirror of the flag pin above — there the OWN ask
  // resolves and the inherited one must not; here ONLY the inherited ask resolves to a
  // runnable task. The base holds a non-runnable boot-prompt at the task loc: its own
  // ask is exempt from the role filter and hits it (then drops on runnable), the
  // memory-less child's inherited ask filters pos 1 and resolves the grand-base's task.
  it('the inherited ask resolves through a base node the own ask would hit', async () => {
    await mapTask();
    const grand = await roleAgent('P3 grand'); await node(grand.memoryId, 'tasks:finish', { isRunnable: true });
    const base = await roleAgent('P3 base', grand.id);
    await node(base.memoryId, 'tasks:finish', { isRunnable: false, role: 'boot-prompt' });
    const child = await roleAgent('P3 child', base.id);
    await db.agent.update({ where: { id: child.id }, data: { systemMemoryId: null } });
    const cw = await worker('A child', child.id); await worker('B base', base.id);
    const r = await pick();
    expect(r.depth).toBe(2);
    expect(r.candidates.map((x: any) => x.worker.id)).toEqual([cw.id]);
  });

  // Axel M11: `agentBaseChains` carries its own MAX_WALK, and no fixture held a
  // chain AT the cap, so drift between the batched and singular walks was
  // unobserved. A full 4-Agent chain (the cap counts the Agent itself) with the
  // task at the farthest base pins parity with the singular walk and the depth
  // it reports through the resolver.
  it('walks a full-cap chain identically to the singular walk: the farthest base still contributes at depth 3', async () => {
    await mapTask();
    const base = await roleAgent('Cap base'); await node(base.memoryId, 'tasks:finish', { isRunnable: true });
    const m1 = await roleAgent('Cap m1', base.id);
    const m2 = await roleAgent('Cap m2', m1.id);
    const child = await roleAgent('Cap child', m2.id);
    const w = await worker('Cap child worker', child.id);
    expect((await agentBaseChains(db, [child.id])).get(child.id)).toEqual(await agentBaseChain(db, child.id));
    const r = await pick();
    expect(r.depth).toBe(3);
    expect(r.candidates.map((x: any) => x.worker.id)).toEqual([w.id]);
  });

  // Axel M12: the chain-member memory lookup keeps `deletedAt: null`, so a
  // soft-deleted Agent never contributes a memory — here as the FIRST memory a
  // memory-less child would read. A soft-deleted base directly under the child is
  // defense-in-depth (the org read gate refuses its memory too, proven while
  // pinning), so the sole-defense shape carries a LIVE grand-base with the task:
  // the correct code skips the deleted Agent and roots at the grand-base (hit,
  // depth 2); a dropped filter roots at the deleted Agent's own memory and dies at
  // its read gate — the wrong root, observable as zero.
  it('a soft-deleted intermediate is skipped for the first memory: the nearest live base contributes', async () => {
    await mapTask();
    const grand = await roleAgent('Del grand'); await node(grand.memoryId, 'tasks:finish', { isRunnable: true });
    const base = await roleAgent('Del base', grand.id);
    const child = await roleAgent('Del child', base.id);
    await db.agent.update({ where: { id: child.id }, data: { systemMemoryId: null } });
    const w = await worker('Del child worker', child.id);
    await db.agent.update({ where: { id: base.id }, data: { deletedAt: new Date() } });
    const r = await pick();
    expect(r.total).toBe(1); expect(r.depth).toBe(2);
    expect(r.candidates.map((x: any) => x.worker.id)).toEqual([w.id]);
  });

  it('exposes only the closed paginated projection in the GraphQL schema', () => {
    const query = parse('{ registerRoleCandidates(appRef: "app", code: "code", limit: 20, offset: 0) { appId code taskLoc depth total candidates { role depth taskUrn worker { id kind name urn } } } }');
    expect(validate(buildSchema(typeDefs), query)).toEqual([]);
  });

  it('a memory-less child still treats the first contributing base as inherited', async () => {
    await mapTask(); const base = await roleAgent('Base'); const task = await node(base.memoryId, 'tasks:finish', { isRunnable: true, role: 'boot-prompt' });
    const child = await roleAgent('Child', base.id); await db.agent.update({ where: { id: child.id }, data: { systemMemoryId: null } });
    await worker('Child worker', child.id); expect((await pick()).candidates).toEqual([]);
    await db.node.update({ where: { id: task.id }, data: { role: null } }); expect((await pick()).depth).toBe(1);
  });

});
