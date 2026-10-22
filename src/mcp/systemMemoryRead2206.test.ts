/**
 * #2206 case 3 — App participants (members, org CONTRIBUTOR+) read the system memory of EVERY Agent installed and
 * licensed in the App, read-only, not only the first-installed one (cor:acl:010:01, Vera 6319156558). Nothing else
 * widens: no write, no item memories, no run or App-key reach, no unlicensed or uninstalled Agent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import { canReadMemory, canWriteToMemory } from './access-control.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { getAccessibleMemoryIds } from '../api/graphql/schema/resolvers.helpers.js';
import { systemMemoryReadGrants } from '../lib/auth/systemMemoryRead.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
type User = { id: string };
let org: { id: string };
let app: { id: string };
let admin: User, member: User, contributor: User, reader: User, outsider: User;
let primary: { id: string; systemMemoryId: string };
let second: { id: string; systemMemoryId: string };
let item: { id: string };

const authOf = (userId: string, extra: Partial<AuthContext> = {}) => ({ userId, roles: ['READER'], clientId: `user:${userId}`, ...extra }) as AuthContext;
const user = async (name: string) => db.user.create({ data: { id: generateId(), name, handle: `${name}-${generateId().slice(-6).toLowerCase()}`, roles: ['READER'] } });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'SR Org', urn: `sr-${generateId().toLowerCase()}.example` } });
  [admin, member, contributor, reader, outsider] = await Promise.all(['admin', 'member', 'contrib', 'reader', 'outsider'].map(user));
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
  ] });
  const ctx = { db, userId: admin.id, roles: ['READER'] } as unknown as Context;
  const a = await M.createAgent({}, { orgId: org.id, name: 'Primary' }, ctx);
  const b = await M.createAgent({}, { orgId: org.id, name: 'Second' }, ctx);
  primary = { id: a.id, systemMemoryId: a.systemMemoryId };
  second = { id: b.id, systemMemoryId: b.systemMemoryId };
  ({ app } = await createDbAppWithKey(db, 'sr-app', org.id));
  await createDbAppAgent(db, app.id, primary.id);
  await createDbAppAgent(db, app.id, second.id);
  await createDbAppMember(db, app.id, member.id, 'member');
  // The second Agent's item memory: its reach through the App is unchanged by this rule.
  item = await db.memory.create({ data: { id: generateId(), class: 'knowledge', name: 'item', urn: `${org.id.toLowerCase()}:sr-item`, organizationId: org.id, appId: app.id } });
  await db.agentMemoryItem.create({ data: { id: generateId(), agentId: second.id, memoryId: item.id, role: 'read-write' } });
});

describe('#2206 case 3: the App participant read fold', () => {
  it('a member and an org CONTRIBUTOR read the second Agent\'s system memory, selected App or not; read-only', async () => {
    for (const who of [member, contributor]) {
      for (const auth of [authOf(who.id), authOf(who.id, { appId: app.id })]) {
        expect(await canReadMemory(db, auth, second.systemMemoryId)).toBe(true);
        expect(await canReadMemory(db, auth, primary.systemMemoryId)).toBe(true);
        expect(await canWriteToMemory(db, auth, second.systemMemoryId)).toBe(false);
      }
      const ids = await getAccessibleMemoryIds({ db, userId: who.id, roles: ['READER'] } as unknown as Context);
      expect(ids).toContain(second.systemMemoryId); // the list gate agrees with the point gate
      // and the GraphQL record gate (the memory row itself) admits the same participant, read-only
      const grants = await systemMemoryReadGrants(db, { userId: who.id, roles: ['READER'] }, second.systemMemoryId);
      expect(grants.some((g) => g.source === 'APP_MEMBER')).toBe(true);
      expect(grants.every((g) => !g.caps.write)).toBe(true);
    }
    expect(await systemMemoryReadGrants(db, { userId: reader.id, roles: ['READER'] }, second.systemMemoryId)).toEqual([]);
  });

  it('no reach for non-participants, runs, or App keys; the item memory is not widened', async () => {
    for (const who of [reader, outsider]) expect(await canReadMemory(db, authOf(who.id), second.systemMemoryId)).toBe(false);
    const run = { userId: member.id, appId: app.id, roles: [], clientId: `run:${generateId()}` } as AuthContext;
    expect(await canReadMemory(db, run, second.systemMemoryId)).toBe(false);
    const appKey = { appId: app.id, roles: [], clientId: 'app' } as AuthContext;
    expect(await canReadMemory(db, appKey, second.systemMemoryId)).toBe(false);
    const contributorItem = await canReadMemory(db, authOf(contributor.id), item.id);
    expect(contributorItem).toBe(false);
  });

  it('an unlicensed Agent, an uninstalled Agent, and an uninstalled App grant nothing', async () => {
    const other = await db.organization.create({ data: { id: generateId(), name: 'SR Other', urn: `sro-${generateId().toLowerCase()}.example` } });
    const otherAdmin = await user('other-admin');
    await db.orgMember.create({ data: { organizationId: other.id, userId: otherAdmin.id, role: 'ADMIN' } });
    const foreign = await M.createAgent({}, { orgId: other.id, name: 'Foreign' }, { db, userId: otherAdmin.id, roles: ['READER'] } as unknown as Context);
    await createDbAppAgent(db, app.id, foreign.id); // installed, but no AgentOrgGrant: unlicensed
    expect(await canReadMemory(db, authOf(member.id), foreign.systemMemoryId)).toBe(false);
    await db.appAgent.deleteMany({ where: { appId: app.id, agentId: second.id } });
    expect(await canReadMemory(db, authOf(member.id), second.systemMemoryId)).toBe(false);
    await db.appAgent.create({ data: { appId: app.id, agentId: second.id } });
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    expect(await canReadMemory(db, authOf(member.id), second.systemMemoryId)).toBe(false);
  });
});

describe('#2233 LOCAL P2 (Xan): only an Agent\'s OWN definition enters the participant fold', () => {
  it('a second Agent whose pointer names another class, another tenant, or an install memory contributes nothing', async () => {
    const other = await db.organization.create({ data: { id: generateId(), name: 'SR Foreign', urn: `srf-${generateId().toLowerCase()}.example` } });
    const foreignSys = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'foreign-def', urn: `${other.id.toLowerCase()}:def`, organizationId: other.id } });
    const knowledge = await db.memory.create({ data: { id: generateId(), class: 'knowledge', name: 'kn', urn: `${org.id.toLowerCase()}:sr-kn`, organizationId: org.id, visibility: 'ORGANIZATION' } });
    const installRow = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'inst', urn: `${org.id.toLowerCase()}:sr-inst`, organizationId: org.id, appId: app.id, installOfAgentId: second.id, isInstallMemory: true } });
    for (const [i, target] of [foreignSys, knowledge, installRow].entries()) {
      const bad = await db.agent.create({ data: { id: generateId(), name: `Bad ${i}`, urn: `${org.id.toLowerCase()}:bad-${i}`, organizationId: org.id, systemMemoryId: target.id } });
      await createDbAppAgent(db, app.id, bad.id);
    }
    // The fold itself (what both the content/list gate and the record gate draw from) never offers a mismatched row.
    const { participantSystemMemoryFolds } = await import('./access-control.js');
    const folded = new Set((await participantSystemMemoryFolds(db, authOf(member.id))).flatMap(({ map }) => [...map.keys()]));
    for (const row of [foreignSys, knowledge, installRow]) expect(folded.has(row.id), row.name).toBe(false);
    expect(folded.has(second.systemMemoryId)).toBe(true); // the valid second Agent still folds
    for (const who of [member, contributor]) {
      expect(await canReadMemory(db, authOf(who.id), foreignSys.id)).toBe(false);
      expect(await systemMemoryReadGrants(db, { userId: who.id, roles: ['READER'] }, foreignSys.id)).toEqual([]);
      expect(await canReadMemory(db, authOf(who.id), second.systemMemoryId)).toBe(true);
    }
  });
});
