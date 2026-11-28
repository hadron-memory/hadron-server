/**
 * #4244 (cor:agt:040:12, Proposed sentence; cor:agt:040:10) — an Agent revision restore leaves the Agent's compiled
 * boot prompts as they are: it does not write one, it does not tombstone one, and it ignores a snapshot's copy of
 * one, because compiling is the only way a compiled node is written. Before #4244 the restore's upsert proposed a
 * compiled row with no role and Postgres refused it (the CHECK of the time, 23514), so every Agent with a compiled
 * boot prompt failed to restore. #5453: a compiled prompt is `system` / `boot-prompt.compiled`; the fixture follows.
 *
 * Also: a snapshot records each node's `role`, and an unknown `revisionLoc` is refused BAD_USER_INPUT before any write.
 *
 * Fixture as in resolvers.revisions.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let orgA: { id: string };
let adminUser: { id: string };
let otherAdmin: { id: string };
let agent: { id: string };
let systemMemory: { id: string };

function adminCtx(userId?: string): Context {
  return { db, roles: ['ADMIN'], userId: userId ?? adminUser.id };
}

beforeEach(async () => {
  await cleanDb(db);

  orgA = await db.organization.create({
    data: { id: generateId(), name: 'rev-org', urn: 'rev-org' },
  });
  adminUser = await db.user.create({
    data: { githubId: 7001, githubUsername: 'rev-admin', roles: ['ADMIN'] },
  });
  otherAdmin = await db.user.create({
    data: { githubId: 7002, githubUsername: 'other-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: orgA.id, userId: adminUser.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { organizationId: orgA.id, userId: otherAdmin.id, role: 'ADMIN' },
  });

  const created = await resolvers.Mutation.createAgent(
    {},
    { orgId: orgA.id, name: 'rev-agent', visibility: 'PERSONAL' },
    adminCtx(),
  );
  agent = created;
  // createAgent now auto-provisions the agent's class='system' memory (#518);
  // read it straight off the returned agent rather than create + attach.
  systemMemory = await db.memory.findUniqueOrThrow({
    where: { id: created.systemMemoryId! },
  });

  // Seed a conversation + stage + prompt
  for (const n of [
    { loc: 'conversations:hello', name: 'hello', nodeType: 'system', data: { stageOrder: ['greet'], isSetup: false } },
    { loc: 'conversations:hello:greet', name: 'greet', nodeType: 'system', data: { promptRef: 'prompts:hello:greet' } },
    { loc: 'prompts:hello', name: 'hello', nodeType: 'system' },
    { loc: 'prompts:hello:greet', name: 'greet', nodeType: 'system', content: 'Hello world!' },
  ] as any[]) {
    await db.node.create({
      data: {
        id: generateId(), memoryId: systemMemory.id,
        loc: n.loc, name: n.name, nodeType: n.nodeType,
        data: n.data ?? null, content: n.content ?? null,
      },
    });
  }
});

const COMPILED = 'boot:coordinator:compiled';
const SOURCE = 'boot:coordinator';
const M = resolvers.Mutation as any;
const node = (loc: string) => db.node.findFirstOrThrow({ where: { memoryId: systemMemory.id, loc } });
const mk = (loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId: systemMemory.id, loc, name: loc.split(':').pop()!, nodeType: 'info', ...extra } as any });
/** The Agent has a boot-prompt source and its compiled prompt, as after a first compile. */
async function compile(content = 'compiled v1') {
  await mk(SOURCE, { role: 'boot-prompt', content: 'source' });
  return mk(COMPILED, { nodeType: 'system', role: 'boot-prompt.compiled', content });
}
const save = () => M.createRevision({}, { agentRef: agent.id }, adminCtx()) as Promise<{ revisionLoc: string }>;
const restore = (revisionLoc: string) => M.restoreRevision({}, { agentRef: agent.id, revisionLoc }, adminCtx());
const asWas = (n: Record<string, unknown>) => ({
  id: n.id, content: n.content, nodeType: n.nodeType, role: n.role, deletedAt: n.deletedAt, rev: n.rev, name: n.name, data: n.data, tags: n.tags, updatedAt: n.updatedAt,
});
const revisionCount = () => db.node.count({ where: { memoryId: systemMemory.id, loc: { startsWith: 'revisions:rev-' } } });
const snapshotNodes = async (revisionLoc: string) =>
  ((await node(revisionLoc)).data as any).snapshot.nodes as Array<Record<string, unknown>>;

