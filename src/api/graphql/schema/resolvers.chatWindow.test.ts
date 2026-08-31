/**
 * #1111 — the transcript window is the NEWEST slice, at both readers.
 *
 * Both places that cap a chat's `:messages:` subtree used an ascending sort
 * with a plain `take`, which is a HEAD-take: a chat longer than the cap
 * returned its opening forever. The severe half was `sendChatMessage`, where
 * the model stopped receiving the message it was being asked to answer.
 *
 * Each test here is paired with a CONTROL under the cap. The control is what
 * makes the capped assertion meaningful rather than tautological: it shows the
 * current turn is normally present, so a capped chat missing it is a window
 * defect and not a design in which the client supplies the latest message
 * separately.
 *
 * Both suites drive the shipping path — the resolver through Apollo, and
 * `sendChatMessage` directly — rather than a hand-copied query, so a future
 * change to the query cannot pass these by agreeing with a copy of itself.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

// ---------------------------------------------------------------------------
// chatHistory — the display reader
// ---------------------------------------------------------------------------

const server = new ApolloServer<Context>({ typeDefs, resolvers });

async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>) {
  const res = await server.executeOperation(
    { query, variables },
    { contextValue: { db, ...ctx } as Context },
  );
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}

const HISTORY = `query($chatId: String!, $limit: Int) {
  chatHistory(chatId: $chatId, limit: $limit) { role content seq }
}`;

describe('chatHistory returns the most recent window (#1111)', () => {
  const CHAT_ID = 'chats:202608310001-w1nd0w42-window';
  let adminId: string;

  /** Seed a transcript of `total` messages, seq 1..total. */
  async function seedTranscript(total: number) {
    await cleanDb(db);
    const admin = await db.user.create({
      data: { id: generateId(), githubId: 990101, githubUsername: 'window-admin' },
    });
    adminId = admin.id;
    const { graph } = await createDbOrgAndGraph(db, { orgName: 'window-org' });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: graph.id,
        loc: CHAT_ID,
        name: 'window chat',
        nodeType: 'chat',
        data: { messageCount: total },
      },
    });
    for (let n = 1; n <= total; n++) {
      await db.node.create({
        data: {
          id: generateId(),
          memoryId: graph.id,
          loc: `${CHAT_ID}:messages:${String(n).padStart(3, '0')}-user`,
          name: `${String(n).padStart(3, '0')}-user`,
          nodeType: 'message',
          content: `message-${n}`,
          seq: n,
        },
      });
    }
  }

  async function read(limit?: number) {
    const res = await gql(
      HISTORY,
      { userId: adminId, roles: ['ADMIN'] },
      limit === undefined ? { chatId: CHAT_ID } : { chatId: CHAT_ID, limit },
    );
    expect(res.errors).toBeUndefined();
    return (res.data as { chatHistory: Array<{ seq: number; content: string }> }).chatHistory;
  }

  it('takes the tail, not the head, when the transcript exceeds the limit', async () => {
    await seedTranscript(60);
    const rows = await read(50);
    expect(rows).toHaveLength(50);
    // The exact window, not just "contains the newest": an off-by-one or a
    // partial reversal would still satisfy a containment assertion.
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 11 + i));
  });

  it('returns that window oldest-first — only the slice moved, not the order', async () => {
    await seedTranscript(60);
    const rows = await read(50);
    expect(rows[0].content).toBe('message-11');
    expect(rows[rows.length - 1].content).toBe('message-60');
  });

  it('CONTROL: under the limit the whole transcript comes back, still ascending', async () => {
    await seedTranscript(12);
    const rows = await read(50);
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  /**
   * The tiebreak has to be inverted as a WHOLE, and nothing above reaches that:
   * every message there has a distinct `seq`, which is the one arity where
   * inverting `seq` alone and inverting all three keys agree. Legacy chats
   * (pre-#919, before the counter was atomic) hold colliding seq values, and
   * for those a half-inverted sort reverses the tied group — so the transcript
   * comes back with two of a member's messages out of chronological order.
   *
   * Seeds both tied cases: a seq collision broken by `createdAt`, and a
   * seq+createdAt collision broken by `loc`.
   */
  it('inverts the whole tiebreak, so colliding-seq legacy rows stay chronological', async () => {
    await cleanDb(db);
    const admin = await db.user.create({
      data: { id: generateId(), githubId: 990102, githubUsername: 'tiebreak-admin' },
    });
    adminId = admin.id;
    const { graph } = await createDbOrgAndGraph(db, { orgName: 'tiebreak-org' });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: graph.id,
        loc: CHAT_ID,
        name: 'legacy chat',
        nodeType: 'chat',
        data: { messageCount: 5 },
      },
    });

    const t = (ms: number) => new Date(Date.parse('2026-01-01T00:00:00.000Z') + ms);
    // chronological order is 1,2,3,4,5 — but seq alone cannot produce it.
    const rowsIn = [
      { n: 1, seq: 1, at: t(0) },
      { n: 2, seq: 5, at: t(10_000) },
      { n: 3, seq: 5, at: t(20_000) }, // ties 2 on seq
      { n: 4, seq: 5, at: t(20_000) }, // ties 3 on seq AND createdAt; loc breaks it
      { n: 5, seq: 9, at: t(30_000) },
    ];
    for (const r of rowsIn) {
      await db.node.create({
        data: {
          id: generateId(),
          memoryId: graph.id,
          loc: `${CHAT_ID}:messages:${String(r.n).padStart(3, '0')}-user`,
          name: `${String(r.n).padStart(3, '0')}-user`,
          nodeType: 'message',
          content: `message-${r.n}`,
          seq: r.seq,
          createdAt: r.at,
        },
      });
    }

    const rows = await read(50);
    expect(rows.map((r) => r.content)).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
      'message-5',
    ]);
  });

  it('applies the same tail window to the default limit of 100', async () => {
    await seedTranscript(130);
    const rows = await read(undefined);
    expect(rows).toHaveLength(100);
    expect(rows[0].seq).toBe(31);
    expect(rows[rows.length - 1].seq).toBe(130);
  });
});

