/**
 * #4313 (cor:agt:040:12, Proposed sentence built by #4311; follow-up to #4244) — a restore leaves the Agent's compiled
 * boot prompts as they are, also when a compile commits WHILE the restore runs, for a compiled row that is already
 * retired, and for edges from a compiled prompt that changed after the snapshot.
 *
 * The race: the restore read the compiled rows once, then read the live rows to tombstone leaving the compiled ones
 * out BY ID. A compile that created the Agent's first compiled row between those two reads was in the second read and
 * not in the first, so the restore tombstoned it, and a retired compiled prompt refuses that Agent's binds
 * (cor:agt:040:10). The tombstone step now leaves compiled rows out by their type, in the statements themselves.
 *
 * The race pins use two connections and no sleep: the restore's transaction runs on one, and a hook on a named
 * statement of it commits the compile on another before that statement's result is handed back.
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
    { loc: 'conversations', name: 'conversations', nodeType: 'system' },
    { loc: 'conversations:hello', name: 'hello', nodeType: 'system', data: { stageOrder: ['greet'], isSetup: false } },
    { loc: 'conversations:hello:greet', name: 'greet', nodeType: 'system', data: { promptRef: 'prompts:hello:greet' } },
    { loc: 'prompts', name: 'prompts', nodeType: 'system' },
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
  return mk(COMPILED, { nodeType: 'compiled-boot-prompt', role: 'boot-prompt', content });
}
const save = () => M.createRevision({}, { agentRef: agent.id }, adminCtx()) as Promise<{ revisionLoc: string }>;
const restore = (revisionLoc: string) => M.restoreRevision({}, { agentRef: agent.id, revisionLoc }, adminCtx());
const asWas = (n: Record<string, unknown>) => ({
  id: n.id, content: n.content, nodeType: n.nodeType, role: n.role, deletedAt: n.deletedAt, rev: n.rev, name: n.name, data: n.data, tags: n.tags, updatedAt: n.updatedAt,
});
const revisionCount = () => db.node.count({ where: { memoryId: systemMemory.id, loc: { startsWith: 'revisions:rev-' } } });
const snapshotNodes = async (revisionLoc: string) =>
  ((await node(revisionLoc)).data as any).snapshot.nodes as Array<Record<string, unknown>>;


/**
 * What a compile leaves behind, committed in ONE transaction on another connection: the source (if absent), the
 * compiled row, and an edge from the compiled row. A fixture of the compile's result, not the compile mutation.
 */
async function commitCompiledFixture() {
  const hasSource = await db.node.findFirst({ where: { memoryId: systemMemory.id, loc: SOURCE }, select: { id: true } });
  const target = await node('prompts');
  const id = generateId();
  const base = { memoryId: systemMemory.id, tags: [] };
  await db.$transaction([
    ...(hasSource ? [] : [db.node.create({ data: { ...base, id: generateId(), loc: SOURCE, name: 'coordinator', nodeType: 'info', role: 'boot-prompt', content: 'source' } as any })]),
    db.node.create({ data: { ...base, id, loc: COMPILED, name: 'compiled', nodeType: 'compiled-boot-prompt', role: 'boot-prompt', content: 'compiled while restoring' } as any }),
    db.edge.create({ data: { id: generateId(), memoryId: systemMemory.id, loc: `${COMPILED}->prompts`, sourceId: id, targetId: target.id } as any }),
  ]);
  return { id };
}

/** `where` names the statement by its own predicate (not by its position); `nth` counts the calls that match it. */
type HookPoint = { model: 'node' | 'edge'; op: 'findMany' | 'updateMany'; nth: number; where?: (where: any) => boolean };
/** The restore's read of the compiled rows: `nodeType` is the compiled type itself, not a `not` filter. */
const readsCompiledRows = (where: any) => where?.nodeType === 'compiled-boot-prompt';
/**
 * A context whose database hands the restore's own transaction a client that runs `during` once, right after the
 * `at.nth` matching call of `at.model.at.op` in that transaction has run and before its result is returned.
 * `restoreRevision` opens two transactions: the auto-save's slot allocation, then the restore. `fired` says whether
 * the hook ran, and `seen` is what the hooked statement returned, so a pin can assert it hooked the read it meant.
 * `locked` holds every row the restore's transaction read back by id (`node.findUniqueOrThrow`): the write loop's
 * read of a row it has just locked, so a pin can assert WHICH row that check judged.
 */
