/**
 * #939 — createTeamChatMessage + teamChatMessages: the team-chat platform
 * operations.
 *
 * Beyond the #935/#936 template (auth matrix one case per PRINCIPAL SHAPE),
 * this suite pins the #919 property AT THIS SURFACE: racing posts get
 * DISTINCT consecutive seqs because every write goes through
 * chatRoot.appendChatMessage (each post holds a transaction open across its
 * insert, so Promise.all genuinely interleaves them — see the finding's
 * "Testing this class" section); and the first-post bootstrap is idempotent
 * under the same race (exactly one chats:team root survives).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import {
  extractMentions,
  mentionTokenOf,
  TEAM_CHAT_LOC,
  TEAM_CHAT_MESSAGES_LOC,
  TEAM_CHAT_BODY_MAX_CHARS,
} from './resolvers.teamChat.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

function ctx(userId?: string, appId?: string): Context {
  return { db, userId, appId, roles: ['READER'] };
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let org: { id: string; urn: string };
let admin: { id: string };
let contrib: { id: string };
let appMember: { id: string; handle: string };
let appReader: { id: string };
let outsider: { id: string };
let teamAgent: { id: string; urn: string; systemMemoryId: string };
let app: { id: string; urn: string };

const post = (c: Context, args: Record<string, unknown>) =>
  M.createTeamChatMessage({}, { appRef: app.id, body: 'hello team', ...args }, c);
const read = (c: Context, args: Record<string, unknown> = {}) =>
  Q.teamChatMessages({}, { appRef: app.id, ...args }, c);

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'tc-org', urn: `tc-org-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 93901, githubUsername: `tc-admin-${suffix}`, roles: ['READER'] },
  });
  contrib = await db.user.create({
    data: { id: generateId(), githubId: 93902, githubUsername: `tc-contrib-${suffix}`, roles: ['READER'] },
  });
  appMember = await db.user.create({
    data: {
      id: generateId(),
      githubId: 93903,
      githubUsername: `tc-member-${suffix}`,
      handle: `bob-${suffix.replace(/[^a-z0-9-]/gi, '')}`,
      roles: ['READER'],
    },
    select: { id: true, handle: true },
  });
  appReader = await db.user.create({
    data: { id: generateId(), githubId: 93904, githubUsername: `tc-reader-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 93905, githubUsername: `tc-outsider-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: contrib.id, role: 'CONTRIBUTOR' },
  });

  // The Team Agent — through the real mutation so it owns a real system
  // memory; the roles: branch is what marks it as the Team Agent.
  const created = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgent = { id: created.id, urn: created.urn, systemMemoryId: created.systemMemoryId };
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      content: 'You are {{name}}, a {{role}}.',
      data: { names: ['Iris', 'Henry'] },
    },
  });

  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: appMember.id, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: appReader.id, role: 'reader' } });
});

/** Mint a persona and bind an active session (driven by `userId`) to it. */
async function personaSession(userId: string): Promise<{ agentId: string; personaName: string; sessionId: string }> {
  const persona = await M.createTeamPersona(
    {},
    { appRef: app.id, role: 'backend-engineer' },
    ctx(admin.id),
  );
  const sessionId = generateId();
  await db.session.create({
    data: { id: sessionId, appId: app.id, userId, agentId: persona.id },
  });
  return { agentId: persona.id, personaName: persona.personaName, sessionId };
}

describe('extractMentions — the one mention format', () => {
  it('extracts @tokens, lowercased, deduped, trailing punctuation dropped', () => {
    expect(extractMentions('@Iris please review, then ping @bob-1. Thanks @iris!')).toEqual([
      'iris',
      'bob-1',
    ]);
  });
  it('ignores bare @ and email addresses (the @ must sit at a token boundary)', () => {
    expect(extractMentions('send to x@example.com and @ nothing')).toEqual([]);
    expect(extractMentions('@ alone')).toEqual([]);
    expect(extractMentions('(@iris) start@end @real-one')).toEqual(['iris', 'real-one']);
  });

  it('mentionTokenOf slugs a multiword name to the canonical mention atom', () => {
    expect(mentionTokenOf('Mary Jane')).toBe('mary-jane');
    expect(mentionTokenOf('Iris')).toBe('iris');
    expect(mentionTokenOf('  ~~ ')).toBeNull();
  });
});