describe('#4244 A: a restore leaves compiled boot prompts as they are', () => {
  it('a snapshot taken with the compiled prompt present restores, and the compiled row is left as it was', async () => {
    const before = asWas(await compile() as any);
    const rev = await save();
    await db.node.updateMany({ where: { memoryId: systemMemory.id, loc: 'prompts:hello:greet' }, data: { content: 'changed' } });
    await restore(rev.revisionLoc);
    expect(asWas(await node(COMPILED) as any)).toEqual(before);
    expect((await node('prompts:hello:greet')).content).toBe('Hello world!'); // the rest of the restore still happens
  });

  it('a snapshot taken before the first compile, restored over an Agent that now has a compiled prompt: it stays live and unchanged', async () => {
    const rev = await save(); // no compiled node, no source
    const before = asWas(await compile() as any);
    await restore(rev.revisionLoc);
    expect(asWas(await node(COMPILED) as any)).toEqual(before);
    expect((await node(SOURCE)).deletedAt).not.toBeNull(); // the source was not in the snapshot, so it is retired as any node is
  });

  it('a snapshot\'s copy of a compiled prompt is ignored: the live one keeps its own content', async () => {
    await compile('compiled v1');
    const rev = await save();
    await db.node.updateMany({ where: { memoryId: systemMemory.id, loc: COMPILED }, data: { content: 'compiled v2' } }); // a later compile
    const before = asWas(await node(COMPILED) as any);
    await restore(rev.revisionLoc);
    expect(asWas(await node(COMPILED) as any)).toEqual(before);
    expect((await node(COMPILED)).content).toBe('compiled v2');
  });

  it('a snapshot\'s copy of a compiled prompt is not recreated when the Agent has none now', async () => {
    const made = await compile();
    const rev = await save();
    await db.node.delete({ where: { id: made.id } });
    await restore(rev.revisionLoc);
    expect(await db.node.count({ where: { memoryId: systemMemory.id, loc: COMPILED } })).toBe(0);
  });

  it('an edge from a compiled prompt is neither retired nor restored a second time', async () => {
    const made = await compile();
    const target = await node('prompts');
    const edge = await db.edge.create({ data: { id: generateId(), memoryId: systemMemory.id, loc: `${COMPILED}->prompts`, sourceId: made.id, targetId: target.id } as any });
    const rev = await save();
    await restore(rev.revisionLoc);
    const after = await db.edge.findMany({ where: { sourceId: made.id } });
    expect(after.map((e) => ({ id: e.id, deletedAt: e.deletedAt, updatedAt: e.updatedAt }))).toEqual([{ id: edge.id, deletedAt: null, updatedAt: edge.updatedAt }]);
  });
  it('an edge TO a compiled prompt, from a node the snapshot restores, is restored', async () => {
    const made = await compile();
    const from = await node('prompts');
    const edge = await db.edge.create({ data: { id: generateId(), memoryId: systemMemory.id, loc: `prompts->${COMPILED}`, sourceId: from.id, targetId: made.id } as any });
    const rev = await save();
    await restore(rev.revisionLoc);
    expect(await db.edge.findUniqueOrThrow({ where: { id: edge.id } })).toMatchObject({ deletedAt: null, sourceId: from.id, targetId: made.id });
  });
});

describe('#4244 A: a snapshot records each node\'s role', () => {
  it('a new snapshot carries the role of every node', async () => {
    await compile();
    const rev = await save();
    const byLoc = new Map((await snapshotNodes(rev.revisionLoc)).map((n) => [n.loc, n]));
    expect(byLoc.get(SOURCE)).toMatchObject({ role: 'boot-prompt' });
    expect(byLoc.get('prompts:hello:greet')).toHaveProperty('role', null);
  });

  it('a source recreated from a snapshot (its row is gone) has the snapshot\'s role', async () => {
    const src = await mk(SOURCE, { nodeType: 'system', role: 'boot-prompt.source', content: 'source' });
    const rev = await save();
    await db.node.delete({ where: { id: src.id } });
    await restore(rev.revisionLoc);
    expect(await node(SOURCE)).toMatchObject({ role: 'boot-prompt.source', content: 'source', deletedAt: null });
  });

  // #5453 changes this one on purpose: a snapshot that holds the BARE role (published before the migration, or a
  // source a mirror wrote back) is recreated as today's source leaf, type system. The bare role is never written back.
  it('#5453: a source recreated from a snapshot that holds the bare role is written as the source leaf', async () => {
    const src = await mk(SOURCE, { role: 'boot-prompt', content: 'source' });
    const rev = await save();
    await db.node.delete({ where: { id: src.id } });
    await restore(rev.revisionLoc);
    expect(await node(SOURCE)).toMatchObject({ nodeType: 'system', role: 'boot-prompt.source', content: 'source', deletedAt: null });
  });

  it('over an existing row the live role is kept, whatever the snapshot holds', async () => {
    await mk(SOURCE, { role: 'boot-prompt', content: 'source' });
    const rev = await save();
    await db.node.updateMany({ where: { memoryId: systemMemory.id, loc: SOURCE }, data: { role: 'boot-prompt.draft', content: 'edited' } });
    await restore(rev.revisionLoc);
    expect(await node(SOURCE)).toMatchObject({ role: 'boot-prompt.draft', content: 'source', deletedAt: null });
  });

  it('a snapshot with no role on its nodes (the shape before this fix) still restores, and an existing row keeps its role', async () => {
    await compile();
    const rev = await save();
    const revNode = await node(rev.revisionLoc);
    const data = revNode.data as any;
    data.snapshot.nodes = data.snapshot.nodes.map(({ role: _role, ...rest }: Record<string, unknown>) => rest);
    await db.node.update({ where: { id: revNode.id }, data: { data } });
    const before = asWas(await node(COMPILED) as any);
    await restore(rev.revisionLoc);
    expect(asWas(await node(COMPILED) as any)).toEqual(before);
    expect(await node(SOURCE)).toMatchObject({ role: 'boot-prompt', deletedAt: null });
  });
});

