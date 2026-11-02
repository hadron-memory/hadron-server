/**
 * #3223 (#2212 A3, cor:api:120:04): `Query.myChatsPage`, the paged sibling of `myChats`.
 *
 * `myChats` is the #876 chat surface: it authorizes on raw caller identity and bypasses `memoryAccessFilter`, so its
 * gate is bespoke. These pins hold the new field to exactly that gate, branch by branch (unauthenticated,
 * impersonation, unknown Agent, App non-member, another user's personal chats, owner-owned App rows, another user's
 * session memory, the team chat, Channel roots and message rows), and hold its paging to the A1/A2 contract: total
 * counts exactly the rows the pages return, pages are stable across equal `updatedAt` (id is the tiebreak), and a
 * limit over 200 is served as 200. `myChats` itself must not change.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;

let org: { id: string; urn: string };
let agent: { id: string; urn: string };
let app: { id: string };
/** Owns a personal memory for the agent and is an AppMember. */
let owner: { id: string };
/** Another AppMember with a personal memory of their own. */
let colleague: { id: string };
/** An AppMember whose only memory for the agent is an App-class session memory. */
let peer: { id: string };
/** Not an AppMember and holds no memory for the agent. */
let outsider: { id: string };
let ownerPersonal: { id: string };

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;
const chat = (memoryId: string, loc: string) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, nodeType: 'record', data: { scope: 'private' } } });
const locs = (rows: Array<{ loc: string }>) => rows.map(r => r.loc);
const EMPTY_PAGE = { items: [], total: 0, hasMore: false };

