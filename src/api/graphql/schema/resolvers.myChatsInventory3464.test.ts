/**
 * #3464 Q3+Q4 (gate 6686874669): the historical `myChats` / `myChatsPage` inventory behind `myChatsScope`.
 *
 * Q4 (cor:dmo:010:04): an App whose organization is soft-deleted is not-found to every read, and its children drop out
 * transitively. Its shared chats must leave both lists, the page total and a count-only page, before any title lookup.
 * The fixture uses a PHYSICAL `AppAgent` row: the derived arm of `appInstallationWhere` already requires a live org, so
 * a derived-only fixture would pass on main and prove nothing. Every other row stays in place, and the test asserts it,
 * so neither a cascade nor a deleted App can make the exclusion vacuous. Restoring the org brings the chat back.
 *
 * Q3 (cor:acl:030:01, :02; cor:dmo:050:07): chat inventory follows the host memory's gate, not the install licence.
 * A chat recorded while a DERIVED install's holder grant was active stays listed after that grant is revoked or
 * expires. Physical ROW installs of the same Agent, one under a revoked grant and one with no grant at all for a
 * PUBLIC Agent, are separate positive audiences that never depend on a grant.
 *
 * Out of scope (gate): Q1, Q2's population, Q5, Q6, query cost, and any change to the existing #3223 controls in
 * `resolvers.myChatsPage2212A3.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const locs = (rows: Array<{ loc: string }>) => rows.map(r => r.loc).sort();
let n = 0;
const mkUser = (tag: string) =>
  db.user.create({ data: { id: generateId(), githubId: 3464_000 + ++n, githubUsername: `u3464-${tag}-${n}`, handle: `u3464-${tag}-${n}` } });
const mkOrg = (tag: string) => db.organization.create({ data: { id: generateId(), name: tag, urn: `o3464-${tag}-${generateId().slice(-8).toLowerCase()}` } });
/** A legal team space of an org App: app class, no session owner, no Worker, no owning user. */
const teamSpace = (orgId: string, appId: string, name: string) =>
  db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: `m3464-${name}-${generateId().slice(-8).toLowerCase()}`, name, class: 'app', appId } });
/** A chat root with one message, so a title lookup would have content to return. */
async function chatWithMessage(memoryId: string, loc: string) {
  const root = await db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, nodeType: 'record', data: { scope: 'shared' } } });
  await db.node.create({ data: { id: generateId(), memoryId, loc: `${loc}:messages:001-u`, name: 'm', nodeType: 'record', content: `hello from ${loc}` } });
  return root;
}
async function inventory(userId: string, agentRef: string) {
  const list = await Q.myChats(null, { agentRef }, ctx(userId));
  const page = await Q.myChatsPage(null, { agentRef }, ctx(userId));
  const count = await Q.myChatsPage(null, { agentRef, limit: 0 }, ctx(userId));
  return { list: locs(list), page: locs(page.items), total: page.total, countOnly: count.total, countItems: count.items.length };
}