// ---------------------------------------------------------------------------
// sendChatMessage — the model's view
// ---------------------------------------------------------------------------

describe("sendChatMessage hands the model the most recent window (#1111)", () => {
  let orgA: { id: string; urn: string };
  let adminUser: { id: string };
  let agent: { id: string; systemMemoryId?: string | null };

  const adminCtx = (): Context => ({ db, roles: ['ADMIN'], userId: adminUser.id }) as Context;

  beforeEach(async () => {
    await cleanDb(db);
    orgA = await db.organization.create({
      data: { id: generateId(), name: 'org-a', urn: 'org-a' },
    });
    adminUser = await db.user.create({
      data: { githubId: 9001, githubUsername: 'admin-user', roles: ['ADMIN'] },
    });
    await db.orgMember.create({
      data: { organizationId: orgA.id, userId: adminUser.id, role: 'ADMIN' },
    });
    const created = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'research-agent', visibility: 'ORGANIZATION' },
      adminCtx(),
    );
    agent = created;
    await db.app.create({
      data: {
        id: generateId(),
        name: 'research-app',
        urn: `${orgA.urn}:research-app`,
        organizationId: orgA.id,
        appAgents: { create: { agentId: agent.id } },
      },
    });
    const systemMemory = await db.memory.findUniqueOrThrow({
      where: { id: created.systemMemoryId! },
    });
    const nodes = [
      { loc: 'conversations', name: 'conversations', nodeType: 'system' },
      {
        loc: 'conversations:research',
        name: 'research',
        nodeType: 'system',
        data: { stageOrder: ['scope'], isSetup: false },
      },
      {
        loc: 'conversations:research:scope',
        name: 'scope',
        nodeType: 'system',
        data: { promptRef: 'prompts:research:scope' },
      },
      { loc: 'prompts', name: 'prompts', nodeType: 'system' },
      { loc: 'prompts:research', name: 'research', nodeType: 'system' },
      {
        loc: 'prompts:research:scope',
        name: 'scope',
        nodeType: 'system',
        content: 'Scope the research.',
      },
    ];
    for (const n of nodes) {
      await db.node.create({
        data: {
          id: generateId(),
          memoryId: systemMemory.id,
          loc: n.loc,
          name: n.name,
          nodeType: n.nodeType,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: ((n as any).data ?? null) as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          content: ((n as any).content ?? null) as any,
        },
      });
    }
  });

  /** Drive `turns` real turns; return the contents the last call handed the model. */
  async function driveTurns(turns: number): Promise<string[]> {
    const start = await resolvers.Mutation.startChat({}, { agentId: agent.id }, adminCtx());
    let last: { messageHistory: Array<{ role: string; content: string }> } | undefined;
    for (let n = 1; n <= turns; n++) {
      last = (await resolvers.Mutation.sendChatMessage(
        {},
        { chatId: start.chatId, userMessage: `turn-${n}` },
        adminCtx(),
      )) as typeof last;
    }
    return last!.messageHistory.map((h) => h.content);
  }

  it('includes the turn being answered on a chat longer than the window', async () => {
    const contents = await driveTurns(60);
    // The whole defect in one assertion: past the cap the model was handed
    // turn-1..turn-50 and never the question in front of it.
    expect(contents).toContain('turn-60');
    expect(contents).not.toContain('turn-1');
  });

  it('hands over exactly the newest window, oldest-first', async () => {
    const contents = await driveTurns(60);
    const userTurns = contents.filter((c) => c.startsWith('turn-'));
    expect(userTurns[userTurns.length - 1]).toBe('turn-60');
    // Ascending: each turn number strictly greater than the one before it.
    const numbers = userTurns.map((c) => Number(c.slice('turn-'.length)));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it('CONTROL: under the window the current turn is present too', async () => {
    const contents = await driveTurns(12);
    expect(contents).toContain('turn-12');
    expect(contents).toContain('turn-1');
  });

  /**
   * The model-side twin of the tiebreak test above. Guarded separately rather
   * than by appeal to the query-side one: these are two implementations of one
   * rule, and a guard on one is not a guard on the other.
   *
   * The atomic allocator cannot produce a seq collision, so the legacy rows are
   * written directly into the chat after `startChat` — which is exactly the
   * pre-#919 shape this tiebreak exists for.
   */
  it('inverts the whole tiebreak for the model too (legacy colliding seq)', async () => {
    const start = await resolvers.Mutation.startChat({}, { agentId: agent.id }, adminCtx());
    const chatNode = await chatNodeByLocOrThrow(db, start.chatId);

    const t = (ms: number) => new Date(Date.parse('2026-01-01T00:00:00.000Z') + ms);
    const legacy = [
      { n: 1, seq: 1, at: t(0) },
      { n: 2, seq: 5, at: t(10_000) },
      { n: 3, seq: 5, at: t(20_000) },
      { n: 4, seq: 5, at: t(20_000) },
    ];
    for (const r of legacy) {
      await db.node.create({
        data: {
          id: generateId(),
          memoryId: chatNode.memoryId,
          loc: `${start.chatId}:messages:${String(r.n).padStart(3, '0')}-legacy`,
          name: `${String(r.n).padStart(3, '0')}-legacy`,
          nodeType: 'message',
          content: `legacy-${r.n}`,
          seq: r.seq,
          createdAt: r.at,
        },
      });
    }

    const res = (await resolvers.Mutation.sendChatMessage(
      {},
      { chatId: start.chatId, userMessage: 'now' },
      adminCtx(),
    )) as { messageHistory: Array<{ content: string }> };

    const legacyOrder = res.messageHistory
      .map((h) => h.content)
      .filter((c) => c.startsWith('legacy-'));
    expect(legacyOrder).toEqual(['legacy-1', 'legacy-2', 'legacy-3', 'legacy-4']);
  });
});