function ctxInterleaving(at: HookPoint, during: () => Promise<unknown>) {
  const state = { fired: false, transactions: 0, seen: undefined as unknown, locked: [] as Array<{ id: string; loc: string; nodeType: string }> };
  const base = adminCtx();
  const proxyDb = new Proxy(base.db, {
    get(target, prop, receiver) {
      if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
      return (fn: unknown, opts: unknown) => {
        if (typeof fn !== 'function') return (target as any).$transaction(fn, opts);
        // #3587: the auto-save is written inside the restore's own transaction, so the restore is the FIRST one.
        const isRestore = ++state.transactions === 1;
        let calls = 0;
        return (target as any).$transaction((tx: any) => {
          if (!isRestore) return (fn as any)(tx);
          const proxyOf = (model: 'node' | 'edge') => new Proxy(tx[model], {
            get(mt, mp, mr) {
              if (model === 'node' && mp === 'findUniqueOrThrow') {
                return async (...args: unknown[]) => {
                  const row = await mt.findUniqueOrThrow(...args);
                  state.locked.push({ id: row.id, loc: row.loc, nodeType: row.nodeType });
                  return row;
                };
              }
              if (model !== at.model || mp !== at.op) return Reflect.get(mt, mp, mr);
              return async (...args: unknown[]) => {
                const result = await mt[at.op](...args);
                if (at.where && !at.where((args[0] as any)?.where)) return result;
                if (++calls === at.nth && !state.fired) { state.fired = true; state.seen = result; await during(); }
                return result;
              };
            },
          });
          const proxies = { node: proxyOf('node'), edge: proxyOf('edge') };
          return (fn as any)(new Proxy(tx, { get: (t, p, r) => (p === 'node' || p === 'edge' ? proxies[p] : Reflect.get(t, p, r)) }));
        }, opts);
      };
    },
  });
  return { ctx: { ...base, db: proxyDb } as Context, state };
}

// The restore's node reads before the live read: the auto-save's snapshot read and its slot read (#3587).
const RESTORE_LIVE_READ = 3;

describe('#4313: a compile that commits while a restore runs is left as it is', () => {
  const points: Array<[string, HookPoint]> = [
    ['after the restore\'s first node read', { model: 'node', op: 'findMany', nth: RESTORE_LIVE_READ }],
    ['after the tombstone statement', { model: 'node', op: 'updateMany', nth: 1 }],
    ['after the edge-retire statement', { model: 'edge', op: 'updateMany', nth: 1 }],
  ];
  it.each(points)('the compile commits %s: the new compiled prompt stays live, with its edge', async (_when, at) => {
    const rev = await save(); // taken before the first compile: no compiled node in it
    let made: { id: string } | undefined;
    const { ctx, state } = ctxInterleaving(at, async () => { made = await commitCompiledFixture(); });
    await M.restoreRevision({}, { agentRef: agent.id, revisionLoc: rev.revisionLoc }, ctx);
    expect(state.fired, 'the compile must have committed inside the restore').toBe(true);
    const after = await node(COMPILED);
    expect(after).toMatchObject({ id: made!.id, deletedAt: null, nodeType: 'compiled-boot-prompt', role: 'boot-prompt', content: 'compiled while restoring' });
    expect(await db.edge.findMany({ where: { sourceId: made!.id }, select: { deletedAt: true } })).toEqual([{ deletedAt: null }]);
    expect((await node('prompts:hello:greet')).deletedAt).toBeNull(); // the restore itself still ran
  });

  it('the hook reaches the restore: with no compile at all the restore still tombstones what the snapshot lacks', async () => {
    const rev = await save();
    const extra = await mk('notes:later', { content: 'added after the snapshot' });
    const { ctx, state } = ctxInterleaving({ model: 'node', op: 'findMany', nth: RESTORE_LIVE_READ }, async () => undefined);
    await M.restoreRevision({}, { agentRef: agent.id, revisionLoc: rev.revisionLoc }, ctx);
    expect(state.fired).toBe(true);
    expect((await db.node.findUniqueOrThrow({ where: { id: extra.id } })).deletedAt).not.toBeNull();
  });

  it('a compile that takes an address the snapshot holds an ordinary node at is not written over, and gets none of that node\'s edges', async () => {
    // The snapshot has an ordinary node at the address a compile then writes its compiled prompt to, with an edge
    // from it. The compile commits right after the restore has read the compiled rows (so that read does not hold
    // it): only the check on the locked row in the write loop can keep the restore from writing over it.
    const squatter = await mk(COMPILED, { content: 'an ordinary node at the compiled address' });
    const conversations = await node('conversations');
    await db.edge.create({ data: { id: generateId(), memoryId: systemMemory.id, loc: `${COMPILED}->conversations`, sourceId: squatter.id, targetId: conversations.id } as any });
    const rev = await save();
    // The snapshot really holds that edge: without it nothing below would show that its replay is suppressed.
    const savedEdges = ((await node(rev.revisionLoc)).data as any).snapshot.edges as Array<{ sourceLoc: string; targetLoc: string }>;
    expect(savedEdges).toContainEqual(expect.objectContaining({ sourceLoc: COMPILED, targetLoc: 'conversations' }));
    await db.edge.deleteMany({ where: { sourceId: squatter.id } });
    await db.node.delete({ where: { id: squatter.id } });
    let made: { id: string } | undefined;
    const { ctx, state } = ctxInterleaving({ model: 'node', op: 'findMany', nth: 1, where: readsCompiledRows }, async () => { made = await commitCompiledFixture(); });
    await M.restoreRevision({}, { agentRef: agent.id, revisionLoc: rev.revisionLoc }, ctx);
    expect(state.fired).toBe(true);
    expect((state.seen as Array<{ loc: string }>).map((r) => r.loc)).not.toContain(COMPILED); // the hooked read did not hold it
    // …and the write loop then read the compile's row back under its lock and judged THAT row: the locked lookup
    // returned the compiled prompt at this address, which is the check that skipped the write.
    expect(state.locked).toContainEqual({ id: made!.id, loc: COMPILED, nodeType: 'compiled-boot-prompt' });
    expect(await node(COMPILED)).toMatchObject({ id: made!.id, deletedAt: null, nodeType: 'compiled-boot-prompt', role: 'boot-prompt', content: 'compiled while restoring' });
    // The snapshot's edge from the ordinary node is not replayed onto the compiled prompt: it keeps its own edge only.
    const edges = await db.edge.findMany({ where: { sourceId: made!.id }, select: { loc: true, deletedAt: true } });
    expect(edges).toEqual([{ loc: `${COMPILED}->prompts`, deletedAt: null }]);
  });
});

