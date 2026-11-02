import { isRawChatNode } from '../../../services/embedding/rawChat.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
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
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import {
  extractMentions,
  mentionTokenOf,
  postSystemNotice,
  TEAM_CHAT_LOC,
  TEAM_CHAT_MESSAGES_LOC,
  TEAM_CHAT_BODY_MAX_CHARS,
} from './resolvers.teamChat.js';
import { workerSlugBase } from '../../../lib/workerSlug.js';
import { writeSessionHandoff } from './resolvers.mutation.session.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { decryptNodeFieldsWithKey, encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';

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
      content: 'You are {{worker.name}}, a {{worker.role}}.',
      data: { names: ['Iris', 'Henry'] },
    },
  });

  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: appMember.id, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: appReader.id, role: 'reader' } });
  await serveEveryAgent(db); // #2712: binds need a served prompt
});

/** Cast a Worker of the installed team agent and bind an active session
 * (driven by `userId`) to it — the #974 fixture shape: the Worker row IS the
 * named identity; `Session.agentId` still records the role-agent. */
async function workerSession(userId: string, name = 'Iris'): Promise<{ workerId: string; workerName: string; sessionId: string }> {
  const worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: teamAgent.id, name, slug: workerSlugBase(name) },
  });
  const sessionId = generateId();
  await db.session.create({
    data: { id: sessionId, appId: app.id, userId, agentId: teamAgent.id, workerId: worker.id },
  });
  return { workerId: worker.id, workerName: worker.name, sessionId };
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
    expect(msg.authorWorkerId).toBeNull();
    expect(msg.authorName).toBe(appMember.handle);
    expect(msg.body).toBe('first!');

    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
    });
    expect(root).not.toBeNull();
    expect(root!.nodeType).toBe('chat');
    const rootData = root!.data as Record<string, unknown>;
    // Bootstrap delegates to the same Channel creation core as createChannel;
    // the retired shared/private marker must not reappear on this path.
    expect(rootData.scope).toBeUndefined();
    expect(rootData.messageCount).toBe(1);

    const row = await db.node.findUnique({ where: { id: msg.nodeId } });
    expect(row!.nodeType).toBe('chat-message');
    expect(isRawChatNode(row!)).toBe(true);
    expect(isRawChatNode(root!)).toBe(false);
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