describe('#4244 B: an unknown revisionLoc is a typed refusal, before any write', () => {
  it('restoreRevision: BAD_USER_INPUT, and no auto-save revision is made', async () => {
    await save();
    const count = await revisionCount();
    await expect(restore('revisions:rev-999')).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await revisionCount()).toBe(count);
  });

  it('publishRevision: BAD_USER_INPUT, and the published revision is unchanged', async () => {
    const rev = await save();
    await M.publishRevision({}, { agentRef: agent.id, revisionLoc: rev.revisionLoc }, adminCtx());
    await expect(M.publishRevision({}, { agentRef: agent.id, revisionLoc: 'revisions:rev-999' }, adminCtx()))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).publishedRevisionLoc).toBe(rev.revisionLoc);
  });

  it('a soft-deleted revision is unknown too', async () => {
    const rev = await save();
    await db.node.updateMany({ where: { memoryId: systemMemory.id, loc: rev.revisionLoc }, data: { deletedAt: new Date() } });
    await expect(restore(rev.revisionLoc)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});

describe('#5453: a snapshot published before the definition-node migration', () => {
  /** Rewrite a saved snapshot into the shape it had before #5453: the retired compiled type, the bare role, `info`. */
  async function ageSnapshot(revisionLoc: string) {
    const rev = await node(revisionLoc);
    const data = rev.data as any;
    for (const n of data.snapshot.nodes as Array<Record<string, unknown>>) {
      if (n.loc === COMPILED) { n.nodeType = 'compiled-boot-prompt'; n.role = 'boot-prompt'; }
      if (n.loc === SOURCE) { n.nodeType = 'info'; n.role = 'boot-prompt'; }
      if (n.loc === 'boot:rules:core') { n.nodeType = 'info'; n.role = 'boot-prompt-rule'; }
    }
    await db.node.update({ where: { id: rev.id }, data: { data } });
  }

  it('restores a source and a rule as today\'s kind, never the bare role or the old type, and still ignores its compiled copy', async () => {
    const compiledRow = await compile('compiled v1');
    const rule = await mk('boot:rules:core', { nodeType: 'system', role: 'boot-prompt.rule', content: 'rule' });
    const rev = await save();
    await ageSnapshot(rev.revisionLoc);
    expect((await snapshotNodes(rev.revisionLoc)).find((n) => n.loc === COMPILED)).toMatchObject({ nodeType: 'compiled-boot-prompt', role: 'boot-prompt' });
    // The source and the rule are gone now, so the restore makes them anew from the old capture.
    await db.node.deleteMany({ where: { memoryId: systemMemory.id, loc: { in: [SOURCE, 'boot:rules:core'] } } });
    const before = asWas(await node(COMPILED) as any);
    await restore(rev.revisionLoc);
    expect(await node(SOURCE)).toMatchObject({ nodeType: 'system', role: 'boot-prompt.source', content: 'source', deletedAt: null });
    expect(await node('boot:rules:core')).toMatchObject({ nodeType: 'system', role: 'boot-prompt.rule', content: 'rule', deletedAt: null });
    expect((await node('boot:rules:core')).id).not.toBe(rule.id);
    expect(asWas(await node(COMPILED) as any)).toEqual(before);
    expect((await node(COMPILED)).id).toBe(compiledRow.id);
    expect(await db.node.count({ where: { memoryId: systemMemory.id, nodeType: 'compiled-boot-prompt' } })).toBe(0);
    expect(await db.node.count({ where: { memoryId: systemMemory.id, role: { in: ['boot-prompt', 'boot-prompt-rule'] } } })).toBe(0);
  });

  it('restored over a live migrated source: the type is not turned back to info and the live role stays', async () => {
    await compile('compiled v1');
    await db.node.updateMany({ where: { memoryId: systemMemory.id, loc: SOURCE }, data: { nodeType: 'system', role: 'boot-prompt.source' } });
    const rev = await save();
    await ageSnapshot(rev.revisionLoc);
    await db.node.updateMany({ where: { memoryId: systemMemory.id, loc: SOURCE }, data: { content: 'edited after the snapshot' } });
    await restore(rev.revisionLoc);
    expect(await node(SOURCE)).toMatchObject({ nodeType: 'system', role: 'boot-prompt.source', content: 'source' });
  });

  it('a snapshot whose only copy of the compiled prompt is in the old form is not recreated when the Agent has none now', async () => {
    const made = await compile();
    const rev = await save();
    await ageSnapshot(rev.revisionLoc);
    await db.node.delete({ where: { id: made.id } });
    await restore(rev.revisionLoc);
    expect(await db.node.count({ where: { memoryId: systemMemory.id, loc: COMPILED } })).toBe(0);
  });
});
