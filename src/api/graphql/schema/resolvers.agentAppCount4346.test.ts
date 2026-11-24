/**
 * #4346 (Holger's ruling B): Agent.appCount is the OWNING TENANT's adoption total, not the viewer's
 * readable installs. This pins today's five viewer rows on a PUBLIC org-owned Agent installed in two
 * user-owned Apps, and the SDL text that says so.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { print } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const A = resolvers.Agent as any;
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let agent: { id: string; organizationId: string | null; ownerUserId: string | null };
let appAOwner: { id: string };
let appBOwner: { id: string };
let orgMember: { id: string };
let orgOwner: { id: string };
let plain: { id: string };
let appAId: string;
let appBId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'ac-org', urn: `ac-org-${Date.now()}` } });
  const mk = (n: number, name: string) => db.user.create({ data: { id: generateId(), githubId: 4346100 + n, githubUsername: name, roles: ['READER'] } });
  [appAOwner, appBOwner, orgMember, orgOwner, plain] = [await mk(1, 'ac-a'), await mk(2, 'ac-b'), await mk(3, 'ac-member'), await mk(4, 'ac-owner'), await mk(5, 'ac-plain')];
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgMember.id, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgOwner.id, role: 'OWNER' } });
  agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:pub`, name: 'Pub', visibility: 'PUBLIC' },
  });
  const mkApp = async (owner: { id: string }, n: string) => {
    const app = await db.app.create({ data: { id: generateId(), name: n, urn: `ac-${n}-${Date.now()}`, ownerUserId: owner.id } });
    await db.appMember.create({ data: { appId: app.id, userId: owner.id, role: 'owner' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    return app.id;
  };
  appAId = await mkApp(appAOwner, 'a');
  appBId = await mkApp(appBOwner, 'b');
});

describe('Agent.appCount viewer rows (#4346, ruling B)', () => {
  it('counts every live install for the owning tenant, 0 for everyone else', async () => {
    expect(await A.appCount(agent, {}, ctx(appAOwner.id))).toBe(0); // owns App A, outside the owning org
    expect(await A.appCount(agent, {}, ctx(appBOwner.id))).toBe(0);
    expect(await A.appCount(agent, {}, ctx(orgMember.id))).toBe(2); // member of the owning org
    expect(await A.appCount(agent, {}, ctx(orgOwner.id))).toBe(2); // owner of the owning org
    expect(await A.appCount(agent, {}, ctx(plain.id))).toBe(0); // no tie at all
  });

  it('is the tenant total, not the viewer\'s readable installs (apps differs by construction)', async () => {
    const ids = async (v: { id: string }) => (await A.apps(agent, {}, ctx(v.id))).map((x: any) => x.id);
    expect(await ids(appAOwner)).toEqual([appAId]); // readable: one, appCount: 0
    expect(await ids(orgMember)).toEqual([]);       // readable: none, appCount: 2
    expect(await ids(orgOwner)).toEqual([]);
    expect(await ids(plain)).toEqual([]);
    expect(appBId).not.toBe(appAId);
  });

  it('a deleted install does not count', async () => {
    await db.app.update({ where: { id: appBId }, data: { deletedAt: new Date() } });
    expect(await A.appCount(agent, {}, ctx(orgMember.id))).toBe(1);
  });
});

describe('Agent.appCount SDL text (#4346)', () => {
  it('says it is the owning tenant\'s total, counts Apps the viewer cannot read, and is 0 outside', () => {
    const text = (typeof typeDefs === 'string' ? typeDefs : print(typeDefs as any)).replace(/\s+/g, ' ');
    const at = text.indexOf('appCount: Int!');
    const doc = text.slice(Math.max(0, at - 700), at);
    expect(doc).toMatch(/owning tenant's total/);
    expect(doc).toMatch(/including Apps the viewer may not be able to read/);
    expect(doc).toMatch(/0 for any viewer outside the owning tenant/);
  });
});