beforeEach(async () => {
  await cleanDb(db);
  const t = generateId().slice(-8);
  org = await db.organization.create({ data: { id: generateId(), name: 'mcp', urn: `mcp-${t}` } });
  const mk = (n: number, tag: string) =>
    db.user.create({ data: { id: generateId(), githubId: 3223_00 + n, githubUsername: `mcp-${tag}-${t}`, handle: `mcp-${tag}-${t}` } });
  owner = await mk(1, 'owner');
  colleague = await mk(2, 'colleague');
  peer = await mk(3, 'peer');
  outsider = await mk(4, 'outsider');
  for (const u of [owner, colleague, peer, outsider]) {
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: u.id, role: 'CONTRIBUTOR' } });
  }
  agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, name: 'agent', urn: `${org.urn}:agent`, visibility: 'ORGANIZATION' },
  });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  for (const u of [owner, colleague, peer]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'admin' } });

  const personalFor = (userId: string, name: string) => db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:${name}`, name, class: 'knowledge',
      visibility: 'ORGANIZATION', userMemoryOfAgentId: agent.id, createdBy: userId,
    },
  });
  ownerPersonal = await personalFor(owner.id, 'owner-p');
  const colleaguePersonal = await personalFor(colleague.id, 'colleague-p');
  await chat(ownerPersonal.id, 'chats:mine');
  await chat(ownerPersonal.id, 'chats:mine:messages');
  await chat(ownerPersonal.id, 'chats:mine:messages:001-u');
  await chat(colleaguePersonal.id, 'chats:theirs');

  // The App's shared team space: its agent chats list for every member; the team chat and a Channel root never do.
  const shared = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:shared`, name: 'shared', class: 'app', appId: app.id },
  });
  await chat(shared.id, 'chats:shared');
  await chat(shared.id, 'chats:team');
  await chat(shared.id, 'chats:team:messages:001-u');
  await ensureChannelWithRoot(db, { memoryId: shared.id, loc: 'chats:standup', name: 'standup', createdBy: owner.id });

  // An owner-owned App-class row: excluded for everyone, its owner included.
  const ownedRow = await db.memory.create({
    data: {
      // `chk_memory_owner_xor`: a user-owned row carries no organization.
      id: generateId(), urn: `${org.urn}:owned`, name: 'owned', class: 'app', appId: app.id, ownerUserId: owner.id,
    },
  });
  await chat(ownedRow.id, 'chats:owned');

  // The peer's App-class SESSION memory for the agent: not a team space, so no other member lists it.
  const session = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:sess`, name: 'sess', class: 'app', appId: app.id,
      userMemoryOfAgentId: agent.id, createdBy: peer.id,
    },
  });
  await chat(session.id, 'chats:session');
});

describe('#3223 myChatsPage keeps the myChats gate, branch by branch', () => {
  it('refuses an unauthenticated caller exactly as myChats does', async () => {
    const old = await Q.myChats({}, { agentRef: agent.id }, ctx(undefined)).catch((e: any) => e.extensions?.code);
    await expect(Q.myChatsPage({}, { agentRef: agent.id }, ctx(undefined))).rejects.toMatchObject({ extensions: { code: old } });
  });

  it('refuses impersonation with Forbidden before reading anything', async () => {
    const touched: string[] = [];
    const tripwire = new Proxy({}, { get: (_t, prop) => { touched.push(String(prop)); throw new Error(`db.${String(prop)} read`); } });
    const imp = { db: tripwire, userId: owner.id, roles: ['READER'], impersonation: { orgId: org.id } } as unknown as Context;
    await expect(Q.myChatsPage({}, { agentRef: agent.id }, imp)).rejects.toThrow(/Forbidden/);
    expect(touched).toEqual([]);
  });

  it('answers an unknown Agent with the empty page, and a malformed ref as myChats does', async () => {
    expect(await Q.myChatsPage({}, { agentRef: generateId() }, ctx(owner.id))).toEqual(EMPTY_PAGE);
    expect(await Q.myChatsPage({}, { agentRef: `${org.urn}:no-such-agent` }, ctx(owner.id))).toEqual(EMPTY_PAGE);
    const oldMsg = await Q.myChats({}, { agentRef: '' }, ctx(owner.id)).then(() => 'resolved', (e: Error) => e.message);
    const newMsg = await Q.myChatsPage({}, { agentRef: '' }, ctx(owner.id)).then(() => 'resolved', (e: Error) => e.message);
    expect(newMsg).toBe(oldMsg);
  });

  it('gives an App non-member with no memory for the agent the empty page', async () => {
    expect(await Q.myChatsPage({}, { agentRef: agent.id }, ctx(outsider.id))).toEqual(EMPTY_PAGE);
  });

  it('lists the caller\'s own chats and the App\'s shared chats, nothing else', async () => {
    const own = await Q.myChatsPage({}, { agentRef: agent.id }, ctx(owner.id));
    expect(locs(own.items).sort()).toEqual(['chats:mine', 'chats:shared']);
    expect(own).toMatchObject({ total: 2, hasMore: false });

    const other = await Q.myChatsPage({}, { agentRef: agent.id }, ctx(colleague.id));
    expect(locs(other.items).sort()).toEqual(['chats:shared', 'chats:theirs']);
    expect(other).toMatchObject({ total: 2, hasMore: false });

    // The peer reads its own session memory as its personal memory, and the shared chats; never the owner-owned row.
    const p = await Q.myChatsPage({}, { agentRef: agent.id }, ctx(peer.id));
    expect(locs(p.items).sort()).toEqual(['chats:session', 'chats:shared']);
  });

  it('accepts the Agent URN as myChats does', async () => {
    const page = await Q.myChatsPage({}, { agentRef: agent.urn }, ctx(owner.id));
    expect(locs(page.items).sort()).toEqual(['chats:mine', 'chats:shared']);
  });

  it('returns the same rows as myChats, in the same Chat shape', async () => {
    const old = await Q.myChats({}, { agentRef: agent.id, limit: 1000 }, ctx(owner.id));
    const page = await Q.myChatsPage({}, { agentRef: agent.id, limit: 200 }, ctx(owner.id));
    const byLoc = (rows: Array<{ loc: string }>) => [...rows].sort((a, b) => a.loc.localeCompare(b.loc));
    expect(byLoc(page.items)).toEqual(byLoc(old));
  });
});

describe('#3223 myChatsPage pages stably and counts only what it can return', () => {
  /** Adds `n` chats to the owner's personal memory, all with ONE updatedAt, so only the tiebreak orders them. */
  async function tiedChats(n: number) {
    await db.node.createMany({ data: Array.from({ length: n }, (_, i) => ({
      id: generateId(), memoryId: ownerPersonal.id, loc: `chats:t${String(i).padStart(3, '0')}`, name: `t${i}`,
      nodeType: 'record', data: { scope: 'private' },
    })) });
    await db.$executeRaw`UPDATE nodes SET updated_at = '2026-01-01 00:00:00' WHERE memory_id = ${ownerPersonal.id}`;
  }

  it('pages 25 tied chats plus the shared one: 20 then 7, total 27, union exact, order updatedAt desc then id', async () => {
    await tiedChats(25);
    const p1 = await Q.myChatsPage({}, { agentRef: agent.id }, ctx(owner.id));
    expect(p1.items).toHaveLength(20);
    expect(p1).toMatchObject({ total: 27, hasMore: true });
    const p2 = await Q.myChatsPage({}, { agentRef: agent.id, offset: 20 }, ctx(owner.id));
    expect(p2.items).toHaveLength(7);
    expect(p2).toMatchObject({ total: 27, hasMore: false });

    const all = [...p1.items, ...p2.items];
    expect(new Set(all.map((c: { id: string }) => c.id)).size).toBe(27);
    const expected = await db.node.findMany({
      where: { id: { in: all.map((c: { id: string }) => c.id) } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    expect(all.map((c: { id: string }) => c.id)).toEqual(expected.map(r => r.id));
  });

  it('serves limit 201 as 200 and keeps the real total', async () => {
    await tiedChats(240);
    const page = await Q.myChatsPage({}, { agentRef: agent.id, limit: 201 }, ctx(owner.id));
    expect(page.items).toHaveLength(200);
    expect(page).toMatchObject({ total: 242, hasMore: true });
  });

  it('limit 0 is count-only; a negative offset is 0', async () => {
    expect(await Q.myChatsPage({}, { agentRef: agent.id, limit: 0 }, ctx(owner.id))).toEqual({ items: [], total: 2, hasMore: true });
    const neg = await Q.myChatsPage({}, { agentRef: agent.id, offset: -5 }, ctx(owner.id));
    expect(neg).toMatchObject({ total: 2, hasMore: false });
    expect(neg.items).toHaveLength(2);
  });

  it('total does not count the excluded rows (team chat, Channel root, messages, owner-owned, other users)', async () => {
    const page = await Q.myChatsPage({}, { agentRef: agent.id, limit: 0 }, ctx(owner.id));
    expect(page.total).toBe(2);
  });

  it('leaves myChats unchanged: a plain list with no cap on an explicit limit', async () => {
    await tiedChats(240);
    const old = await Q.myChats({}, { agentRef: agent.id, limit: 241 }, ctx(owner.id));
    expect(Array.isArray(old)).toBe(true);
    expect(old).toHaveLength(241);
  });
});