describe('#4313: a compiled prompt that is already retired stays as it is', () => {
  it('a retired compiled row keeps its fields, stays retired and keeps its outgoing edges', async () => {
    const made = await compile();
    const target = await node('prompts');
    const edge = await db.edge.create({ data: { id: generateId(), memoryId: systemMemory.id, loc: `${COMPILED}->prompts`, sourceId: made.id, targetId: target.id } as any });
    const rev = await save(); // the snapshot holds a live copy of it
    await db.node.update({ where: { id: made.id }, data: { deletedAt: new Date() } }); // retired since
    const before = asWas(await db.node.findUniqueOrThrow({ where: { id: made.id } }) as any);
    expect(before.deletedAt).not.toBeNull();
    await restore(rev.revisionLoc);
    expect(asWas(await db.node.findUniqueOrThrow({ where: { id: made.id } }) as any)).toEqual(before); // not resurrected, not rewritten
    expect(await db.edge.findUniqueOrThrow({ where: { id: edge.id } })).toMatchObject({ deletedAt: null, updatedAt: edge.updatedAt });
  });

  it('a retired compiled row the snapshot never held stays retired too', async () => {
    const rev = await save();
    const made = await compile();
    await db.node.update({ where: { id: made.id }, data: { deletedAt: new Date() } });
    const before = asWas(await db.node.findUniqueOrThrow({ where: { id: made.id } }) as any);
    await restore(rev.revisionLoc);
    expect(asWas(await db.node.findUniqueOrThrow({ where: { id: made.id } }) as any)).toEqual(before);
  });
});

describe('#4313: edges from a compiled prompt that changed after the snapshot stay as they are now', () => {
  it('an edge added after the snapshot stays live; one retired after the snapshot stays retired', async () => {
    const made = await compile();
    const prompts = await node('prompts');
    const conversations = await node('conversations');
    const old = await db.edge.create({ data: { id: generateId(), memoryId: systemMemory.id, loc: `${COMPILED}->prompts`, sourceId: made.id, targetId: prompts.id } as any });
    const rev = await save(); // the snapshot holds `old`, live
    const retiredAt = new Date();
    await db.edge.update({ where: { id: old.id }, data: { deletedAt: retiredAt } }); // retired after the snapshot
    const added = await db.edge.create({ data: { id: generateId(), memoryId: systemMemory.id, loc: `${COMPILED}->conversations`, sourceId: made.id, targetId: conversations.id } as any });
    const oldNow = await db.edge.findUniqueOrThrow({ where: { id: old.id } });
    await restore(rev.revisionLoc);
    expect(await db.edge.findUniqueOrThrow({ where: { id: added.id } })).toMatchObject({ deletedAt: null, updatedAt: added.updatedAt });
    expect(await db.edge.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ deletedAt: oldNow.deletedAt, updatedAt: oldNow.updatedAt });
    expect(await db.edge.count({ where: { sourceId: made.id } })).toBe(2); // none restored a second time
  });
});
