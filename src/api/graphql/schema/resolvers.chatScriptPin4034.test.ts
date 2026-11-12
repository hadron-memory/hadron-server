/**
 * #4034 (Know Yourself engine S1; cor:cht:020:01, cor:cht:030:02, plan decisions D2/D3, rulings Q9/Q10):
 * a chat reads its script (rules, extraction spec, agent-wide condition layer) from the revision it
 * was pinned to, not from the live draft; a v2 snapshot carries edge `condition` and `priority` and
 * node `seq`, and `restoreRevision` brings all three back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import { loadChatScript } from '../../../lib/chatScript.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let adminUser: { id: string };
let agent: { id: string };
let systemMemory: { id: string };

const adminCtx = (): Context => ({ db, roles: ['ADMIN'], userId: adminUser.id });
const userCtx = (): Context => ({ db, roles: ['READER'], userId: adminUser.id });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'pin-org', urn: 'pin-org' } });
  adminUser = await db.user.create({ data: { githubId: 8434, githubUsername: 'script-pin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: adminUser.id, role: 'ADMIN' } });
  const created = await resolvers.Mutation.createAgent({}, { orgId: org.id, name: 'scribe', visibility: 'PERSONAL' }, adminCtx());
  agent = created;
  systemMemory = await db.memory.findUniqueOrThrow({ where: { id: created.systemMemoryId! } });
  await serveEveryAgent(db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Seed = { loc: string; name: string; data?: unknown; seq?: number };

async function seed(nodes: Seed[]): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const n of nodes) {
    const row = await db.node.create({
      data: {
        id: generateId(), memoryId: systemMemory.id, loc: n.loc, name: n.name, nodeType: 'system',
        data: (n.data ?? null) as never, seq: n.seq ?? null,
      },
    });
    ids[n.loc] = row.id;
  }
  return ids;
}

async function seedEdge(
  ids: Record<string, string>,
  from: string,
  to: string,
  opts: { condition?: unknown; priority?: number; data?: Record<string, unknown> } = {},
) {
  return db.edge.create({
    data: {
      id: generateId(), memoryId: systemMemory.id, loc: deriveEdgeLoc(from, 'rule', to),
      sourceId: ids[from], targetId: ids[to], name: 'rule',
      condition: (opts.condition ?? null) as never, priority: opts.priority ?? 0,
      data: { timing: 'on_complete', behavior: 'transition', ...(opts.data ?? {}) } as never,
    },
  });
}

async function publish(): Promise<string> {
  const rev = await resolvers.Mutation.createRevision({}, { agentId: agent.id }, adminCtx());
  await resolvers.Mutation.publishRevision({}, { agentId: agent.id, revisionLoc: rev.revisionLoc }, adminCtx());
  return rev.revisionLoc;
}

/** main:check --rule--> alpha / beta (two target conversations). */
async function seedScript(extra: Seed[] = []) {
  return seed([
    { loc: 'conversations', name: 'conversations' },
    { loc: 'conversations:main', name: 'main', data: { stageOrder: ['check'], isSetup: false } },
    { loc: 'conversations:main:check', name: 'check', data: {} },
    { loc: 'conversations:alpha', name: 'alpha', data: { stageOrder: ['a1'], isSetup: false } },
    { loc: 'conversations:alpha:a1', name: 'a1', data: {} },
    { loc: 'conversations:beta', name: 'beta', data: { stageOrder: ['b1'], isSetup: false } },
    { loc: 'conversations:beta:b1', name: 'b1', data: {} },
    ...extra,
  ]);
}

const startMain = () =>
  resolvers.Mutation.startChat({}, { agentId: agent.id, conversationName: 'main' }, userCtx());
const finishStage = (chatId: string) =>
  resolvers.Mutation.processChatResponse(
    {}, { chatId, toolResponse: { message: 'done', next_stage: null, onTrack: true } }, userCtx(),
  );