describe('#1061 — team chat posts and reads are counted as usage', () => {
  /** Poll: recording is fire-and-forget, so the row lands after the call returns. */
  const settle = async (type: 'read' | 'write', want: number) => {
    for (let i = 0; i < 50; i++) {
      if ((await db.usageEvent.count({ where: { type } })) >= want) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    return db.usageEvent.findMany({
      where: { type },
      select: { nodeId: true, nodeLoc: true, memoryId: true, userId: true },
    });
  };

  it('records a write for a post, attributed to the poster and the shared memory', async () => {
    const msg = await post(ctx(appMember.id), { body: 'counted' });

    const events = await settle('write', 1);
    expect(events).toHaveLength(1);
    // The loc is minted inside the append transaction — this asserts it
    // actually escapes the closure, not just that SOMETHING was recorded.
    expect(events[0].nodeId).toBe(msg.nodeId);
    expect(events[0].nodeLoc).not.toBeNull();
    expect(events[0].userId).toBe(appMember.id);

    const row = await db.node.findUniqueOrThrow({ where: { id: msg.nodeId } });
    expect(events[0].nodeLoc).toBe(row.loc);
    expect(events[0].memoryId).toBe(row.memoryId);
  });

  it('records one read per message returned by a transcript read', async () => {
    await post(ctx(appMember.id), { body: 'one' });
    await post(ctx(appMember.id), { body: 'two' });
    await post(ctx(appMember.id), { body: 'three' });

    const page = await read(ctx(appMember.id));
    expect(page.items).toHaveLength(3);

    const events = await settle('read', 3);
    expect(events).toHaveLength(3);
  });

  it('records nothing for an impersonated read that SUCCEEDS', async () => {
    await post(ctx(appMember.id), { body: 'seed' });
    const baseline = await db.usageEvent.count({ where: { type: 'read' } });

    // The impersonation org MUST match the App's, so the read is genuinely
    // ALLOWED — otherwise this would only be asserting that a FORBIDDEN throw
    // records nothing, which proves nothing about the suppression.
    const imp = {
      db,
      userId: appMember.id,
      roles: [],
      impersonation: { sessionId: 'imp', adminUserId: admin.id, orgId: org.id },
    } as unknown as Context;
    const page = await Q.teamChatMessages({}, { appRef: app.id }, imp);
    expect(page.items).toHaveLength(1); // the read succeeded

    // ctx.userId is the TARGET in a support session, so recording would file
    // an admin's browsing as the target user's own activity.
    await new Promise((r) => setTimeout(r, 150));
    expect(await db.usageEvent.count({ where: { type: 'read' } })).toBe(baseline);
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

  it('a soft-deleted target is the same typed refusal (the deletedAt filter holds)', async () => {
    const first = await post(ctx(appMember.id), { body: 'gone soon' });
    await db.node.update({ where: { id: first.nodeId }, data: { deletedAt: new Date() } });
    await expectCode(
      post(ctx(appMember.id), { body: 'reply to deleted', replyToSeq: first.seq }),
      'TEAM_CHAT_REPLY_NOT_FOUND',
    );
  });
});

describe('#1842 — a reply notifies the replied-to worker (cor:agt:020:04 rev17)', () => {
  const envOf = async (nodeId: string) =>
    ((await db.node.findUnique({ where: { id: nodeId }, select: { data: true } }))!.data) as Record<string, unknown>;

  it('an untagged reply to a worker message records that worker as mentioned (the #1842 red on main)', async () => {
    const iris = await workerSession(appMember.id, 'Iris');
    const target = await post(ctx(appMember.id), { body: 'the blocking question', sessionRef: iris.sessionId });
    const reply = await post(ctx(admin.id), { body: 'ruling: A', replyToSeq: target.seq });
    expect(await envOf(reply.nodeId)).toMatchObject({ mentions: ['iris'] });
  });

  it('direct target only — a reply to a reply never notifies the grandparent author (no thread propagation)', async () => {
    const iris = await workerSession(appMember.id, 'Iris');
    const henry = await workerSession(admin.id, 'Henry');
    const first = await post(ctx(appMember.id), { body: 'q', sessionRef: iris.sessionId });
    const second = await post(ctx(admin.id), { body: 'a', replyToSeq: first.seq, sessionRef: henry.sessionId });
    expect(await envOf(second.nodeId)).toMatchObject({ mentions: ['iris'] });
    const third = await post(ctx(appMember.id), { body: 'thanks', replyToSeq: second.seq });
    expect(await envOf(third.nodeId)).toMatchObject({ mentions: ['henry'] });
  });

  it('no self-notification — a worker replying to its own message records no mention', async () => {
    const iris = await workerSession(appMember.id, 'Iris');
    const first = await post(ctx(appMember.id), { body: 'note', sessionRef: iris.sessionId });
    const reply = await post(ctx(appMember.id), { body: 'update', replyToSeq: first.seq, sessionRef: iris.sessionId });
    expect((await envOf(reply.nodeId)).mentions).toBeUndefined();
  });

  it('workers only — a reply to a HUMAN message records no mention for the human', async () => {
    const human = await post(ctx(appMember.id), { body: 'human asking' });
    const iris = await workerSession(admin.id, 'Iris');
    const reply = await post(ctx(admin.id), { body: 'worker answering', replyToSeq: human.seq, sessionRef: iris.sessionId });
    expect((await envOf(reply.nodeId)).mentions).toBeUndefined();
  });

  it('workers only — a reply to a SYSTEM message records no mention', async () => {
    // The Channel bootstraps lazily on the first ordinary post; a system
    // notice only posts into a LIVE Channel (#1791), so seed one first.
    await post(ctx(appMember.id), { body: 'seed' });
    expect(await postSystemNotice(db, app.id, 'platform notice')).toBe(true);
    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
    });
    const notice = await db.node.findFirst({
      where: {
        memoryId: root!.memoryId,
        loc: { startsWith: `${TEAM_CHAT_MESSAGES_LOC}:` },
        nodeType: 'chat-message',
      },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    const iris = await workerSession(admin.id, 'Iris');
    const reply = await post(ctx(admin.id), { body: 'noted', replyToSeq: notice!.seq, sessionRef: iris.sessionId });
    expect((await envOf(reply.nodeId)).mentions).toBeUndefined();
  });

  it('set semantics — a body @token and the fold of the same worker record exactly one mention', async () => {
    const iris = await workerSession(appMember.id, 'Iris');
    const first = await post(ctx(appMember.id), { body: 'q', sessionRef: iris.sessionId });
    const reply = await post(ctx(admin.id), { body: '@iris agreed', replyToSeq: first.seq });
    expect(await envOf(reply.nodeId)).toMatchObject({ mentions: ['iris'] });
  });

  it("the token follows the worker's CURRENT name — a renamed worker is still notified", async () => {
    const mary = await workerSession(appMember.id, 'Mary Jane');
    const first = await post(ctx(appMember.id), { body: 'q', sessionRef: mary.sessionId });
    await db.worker.update({ where: { id: mary.workerId }, data: { name: 'Mary Jane Smith' } });
    const reply = await post(ctx(admin.id), { body: 'answer', replyToSeq: first.seq });
    expect(await envOf(reply.nodeId)).toMatchObject({ mentions: ['mary-jane-smith'] });
  });

  it('a target whose worker row no longer exists posts without a fold (the fold never refuses a reply)', async () => {
    const iris = await workerSession(appMember.id, 'Iris');
    const first = await post(ctx(appMember.id), { body: 'q', sessionRef: iris.sessionId });
    await db.session.delete({ where: { id: iris.sessionId } });
    await db.worker.delete({ where: { id: iris.workerId } });
    const reply = await post(ctx(admin.id), { body: 'late answer', replyToSeq: first.seq });
    expect((await envOf(reply.nodeId)).mentions).toBeUndefined();
  });

  it('no backfill — a later folded reply never touches existing messages', async () => {
    const iris = await workerSession(appMember.id, 'Iris');
    const first = await post(ctx(appMember.id), { body: 'q', sessionRef: iris.sessionId });
    const early = await post(ctx(admin.id), { body: 'early reply', replyToSeq: first.seq });
    const before = JSON.stringify(await envOf(first.nodeId));
    const henry = await workerSession(admin.id, 'Henry');
    await post(ctx(admin.id), { body: 'later reply', replyToSeq: first.seq, sessionRef: henry.sessionId });
    expect(JSON.stringify(await envOf(first.nodeId))).toBe(before);
    // The early reply keeps exactly its own fold; the new one added nothing to it.
    expect(await envOf(early.nodeId)).toMatchObject({ mentions: ['iris'] });
  });

  // Riana §10 P2 (#10533): the fold must never widen a wake. A worker whose
  // token IS a broadcast word ('all'/'team') cannot be reply-notified, because
  // the stored broadcast token wakes everyone (broadcastWakes, and every
  // mention-filtered reader matches it for every worker). The fold skips such
  // tokens; an explicit @all in the body keeps its existing broadcast meaning.
  it('a worker named "All" is never fold-notified — no broadcast token, no broadcastWakes stamp', async () => {
    const allWorker = await workerSession(appMember.id, 'All');
    const first = await post(ctx(appMember.id), { body: 'q', sessionRef: allWorker.sessionId });
    // appMember is the App owner (created it via the org ADMIN) — a manager
    // author, the exact shape whose tagless reply must not broadcast.
    const reply = await post(ctx(admin.id), { body: 'answer', replyToSeq: first.seq });
    const env = await envOf(reply.nodeId);
    expect(env.mentions).toBeUndefined();
    expect(env.broadcastWakes).toBeUndefined();
  });

  it('a worker named "Team" is likewise never fold-notified', async () => {
    const teamWorker = await workerSession(appMember.id, 'Team');
    const first = await post(ctx(appMember.id), { body: 'q', sessionRef: teamWorker.sessionId });
    const reply = await post(ctx(admin.id), { body: 'answer', replyToSeq: first.seq });
    const env = await envOf(reply.nodeId);
    expect(env.mentions).toBeUndefined();
    expect(env.broadcastWakes).toBeUndefined();
  });

  it('an explicit @all in the body still broadcasts — the one-format contract is unchanged', async () => {
    await post(ctx(appMember.id), { body: 'seed' });
    const reply = await post(ctx(admin.id), { body: '@all heads up', replyToSeq: 1 });
    const env = await envOf(reply.nodeId);
    expect(env.mentions).toEqual(['all']);
  });
});

describe('createTeamChatMessage — sessionRef author derivation', () => {
  it('posts as the session-bound worker and stamps the driving session', async () => {
    const s = await workerSession(appMember.id);
    const msg = await post(ctx(appMember.id), { body: 'worker speaking', sessionRef: s.sessionId });
    expect(msg.authorWorkerId).toBe(s.workerId);
    expect(msg.authorUserId).toBeNull();
    expect(msg.authorName).toBe(s.workerName);
    expect(msg.sessionId).toBe(s.sessionId);
    // createdBy stays the human DRIVER (#914 — the sender column).
    const row = await db.node.findUnique({ where: { id: msg.nodeId } });
    expect(row!.createdBy).toBe(appMember.id);
    const env = row!.data as Record<string, unknown>;
    expect(env.authorWorkerId).toBe(s.workerId);
    expect(env.sessionId).toBe(s.sessionId);
  });

  it("refuses a session attributed to someone else (co-members can't wear each other's worker)", async () => {
    const s = await workerSession(admin.id);
    await expectCode(post(ctx(appMember.id), { sessionRef: s.sessionId }), 'FORBIDDEN');
  });

  it('refuses an ended session with SESSION_ENDED', async () => {
    const s = await workerSession(appMember.id);
    await db.session.update({ where: { id: s.sessionId }, data: { endedAt: new Date() } });
    await expectCode(post(ctx(appMember.id), { sessionRef: s.sessionId }), 'SESSION_ENDED');
  });

  it('refuses a session with no worker binding with SESSION_NOT_WORKER_BOUND', async () => {
    const sessionId = generateId();
    await db.session.create({ data: { id: sessionId, appId: app.id, userId: appMember.id } });
    await expectCode(post(ctx(appMember.id), { sessionRef: sessionId }), 'SESSION_NOT_WORKER_BOUND');
  });

  it('refuses an unknown session with SESSION_NOT_FOUND', async () => {
    await expectCode(post(ctx(appMember.id), { sessionRef: 'nope' }), 'SESSION_NOT_FOUND');
  });

  it("a session of another App bound to THIS App's worker authors — the session-App pin is subsumed by item J (spec 049 Phase 8)", async () => {
    // Before Phase 8 this refused SESSION_NOT_IN_APP. Item J replaced both
    // pins with one check on the WORKER: its App is the Channel's (true here),
    // or its driver may write the host memory. The session's own App is not
    // a rule any more — the Worker is what authors, and this one is ours.
    const s = await workerSession(appMember.id);
    const otherApp = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Other App', urn: `${org.urn}:other-s` },
    });
    await db.session.update({ where: { id: s.sessionId }, data: { appId: otherApp.id } });
    const msg = await post(ctx(appMember.id), { sessionRef: s.sessionId });
    expect(msg.authorWorkerId).toBe(s.workerId);
    expect(msg.authorAppId).toBeNull();
  });

  it("refuses a worker of a DIFFERENT App whose driver may not write this host memory — CHANNEL_HOST_NOT_WRITABLE (item J, the successor of the worker-App pin)", async () => {
    // A session OF this App, hand-bound to another App's worker. Its driver
    // is outside this App, so the host-memory check refuses the cross-App post.
    const otherApp = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Other App W', urn: `${org.urn}:other-w` },
    });
    await db.appAgent.create({ data: { appId: otherApp.id, agentId: teamAgent.id } });
    const foreignWorker = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: otherApp.id, agentId: teamAgent.id, name: 'Iris', slug: 'iris' },
    });
    const sessionId = generateId();
    await db.session.create({
      data: { id: sessionId, appId: app.id, userId: outsider.id, agentId: teamAgent.id, workerId: foreignWorker.id },
    });
    await expectCode(post({ ...ctx(admin.id), roles: ['ADMIN'] }, { sessionRef: sessionId }), 'CHANNEL_HOST_NOT_WRITABLE');
  });

  it('a retired worker stops authoring at once — WORKER_RETIRED at post time (#974)', async () => {
    const s = await workerSession(appMember.id);
    await post(ctx(appMember.id), { body: 'still cast', sessionRef: s.sessionId });
    // Retirement is checked at POST time, not bind time: the still-active
    // session does not grandfather the identity.
    await db.worker.update({ where: { id: s.workerId }, data: { retiredAt: new Date() } });
    await expectCode(post(ctx(appMember.id), { sessionRef: s.sessionId }), 'WORKER_RETIRED');
  });

  it("posting survives the agent's uninstall — retirement, not uninstall, is the revocation lever (#974)", async () => {
    const s = await workerSession(appMember.id);
    // Bootstrap while the agent is still installed (first-post bootstrap
    // locates the Team Agent; the Worker row itself does not need it).
    await post(ctx(appMember.id), { body: 'bootstrap' });
    await db.appAgent.delete({ where: { appId_agentId: { appId: app.id, agentId: teamAgent.id } } });
    const msg = await post(ctx(appMember.id), { body: 'after uninstall', sessionRef: s.sessionId });
    expect(msg.authorWorkerId).toBe(s.workerId);
    expect(msg.authorName).toBe(s.workerName);
  });
});

