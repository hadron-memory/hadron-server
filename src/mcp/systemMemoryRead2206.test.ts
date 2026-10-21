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
    }
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