describe('#3464 Q4: a soft-deleted org takes its Apps\' shared chats out of the inventory', () => {
  let member: { id: string }, stranger: { id: string };
  let agent: { id: string };
  let target: { org: { id: string }; app: { id: string }; memory: { id: string }; root: { id: string } };
  let live: { org: { id: string }; app: { id: string }; memory: { id: string } };
  let personal: { id: string };
  let userOwned: { app: { id: string } };

  beforeEach(async () => {
    await cleanDb(db);
    member = await mkUser('member');
    stranger = await mkUser('stranger');
    const home = await mkOrg('home');
    agent = await db.agent.create({ data: { id: generateId(), organizationId: home.id, name: 'bot', urn: `${home.urn}:bot`, visibility: 'PUBLIC' } });

    const appIn = async (tag: string) => {
      const org = await mkOrg(tag);
      const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: tag, urn: `${org.urn}:${tag}` } });
      await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } }); // physical ROW install
      await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
      const memory = await teamSpace(org.id, app.id, `${tag}-space`);
      return { org, app, memory };
    };
    const t = await appIn('target');
    target = { ...t, root: await chatWithMessage(t.memory.id, 'chats:target') };
    live = await appIn('live');
    await chatWithMessage(live.memory.id, 'chats:live');

    personal = await db.memory.create({
      data: { id: generateId(), organizationId: home.id, urn: `m3464-personal-${generateId().slice(-8).toLowerCase()}`, name: 'p', class: 'knowledge', visibility: 'ORGANIZATION', userMemoryOfAgentId: agent.id, createdBy: member.id },
    });
    await chatWithMessage(personal.id, 'chats:personal');

    // A USER-owned App the member belongs to. Its team space is owner-owned (`chk_memory_owner_xor`), and
    // `myChatsScope` excludes owner-owned rows, so it lists nothing on main. Q4 must not change that shape either way.
    const owner = await mkUser('owner');
    const app = await db.app.create({ data: { id: generateId(), ownerUserId: owner.id, name: 'mine', urn: `u3464-mine-${generateId().slice(-8).toLowerCase()}` } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
    const owned = await db.memory.create({ data: { id: generateId(), ownerUserId: owner.id, urn: `m3464-owned-${generateId().slice(-8).toLowerCase()}`, name: 'owned', class: 'app', appId: app.id } });
    await chatWithMessage(owned.id, 'chats:user-owned');
    userOwned = { app };
  });

  const softDeleteTarget = () => db.organization.update({ where: { id: target.org.id }, data: { deletedAt: new Date('2026-11-01T00:00:00Z') } });

  it('control: before the delete, the target, the live App and personal chats all list', async () => {
    expect(await inventory(member.id, agent.id)).toEqual({
      list: ['chats:live', 'chats:personal', 'chats:target'], page: ['chats:live', 'chats:personal', 'chats:target'], total: 3, countOnly: 3, countItems: 0,
    });
  });

  it('after the org is soft-deleted, list, page items, page total and count-only all drop the target chat', async () => {
    await softDeleteTarget();
    // Preconditions: only the org moved. App, AppMember, physical install, memory and chat rows are all live.
    expect(await db.organization.findUnique({ where: { id: target.org.id }, select: { deletedAt: true } })).toMatchObject({ deletedAt: expect.any(Date) });
    expect(await db.app.findUnique({ where: { id: target.app.id }, select: { deletedAt: true, uninstalledAt: true } })).toEqual({ deletedAt: null, uninstalledAt: null });
    expect(await db.appMember.count({ where: { appId: target.app.id, userId: member.id } })).toBe(1);
    expect(await db.appAgent.count({ where: { appId: target.app.id, agentId: agent.id } })).toBe(1);
    expect(await db.memory.findUnique({ where: { id: target.memory.id }, select: { deletedAt: true } })).toEqual({ deletedAt: null });
    expect(await db.node.findUnique({ where: { id: target.root.id }, select: { deletedAt: true } })).toEqual({ deletedAt: null });

    expect(await inventory(member.id, agent.id)).toEqual({
      list: ['chats:live', 'chats:personal'], page: ['chats:live', 'chats:personal'], total: 2, countOnly: 2, countItems: 0,
    });
  });

  it('the page envelope stays consistent when the deleted org\'s chat would have filled the page', async () => {
    await softDeleteTarget();
    const first = await Q.myChatsPage(null, { agentRef: agent.id, limit: 1 }, ctx(member.id));
    const second = await Q.myChatsPage(null, { agentRef: agent.id, limit: 1, offset: 1 }, ctx(member.id));
    expect([first.total, first.hasMore, second.total, second.hasMore]).toEqual([2, true, 2, false]);
    expect(locs([...first.items, ...second.items])).toEqual(['chats:live', 'chats:personal']);
  });

  it('with only the deleted org\'s App left, personal chats still list (no early return drops them)', async () => {
    await db.appMember.deleteMany({ where: { appId: { in: [live.app.id, userOwned.app.id] }, userId: member.id } });
    await softDeleteTarget();
    expect(await inventory(member.id, agent.id)).toEqual({ list: ['chats:personal'], page: ['chats:personal'], total: 1, countOnly: 1, countItems: 0 });
  });

  it('an uninstalled App with a physical install keeps its historical chat (existing behaviour, includeUninstalled)', async () => {
    await db.app.update({ where: { id: live.app.id }, data: { uninstalledAt: new Date('2026-11-01T00:00:00Z') } });
    expect((await inventory(member.id, agent.id)).list).toEqual(['chats:live', 'chats:personal', 'chats:target']);
  });

  it('restoring the org brings the chat back', async () => {
    await softDeleteTarget();
    await db.organization.update({ where: { id: target.org.id }, data: { deletedAt: null } });
    expect((await inventory(member.id, agent.id)).list).toEqual(['chats:live', 'chats:personal', 'chats:target']);
  });

  // `chatHistory` addresses a chat by its loc (`chatLocFilter`), not its node id (Cooper, QA 6712573209).
  it('a direct read of the deleted org\'s chat keeps the existing not-found refusal', async () => {
    // Positive control: before the delete the same loc reads, so the refusal below is caused by the delete.
    await expect(Q.chatHistory(null, { chatId: 'chats:target' }, ctx(member.id))).resolves.toBeTruthy();
    await softDeleteTarget();
    const unknown = await Q.chatHistory(null, { chatId: 'chats:no-such-chat' }, ctx(member.id)).catch((e: any) => e);
    const deleted = await Q.chatHistory(null, { chatId: 'chats:target' }, ctx(member.id)).catch((e: any) => e);
    expect(unknown?.extensions?.code).toBeTruthy();
    expect(deleted?.extensions?.code).toBe(unknown.extensions.code);
    await expect(Q.chatHistory(null, { chatId: 'chats:live' }, ctx(member.id))).resolves.toBeTruthy();
  });

  it('a stranger, in a separate Context, lists nothing before or after the delete', async () => {
    expect(await inventory(stranger.id, agent.id)).toEqual({ list: [], page: [], total: 0, countOnly: 0, countItems: 0 });
    await softDeleteTarget();
    expect(await inventory(stranger.id, agent.id)).toEqual({ list: [], page: [], total: 0, countOnly: 0, countItems: 0 });
  });
});

