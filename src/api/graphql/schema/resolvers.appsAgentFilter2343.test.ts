/**
 * #2343 — `apps(filter: { agentId })`: the Apps that install an Agent.
 *
 * Matches the AppAgent join (there is no primary-agent column on the server),
 * AND-combines with `ownedByMe`, and resolves the value through the Agent read
 * gate: an unreadable, deleted, malformed or nonexistent agent all answer the
 * SAME empty page, so the filter is no existence oracle.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const ctx = (over: Partial<Context> = {}): Context => ({ db, ...over });
const ids = (page: { items: Array<{ id: string }> }) => page.items.map((a) => a.id).sort();
const EMPTY = { items: [], total: 0 };

let orgO: string;
let orgX: string;
let member: string;
let outsider: string;
let admin: string;
let agentG: string; // readable by the member (ORGANIZATION agent of org O)
let agentH: string; // a second readable agent
let agentS: string; // NOT readable by the member (ORGANIZATION agent of org X)
let agentDeleted: string;
let a1: string; // installs G
let a2: string; // installs only H
let a3: string; // installs S first, then G (G is not the first AppAgent)
let a4: string; // installs only S

async function seedAgent(organizationId: string, over: Record<string, unknown> = {}) {
  const id = generateId();
  await db.agent.create({
    data: { id, name: `Agent ${id}`, urn: `agent-${id}`, organizationId, visibility: 'ORGANIZATION', ...over },
  });
  return id;
}
async function seedApp(organizationId: string | null, over: Record<string, unknown> = {}) {
  const id = generateId();
  await db.app.create({ data: { id, name: `App ${id}`, urn: `app-${id}`, organizationId, ...over } });
  return id;
}
async function install(appId: string, agentId: string, createdAt: Date) {
  await db.appAgent.create({ data: { appId, agentId, createdAt } });
}

beforeEach(async () => {
  await cleanDb(db);
  member = (await db.user.create({ data: { id: generateId(), name: 'Member', handle: `m${generateId().slice(-6)}`, roles: ['READER'] } })).id;
  outsider = (await db.user.create({ data: { id: generateId(), name: 'Outsider', handle: `o${generateId().slice(-6)}`, roles: ['READER'] } })).id;
  admin = (await db.user.create({ data: { id: generateId(), name: 'Admin', handle: `a${generateId().slice(-6)}`, roles: ['ADMIN'] } })).id;
  orgO = (await db.organization.create({ data: { id: generateId(), name: 'Org O', urn: `org-o-${generateId()}` } })).id;
  orgX = (await db.organization.create({ data: { id: generateId(), name: 'Org X', urn: `org-x-${generateId()}` } })).id;
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgO, userId: member, role: 'READER' } });
  agentG = await seedAgent(orgO);
  agentH = await seedAgent(orgO);
  agentS = await seedAgent(orgX);
  agentDeleted = await seedAgent(orgO, { deletedAt: new Date() });
  a1 = await seedApp(orgO);
  a2 = await seedApp(orgO);
  a3 = await seedApp(orgO);
  a4 = await seedApp(orgO);
  await install(a1, agentG, new Date('2026-01-01'));
  await install(a2, agentH, new Date('2026-01-01'));
  await install(a3, agentS, new Date('2026-01-01'));
  await install(a3, agentG, new Date('2026-01-02'));
  await install(a4, agentS, new Date('2026-01-01'));
});

const asMember = () => ctx({ userId: member, roles: ['READER'] });

describe('Query.apps(filter.agentId)', () => {
  it('returns only the Apps that install the Agent, with a consistent total', async () => {
    const res = await resolvers.Query.apps(null, { filter: { agentId: agentG } }, asMember());
    expect(ids(res)).toEqual([a1, a3].sort());
    expect(res.total).toBe(2);
  });

  it('matches the join, not a primary agent: G installed second still matches', async () => {
    const res = await resolvers.Query.apps(null, { filter: { agentId: agentG } }, asMember());
    expect(ids(res)).toContain(a3);
    expect(ids(res)).not.toContain(a2);
  });

  it('still returns an App whose other installed Agent the caller cannot read, and leaves the unfiltered list unchanged', async () => {
    const filtered = await resolvers.Query.apps(null, { filter: { agentId: agentG } }, asMember());
    expect(ids(filtered)).toContain(a3);
    const all = await resolvers.Query.apps(null, {}, asMember());
    expect(ids(all)).toEqual([a1, a2, a3, a4].sort());
    expect(all.total).toBe(4);
  });

  it('accepts a fully-qualified URN as well as an id', async () => {
    const row = await db.agent.findUniqueOrThrow({ where: { id: agentG }, select: { urn: true } });
    const res = await resolvers.Query.apps(null, { filter: { agentId: `hrn:agent:${row.urn}` } }, asMember());
    expect(ids(res)).toEqual([a1, a3].sort());
  });

  it('answers the identical empty page for an unreadable, deleted, nonexistent or malformed agent', async () => {
    const unreadable = await resolvers.Query.apps(null, { filter: { agentId: agentS } }, asMember());
    const deleted = await resolvers.Query.apps(null, { filter: { agentId: agentDeleted } }, asMember());
    const missing = await resolvers.Query.apps(null, { filter: { agentId: generateId() } }, asMember());
    const malformed = await resolvers.Query.apps(null, { filter: { agentId: 'not a ref' } }, asMember());
    expect(unreadable).toEqual(EMPTY);
    expect(deleted).toEqual(unreadable);
    expect(missing).toEqual(unreadable);
    expect(malformed).toEqual(unreadable);
  });

  it('scopes to the org with orgId, and a non-member of that org gets an empty page', async () => {
    const scoped = await resolvers.Query.apps(null, { orgId: orgO, filter: { agentId: agentG } }, asMember());
    expect(ids(scoped)).toEqual([a1, a3].sort());
    const outside = await resolvers.Query.apps(
      null, { orgId: orgO, filter: { agentId: agentG } }, ctx({ userId: outsider, roles: ['READER'] }),
    );
    expect(outside).toEqual(EMPTY);
  });

  it('paginates the filtered set; limit 0 returns the count only', async () => {
    const first = await resolvers.Query.apps(null, { filter: { agentId: agentG }, limit: 1, offset: 0 }, asMember());
    const second = await resolvers.Query.apps(null, { filter: { agentId: agentG }, limit: 1, offset: 1 }, asMember());
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.items[0].id).not.toBe(second.items[0].id);
    expect(first.total).toBe(2);
    const countOnly = await resolvers.Query.apps(null, { filter: { agentId: agentG }, limit: 0 }, asMember());
    expect(countOnly).toEqual({ items: [], total: 2 });
  });

  it('treats no filter, an empty filter and a null agentId exactly as today', async () => {
    const none = await resolvers.Query.apps(null, {}, asMember());
    expect(ids(none)).toEqual([a1, a2, a3, a4].sort());
    expect(await resolvers.Query.apps(null, { filter: {} }, asMember())).toEqual(none);
    expect(await resolvers.Query.apps(null, { filter: { agentId: null } }, asMember())).toEqual(none);
  });
});

describe('Query.apps(filter: { ownedByMe, agentId })', () => {
  let mineWithG: string;
  let mineWithH: string;
  let othersWithG: string;
  let publicAgent: string;

  beforeEach(async () => {
    publicAgent = await seedAgent(orgO, { visibility: 'PUBLIC' });
    mineWithG = await seedApp(null, { ownerUserId: member });
    mineWithH = await seedApp(null, { ownerUserId: member });
    othersWithG = await seedApp(null, { ownerUserId: outsider });
    await install(mineWithG, publicAgent, new Date('2026-01-01'));
    await install(mineWithH, agentH, new Date('2026-01-01'));
    await install(othersWithG, publicAgent, new Date('2026-01-01'));
  });

  it('AND-combines: only the caller’s own org-less Apps that install the Agent', async () => {
    const res = await resolvers.Query.apps(null, { filter: { ownedByMe: true, agentId: publicAgent } }, asMember());
    expect(ids(res)).toEqual([mineWithG]);
    expect(res.total).toBe(1);
  });

  it('a platform ADMIN gets only their own, never another user’s', async () => {
    const adminApp = await seedApp(null, { ownerUserId: admin });
    await install(adminApp, publicAgent, new Date('2026-01-01'));
    const adminOther = await seedApp(null, { ownerUserId: admin });
    await install(adminOther, agentH, new Date('2026-01-01'));
    const res = await resolvers.Query.apps(
      null, { filter: { ownedByMe: true, agentId: publicAgent } }, ctx({ userId: admin, roles: ['ADMIN'] }),
    );
    expect(ids(res)).toEqual([adminApp]);
  });

  it('an App-key caller and an impersonated caller get an empty page', async () => {
    const key = await resolvers.Query.apps(
      null, { filter: { ownedByMe: true, agentId: publicAgent } }, ctx({ appId: mineWithG, roles: ['READER'] }),
    );
    expect(key).toEqual(EMPTY);
    const impersonated = await resolvers.Query.apps(
      null, { filter: { ownedByMe: true, agentId: publicAgent } },
      ctx({ userId: member, roles: ['READER'], impersonation: { orgId: orgO } as never }),
    );
    expect(impersonated).toEqual(EMPTY);
  });

  it('an unreadable agent is the same empty page here too', async () => {
    const res = await resolvers.Query.apps(null, { filter: { ownedByMe: true, agentId: agentS } }, asMember());
    expect(res).toEqual(EMPTY);
  });
});