describe('teamChatMessages — mentions round trip', () => {
  it('stores only prose mentions when a worker name appears in Markdown code', async () => {
    const s = await workerSession(appMember.id);
    const token = `@${s.workerName}`;
    const codeOnly = await post(ctx(admin.id), {
      body: [`Example: \`${token}\``, '```sh', `notify ${token}`, '```'].join('\n'),
    });
    expect(codeOnly.mentions).toEqual([]);
    const quotedFence = await post(ctx(admin.id), {
      body: ['> ~~~', `> ${token}`, '> ~~~'].join('\n'),
    });
    expect(quotedFence.mentions).toEqual([]);
    const headingCode = await post(ctx(admin.id), {
      body: ['# Example', `    ${token}`].join('\n'),
    });
    expect(headingCode.mentions).toEqual([]);
    const codeWithQuotePrefix = await post(ctx(admin.id), {
      body: ['```sh', `> ${token}`, token, '```'].join('\n'),
    });
    expect(codeWithQuotePrefix.mentions).toEqual([]);
    expect(await read(ctx(appMember.id), { mentionsRef: s.workerId })).toMatchObject({ items: [], total: 0 });

    const addressed = await post(ctx(admin.id), { body: `\`${token}\` is an example. ${token}, please review.` });
    expect(addressed.mentions).toEqual([s.workerName.toLowerCase()]);
    const page = await read(ctx(appMember.id), { mentionsRef: s.workerId });
    expect(page.total).toBe(1);
    expect(page.items[0].seq).toBe(addressed.seq);
  });

  it('write-time extraction feeds the read-time filter, for workers and users', async () => {
    const s = await workerSession(appMember.id);
    await post(ctx(appMember.id), { body: `@${s.workerName} please take auth` });
    await post(ctx(admin.id), { body: `thanks @${appMember.handle}, merged` });
    await post(ctx(admin.id), { body: 'no mentions here' });

    const forWorker = await read(ctx(appMember.id), { mentionsRef: s.workerId });
    expect(forWorker.total).toBe(1);
    expect(forWorker.items[0].body).toContain('please take auth');
    expect(forWorker.items[0].mentions).toContain(s.workerName.toLowerCase());

    // A worker also resolves by NAME, case-insensitively (#974).
    const byName = await read(ctx(appMember.id), { mentionsRef: s.workerName.toUpperCase() });
    expect(byName.total).toBe(1);

    const forUser = await read(ctx(appMember.id), { mentionsRef: `hrn:user:${appMember.handle}` });
    expect(forUser.total).toBe(1);
    expect(forUser.items[0].body).toContain('merged');

    // The mentions filter composes with the sinceSeq watermark.
    const windowed = await read(ctx(appMember.id), { mentionsRef: s.workerId, sinceSeq: 1 });
    expect(windowed.total).toBe(0);

    // A RETIRED worker still resolves — history keeps its mentions readable.
    await db.worker.update({ where: { id: s.workerId }, data: { retiredAt: new Date() } });
    const retired = await read(ctx(appMember.id), { mentionsRef: s.workerId });
    expect(retired.total).toBe(1);
  });

  it('an unresolvable mentionsRef collapses to the empty page, never an error', async () => {
    await post(ctx(appMember.id), { body: '@nobody hello' });
    const page = await read(ctx(appMember.id), { mentionsRef: 'hrn:agent:no-such-org.com:ghost' });
    expect(page).toMatchObject({ items: [], total: 0 });
  });

  it("a Worker of ANOTHER App reads as the same empty page (Codex P1 — no existence oracle)", async () => {
    // A foreign App's worker whose name matches a stored token: the filter
    // must not distinguish it from a nonexistent ref — a worker ref only
    // resolves within THIS App's own staff (#974).
    const foreignOrg = await db.organization.create({
      data: { id: generateId(), name: 'foreign', urn: `foreign-${Date.now()}.example` },
    });
    const foreignApp = await db.app.create({
      data: {
        id: generateId(),
        organizationId: foreignOrg.id,
        name: 'Foreign Team',
        urn: `${foreignOrg.urn}:foreign-team`,
      },
    });
    const foreignAgent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: foreignOrg.id,
        name: 'Ghost',
        urn: `${foreignOrg.urn}:ghost`,
      },
    });
    const foreignWorker = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: foreignApp.id, agentId: foreignAgent.id, name: 'Iris', slug: 'iris' },
    });
    await post(ctx(appMember.id), { body: '@iris are you there' });
    const page = await read(ctx(appMember.id), { mentionsRef: foreignWorker.id });
    expect(page).toMatchObject({ items: [], total: 0 });
    // Nor does the foreign worker's NAME resolve here — this App has no Iris.
    const byName = await read(ctx(appMember.id), { mentionsRef: 'Iris' });
    expect(byName).toMatchObject({ items: [], total: 0 });
  });

  it('a user who is not on the roster reads as the empty page; the caller themself resolves', async () => {
    await post(ctx(appMember.id), { body: `ping @${appMember.handle}` });
    // outsider (a real user, resolvable globally) is not an AppMember —
    // filtering by them must look identical to a nonexistent ref.
    const page = await read(ctx(appMember.id), { mentionsRef: outsider.id });
    expect(page).toMatchObject({ items: [], total: 0 });
    // The caller can always filter for their own mentions.
    const self = await read(ctx(appMember.id), { mentionsRef: appMember.id });
    expect(self.total).toBe(1);
  });

  it('a multiword worker is mentioned by its slug (@mary-jane)', async () => {
    // Worker names may legally contain spaces; the mention contract slugs
    // them (mentionTokenOf) on both the write and the filter side.
    const mj = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: teamAgent.id, name: 'Mary Jane', slug: 'mary-jane' },
    });
    await post(ctx(appMember.id), { body: '@mary-jane please review' });
    const page = await read(ctx(appMember.id), { mentionsRef: mj.id });
    expect(page.total).toBe(1);
    expect(page.items[0].mentions).toEqual(['mary-jane']);
    // The full display name resolves to the same slugged token.
    const byName = await read(ctx(appMember.id), { mentionsRef: 'mary jane' });
    expect(byName.total).toBe(1);
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

  it('takes the newest page by default while explicit sinceSeq and offset keep forward paging', async () => {
    const latest = await read(ctx(appMember.id), { limit: 2 });
    expect(latest.total).toBe(5);
    expect(latest.items.map((m: { seq: number }) => m.seq)).toEqual([4, 5]);
    expect((await read(ctx(appMember.id), { sinceSeq: 0, limit: 2 })).items.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
    expect((await read(ctx(appMember.id), { offset: 0, limit: 2 })).items.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
  });

  it('sinceSeq is a strictly-greater watermark', async () => {
    const page = await read(ctx(appMember.id), { sinceSeq: 3 });
    expect(page.total).toBe(2);
    expect(page.items.map((m: { seq: number }) => m.seq)).toEqual([4, 5]);
  });

  it('limit: 0 is count-only', async () => {
    const page = await read(ctx(appMember.id), { limit: 0 });
    expect(page).toMatchObject({ items: [], total: 5 });
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

  it('an unauthenticated caller is refused as UNAUTHENTICATED, not FORBIDDEN (#1509)', async () => {
    // No principal is not a lack of rights: a client must be able to tell
    // "sign in again" from "not a participant" (hadron-portal#974).
    await expectCode(post(ctx(undefined), {}), 'UNAUTHENTICATED');
    await expectCode(read(ctx(undefined)), 'UNAUTHENTICATED');
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

/**
 * #1030 — the team chat lives inside the `chats:` namespace the AGENT-chat
 * surface enumerates and addresses by loc, so it was returned by `myChats` as
 * one of the caller's chatbot conversations and carried every affordance one
 * has: an LLM composer that bypasses this file's seq allocator, mention
 * extraction and authorship gate, and a delete that soft-deletes the root and
 * every message on it.
 *
 * These run against a REAL bootstrapped team chat rather than a planted node,
 * because the shapes that made it indistinguishable — the `chats:` prefix,
 * `data.scope='shared'`, `createdBy` = the human who posted first — are the
 * bootstrap's own output, and a fixture asserting them by hand would keep
 * passing if the bootstrap changed.
 */
describe('#1030 — the team chat is not an agent chat', () => {
  it('myChats does not list it, though the caller can read the memory holding it', async () => {
    await post(ctx(appMember.id), { body: 'first!' });

    // Precondition, so a green test cannot mean "the query found nothing
    // because nothing was reachable": this caller IS an AppMember of an App
    // with this agent installed, which is exactly the branch myChats collects
    // shared chats through.
    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
      select: { memoryId: true, createdBy: true },
    });
    expect(root).not.toBeNull();
    const sharedMem = await db.memory.findUniqueOrThrow({
      where: { id: root!.memoryId },
      select: { appId: true, class: true },
    });
    expect(sharedMem).toEqual({ appId: app.id, class: 'app' });

    const chats = await Q.myChats({}, { agentRef: teamAgent.id }, ctx(appMember.id));
    expect(chats.map((c: { loc: string }) => c.loc)).not.toContain(TEAM_CHAT_LOC);
    expect(chats).toEqual([]);
  });

  it('the composer cannot append an LLM turn to it', async () => {
    await post(ctx(appMember.id), { body: 'first!' });
    await expect(
      M.sendChatMessage({}, { chatId: TEAM_CHAT_LOC, userMessage: 'hi' }, ctx(appMember.id)),
    ).rejects.toThrow(`Chat "${TEAM_CHAT_LOC}" not found`);

    // The record is untouched: still one message, still allocated by this
    // file's allocator rather than the agent-chat path.
    const page = await read(ctx(appMember.id));
    expect(page.total).toBe(1);
    expect(page.items[0].seq).toBe(1);
  });

  it('deleteChat cannot destroy it — not by its author, and not by a platform admin', async () => {
    const msg = await post(ctx(appMember.id), { body: 'first!' });
    expect(msg.seq).toBe(1);

    // The author gate would admit the first poster: bootstrap stamps
    // `createdBy` with the human driver (#914), so before this fix the person
    // who opened the team chat could delete it and every message on it.
    const root = await db.node.findFirstOrThrow({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
      select: { id: true, createdBy: true },
    });
    expect(root.createdBy).toBe(appMember.id);

    await expect(
      M.deleteChat({}, { chatId: TEAM_CHAT_LOC }, ctx(appMember.id)),
    ).rejects.toThrow(`Chat "${TEAM_CHAT_LOC}" not found`);
    await expect(
      M.deleteChat({}, { chatId: TEAM_CHAT_LOC }, { db, userId: admin.id, roles: ['ADMIN'] } as Context),
    ).rejects.toThrow(`Chat "${TEAM_CHAT_LOC}" not found`);

    // Root and messages both survive, and the surface that owns them still
    // reads them.
    const after = await db.node.findMany({
      where: { memoryId: (await db.node.findUniqueOrThrow({ where: { id: root.id }, select: { memoryId: true } })).memoryId },
      select: { loc: true, deletedAt: true },
    });
    for (const n of after.filter((n) => n.loc.startsWith(TEAM_CHAT_LOC))) {
      expect(n.deletedAt).toBeNull();
    }
    expect((await read(ctx(appMember.id))).total).toBe(1);
  });

  it('updateChatTitle cannot rename it', async () => {
    await post(ctx(appMember.id), { body: 'first!' });
    await expect(
      M.updateChatTitle({}, { chatId: TEAM_CHAT_LOC, title: 'renamed' }, ctx(appMember.id)),
    ).rejects.toThrow(`Chat "${TEAM_CHAT_LOC}" not found`);
  });

  it("an ordinary agent chat in the same memory still lists — the exclusion is the team chat, not the App", async () => {
    await post(ctx(appMember.id), { body: 'first!' });
    const root = await db.node.findFirstOrThrow({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
      select: { memoryId: true },
    });
    // A shared agent chat, in the same app-class memory, minted in startChat's
    // own loc shape.
    await db.node.create({
      data: {
        id: generateId(), memoryId: root.memoryId, loc: 'chats:202608181200-abcd1234-research',
        name: '202608181200-abcd1234-research', nodeType: 'record',
        createdBy: appMember.id, data: { scope: 'shared', messageCount: 0 },
      },
    });

    const chats = await Q.myChats({}, { agentRef: teamAgent.id }, ctx(appMember.id));
    expect(chats.map((c: { loc: string }) => c.loc)).toEqual([
      'chats:202608181200-abcd1234-research',
    ]);
  });
});

/**
 * #1029 — session handoff, end to end.
 *
 * The acceptance narrative from the issue: one driver ends a stint with a
 * handoff, a DIFFERENT driver binds the same worker, and the handoff arrives
 * through the bind's own return value with no human copying anything. These
 * run against the real cast/bind/end path rather than planted nodes, because
 * the thing under test is precisely that the pieces meet.
 */
describe('#1029 — worker handoff', () => {
  const startAs = (userId: string, workerId: string) =>
    M.startSession({}, { input: { workerRef: workerId, description: 'stint', appRef: app.id } }, ctx(userId));

  async function castOne(name = 'Iris') {
    const worker = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: teamAgent.id, name, slug: workerSlugBase(name) },
    });
    return worker;
  }

  it('a second driver receives the first driver\'s handoff at bind — nothing is copied', async () => {
    const worker = await castOne();
    const first = await startAs(appMember.id, worker.id);
    await M.endSession(
      {},
      { id: first.id, summary: 'stint one', handoff: 'PR #1042 is open and awaiting review. Do not re-run the migration.' },
      ctx(appMember.id),
    );

    // #1050 — the name is now HELD by the first driver, and ending a session
    // does not free it. So the cross-human path runs through a release, which
    // is the model working rather than an obstacle: a handoff reaches a
    // different person only when the name was deliberately handed over.
    await M.releaseWorker({}, { workerRef: worker.id }, ctx(appMember.id));

    // A DIFFERENT human binds the same worker — and inherits the sequence,
    // because a handoff belongs to the WORKER (Holger, 2026-08-19).
    const second = await startAs(appReader.id, worker.id);
    expect(second.id).not.toBe(first.id);

    const fresh = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const continuity = await resolvers.Worker.continuity(fresh as any, {}, ctx(appReader.id));
    expect(continuity!.status).toBe('CURRENT');
    expect(continuity!.handoff!.content).toContain('PR #1042 is open');
    expect(continuity!.previousSession!.id).toBe(first.id);
    // The chain is walkable, which it was not before: prevSessionId has been in
    // the schema since the beginning with nothing writing it.
    expect(second.prevSessionId).toBe(first.id);
  });

  it('stores the handoff as an ordered child in the worker\'s own working memory', async () => {
    const worker = await castOne('Henry');
    const s1 = await startAs(appMember.id, worker.id);
    await M.endSession({}, { id: s1.id, handoff: 'first' }, ctx(appMember.id));
    const s2 = await startAs(appMember.id, worker.id);
    await M.endSession({}, { id: s2.id, handoff: 'second' }, ctx(appMember.id));

    const fresh = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(fresh.memoryId).not.toBeNull();
    const nodes = await db.node.findMany({
      where: { memoryId: fresh.memoryId!, deletedAt: null },
      orderBy: { loc: 'asc' },
      select: { loc: true, content: true, data: true },
    });
    // The parent carries the convention; the children are the sequence.
    expect(nodes[0].loc).toBe('handoffs');
    const children = nodes.slice(1);
    expect(children).toHaveLength(2);
    expect(children.every((n) => n.loc.startsWith('handoffs:'))).toBe(true);
    // Append-only, oldest first by loc — the ordering contract.
    expect(children.map((n) => n.content)).toEqual(['first', 'second']);
    // Each stamps its writing session, which is what separates CURRENT from stale.
    expect((children[0].data as any).sessionId).toBe(s1.id);
    expect((children[1].data as any).sessionId).toBe(s2.id);
    // And nothing put the timestamp in seq, where it would overflow Int32.
    const seqs = await db.node.findMany({
      where: { memoryId: fresh.memoryId!, loc: { startsWith: 'handoffs:' } },
      select: { seq: true },
    });
    for (const n of seqs) expect(n.seq === null || n.seq < 2_147_483_647).toBe(true);
  });

  it('an auto-expired stint degrades honestly — MISSING, with the older handoff still handed over', async () => {
    const worker = await castOne('Mara');
    const s1 = await startAs(appMember.id, worker.id);
    await M.endSession({}, { id: s1.id, handoff: 'the state as of stint one' }, ctx(appMember.id));

    // Stint two is REAPED: the #930 reaper stamps endedAt and autoExpiredAt
    // together, and writes no handoff because nobody closed it.
    const s2 = await startAs(appMember.id, worker.id);
    const reapedAt = new Date();
    await db.session.update({
      where: { id: s2.id },
      data: { endedAt: reapedAt, autoExpiredAt: reapedAt },
    });

    const fresh = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const continuity = await resolvers.Worker.continuity(fresh as any, {}, ctx(appMember.id));
    expect(continuity!.status).toBe('MISSING');
    // Still handed over — a stale handoff is the best available account.
    expect(continuity!.handoff!.content).toBe('the state as of stint one');
    expect(continuity!.previousSession!.id).toBe(s2.id);
    expect(continuity!.previousSession!.autoExpiredAt).not.toBeNull();
  });

  it('FIRST_STINT on a worker nobody has driven', async () => {
    const worker = await castOne('Nils');
    const continuity = await resolvers.Worker.continuity(worker as any, {}, ctx(appMember.id));
    expect(continuity!.status).toBe('FIRST_STINT');
    expect(continuity!.handoff).toBeNull();
    expect(continuity!.previousSession).toBeNull();
  });

  it('a failed handoff write does NOT end the session', async () => {
    const worker = await castOne('Olav');
    const s1 = await startAs(appMember.id, worker.id);
    // Point the worker at a USER-OWNED memory belonging to someone else.
    // Strict ownership (spec 047) refuses the write even to a platform admin,
    // so this exercises a real refusal rather than a synthetic one — and the
    // contract is that the stint stays OPEN, so the prose can be retried
    // rather than lost with the context that composed it.
    const foreign = await db.memory.create({
      data: {
        id: generateId(), ownerUserId: outsider.id, organizationId: null,
        urn: `hf-foreign-${generateId()}`, name: 'someone else', class: 'app', appId: app.id,
      },
    });
    await db.worker.update({ where: { id: worker.id }, data: { memoryId: foreign.id } });

    await expectCode(
      M.endSession({}, { id: s1.id, handoff: 'work in progress' }, ctx(appMember.id)),
      'HANDOFF_WRITE_FAILED',
    );
    const after = await db.session.findUniqueOrThrow({ where: { id: s1.id } });
    expect(after.endedAt).toBeNull();
  });

  it('refuses a handoff on a session with no worker rather than dropping it', async () => {
    const bare = await M.startSession({}, { input: { description: 'no worker', appRef: app.id } }, ctx(appMember.id));
    await expectCode(
      M.endSession({}, { id: bare.id, handoff: 'nowhere to put this' }, ctx(appMember.id)),
      'SESSION_NOT_WORKER_BOUND',
    );
    const after = await db.session.findUniqueOrThrow({ where: { id: bare.id } });
    expect(after.endedAt).toBeNull();
  });

  it('re-ending an already-ended session writes no second handoff (Codex P1)', async () => {
    // Ending is retry-tolerant, but the sequence is append-only: a retry of a
    // call that actually succeeded would append a SECOND node, newest by loc
    // and stamped with the older session — which, with a re-stamped endedAt,
    // made a stale account read as CURRENT while a later stint's real one was
    // buried.
    const worker = await castOne('Quinn');
    const s1 = await startAs(appMember.id, worker.id);
    await M.endSession({}, { id: s1.id, handoff: 'stint one' }, ctx(appMember.id));
    const endedAt = (await db.session.findUniqueOrThrow({ where: { id: s1.id } })).endedAt;

    const s2 = await startAs(appMember.id, worker.id);
    await M.endSession({}, { id: s2.id, handoff: 'stint two' }, ctx(appMember.id));

    // The retry of the OLDER session.
    await expectCode(
      M.endSession({}, { id: s1.id, handoff: 'stint one' }, ctx(appMember.id)),
      'SESSION_ALREADY_ENDED',
    );

    const fresh = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const children = await db.node.findMany({
      where: { memoryId: fresh.memoryId!, loc: { startsWith: 'handoffs:' }, deletedAt: null },
      orderBy: { loc: 'asc' },
      select: { content: true },
    });
    expect(children.map((c) => c.content)).toEqual(['stint one', 'stint two']);

    // And a plain re-end does not move when the stint finished — endedAt
    // orders the whole continuity chain.
    await M.endSession({}, { id: s1.id, summary: 'late metrics' }, ctx(appMember.id));
    const after = await db.session.findUniqueOrThrow({ where: { id: s1.id } });
    expect(after.endedAt).toEqual(endedAt);

    const continuity = await resolvers.Worker.continuity(fresh as any, {}, ctx(appMember.id));
    expect(continuity!.status).toBe('CURRENT');
    expect(continuity!.handoff!.content).toBe('stint two');
  });

  it('a handoff already written for this stint is not written twice (Codex P2)', async () => {
    // The handoff write and the session close are separate commits, so a crash
    // between them — or two ends racing past the endedAt check — leaves a
    // handoff written against a session still marked open. A retry must not
    // append a duplicate for one stint.
    const worker = await castOne('Sten');
    const s1 = await startAs(appMember.id, worker.id);
    await writeSessionHandoff(ctx(appMember.id) as any, s1.id, worker.id, 'written, not yet closed');
    // The session is still open — exactly the partial-failure state.
    expect((await db.session.findUniqueOrThrow({ where: { id: s1.id } })).endedAt).toBeNull();

    await M.endSession({}, { id: s1.id, handoff: 'written, not yet closed' }, ctx(appMember.id));

    const fresh = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const children = await db.node.findMany({
      where: { memoryId: fresh.memoryId!, loc: { startsWith: 'handoffs:' }, deletedAt: null },
      select: { content: true },
    });
    expect(children).toHaveLength(1);
    expect((await db.session.findUniqueOrThrow({ where: { id: s1.id } })).endedAt).not.toBeNull();
  });

  it('previousSession is a sanitized projection, not the Session row (Codex P1)', async () => {
    // The worker gate is App PARTICIPATION; the session gate needs ORG
    // membership. Returning the row would hand an AppMember the previous
    // driver's transcriptPath, host, repo and summary.
    const worker = await castOne('Rune');
    const s1 = await M.startSession(
      {},
      {
        input: {
          workerRef: worker.id, description: 'stint', appRef: app.id,
          repo: 'secret/repo', transcriptPath: '/Users/someone/private.jsonl',
        },
      },
      ctx(appMember.id),
    );
    await M.endSession({}, { id: s1.id, summary: 'private summary', handoff: 'h' }, ctx(appMember.id));

    const fresh = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const continuity = await resolvers.Worker.continuity(fresh as any, {}, ctx(appMember.id));
    expect(Object.keys(continuity!.previousSession!).sort()).toEqual([
      'autoExpiredAt', 'endedAt', 'id',
    ]);
  });

  it('continuity is a working-state field — masked to null for a caller outside the App', async () => {
    // Same posture as prompt/memoryId (#983): it returns a node out of the
    // worker's memory and a Session row, either of which would otherwise hand
    // an outsider that entity's field resolvers.
    const worker = await castOne('Petra');
    const s1 = await startAs(appMember.id, worker.id);
    await M.endSession({}, { id: s1.id, handoff: 'internal state' }, ctx(appMember.id));
    const fresh = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(await resolvers.Worker.continuity(fresh as any, {}, ctx(outsider.id))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #1116 — beforeSeq: the backward mirror of sinceSeq
// ---------------------------------------------------------------------------

describe('teamChatMessages beforeSeq (#1116)', () => {
  /** Post n messages, bodies "m1".."mn", seq 1..n. */
  async function postN(n: number) {
    for (let i = 1; i <= n; i++) await post(ctx(admin.id), { body: `m${i}` });
  }
  const bodies = (page: { items: Array<{ body: string }> }) => page.items.map((m) => m.body);

  it('returns the page immediately BEFORE the cursor, still ascending', async () => {
    await postN(12);
    const page = await read(ctx(admin.id), { beforeSeq: 9, limit: 3 });
    // The three before 9 — not the three oldest, which is what an ascending
    // read of the same narrowed set would have returned.
    expect(bodies(page)).toEqual(['m6', 'm7', 'm8']);
  });

  it('is strictly less than — the cursor message is never returned', async () => {
    await postN(12);
    const page = await read(ctx(admin.id), { beforeSeq: 9, limit: 3 });
    expect(bodies(page)).not.toContain('m9');
  });

  it('composes with sinceSeq as a bounded slice', async () => {
    await postN(12);
    const page = await read(ctx(admin.id), { sinceSeq: 4, beforeSeq: 9, limit: 50 });
    expect(bodies(page)).toEqual(['m5', 'm6', 'm7', 'm8']);
  });

  /** A backward walk must not lose or repeat a message at a page seam. */
  it('walks the whole transcript backward without a gap or a repeat', async () => {
    await postN(11);
    const seen: string[] = [];
    let cursor: number | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await read(
        ctx(admin.id),
        cursor === undefined
          ? { limit: 4 }
          : { beforeSeq: cursor, limit: 4 },
      );
      if (page.items.length === 0) break;
      seen.unshift(...bodies(page));
      cursor = page.items[0].seq;
    }
    expect(seen).toEqual(Array.from({ length: 11 }, (_, i) => `m${i + 1}`));
  });

  it('an explicit sinceSeq retains the oldest-first forward reader', async () => {
    await postN(12);
    const page = await read(ctx(admin.id), { sinceSeq: 0, limit: 3 });
    expect(bodies(page)).toEqual(['m1', 'm2', 'm3']);
  });

  it('selects both ends of a chat longer than the 200-message cap', async () => {
    const first = await post(ctx(admin.id), { body: 'm1' });
    const firstRow = await db.node.findUniqueOrThrow({ where: { id: first.nodeId }, select: { memoryId: true } });
    // Canonical imported messages cross the cap without 204 transaction-heavy
    // posts; the read path intentionally supports such imported rows.
    await db.node.createMany({ data: Array.from({ length: 204 }, (_, index) => {
      const seq = index + 2;
      return {
        id: generateId(), memoryId: firstRow.memoryId,
        loc: `${TEAM_CHAT_MESSAGES_LOC}:${String(seq).padStart(4, '0')}-${generateId()}`,
        name: `m${seq}`, nodeType: 'chat-message', seq, content: `m${seq}`,
      };
    }) });

    const newest = await read(ctx(admin.id));
    expect(newest.total).toBe(205);
    expect(newest.items.map((m: { seq: number }) => m.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 186));
    expect((await read(ctx(admin.id), { beforeSeq: 186 })).items.map((m: { seq: number }) => m.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 166));
    expect((await read(ctx(admin.id), { sinceSeq: 0 })).items.map((m: { seq: number }) => m.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // The old portal's second request remains correct during rollout.
    expect((await read(ctx(admin.id), { offset: 5, limit: 200 })).items.at(-1)?.seq).toBe(205);
  });

  it('reports the full narrowed total, not the page size', async () => {
    await postN(12);
    const page = await read(ctx(admin.id), { beforeSeq: 9, limit: 3 });
    expect(page.total).toBe(8);
  });

  it('returns an empty page once paged past the beginning', async () => {
    await postN(5);
    expect((await read(ctx(admin.id), { beforeSeq: 1, limit: 5 })).items).toEqual([]);
  });

  /**
   * The mentions branch filters IN MEMORY rather than in SQL (the envelope is
   * ciphertext on an encrypted memory), so it slices the result itself and does
   * not inherit the backward read order from the query. That makes it a second
   * implementation of the same paging rule, and nothing above reaches it.
   */
  it('applies the backward window to the mentions branch too', async () => {
    const s = await workerSession(appMember.id);
    for (let i = 1; i <= 6; i++) {
      await post(ctx(appMember.id), { body: `@${s.workerName} note ${i}` });
    }
    await post(ctx(admin.id), { body: 'unrelated, mentions nobody' });

    const all = await read(ctx(appMember.id), { mentionsRef: s.workerId, limit: 50 });
    expect(all.items).toHaveLength(6);
    const cursor = all.items[4].seq; // the 5th mention

    const page = await read(ctx(appMember.id), {
      mentionsRef: s.workerId,
      beforeSeq: cursor,
      limit: 2,
    });
    // The two mentions immediately BEFORE the cursor — not the two oldest,
    // which is what an unmodified head-slice would have returned.
    expect(bodies(page)).toEqual([
      '@' + s.workerName + ' note 3',
      '@' + s.workerName + ' note 4',
    ]);
  });

  it('takes the newest matching mentions without a cursor', async () => {
    const s = await workerSession(appMember.id);
    for (let i = 1; i <= 5; i++) await post(ctx(appMember.id), { body: `@${s.workerName} note ${i}` });
    await post(ctx(admin.id), { body: 'unrelated' });
    const page = await read(ctx(appMember.id), { mentionsRef: s.workerId, limit: 2 });
    expect(bodies(page)).toEqual([`@${s.workerName} note 4`, `@${s.workerName} note 5`]);
    expect(page.total).toBe(5);
  });
});

// ── #1209 — a message carries its own address ─────────────────────────────
//
// No client can compose it: a message loc is `<root>:messages:<seq>-<rand>-…`,
// so the root and the seq reconstruct nothing. These pin that the server hands
// back the node's real canonical URN on BOTH producers (the post result and the
// read page, which are built separately), and null — never a guess — when the
// host memory's stored URN cannot be emitted.
describe('#1209 — TeamChatMessage.urn', () => {
  it('the post result and the read page carry the SAME urn, and it resolves to that very node', async () => {
    const posted = await post(ctx(appMember.id), { body: 'address me' });
    expect(posted.urn).toMatch(/^hrn:node:/);

    const page = await read(ctx(appMember.id));
    const readBack = page.items.find((m: { nodeId: string }) => m.nodeId === posted.nodeId);
    expect(readBack.urn).toBe(posted.urn);

    // Round trip through the platform's own resolver: the URN addresses THIS
    // message node, not merely something URN-shaped.
    const resolved = await Q.resolveUrn({}, { urn: posted.urn }, ctx(appMember.id));
    expect(resolved).toMatchObject({ kind: 'node', id: posted.nodeId });
  });

  it('is the stored node\'s canonical address, and differs per message', async () => {
    await post(ctx(appMember.id), { body: 'one' });
    await post(ctx(appMember.id), { body: 'two' });
    const { items } = await read(ctx(appMember.id));
    expect(items).toHaveLength(2);
    for (const m of items) {
      const node = await db.node.findUniqueOrThrow({ where: { id: m.nodeId }, include: { memory: { select: { urn: true } } } });
      expect(m.urn).toBe(`hrn:node:${node.memory.urn}:${node.loc}`);
    }
    expect(new Set(items.map((m: { urn: string }) => m.urn)).size).toBe(2);
  });

  it('is NULL — not a best-effort guess — when the host memory URN cannot be emitted, and the rest of the message is intact', async () => {
    const posted = await post(ctx(appMember.id), { body: 'still readable' });
    const node = await db.node.findUniqueOrThrow({ where: { id: posted.nodeId } });
    // A stored memory URN the v2 emitter rejects (an empty root).
    await db.memory.update({ where: { id: node.memoryId }, data: { urn: `::${generateId()}::legacy` } });

    const { items } = await read(ctx(appMember.id));
    const m = items.find((x: { nodeId: string }) => x.nodeId === posted.nodeId);
    expect(m.urn).toBeNull();
    expect(m).toMatchObject({ nodeId: posted.nodeId, body: 'still readable' });
  });
});

describe('#1209 review (@codex P2): a COMPOUND host memory URN yields null, not an unresolvable address', () => {
  it('the legacy team-space shape <org>:<app>:<agent>:shared emits a flat string that does not resolve back — so urn is null', async () => {
    const posted = await post(ctx(appMember.id), { body: 'legacy space' });
    const node = await db.node.findUniqueOrThrow({ where: { id: posted.nodeId } });
    // A stored pre-v2 COMPOUND memory urn: emission succeeds (no fallback) but
    // resolveNodeRef splits two atoms of memory, so the URN would name nothing.
    await db.memory.update({ where: { id: node.memoryId }, data: { urn: `${org.urn}:team:agent-${generateId().slice(0, 8)}:shared` } });

    const { items } = await read(ctx(appMember.id));
    const m = items.find((x: { nodeId: string }) => x.nodeId === posted.nodeId);
    expect(m.urn).toBeNull();
    expect(m.body).toBe('legacy space');
  });
});

describe('#1317 review (@codex P1): no fallible work after the message commits', () => {
  it('a failing host-URN lookup fails the post BEFORE anything is written, so a retry cannot duplicate', async () => {
    const first = await post(ctx(appMember.id), { body: 'bootstrap the chat' });
    // Scoped to the chat's own memory: a loc is unique per memory, not globally.
    const { memoryId } = await db.node.findUniqueOrThrow({ where: { id: first.nodeId }, select: { memoryId: true } });
    const messages = () => db.node.count({ where: { memoryId, loc: { contains: ':messages:' } } });
    const before = await messages();
    const real = db.memory.findUnique.bind(db.memory);
    const spy = vi.spyOn(db.memory, 'findUnique').mockImplementation(((args: any) =>
      args?.select?.urn === true && Object.keys(args.select).length === 1
        ? Promise.reject(new Error('transient: connection reset'))
        : real(args)) as any);
    try {
      await expect(post(ctx(appMember.id), { body: 'must not half-land' })).rejects.toThrow(/connection reset/);
    } finally {
      spy.mockRestore();
    }
    expect(await messages()).toBe(before);
  });
});

describe('#1874 — the reply fold on an ENCRYPTED team chat (cor:agt:020:04 has no encrypted exception)', () => {
  const envOf = async (nodeId: string) =>
    ((await db.node.findUnique({ where: { id: nodeId }, select: { data: true } }))!.data) as Record<string, unknown>;

  /** The legacy encrypted-channel shape from Chip's #1874 reproduction: mark
   * the chat memory encrypted, cache a session key, and re-write every
   * existing message's fields as genuine ciphertext. */
  async function encryptChannelMemory(): Promise<void> {
    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
    });
    const key = generateDataKey();
    sessionKeyCache.set('tc-1874', root!.memoryId, key);
    await db.memory.update({ where: { id: root!.memoryId }, data: { isEncrypted: true } });
    const messages = await db.node.findMany({
      where: { memoryId: root!.memoryId, nodeType: 'chat-message' },
    });
    for (const m of messages) {
      const enc = encryptNodeFieldsWithKey(
        { content: m.content ?? null, data: (m.data ?? null) as unknown },
        key,
      );
      await db.node.update({
        where: { id: m.id },
        data: { content: enc.content ?? null, data: enc.data as never },
      });
    }
  }

  it('a tagless reply on an encrypted channel folds the replied-to worker (the #1874 red on main)', async () => {
    const iris = await workerSession(appMember.id, 'Iris');
    const target = await post(ctx(appMember.id), { body: 'the blocking question', sessionRef: iris.sessionId });
    await encryptChannelMemory();
    const reply = await post(ctx(admin.id), { body: 'ruling: A', replyToSeq: target.seq });
    // The stored envelope of the REPLY is itself ciphertext now; read it back
    // through the same key the post used.
    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
    });
    const key = sessionKeyCache.getByMemoryId(root!.memoryId)!;
    const sealed = await db.node.findUnique({ where: { id: reply.nodeId }, select: { data: true } });
    const env = decryptNodeFieldsWithKey({ data: sealed!.data as unknown }, key).data as Record<string, unknown>;
    expect(env.mentions).toEqual(['iris']);
  });

  it('an explicit @mention body on an encrypted channel still stores the mention (control, unchanged)', async () => {
    const iris = await workerSession(appMember.id, 'Iris');
    const target = await post(ctx(appMember.id), { body: 'q', sessionRef: iris.sessionId });
    await encryptChannelMemory();
    const reply = await post(ctx(admin.id), { body: '@iris explicit', replyToSeq: target.seq });
    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
    });
    const key = sessionKeyCache.getByMemoryId(root!.memoryId)!;
    const sealed = await db.node.findUnique({ where: { id: reply.nodeId }, select: { data: true } });
    const env = decryptNodeFieldsWithKey({ data: sealed!.data as unknown }, key).data as Record<string, unknown>;
    expect(env.mentions).toEqual(['iris']);
  });

  it('a decrypt failure skips the fold and never refuses the reply (corrupt target envelope)', async () => {
    const iris = await workerSession(appMember.id, 'Iris');
    const target = await post(ctx(appMember.id), { body: 'q', sessionRef: iris.sessionId });
    await encryptChannelMemory();
    // Corrupt the TARGET's stored envelope into undecryptable garbage. The
    // reply must still post; only the fold is skipped.
    await db.node.update({ where: { id: target.nodeId }, data: { data: 'garbage-not-an-envelope' as never } });
    const reply = await post(ctx(admin.id), { body: 'still posts', replyToSeq: target.seq });
    expect(reply.nodeId).toBeTruthy();
    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
    });
    const key = sessionKeyCache.getByMemoryId(root!.memoryId)!;
    const sealed = await db.node.findUnique({ where: { id: reply.nodeId }, select: { data: true } });
    const env = decryptNodeFieldsWithKey({ data: sealed!.data as unknown }, key).data as Record<string, unknown>;
    expect(env.mentions).toBeUndefined();
  });

  it('the broadcast-name exception holds on the encrypted path — a worker named All is never fold-notified', async () => {
    const allWorker = await workerSession(appMember.id, 'All');
    const target = await post(ctx(appMember.id), { body: 'q', sessionRef: allWorker.sessionId });
    await encryptChannelMemory();
    const reply = await post(ctx(admin.id), { body: 'answer', replyToSeq: target.seq });
    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
    });
    const key = sessionKeyCache.getByMemoryId(root!.memoryId)!;
    const sealed = await db.node.findUnique({ where: { id: reply.nodeId }, select: { data: true } });
    const env = decryptNodeFieldsWithKey({ data: sealed!.data as unknown }, key).data as Record<string, unknown>;
    expect(env.mentions).toBeUndefined();
    expect(env.broadcastWakes).toBeUndefined();
  });

  it('no self-notification on the encrypted path — a worker replying to its own message folds nothing', async () => {
    const iris = await workerSession(appMember.id, 'Iris');
    const first = await post(ctx(appMember.id), { body: 'note', sessionRef: iris.sessionId });
    await encryptChannelMemory();
    const reply = await post(ctx(appMember.id), { body: 'update', replyToSeq: first.seq, sessionRef: iris.sessionId });
    const root = await db.node.findFirst({
      // loc-scope-ok: scoped to the fixture App via the memory relation
      where: { loc: TEAM_CHAT_LOC, memory: { appId: app.id, class: 'app' } },
    });
    const key = sessionKeyCache.getByMemoryId(root!.memoryId)!;
    const sealed = await db.node.findUnique({ where: { id: reply.nodeId }, select: { data: true } });
    const env = decryptNodeFieldsWithKey({ data: sealed!.data as unknown }, key).data as Record<string, unknown>;
    expect(env.mentions).toBeUndefined();
  });
});
