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
import { serveAgentBootPrompt, serveEveryAgent } from '../../../test/servedBootPrompt.js';
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

  /**
   * `Node.seq` is nullable and Postgres sorts NULLs FIRST on DESC — not last,
   * as it does on ASC. So the descending window meets null-seq rows the old
   * ascending head-take never did: left at the default they would fill the
   * whole window and push the numbered messages out, reproducing this bug for
   * legacy transcripts. A row with no counter predates the counter, so it
   * sorts as the OLDEST. (Codex P2 on PR #1112.)
   *
   * Seeds MORE null-seq rows than the window so the failure is reachable — a
   * handful of them would be carried by the window regardless and prove
   * nothing.
   */
  it('treats null-seq legacy rows as oldest, so they cannot crowd out the newest', async () => {
    await cleanDb(db);
    const admin = await db.user.create({
      data: { id: generateId(), githubId: 990103, githubUsername: 'nullseq-admin' },
    });
    adminId = admin.id;
    const { graph } = await createDbOrgAndGraph(db, { orgName: 'nullseq-org' });
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

    // 12 rows with NO seq at all, then 5 numbered ones.
    for (let n = 1; n <= 12; n++) {
      await db.node.create({
        data: {
          id: generateId(),
          memoryId: graph.id,
          loc: `${CHAT_ID}:messages:legacy-${String(n).padStart(3, '0')}`,
          name: `legacy-${String(n).padStart(3, '0')}`,
          nodeType: 'message',
          content: `legacy-${n}`,
          seq: null,
          createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + n * 1000),
        },
      });
    }
    for (let n = 1; n <= 5; n++) {
      await db.node.create({
        data: {
          id: generateId(),
          memoryId: graph.id,
          loc: `${CHAT_ID}:messages:${String(n).padStart(3, '0')}-user`,
          name: `${String(n).padStart(3, '0')}-user`,
          nodeType: 'message',
          content: `message-${n}`,
          seq: n,
          createdAt: new Date(Date.parse('2026-02-01T00:00:00.000Z') + n * 1000),
        },
      });
    }

    // A window smaller than the null-seq population: with NULLs sorted first
    // on DESC they would take the entire window and no numbered message would
    // survive.
    const rows = await read(5);
    expect(rows.map((r) => r.content)).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
      'message-5',
    ]);

    // And with room for everything, the legacy rows come back as the OLDEST,
    // chronological among themselves.
    const all = await read(50);
    expect(all.map((r) => r.content)).toEqual([
      ...Array.from({ length: 12 }, (_, i) => `legacy-${i + 1}`),
      ...Array.from({ length: 5 }, (_, i) => `message-${i + 1}`),
    ]);
  });

  it('applies the same tail window to the default limit of 20', async () => {
    await seedTranscript(130);
    const rows = await read(undefined);
    expect(rows).toHaveLength(20);
    expect(rows[0].seq).toBe(111);
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
    // #2712: chats are served the Agent's boot prompt; an Agent without one is refused.
    await serveEveryAgent(db);
  });

  /**
   * #2003: `driveTurns(60)` is 60 sequential chat turns, each with several DB
   * calls. Measured alone it took 2-5 s and followed host load (5.2 s seen at
   * load ~76 on 32 cores), so vitest's 5 s default is too tight on the shared
   * agent host. 20 s is about 4x the worst observed time, a candidate margin
   * and not a measured necessity (waits were not instrumented). It bounds
   * slow runs only: a hang still fails, just later.
   */
  const DRIVE_60_TIMEOUT_MS = 20_000;

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

  it('binds the Agent identity in both chat prompt paths and preserves the stage prompt', async () => {
    await db.agent.update({ where: { id: agent.id }, data: { personaRole: 'researcher' } });
    await serveAgentBootPrompt(db, agent.id, 'You are {{worker.name}}, a {{worker.role}}.');

    const start = await resolvers.Mutation.startChat({}, { agentId: agent.id }, adminCtx());
    expect(start.systemMessage).toBe('You are research-agent, a researcher.\n\nScope the research.');

    const turn = await resolvers.Mutation.sendChatMessage(
      {}, { chatId: start.chatId, userMessage: 'first turn' }, adminCtx(),
    );
    expect(turn.systemMessage).toBe(start.systemMessage);

    // A newly served prompt without tokens reaches the next turn byte-for-byte.
    await serveAgentBootPrompt(db, agent.id, 'Existing prompt.');
    const next = await resolvers.Mutation.sendChatMessage(
      {}, { chatId: start.chatId, userMessage: 'second turn' }, adminCtx(),
    );
    expect(next.systemMessage).toBe('Existing prompt.\n\nScope the research.');
  });

  it('includes the turn being answered on a chat longer than the window', async () => {
    const contents = await driveTurns(60);
    // The whole defect in one assertion: past the cap the model was handed
    // turn-1..turn-50 and never the question in front of it.
    expect(contents).toContain('turn-60');
    expect(contents).not.toContain('turn-1');
  }, DRIVE_60_TIMEOUT_MS);

  it('hands over exactly the newest window, oldest-first', async () => {
    const contents = await driveTurns(60);
    const userTurns = contents.filter((c) => c.startsWith('turn-'));
    expect(userTurns[userTurns.length - 1]).toBe('turn-60');
    // Ascending: each turn number strictly greater than the one before it.
    const numbers = userTurns.map((c) => Number(c.slice('turn-'.length)));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  }, DRIVE_60_TIMEOUT_MS);

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

  /**
   * The model-side twin of the null-seq test on `chatHistory`. Sharper here:
   * enough null-seq legacy rows would fill the model's entire window and
   * exclude the turn being answered — this bug returning by another door.
   * Seeds MODEL_HISTORY_LIMIT + 10 of them so the window cannot carry both.
   */
  it('null-seq legacy rows cannot crowd the current turn out of the model window', async () => {
    const start = await resolvers.Mutation.startChat({}, { agentId: agent.id }, adminCtx());
    const chatNode = await chatNodeByLocOrThrow(db, start.chatId);

    for (let n = 1; n <= 60; n++) {
      await db.node.create({
        data: {
          id: generateId(),
          memoryId: chatNode.memoryId,
          loc: `${start.chatId}:messages:legacy-${String(n).padStart(3, '0')}`,
          name: `legacy-${String(n).padStart(3, '0')}`,
          nodeType: 'message',
          content: `legacy-${n}`,
          seq: null,
          createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + n * 1000),
        },
      });
    }

    const res = (await resolvers.Mutation.sendChatMessage(
      {},
      { chatId: start.chatId, userMessage: 'the question being asked' },
      adminCtx(),
    )) as { messageHistory: Array<{ content: string }> };

    expect(res.messageHistory.map((h) => h.content)).toContain('the question being asked');
  });
});