describe('#3464 Q3: a lapsed DERIVED install licence does not narrow the historical inventory', () => {
  let member: { id: string };
  let foreignAgent: { id: string };
  let customer: { id: string; urn: string };

  beforeEach(async () => {
    await cleanDb(db);
    member = await mkUser('q3member');
    customer = await mkOrg('customer');
    const vendor = await mkOrg('vendor');
    foreignAgent = await db.agent.create({ data: { id: generateId(), organizationId: vendor.id, name: 'y', urn: `${vendor.urn}:y`, visibility: 'PUBLIC' } });
    const parent = await db.agent.create({ data: { id: generateId(), organizationId: customer.id, name: 'p', urn: `${customer.urn}:p`, visibility: 'ORGANIZATION' } });

    // DERIVED: the customer App installs P, P imports Y under an active holder grant, and a chat is recorded then.
    await db.agentOrgGrant.create({ data: { orgId: customer.id, agentId: foreignAgent.id, activatedAt: new Date('2026-10-01T00:00:00Z') } });
    await db.agentImport.create({ data: { parentAgentId: parent.id, importedAgentId: foreignAgent.id, position: 100, required: true, agentOrgGrantOrgId: customer.id, agentOrgGrantAgentId: foreignAgent.id } });
    const derivedApp = await db.app.create({ data: { id: generateId(), organizationId: customer.id, name: 'derived', urn: `${customer.urn}:derived` } });
    await db.appAgent.create({ data: { appId: derivedApp.id, agentId: parent.id } });
    await db.appMember.create({ data: { appId: derivedApp.id, userId: member.id, role: 'member' } });
    await chatWithMessage((await teamSpace(customer.id, derivedApp.id, 'derived-space')).id, 'chats:derived');

    // ROW control: the same Agent physically installed in another customer App; it never reads the grant.
    const rowApp = await db.app.create({ data: { id: generateId(), organizationId: customer.id, name: 'row', urn: `${customer.urn}:row` } });
    await db.appAgent.create({ data: { appId: rowApp.id, agentId: foreignAgent.id } });
    await db.appMember.create({ data: { appId: rowApp.id, userId: member.id, role: 'member' } });
    await chatWithMessage((await teamSpace(customer.id, rowApp.id, 'row-space')).id, 'chats:row');

    // PUBLIC control: an org with no grant at all physically installs the PUBLIC Agent.
    const other = await mkOrg('public');
    const publicApp = await db.app.create({ data: { id: generateId(), organizationId: other.id, name: 'pub', urn: `${other.urn}:pub` } });
    await db.appAgent.create({ data: { appId: publicApp.id, agentId: foreignAgent.id } });
    await db.appMember.create({ data: { appId: publicApp.id, userId: member.id, role: 'member' } });
    await chatWithMessage((await teamSpace(other.id, publicApp.id, 'public-space')).id, 'chats:public');
  });

  const ALL = ['chats:derived', 'chats:public', 'chats:row'];

  it('control: with the grant active, the derived, ROW and PUBLIC chats all list', async () => {
    expect(await inventory(member.id, foreignAgent.id)).toEqual({ list: ALL, page: ALL, total: 3, countOnly: 3, countItems: 0 });
  });

  it.each([
    ['revoked', { revokedAt: new Date('2026-11-02T00:00:00Z') }],
    ['expired', { expiresAt: new Date('2026-11-02T00:00:00Z') }],
  ] as const)('after the holder grant is %s, the historical inventory is unchanged', async (_label, lapse) => {
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: customer.id, agentId: foreignAgent.id } }, data: lapse });
    expect(await inventory(member.id, foreignAgent.id)).toEqual({ list: ALL, page: ALL, total: 3, countOnly: 3, countItems: 0 });
  });
});
