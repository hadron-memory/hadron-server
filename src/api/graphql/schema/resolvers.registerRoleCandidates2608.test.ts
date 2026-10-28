import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/** #2608 — independent real-Postgres pins for register role picking. */

import { buildSchema, parse, validate } from 'graphql';
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
    const install = await db.memory.create({ data: { id: generateId(), name: 'Install', urn: `${org.urn}:install`, class: 'app', appId: app.id, organizationId: org.id } });
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
  it('refuses an App outsider through the roster gate and pages all ties without changing their minimum depth', async () => {
    await mapTask(); await node(teamMemoryId, 'tasks:finish', { isRunnable: true });
    await expect(pick(outsider.id)).rejects.toBeTruthy();
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