describe('createTeamChatMessage — happy path + bootstrap', () => {
  it('bootstraps chats:team in the Team Agent shared app memory on first post', async () => {
    const msg = await post(ctx(appMember.id), { body: 'first!' });
    expect(msg.seq).toBe(1);
    expect(msg.authorUserId).toBe(appMember.id);
    expect(msg.authorAgentId).toBeNull();
    expect(msg.authorName).toBe(appMember.handle);
    expect(msg.body).toBe('first!');

    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
    });
    expect(root).not.toBeNull();
    expect(root!.nodeType).toBe('chat');
    const rootData = root!.data as Record<string, unknown>;
    expect(rootData.scope).toBe('shared');
    expect(rootData.messageCount).toBe(1);

    const row = await db.node.findUnique({ where: { id: msg.nodeId } });
    expect(row!.nodeType).toBe('chat-message');
    expect(row!.seq).toBe(1);
    expect(row!.content).toBe('first!');
    expect(row!.createdBy).toBe(appMember.id);
    expect(row!.loc.startsWith(`${TEAM_CHAT_MESSAGES_LOC}:`)).toBe(true);
    expect((row!.data as Record<string, unknown>).authorUserId).toBe(appMember.id);
  });

  it('first-post bootstrap is idempotent under race — exactly one root survives', async () => {
    const [a, b] = await Promise.all([
      post(ctx(appMember.id), { body: 'racer A' }),
      post(ctx(admin.id), { body: 'racer B' }),
    ]);
    const roots = await db.node.findMany({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' }, deletedAt: null },
    });
    expect(roots).toHaveLength(1);
    expect([a.seq, b.seq].sort()).toEqual([1, 2]);
  });

  it('racing posts get DISTINCT consecutive seqs (#919 at this surface)', async () => {
    await post(ctx(appMember.id), { body: 'bootstrap' });
    const results = await Promise.all([
      post(ctx(appMember.id), { body: 'r1' }),
      post(ctx(admin.id), { body: 'r2' }),
      post(ctx(contrib.id), { body: 'r3' }),
    ]);
    expect(results.map((r) => r.seq).sort()).toEqual([2, 3, 4]);
    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
    });
    expect((root!.data as Record<string, unknown>).messageCount).toBe(4);
  });

  it('falls back to the single installed Agent when no roles: branch marks a Team Agent', async () => {
    const plain = await M.createAgent({}, { orgId: org.id, name: 'Solo Agent' }, ctx(admin.id));
    const app2 = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Solo App', urn: `${org.urn}:solo` },
    });
    await db.appAgent.create({ data: { appId: app2.id, agentId: plain.id } });
    const msg = await M.createTeamChatMessage(
      {},
      { appRef: app2.id, body: 'solo hello' },
      ctx(admin.id),
    );
    expect(msg.seq).toBe(1);
    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app2.id, class: 'app' } },
    });
    expect(root).not.toBeNull();
  });

  it('refuses an uninstalled App with APP_UNINSTALLED', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expectCode(post(ctx(appMember.id), {}), 'APP_UNINSTALLED');
  });
});

describe('createTeamChatMessage — body validation', () => {
  it('refuses an empty body with BAD_USER_INPUT', async () => {
    await expectCode(post(ctx(appMember.id), { body: '   ' }), 'BAD_USER_INPUT');
  });

  it('refuses an over-cap body with TEAM_CHAT_BODY_TOO_LARGE', async () => {
    await expectCode(
      post(ctx(appMember.id), { body: 'x'.repeat(TEAM_CHAT_BODY_MAX_CHARS + 1) }),
      'TEAM_CHAT_BODY_TOO_LARGE',
    );
  });
});

describe('createTeamChatMessage — replyToSeq', () => {
  it('wires a replies-to edge and stamps the envelope', async () => {
    const first = await post(ctx(appMember.id), { body: 'question?' });
    const reply = await post(ctx(admin.id), { body: 'answer.', replyToSeq: first.seq });
    expect(reply.replyToSeq).toBe(first.seq);

    const edge = await db.edge.findFirst({ where: { sourceId: reply.nodeId, name: 'replies-to' } });
    expect(edge).not.toBeNull();
    expect(edge!.targetId).toBe(first.nodeId);
    const row = await db.node.findUnique({ where: { id: reply.nodeId } });
    expect((row!.data as Record<string, unknown>).replyToSeq).toBe(first.seq);
  });

  it('a missing seq is a typed refusal and writes nothing (transaction aborts)', async () => {
    await post(ctx(appMember.id), { body: 'only message' });
    await expectCode(
      post(ctx(appMember.id), { body: 'reply to nothing', replyToSeq: 99 }),
      'TEAM_CHAT_REPLY_NOT_FOUND',
    );
    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
    });
    // The failed reply consumed no seq and left no row.
    expect((root!.data as Record<string, unknown>).messageCount).toBe(1);
    const messages = await db.node.count({
      where: { memoryId: root!.memoryId, loc: { startsWith: `${TEAM_CHAT_MESSAGES_LOC}:` } },
    });
    expect(messages).toBe(1);
  });
});

