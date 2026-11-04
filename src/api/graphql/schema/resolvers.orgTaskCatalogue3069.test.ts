import { beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

/**
 * #3069 (R208 A, cor:api:060:04): the org Task Nodes list and the org skill export leave out App-owned memories,
 * install memories included, and keep an Agent's own system memory (#1689).
 *
 * The rule lands in the portal (seam 3): `orgTaskMemoryIds` drops every id whose `appId` is set from
 * `memories(orgId, [system])`. The server doesn't apply the rule to a named memory set, on purpose: a caller who may
 * reference an install memory still gets it. That list is how a manager finds an install record, retained ones included
 * (#2044 pin in installMemory.lifecycle.test.ts, R45), and a named set is legitimate input to findNodes and createScope.
 *
 * Test-only. These pins hold what the portal's composition relies on: the org system list carries `appId`, and the
 * filtered set gives the catalogue the rule asks for. The permissive block says why the filter must exist.
 */
const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const ORG = resolvers.Organization as any;

let orgId: string;
let orgMemoryId: string;
let agentMemoryId: string;
let installMemoryId: string;
const users: Record<string, string> = {};

// `admin` is an org READER who is also a platform ADMIN, the caller the issue's side observation names.
const context = (who: 'owner' | 'admin'): Context =>
  ({ db, userId: users[who], roles: who === 'admin' ? ['ADMIN'] : ['READER'] }) as Context;

/** The two halves of the portal's org memory set, as `orgTaskMemoryIds` requests them. */
async function portalHalves(who: 'owner' | 'admin') {
  const ctx = context(who);
  const org = await Q.organization({}, { ref: orgId }, ctx);
  const own = ((await ORG.memories(org, {}, ctx)) as { id: string }[]).map(m => m.id);
  const system = (await Q.memories({}, { orgId, filter: { memoryClasses: ['system'] }, limit: 50 }, ctx)).items as { id: string; appId: string | null }[];
  return { own, system };
}

/** The set before the fix: every system id joins. */
const unfilteredSet = async (who: 'owner' | 'admin') => {
  const { own, system } = await portalHalves(who);
  return [...own, ...system.map(m => m.id)];
};

/** The set after the fix: an id that carries an App stays out. */
const orgTaskSet = async (who: 'owner' | 'admin') => {
  const { own, system } = await portalHalves(who);
  return [...own, ...system.filter(m => m.appId == null).map(m => m.id)];
};

const listed = async (who: 'owner' | 'admin', memoryIds: string[]) => {
  const result = await Q.findNodes({}, { filter: { memoryIds, isRunnable: true } }, context(who));
  return (result.hits as { node: { loc: string } }[]).map(h => h.node.loc).sort();
};

const exported = async (who: 'owner' | 'admin', memoryRefs: string[]) => {
  const ctx = context(who);
  const scope = await M.createScope({}, { input: { name: `org-export-${who}`, organizationRef: orgId, memoryRefs } }, ctx);
  const plan = await Q.skillPlan({}, { input: { intent: 'EXPORT', host: 'claudeSkill', scopeRef: scope.id } }, ctx);
  return (plan.entries as { urn: string }[]).map(e => e.urn.split(':').slice(-2).join(':')).sort();
};

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), urn: 'catalogue3069.example', name: 'Catalogue' } })).id;
  for (const who of ['owner', 'admin'] as const) {
    users[who] = (await db.user.create({ data: { id: generateId(), handle: `catalogue3069-${who}`, roles: who === 'admin' ? ['ADMIN'] : ['READER'] } })).id;
    await db.orgMember.create({ data: { userId: users[who], organizationId: orgId, role: who === 'owner' ? 'OWNER' : 'READER' } });
  }
  const appId = (await db.app.create({ data: { id: generateId(), urn: 'catalogue3069.example:app', name: 'App', organizationId: orgId } })).id;
  agentMemoryId = (await db.memory.create({ data: { id: generateId(), urn: 'catalogue3069.example:agent-system', name: 'Agent system', class: 'system', organizationId: orgId } })).id;
  const agentId = (await db.agent.create({ data: { id: generateId(), urn: 'catalogue3069.example:agent', name: 'Agent', organizationId: orgId, systemMemoryId: agentMemoryId } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  orgMemoryId = (await db.memory.create({ data: { id: generateId(), urn: 'catalogue3069.example:org', name: 'Org tasks', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: orgId } })).id;
  installMemoryId = (await db.memory.create({ data: { id: generateId(), urn: 'catalogue3069.example:install', name: 'Install', class: 'system', organizationId: orgId, appId, isInstallMemory: true, installOfAgentId: agentId } })).id;
  const task = (memoryId: string, loc: string) => db.node.create({
    data: {
      id: generateId(), memoryId, loc, name: loc, content: `# ${loc}`, isRunnable: true,
      properties: { exports: { claudeSkill: { name: loc.replace(':', '-'), description: `Run ${loc}. Use when asked.`, enable: true } } },
    },
  });
  await task(orgMemoryId, 'tasks:org-task');
  await task(agentMemoryId, 'tasks:agent-task');
  await task(installMemoryId, 'tasks:install-task');
});

describe('#3069 what the portal filter relies on', () => {
  it('the portal can select appId on that list: the document it needs validates against the schema', () => {
    const document = parse('query($orgId: ID!) { memories(orgId: $orgId, filter: { memoryClasses: [system] }) { items { id appId } total } }');
    expect(validate(buildSchema(typeDefs), document)).toEqual([]);
  });

  it('the org system list carries appId: set on the install memory, null on the Agent system memory', async () => {
    const { system } = await portalHalves('owner');
    expect(Object.fromEntries(system.map(m => [m.id, m.appId != null]))).toEqual({ [installMemoryId]: true, [agentMemoryId]: false });
  });

  it('an org OWNER: the filtered set lists the org and Agent tasks and omits the install task', async () => {
    expect(await listed('owner', await orgTaskSet('owner'))).toEqual(['tasks:agent-task', 'tasks:org-task']);
  });

  it('an org OWNER: the skill export of the filtered set omits the install task', async () => {
    expect(await exported('owner', await orgTaskSet('owner'))).toEqual(['tasks:agent-task', 'tasks:org-task']);
  });

  it('a platform-ADMIN org member: the export of the filtered set does not fail', async () => {
    expect(await exported('admin', await orgTaskSet('admin'))).toEqual(['tasks:agent-task', 'tasks:org-task']);
  });
});

describe('#3069 a named set is taken as named, for a caller who may reference it, so the filter is the portal\'s job', () => {
  it('an org OWNER: the unfiltered set still reaches the install task, in the list and the export', async () => {
    const set = await unfilteredSet('owner');
    expect(set).toContain(installMemoryId);
    expect(await listed('owner', set)).toContain('tasks:install-task');
    expect(await exported('owner', set)).toContain('tasks:install-task');
  });

  it('a platform-ADMIN org member: createScope refuses the unfiltered set on the install memory', async () => {
    const set = await unfilteredSet('admin');
    expect(set).toContain(installMemoryId);
    await expect(exported('admin', set)).rejects.toThrow(`No match for memoryRef "${installMemoryId}"`);
  });

  it('control: passing orgId narrows the unfiltered set on the list path alone', async () => {
    const result = await Q.findNodes({}, { orgId, filter: { memoryIds: await unfilteredSet('owner'), isRunnable: true } }, context('owner'));
    expect((result.hits as { node: { loc: string } }[]).map(h => h.node.loc).sort()).toEqual(['tasks:agent-task', 'tasks:org-task']);
  });
});