// ---------------------------------------------------------------------------
// #1116 — beforeSeq, the backward cursor
// ---------------------------------------------------------------------------

describe('chatHistory beforeSeq pages backward (#1116)', () => {
  const CHAT_ID = 'chats:202609010001-cur50r42-cursor';
  let adminId: string;

  async function seed(rows: Array<{ n: number; seq: number | null }>) {
    await cleanDb(db);
    const admin = await db.user.create({
      data: { id: generateId(), githubId: 990201, githubUsername: 'cursor-admin' },
    });
    adminId = admin.id;
    const { graph } = await createDbOrgAndGraph(db, { orgName: 'cursor-org' });
    await db.node.create({
      data: {
        id: generateId(), memoryId: graph.id, loc: CHAT_ID,
        name: 'cursor chat', nodeType: 'chat', data: { messageCount: rows.length },
      },
    });
    for (const r of rows) {
      await db.node.create({
        data: {
          id: generateId(), memoryId: graph.id,
          loc: `${CHAT_ID}:messages:${String(r.n).padStart(3, '0')}-user`,
          name: `${String(r.n).padStart(3, '0')}-user`,
          nodeType: 'message', content: `message-${r.n}`, seq: r.seq,
          createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + r.n * 1000),
        },
      });
    }
  }

  async function read(vars: Record<string, unknown>) {
    const res = await gql(
      `query($chatId: String!, $limit: Int, $beforeSeq: Int) {
         chatHistory(chatId: $chatId, limit: $limit, beforeSeq: $beforeSeq) { content seq }
       }`,
      { userId: adminId, roles: ['ADMIN'] },
      { chatId: CHAT_ID, ...vars },
    );
    expect(res.errors).toBeUndefined();
    return (res.data as { chatHistory: Array<{ seq: number; content: string }> }).chatHistory;
  }

  const numbered = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ n: i + 1, seq: i + 1 }));

  it('returns the page immediately preceding the cursor, still oldest-first', async () => {
    await seed(numbered(60));
    const page = await read({ limit: 10, beforeSeq: 31 });
    // The ten before 31 — not the ten oldest, and not the ten newest.
    expect(page.map((r) => r.seq)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  });

  it('is strictly less than — the cursor message is never returned twice', async () => {
    await seed(numbered(60));
    const page = await read({ limit: 10, beforeSeq: 31 });
    expect(page.map((r) => r.seq)).not.toContain(31);
  });

  it('walks the whole transcript without a gap or a repeat', async () => {
    await seed(numbered(25));
    const seen: number[] = [];
    let cursor: number | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page: Array<{ seq: number }> = await read(
        cursor === undefined ? { limit: 10 } : { limit: 10, beforeSeq: cursor },
      );
      if (page.length === 0) break;
      seen.unshift(...page.map((r) => r.seq));
      cursor = page[0].seq;
    }
    // Every message exactly once, in order — the property a scroll-up client
    // depends on, and the one a positional offset loses under concurrent writes.
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('CONTROL: without a cursor the window is unchanged (the tail)', async () => {
    await seed(numbered(60));
    const page = await read({ limit: 10 });
    expect(page.map((r) => r.seq)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
  });

  it('returns an empty page once the caller has paged past the beginning', async () => {
    await seed(numbered(25));
    expect(await read({ limit: 10, beforeSeq: 1 })).toEqual([]);
  });

  it('every cursor reaches counterless messages, which are older than all of them', async () => {
    // Two legacy rows with no seq, then three numbered ones.
    await seed([
      { n: 1, seq: null }, { n: 2, seq: null },
      { n: 3, seq: 1 }, { n: 4, seq: 2 }, { n: 5, seq: 3 },
    ]);
    // Paging back from the oldest NUMBERED message must not strand the
    // counterless ones — they are the oldest part of the transcript, and
    // excluding them would make it the one part paging can never reach.
    const page = await read({ limit: 10, beforeSeq: 1 });
    expect(page.map((r) => r.content)).toEqual(['message-1', 'message-2']);
  });
});