describe('createTeamChatMessage — sessionRef author derivation', () => {
  it('posts as the session-bound persona and stamps the driving session', async () => {
    const s = await personaSession(appMember.id);
    const msg = await post(ctx(appMember.id), { body: 'persona speaking', sessionRef: s.sessionId });
    expect(msg.authorAgentId).toBe(s.agentId);
    expect(msg.authorUserId).toBeNull();
    expect(msg.authorName).toBe(s.personaName);
    expect(msg.sessionId).toBe(s.sessionId);
    // createdBy stays the human DRIVER (#914 — the sender column).
    const row = await db.node.findUnique({ where: { id: msg.nodeId } });
    expect(row!.createdBy).toBe(appMember.id);
    const env = row!.data as Record<string, unknown>;
    expect(env.authorAgentId).toBe(s.agentId);
    expect(env.sessionId).toBe(s.sessionId);
  });

  it("refuses a session attributed to someone else (co-members can't wear each other's persona)", async () => {
    const s = await personaSession(admin.id);
    await expectCode(post(ctx(appMember.id), { sessionRef: s.sessionId }), 'FORBIDDEN');
  });

  it('refuses an ended session with SESSION_ENDED', async () => {
    const s = await personaSession(appMember.id);
    await db.session.update({ where: { id: s.sessionId }, data: { endedAt: new Date() } });
    await expectCode(post(ctx(appMember.id), { sessionRef: s.sessionId }), 'SESSION_ENDED');
  });

  it('refuses a session with no persona binding with SESSION_NOT_PERSONA_BOUND', async () => {
    const sessionId = generateId();
    await db.session.create({ data: { id: sessionId, appId: app.id, userId: appMember.id } });
    await expectCode(post(ctx(appMember.id), { sessionRef: sessionId }), 'SESSION_NOT_PERSONA_BOUND');
  });

  it('refuses an unknown session with SESSION_NOT_FOUND', async () => {
    await expectCode(post(ctx(appMember.id), { sessionRef: 'nope' }), 'SESSION_NOT_FOUND');
  });

  it("refuses another App's session with SESSION_NOT_IN_APP (Codex P1 — no cross-App persona authoring)", async () => {
    // The caller's OWN writable session, but bound to a different App: the
    // write gate passes and the App binding must still refuse it.
    const s = await personaSession(appMember.id);
    const otherApp = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Other App', urn: `${org.urn}:other-s` },
    });
    await db.session.update({ where: { id: s.sessionId }, data: { appId: otherApp.id } });
    await expectCode(post(ctx(appMember.id), { sessionRef: s.sessionId }), 'SESSION_NOT_IN_APP');
  });
});

describe('teamChatMessages — mentions round trip', () => {
  it('write-time extraction feeds the read-time filter, for personas and users', async () => {
    const s = await personaSession(appMember.id);
    await post(ctx(appMember.id), { body: `@${s.personaName} please take auth` });
    await post(ctx(admin.id), { body: `thanks @${appMember.handle}, merged` });
    await post(ctx(admin.id), { body: 'no mentions here' });

    const forPersona = await read(ctx(appMember.id), { mentionsRef: s.agentId });
    expect(forPersona.total).toBe(1);
    expect(forPersona.items[0].body).toContain('please take auth');
    expect(forPersona.items[0].mentions).toContain(s.personaName.toLowerCase());

    const forUser = await read(ctx(appMember.id), { mentionsRef: `hrn:user:${appMember.handle}` });
    expect(forUser.total).toBe(1);
    expect(forUser.items[0].body).toContain('merged');

    // The mentions filter composes with the sinceSeq watermark.
    const windowed = await read(ctx(appMember.id), { mentionsRef: s.agentId, sinceSeq: 1 });
    expect(windowed.total).toBe(0);
  });

  it('an unresolvable mentionsRef collapses to the empty page, never an error', async () => {
    await post(ctx(appMember.id), { body: '@nobody hello' });
    const page = await read(ctx(appMember.id), { mentionsRef: 'hrn:agent:no-such-org.com:ghost' });
    expect(page).toEqual({ items: [], total: 0 });
  });

  it('an Agent NOT installed in this App reads as the same empty page (Codex P1 — no existence oracle)', async () => {
    // A foreign org's private agent whose name matches a stored token: the
    // filter must not distinguish it from a nonexistent ref.
    const foreignOrg = await db.organization.create({
      data: { id: generateId(), name: 'foreign', urn: `foreign-${Date.now()}.example` },
    });
    const foreign = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: foreignOrg.id,
        name: 'Ghost',
        urn: `${foreignOrg.urn}:ghost`,
        personaName: 'Iris',
      },
    });
    await post(ctx(appMember.id), { body: '@iris are you there' });
    const page = await read(ctx(appMember.id), { mentionsRef: foreign.id });
    expect(page).toEqual({ items: [], total: 0 });
  });

  it('a user who is not on the roster reads as the empty page; the caller themself resolves', async () => {
    await post(ctx(appMember.id), { body: `ping @${appMember.handle}` });
    // outsider (a real user, resolvable globally) is not an AppMember —
    // filtering by them must look identical to a nonexistent ref.
    const page = await read(ctx(appMember.id), { mentionsRef: outsider.id });
    expect(page).toEqual({ items: [], total: 0 });
    // The caller can always filter for their own mentions.
    const self = await read(ctx(appMember.id), { mentionsRef: appMember.id });
    expect(self.total).toBe(1);
  });

  it('a multiword persona is mentioned by its slug (@mary-jane)', async () => {
    const mj = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        name: 'Mary Jane',
        urn: `${org.urn}:mary-jane`,
        personaName: 'Mary Jane',
      },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: mj.id } });
    await post(ctx(appMember.id), { body: '@mary-jane please review' });
    const page = await read(ctx(appMember.id), { mentionsRef: mj.id });
    expect(page.total).toBe(1);
    expect(page.items[0].mentions).toEqual(['mary-jane']);
  });
});

