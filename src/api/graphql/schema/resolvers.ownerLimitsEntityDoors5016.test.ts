/**
 * #5016 (Billing A7c): the memory, Agent and App doors ask `requireOwnerHeadroom`. Real database, the real resolvers.
 * Each refusing case fails on main (the row is created); the "never refused" cases pass on main and stay as guards.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { cleanDb } from '../../../test/helpers.js';
import { reloadOwnerDefaultLimitsForTests } from '../../../lib/ownerLimits/defaults.js';
import { OWNER_LIMIT_KEYS, memoryCountsAgainstOwner } from '../../../lib/ownerLimits/keys.js';
import { resolvers, type Context } from './resolvers.js';

let admin: { id: string };
let contributor: { id: string };
let org: { id: string; urn: string };
let org2: { id: string; urn: string };
let seq = 0;

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const defaults = (value: unknown) => reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: JSON.stringify(value) });
const M = resolvers.Mutation as Record<string, (...a: never[]) => Promise<any>>;
const call = (name: string, args: Record<string, unknown>, userId = admin.id) => (M[name] as any)(null, args, ctx(userId));
const REACHED = { extensions: { code: 'OWNER_LIMIT_REACHED' } };
const orgMemory = (organizationId = org.id) => call('createMemory', { orgRef: organizationId, name: `m${++seq}` });
const userMemory = (userId = admin.id, memoryClass = 'private') => call('createMemory', { name: `u${++seq}`, memoryClass }, userId);

beforeEach(async () => {
  await cleanDb(db);
  defaults({});
  admin = await db.user.create({ data: { id: generateId(), handle: 'door-admin', roles: ['READER'] } });
  contributor = await db.user.create({ data: { id: generateId(), handle: 'door-contrib', roles: ['READER'] } });
  org = await db.organization.create({ data: { id: generateId(), name: 'Door Org', urn: 'door-org' } });
  org2 = await db.organization.create({ data: { id: generateId(), name: 'Door Org Two', urn: 'door-org-two' } });
  for (const o of [org, org2]) await db.orgMember.create({ data: { id: generateId(), organizationId: o.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' } });
});
afterEach(() => reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }));

describe('#5016 createMemory', () => {
  it('refuses the second free-standing memory of a person at memories: 1 and writes nothing', async () => {
    defaults({ user: { memories: 1 } });
    await userMemory();
    await expect(userMemory()).rejects.toMatchObject(REACHED);
    expect(await db.memory.count({ where: { ownerUserId: admin.id } })).toBe(1);
  });

  it('an explicit row with a null limit lifts the cap', async () => {
    defaults({ user: { memories: 1 } });
    await db.ownerLimit.create({ data: { id: generateId(), key: 'memories', limitValue: null, sourceType: 'manual', sourceId: 't', note: 'n', ownerUserId: admin.id } });
    await userMemory();
    await userMemory();
    expect(await db.memory.count({ where: { ownerUserId: admin.id } })).toBe(2);
  });

  it('two concurrent calls one below the limit end with exactly one success (organization-owned: no handle root to race on)', async () => {
    defaults({ organization: { memories: 1 } });
    const results = await Promise.allSettled([orgMemory(), orgMemory()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as { extensions: { code: string } }).extensions.code).toBe('OWNER_LIMIT_REACHED');
    expect(await db.memory.count({ where: { organizationId: org.id } })).toBe(1);
  });

  it('shows the number to an organization admin and none to a contributor creating a personal memory', async () => {
    defaults({ organization: { memories: 1 } });
    await orgMemory();
    const asAdmin = await orgMemory().catch((e: unknown) => e as { extensions: Record<string, unknown>; message: string });
    expect(asAdmin.extensions).toMatchObject({ code: 'OWNER_LIMIT_REACHED', callerCanManageOwner: true, limit: '1', ownerId: org.id });
    const asContributor = await call('createMemory', { orgRef: org.id, name: 'cm', memoryClass: 'personal' }, contributor.id).catch((e: unknown) => e as { extensions: Record<string, unknown>; message: string });
    expect(asContributor.extensions).toMatchObject({ code: 'OWNER_LIMIT_REACHED', callerCanManageOwner: false });
    expect(asContributor.extensions).not.toHaveProperty('limit');
    expect(asContributor.extensions).not.toHaveProperty('ownerId');
    expect(asContributor.message).not.toMatch(/\d/);
  });

  it('an owner over its cap can still delete, and deleting lets the next creation through at once', async () => {
    defaults({ user: { memories: 1 } });
    const first = await userMemory();
    await expect(userMemory()).rejects.toMatchObject(REACHED);
    await call('deleteMemory', { ref: first.id });
    await expect(userMemory()).resolves.toBeTruthy();
  });

  it('with OWNER_DEFAULT_LIMITS unset nothing is refused', async () => {
    await userMemory();
    await userMemory();
    await orgMemory();
    await orgMemory();
  });
});

describe('#5016 createAgent', () => {
  it('is refused at agents: 1 and the refused Agent leaves no system memory and no skeleton', async () => {
    defaults({ organization: { agents: 1 } });
    await call('createAgent', { orgRef: org.id, name: 'first' });
    const memories = await db.memory.count();
    const nodes = await db.node.count();
    await expect(call('createAgent', { orgRef: org.id, name: 'second' })).rejects.toMatchObject(REACHED);
    expect(await db.agent.count({ where: { organizationId: org.id } })).toBe(1);
    expect(await db.memory.count()).toBe(memories);
    expect(await db.node.count()).toBe(nodes);
  });

  it('the system memory of a new Agent is never counted: memories: 0 does not refuse createAgent', async () => {
    defaults({ organization: { memories: 0 } });
    await expect(call('createAgent', { orgRef: org.id, name: 'free-system-memory' })).resolves.toBeTruthy();
  });
});

describe('#5016 createApp', () => {
  it('is refused at apps: 1 and writes no App', async () => {
    defaults({ organization: { apps: 1 } });
    const agent = await call('createAgent', { orgRef: org.id, name: 'solo' });
    await call('createApp', { orgRef: org.id, agentRef: agent.id, name: 'one', urn: 'one' });
    await expect(call('createApp', { orgRef: org.id, agentRef: agent.id, name: 'two', urn: 'two' })).rejects.toMatchObject(REACHED);
    expect(await db.app.count({ where: { organizationId: org.id, deletedAt: null } })).toBe(1);
  });

  it('a cascade that would exceed the cap is refused before ANY App is written', async () => {
    const parent = await call('createAgent', { orgRef: org.id, name: 'parent' });
    const dep = await call('createAgent', { orgRef: org.id, name: 'dep' });
    await db.agentOrgGrant.create({ data: { orgId: org.id, agentId: dep.id, activatedAt: new Date() } });
    await db.agentImport.create({ data: { parentAgentId: parent.id, importedAgentId: dep.id, position: 100, required: true, agentOrgGrantOrgId: org.id, agentOrgGrantAgentId: dep.id } });
    defaults({ organization: { apps: 1 } });
    await expect(call('createApp', { orgRef: org.id, agentRef: parent.id, name: 'cascade', urn: 'cascade' })).rejects.toMatchObject(REACHED);
    expect(await db.app.count({ where: { organizationId: org.id } })).toBe(0);
    defaults({ organization: { apps: 2 } });
    await call('createApp', { orgRef: org.id, agentRef: parent.id, name: 'cascade', urn: 'cascade' });
    expect(await db.app.count({ where: { organizationId: org.id, deletedAt: null } })).toBe(2);
  });
});

describe('#5016 createApp reuses an existing dependency App', () => {
  it('asks only for the App itself when every dependency already has an App in the organization', async () => {
    const parent = await call('createAgent', { orgRef: org.id, name: 'parent2' });
    const dep = await call('createAgent', { orgRef: org.id, name: 'dep2' });
    await db.agentOrgGrant.create({ data: { orgId: org.id, agentId: dep.id, activatedAt: new Date() } });
    await db.agentImport.create({ data: { parentAgentId: parent.id, importedAgentId: dep.id, position: 100, required: true, agentOrgGrantOrgId: org.id, agentOrgGrantAgentId: dep.id } });
    await call('createApp', { orgRef: org.id, agentRef: dep.id, name: 'dep-app', urn: 'dep-app' });
    defaults({ organization: { apps: 2 } });
    await expect(call('createApp', { orgRef: org.id, agentRef: parent.id, name: 'parent-app', urn: 'parent-app' })).resolves.toBeTruthy();
    expect(await db.app.count({ where: { organizationId: org.id, deletedAt: null } })).toBe(2);
  });
});

describe('#5016 cloneMemory and cloneAgent', () => {
  it('cloneMemory into an organization at memories: 1 is refused and writes no memory', async () => {
    const src = await orgMemory();
    defaults({ organization: { memories: 1 } });
    await orgMemory(org2.id);
    const before = await db.memory.count();
    await expect(call('cloneMemory', { ref: src.id, targetUrn: `hrn:mem:${org2.urn}:copy` })).rejects.toMatchObject(REACHED);
    expect(await db.memory.count()).toBe(before);
  });

  it('cloneAgent into an organization at agents: 1 is refused, while its system memory is never what counts', async () => {
    const src = await call('createAgent', { orgRef: org.id, name: 'src' });
    await db.agent.update({ where: { id: src.id }, data: { visibility: 'PUBLIC' } });
    defaults({ organization: { agents: 1, memories: 0 } });
    await call('createAgent', { orgRef: org2.id, name: 'occupant' });
    const before = { agents: await db.agent.count(), memories: await db.memory.count() };
    await expect(call('cloneAgent', { source: src.urn, target: org2.urn })).rejects.toMatchObject(REACHED);
    expect({ agents: await db.agent.count(), memories: await db.memory.count() }).toEqual(before);
    defaults({ organization: { agents: 5, memories: 0 } });
    await expect(call('cloneAgent', { source: src.urn, target: org2.urn })).resolves.toBeTruthy();
  });
});

describe('#5016 extractParentNodeToMemory', () => {
  it('into an organization at memories: 1 is refused and moves no node', async () => {
    const src = await orgMemory();
    const parent = await db.node.create({ data: { id: generateId(), memoryId: src.id, loc: 'p', name: 'p', tags: [] } });
    await db.node.create({ data: { id: generateId(), memoryId: src.id, loc: 'p:c', name: 'c', tags: [] } });
    // A new memory has no root node (#3952), so the source needs a node outside the subtree or the move is refused as emptying it.
    await db.node.create({ data: { id: generateId(), memoryId: src.id, loc: 'keep', name: 'keep', tags: [] } });
    defaults({ organization: { memories: 1 } });
    await orgMemory(org2.id);
    const liveBefore = await db.node.count({ where: { memoryId: src.id, deletedAt: null } });
    await expect(call('extractParentNodeToMemory', { parentRef: parent.id, targetUrn: `hrn:mem:${org2.urn}:extracted`, move: true })).rejects.toMatchObject(REACHED);
    expect(await db.node.count({ where: { memoryId: src.id, deletedAt: null } })).toBe(liveBefore);
    expect(await db.memory.count({ where: { urn: `${org2.urn}:extracted` } })).toBe(0);
  });
});

describe('#5016 transferMemoryOwnership', () => {
  const mk = async (nodes = 0) => {
    const m = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `door-org:t${++seq}`, name: 't', class: 'knowledge' } });
    for (let i = 0; i < nodes; i++) await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: `n${i}`, name: 'n', tags: [] } });
    return m;
  };
  const input = (memoryId: string) => ({ memoryRef: memoryId, orgRef: org2.id, targetClass: 'knowledge' });

  it('is refused when the receiving owner would exceed memories, the source is unchanged, and dryRun shows it as a blocker', async () => {
    defaults({ organization: { memories: 1 } });
    await orgMemory(org2.id);
    const m = await mk();
    const preview = await call('transferMemoryOwnership', { ...input(m.id), dryRun: true });
    expect(preview.canApply).toBe(false);
    expect(preview.blockers).toEqual([{ code: 'OWNER_LIMIT_REACHED', message: 'This organization has reached its limit of 1 memory.' }]);
    await expect(call('transferMemoryOwnership', input(m.id))).rejects.toMatchObject(REACHED);
    expect(await db.memory.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ organizationId: org.id, urn: m.urn });
  });

  it('a dryRun by a platform admin into another person\'s namespace shows the blocker WITHOUT the number, and apply refuses in the same form', async () => {
    // The caller cannot manage the receiving owner (another person), so neither the preview nor the refusal may carry the number.
    defaults({ user: { memories: 1 } });
    await db.user.update({ where: { id: admin.id }, data: { roles: ['ADMIN'] } });
    await db.memory.create({ data: { id: generateId(), ownerUserId: contributor.id, userId: contributor.id, urn: 'door-contrib:held', name: 'held', class: 'private' } });
    const src = await mk();
    const args = { memoryRef: src.id, userRef: contributor.id, targetClass: 'private' };
    const platform = { db, userId: admin.id, roles: ['ADMIN'] } as unknown as Context;
    const preview = await resolvers.Mutation.transferMemoryOwnership(null, { ...args, dryRun: true } as never, platform);
    expect(preview.blockers).toEqual([{ code: 'OWNER_LIMIT_REACHED', message: 'The owner of this memory has reached a limit of their account.' }]);
    const refused = await resolvers.Mutation.transferMemoryOwnership(null, args as never, platform).catch((e: unknown) => e as { message: string; extensions: Record<string, unknown> });
    expect(refused.extensions).toMatchObject({ code: 'OWNER_LIMIT_REACHED', callerCanManageOwner: false });
    expect(refused.message).toBe(preview.blockers[0].message);
    expect((await db.memory.findUniqueOrThrow({ where: { id: src.id } })).organizationId).toBe(org.id);
  });

  it('is refused when the live nodes it brings exceed nodes', async () => {
    defaults({ organization: { nodes: 2 } });
    const m = await mk(3);
    await expect(call('transferMemoryOwnership', input(m.id))).rejects.toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED', limitKey: 'nodes' } });
    expect((await db.memory.findUniqueOrThrow({ where: { id: m.id } })).organizationId).toBe(org.id);
  });

  it('a transfer that fits succeeds, and a transfer to the same owner is not judged by the limit', async () => {
    defaults({ organization: { memories: 1, nodes: 5 } });
    await orgMemory(org.id);
    const m = await mk(2);
    await expect(call('transferMemoryOwnership', input(m.id))).resolves.toMatchObject({ applied: true });
    const same = await call('transferMemoryOwnership', { memoryRef: m.id, orgRef: org2.id, targetClass: 'knowledge', dryRun: true });
    expect(same.blockers.map((b: { code: string }) => b.code)).toEqual(['MEMORY_TRANSFER_SAME_OWNER']);
  });
});

describe('#5016 the counts-as-a-memory predicate agrees with the SQL count', () => {
  it('shape by shape: each row alone in its own organization counts 1 or 0 exactly as the predicate says', async () => {
    const holder = await db.app.create({ data: { id: generateId(), name: 'p', urn: 'door-org:p', organizationId: org.id } as never });
    const created: Array<{ cls: string; withApp: boolean; install: boolean; counts: boolean }> = [];
    const missing: string[] = [];
    for (const cls of ['knowledge', 'group', 'personal', 'private', 'system', 'app']) {
      const personal = cls === 'personal' || cls === 'private';
      for (const withApp of [false, true]) for (const install of [false, true]) {
        const label = `${cls}/app=${withApp}/install=${install}`;
        const solo = await db.organization.create({ data: { id: generateId(), name: `solo${++seq}`, urn: `solo-${seq}` } });
        try {
          await db.memory.create({ data: {
            id: generateId(), organizationId: solo.id, urn: `solo-${seq}:m`, name: 's', class: cls, isInstallMemory: install,
            ...(withApp ? { appId: holder.id } : {}), ...(personal ? { userId: admin.id } : {}),
          } as never });
        } catch (e) {
          // Only a shape the database's own CHECK constraints refuse is skipped, and it is named.
          if ((e as { code?: string }).code !== 'P2010' && !/check constraint/i.test(String((e as Error).message))) throw e;
          missing.push(label);
          continue;
        }
        const counts = memoryCountsAgainstOwner({ class: cls, appId: withApp ? holder.id : null, isInstallMemory: install });
        expect(await OWNER_LIMIT_KEYS.memories.count(db, { organizationId: solo.id }), label).toBe(counts ? 1n : 0n);
        created.push({ cls, withApp, install, counts });
      }
    }
    // The four counting classes exist as a plain free-standing row, and at least one excluded shape of each reason was really created.
    for (const cls of ['knowledge', 'group', 'personal', 'private']) expect(created.some((c) => c.cls === cls && !c.withApp && !c.install && c.counts), cls).toBe(true);
    expect(created.some((c) => c.withApp && !c.counts)).toBe(true);
    expect(created.some((c) => c.install && !c.counts)).toBe(true);
    expect(created.some((c) => c.cls === 'system' && !c.counts)).toBe(true);
    // The rest are shapes the schema itself forbids (listed in the failure message if this ever changes).
    expect(created.length, `refused by constraints: ${missing.join(', ')}`).toBeGreaterThanOrEqual(9);
  });
});