describe('#4034 a pinned chat reads its script from the pinned revision', () => {
  it('pin 1: routes and builds its tool from R after the draft changes a rule target, its condition and an extraction field', async () => {
    const ids = await seedScript([]);
    // The conversation-level spec is the one the builder reads live today (the stage's own comes from the snapshot).
    await db.node.update({
      where: { id: ids['conversations:main'] },
      data: { data: { stageOrder: ['check'], isSetup: false, extractionSpec: [{ field: 'memory.color', description: 'colour', shape: 'string' }] } },
    });
    const rule = await seedEdge(ids, 'conversations:main:check', 'conversations:alpha');
    await publish();

    // The draft now routes elsewhere, never, and asks for another field.
    await db.edge.update({
      where: { id: rule.id },
      data: { targetId: ids['conversations:beta'], condition: { '==': [1, 2] } },
    });
    await db.node.update({
      where: { id: ids['conversations:main'] },
      data: { data: { stageOrder: ['check'], isSetup: false, extractionSpec: [{ field: 'memory.size', description: 'size', shape: 'string' }] } },
    });

    const chat = await startMain();
    const props = (chat.tools![0].parameters as any).properties.data.properties;
    expect(Object.keys(props)).toEqual(['color']);

    const turn = await finishStage(chat.chatId);
    expect(turn.conversationHandoff).toBe('alpha');
  });

  it('pin 2: a conditional rule in a v2 snapshot does not fire when its condition is false, even after the draft drops the condition', async () => {
    const ids = await seedScript();
    const rule = await seedEdge(ids, 'conversations:main:check', 'conversations:alpha', { condition: { '==': [1, 2] } });
    await publish();
    await db.edge.update({ where: { id: rule.id }, data: { condition: Prisma.JsonNull } });

    const chat = await startMain();
    const turn = await finishStage(chat.chatId);
    expect(turn.conversationHandoff ?? null).toBeNull();
  });

  it('pin 3: a chat pinned to a pre-v2 snapshot reads the live rules and logs that it did, once per turn', async () => {
    const ids = await seedScript();
    await seedEdge(ids, 'conversations:main:check', 'conversations:alpha');
    const revLoc = await publish();
    // The draft now routes elsewhere: only a live rule read can reach it (the snapshot still says alpha).
    await db.edge.updateMany({ where: { memoryId: systemMemory.id, sourceId: ids['conversations:main:check'] }, data: { targetId: ids['conversations:beta'] } });
    // Make the snapshot a pre-v2 one: no format marker, no condition/priority/seq on anything.
    const revNode = await db.node.findFirstOrThrow({ where: { memoryId: systemMemory.id, loc: revLoc } });
    const data = revNode.data as any;
    delete data.snapshot.edgeFormat;
    data.snapshot.edges = data.snapshot.edges.map(({ condition: _c, priority: _p, ...rest }: any) => rest);
    data.snapshot.nodes = data.snapshot.nodes.map(({ seq: _s, ...rest }: any) => rest);
    await db.node.update({ where: { id: revNode.id }, data: { data } });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chat = await startMain();
    warn.mockClear();
    const turn = await finishStage(chat.chatId);

    expect(turn.conversationHandoff).toBe('beta');
    const logged = warn.mock.calls.filter((c) => String(c[0]).includes('chat_script_pre_v2_live_rules'));
    expect(logged).toHaveLength(1);
  });

  it('pin 8: equal-priority rules are snapshotted in createdAt order, so routing matches the live read', async () => {
    const ids = await seedScript();
    const first = await seedEdge(ids, 'conversations:main:check', 'conversations:alpha');
    const second = await seedEdge(ids, 'conversations:main:check', 'conversations:beta');
    // `second` was created first by the clock, though inserted last: the live read puts it ahead of `first`.
    await db.edge.update({ where: { id: second.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    await publish();
    const chat = await startMain();
    const turn = await finishStage(chat.chatId);
    expect(turn.conversationHandoff).toBe('beta');
  });

  it('pin 4: restoring a v2 revision brings back each rule condition and priority and each node seq', async () => {
    const ids = await seed([
      { loc: 'conversations', name: 'conversations' },
      { loc: 'conversations:main', name: 'main', data: { stageOrder: ['check'] }, seq: 7 },
      { loc: 'conversations:main:check', name: 'check', data: {} },
      { loc: 'conversations:alpha', name: 'alpha', data: { stageOrder: ['a1'] }, seq: 3 },
      { loc: 'conversations:alpha:a1', name: 'a1', data: {} },
    ]);
    const rule = await seedEdge(ids, 'conversations:main:check', 'conversations:alpha', {
      condition: { '==': [1, 1] }, priority: 4,
    });
    const revLoc = (await resolvers.Mutation.createRevision({}, { agentId: agent.id }, adminCtx())).revisionLoc;
    // The served boot prompt fixture is a compiled node a restore cannot rewrite (chk_nodes_compiled_boot_prompt_role);
    // it is not part of what this pin is about, so the revision under test leaves it out.
    const revNode = await db.node.findFirstOrThrow({ where: { memoryId: systemMemory.id, loc: revLoc } });
    const revData = revNode.data as any;
    revData.snapshot.nodes = revData.snapshot.nodes.filter((n: any) => !n.loc.startsWith('boot:'));
    await db.node.update({ where: { id: revNode.id }, data: { data: revData } });

    await db.edge.update({ where: { id: rule.id }, data: { condition: Prisma.JsonNull, priority: 0 } });
    await db.node.update({ where: { id: ids['conversations:main'] }, data: { seq: 99 } });
    await db.node.update({ where: { id: ids['conversations:alpha'] }, data: { seq: null } });

    await resolvers.Mutation.restoreRevision({}, { agentId: agent.id, revisionLoc: revLoc }, adminCtx());

    const edge = await db.edge.findFirstOrThrow({ where: { memoryId: systemMemory.id, sourceId: ids['conversations:main:check'], deletedAt: null } });
    expect(edge.condition).toEqual({ '==': [1, 1] });
    expect(edge.priority).toBe(4);
    const main = await db.node.findFirstOrThrow({ where: { memoryId: systemMemory.id, loc: 'conversations:main' } });
    const alpha = await db.node.findFirstOrThrow({ where: { memoryId: systemMemory.id, loc: 'conversations:alpha' } });
    expect(main.seq).toBe(7);
    expect(alpha.seq).toBe(3);
  });

  it('pin 5 (regression, green on main): a chat with no published revision reads the draft', async () => {
    const ids = await seedScript();
    const rule = await seedEdge(ids, 'conversations:main:check', 'conversations:alpha');
    const chat = await startMain();
    await db.edge.update({ where: { id: rule.id }, data: { targetId: ids['conversations:beta'] } });
    const turn = await finishStage(chat.chatId);
    expect(turn.conversationHandoff).toBe('beta');
  });

  it('pin 6a: a publish that changes an agent-wide default does not change a live pinned chat\'s routing', async () => {
    const ids = await seedScript([{ loc: 'data', name: 'defaults', data: { threshold: 1 } }]);
    await seedEdge(ids, 'conversations:main:check', 'conversations:alpha', { condition: { '<': [{ var: 'memory.threshold' }, 5] } });
    await publish();
    const chat = await startMain();
    // The author edits the draft default afterwards (a later publish would do the same to the live row).
    await db.node.update({ where: { id: ids['data'] }, data: { data: { threshold: 10 } } });
    const turn = await finishStage(chat.chatId);
    expect(turn.conversationHandoff).toBe('alpha');
  });

  it('pin 6b: a change to agent.config does not change a live pinned chat\'s routing', async () => {
    const ids = await seedScript([{ loc: 'config', name: 'config', data: { mode: 'a' } }]);
    await seedEdge(ids, 'conversations:main:check', 'conversations:alpha', { condition: { '==': [{ var: 'agent.config.mode' }, 'a'] } });
    await publish();
    const chat = await startMain();
    await db.node.update({ where: { id: ids['config'] }, data: { data: { mode: 'b' } } });
    const turn = await finishStage(chat.chatId);
    expect(turn.conversationHandoff).toBe('alpha');
  });

  it('pin 4b: the reader returns R\'s conversation seq after the draft reorders conversations', async () => {
    const ids = await seedScript();
    await db.node.update({ where: { id: ids['conversations:main'] }, data: { seq: 1 } });
    await db.node.update({ where: { id: ids['conversations:alpha'] }, data: { seq: 2 } });
    const revLoc = await publish();
    await db.node.update({ where: { id: ids['conversations:main'] }, data: { seq: 9 } });
    await db.node.update({ where: { id: ids['conversations:alpha'] }, data: { seq: 0 } });

    const script = await loadChatScript(db, systemMemory.id, revLoc);
    const seqs = Object.fromEntries((await script.nodesByPrefix('conversations:')).map((n) => [n.loc, n.seq]));
    expect(script.source).toBe('snapshot');
    expect(seqs['conversations:main']).toBe(1);
    expect(seqs['conversations:alpha']).toBe(2);
  });

  it('pin 4c: a pre-v2 snapshot reads the conversation seq live (ruling Q9)', async () => {
    const ids = await seedScript();
    const revLoc = await publish();
    const revNode = await db.node.findFirstOrThrow({ where: { memoryId: systemMemory.id, loc: revLoc } });
    const data = revNode.data as any;
    delete data.snapshot.edgeFormat;
    await db.node.update({ where: { id: revNode.id }, data: { data } });
    await db.node.update({ where: { id: ids['conversations:alpha'] }, data: { seq: 5 } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const script = await loadChatScript(db, systemMemory.id, revLoc);
    expect(script.source).toBe('snapshot-pre-v2');
    const seqs = Object.fromEntries((await script.nodesByPrefix('conversations:')).map((n) => [n.loc, n.seq]));
    expect(seqs['conversations:alpha']).toBe(5);
  });
});