describe('canonical-shape guards (off-road nodes, tombstoned root)', () => {
  it('off-road nodes under the messages prefix neither read as messages nor accept replies', async () => {
    await post(ctx(appMember.id), { body: 'real message' });
    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
    });
    // A generic write (D-2026-08-10-003 keeps the surface open) parks an
    // off-road node with a seq under the messages prefix.
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: root!.memoryId,
        loc: `${TEAM_CHAT_MESSAGES_LOC}:offroad-note`,
        name: 'offroad',
        nodeType: 'info',
        seq: 999,
      },
    });
    const page = await read(ctx(appMember.id));
    expect(page.total).toBe(1);
    expect(page.items.map((m: { seq: number }) => m.seq)).toEqual([1]);
    await expectCode(
      post(ctx(appMember.id), { body: 'replying off-road', replyToSeq: 999 }),
      'TEAM_CHAT_REPLY_NOT_FOUND',
    );
  });

  it('a soft-deleted chats:team root is restored on the next post, seq continuing (Copilot on PR #941)', async () => {
    await post(ctx(appMember.id), { body: 'before delete' });
    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
    });
    // Soft-delete the whole chat subtree (root, container, message).
    await db.node.updateMany({
      where: { memoryId: root!.memoryId, loc: { startsWith: 'chats' } },
      data: { deletedAt: new Date() },
    });
    const msg = await post(ctx(appMember.id), { body: 'after restore' });
    // The tombstone was restored, not re-created: data survives, so the seq
    // continues past the (still-deleted) first message.
    expect(msg.seq).toBe(2);
    const restored = await db.node.findUnique({ where: { id: root!.id } });
    expect(restored!.deletedAt).toBeNull();
    // Old messages stay deleted; the transcript shows only the new one.
    const page = await read(ctx(appMember.id));
    expect(page.total).toBe(1);
    expect(page.items[0].body).toBe('after restore');
  });
});

describe('teamChatMessages — pagination + sinceSeq', () => {
  beforeEach(async () => {
    for (let i = 1; i <= 5; i++) {
      await post(ctx(appMember.id), { body: `message ${i}` });
    }
  });

  it('pages seq-ascending with { items, total }', async () => {
    const page = await read(ctx(appMember.id), { limit: 2, offset: 2 });
    expect(page.total).toBe(5);
    expect(page.items.map((m: { seq: number }) => m.seq)).toEqual([3, 4]);
  });

  it('sinceSeq is a strictly-greater watermark', async () => {
    const page = await read(ctx(appMember.id), { sinceSeq: 3 });
    expect(page.total).toBe(2);
    expect(page.items.map((m: { seq: number }) => m.seq)).toEqual([4, 5]);
  });

  it('limit: 0 is count-only', async () => {
    const page = await read(ctx(appMember.id), { limit: 0 });
    expect(page).toEqual({ items: [], total: 5 });
  });

  it('an App with no team chat yet reads as the empty page', async () => {
    const app2 = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Fresh App', urn: `${org.urn}:fresh` },
    });
    const page = await Q.teamChatMessages({}, { appRef: app2.id }, ctx(admin.id));
    expect(page).toEqual({ items: [], total: 0 });
  });
});

describe('auth matrix — one case per principal shape', () => {
  it("a 'reader' AppMember may post (participation follows the host memory, cor:acl:030:01)", async () => {
    const msg = await post(ctx(appReader.id), { body: 'reader speaking' });
    expect(msg.seq).toBe(1);
  });

  it('an org CONTRIBUTOR who is not an AppMember may post and read', async () => {
    await post(ctx(contrib.id), { body: 'contributor here' });
    const page = await read(ctx(contrib.id));
    expect(page.total).toBe(1);
  });

  it('a non-member is refused for both post and read', async () => {
    await expectCode(post(ctx(outsider.id), {}), 'FORBIDDEN');
    await expectCode(read(ctx(outsider.id)), 'FORBIDDEN');
  });

  it('an unauthenticated caller is refused', async () => {
    await expectCode(post(ctx(undefined), {}), 'FORBIDDEN');
  });

  it('a pure App-key principal cannot post but may read its own team chat', async () => {
    await post(ctx(appMember.id), { body: 'for the record' });
    await expectCode(post(ctx(undefined, app.id), {}), 'FORBIDDEN');
    const page = await read(ctx(undefined, app.id));
    expect(page.total).toBe(1);
  });

  it("another App's key may not read this team chat", async () => {
    const app2 = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Other App', urn: `${org.urn}:other` },
    });
    await expectCode(read(ctx(undefined, app2.id)), 'FORBIDDEN');
  });

  it('a hybrid user+selection principal is judged on the USER, not the selection', async () => {
    // outsider with an active-App selection of this very App — the selection
    // is not a credential (findings:auth-appid-credential-vs-selection).
    await expectCode(post(ctx(outsider.id, app.id), {}), 'FORBIDDEN');
  });

  it('an impersonation session may read but never post', async () => {
    await post(ctx(appMember.id), { body: 'visible to support' });
    const imp: Context = {
      db,
      userId: appMember.id,
      roles: ['READER'],
      impersonation: { orgId: org.id } as any,
    } as Context;
    const page = await Q.teamChatMessages({}, { appRef: app.id }, imp);
    expect(page.total).toBe(1);
    await expectCode(M.createTeamChatMessage({}, { appRef: app.id, body: 'hi' }, imp), 'FORBIDDEN');
  });

  it("impersonation reads stay inside the support session's org (#876 class)", async () => {
    await post(ctx(appMember.id), { body: 'org-A only' });
    // Support session opened for a DIFFERENT org: the target's membership in
    // this App must not widen the view.
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'other-org', urn: `imp-other-${Date.now()}.com` },
    });
    const crossOrgImp: Context = {
      db,
      userId: appMember.id,
      roles: ['READER'],
      impersonation: { orgId: otherOrg.id } as any,
    } as Context;
    await expectCode(Q.teamChatMessages({}, { appRef: app.id }, crossOrgImp), 'FORBIDDEN');
    // And a user-owned App is never readable under impersonation at all.
    const owner = await db.user.create({
      data: { id: generateId(), githubId: 93907, githubUsername: `tc-imp-owner-${Date.now()}`, roles: ['READER'] },
    });
    const userApp = await db.app.create({
      data: { id: generateId(), ownerUserId: owner.id, name: 'Owned', urn: `u:${owner.id}:owned` },
    });
    const ownerImp: Context = {
      db,
      userId: owner.id,
      roles: ['READER'],
      impersonation: { orgId: org.id } as any,
    } as Context;
    await expectCode(Q.teamChatMessages({}, { appRef: userApp.id }, ownerImp), 'FORBIDDEN');
  });

  it('a user-owned App is strictly owner-gated (spec 047)', async () => {
    const owner = await db.user.create({
      data: { id: generateId(), githubId: 93906, githubUsername: `tc-owner-${Date.now()}`, roles: ['READER'] },
    });
    const userApp = await db.app.create({
      data: { id: generateId(), ownerUserId: owner.id, name: 'My App', urn: `u:${owner.id}:mine` },
    });
    // Gate check via read (no bootstrap on reads): owner gets the empty page,
    // anyone else — even a platform org admin — is refused.
    const page = await Q.teamChatMessages({}, { appRef: userApp.id }, ctx(owner.id));
    expect(page).toEqual({ items: [], total: 0 });
    await expectCode(Q.teamChatMessages({}, { appRef: userApp.id }, ctx(admin.id)), 'FORBIDDEN');
  });
});
