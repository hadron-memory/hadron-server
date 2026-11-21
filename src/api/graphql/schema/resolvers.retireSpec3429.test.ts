/**
 * #3429 (rulings 0212-0214, 0218-0220; cor:spc:010:02, cor:spc:010:01): the retire door. One transaction, under the
 * spec memory's channel key, the spec's loc key and its row lock, writes the tag, banner, abstract and (supersede) the
 * `superseded-by` edge, or refuses with nothing written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { observeTransactionBackend, waitForAdvisoryWaiter } from '../../../test/advisoryWaiter.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';
import { generateId } from '../../../lib/id.js';
import { acquireLockSet } from '../../../lib/nodeSubtreeLock.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/mirrorNodeMove.js', () => ({ mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined) }));

let admin: { id: string };
let outsider: { id: string };
let mem: { id: string; urn: string };
let otherMem: { id: string };
const as = (userId: string): Context => ({ db, userId, roles: [] });

const spec = async (loc: string, patch: Record<string, unknown> = {}, memoryId = mem.id) =>
  (await resolvers.Mutation.createSpecNode(null, { input: {
    memoryId, loc, name: `Spec ${loc}`, role: 'spec', content: `# Title ${loc}\n\nBody of ${loc}.`, abstract: `About ${loc}.`, tags: ['spec'], ...patch,
  } } as never, as(admin.id))) as { id: string };
const rev = async (id: string) => (await db.node.findUniqueOrThrow({ where: { id } })).revSeq;
const snap = async (id: string) => {
  const n = await db.node.findUniqueOrThrow({ where: { id } });
  const edges = await db.edge.findMany({ where: { sourceId: id }, orderBy: { id: 'asc' } });
  const revisions = await db.nodeRevision.count({ where: { nodeId: id } });
  return JSON.stringify({ n, edges, revisions });
};
type Retire = Record<string, unknown>;
const retire = async (input: Retire, ctx: Context = as(admin.id)) =>
  resolvers.Mutation.retireSpec(null, { input } as never, ctx) as Promise<{ node: { id: string; abstract: string | null; content: string | null; tags: string[]; revSeq: number }; successorEdge: { id: string; name: string; target?: { id: string } } | null }>;
const rescind = async (id: string, extra: Retire = {}) =>
  retire({ ref: id, form: 'RESCIND', expectedRevision: await rev(id), reason: 'Superseded by policy', summary: 'The old rule.', ...extra });
const supersede = async (id: string, successor: string, extra: Retire = {}) =>
  retire({ ref: id, form: 'SUPERSEDE', successorRef: successor, expectedRevision: await rev(id), ...extra });
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    // A raw class is NOT a typed refusal: the server masks it as INTERNAL_SERVER_ERROR on the wire (#4669 QA P2).
    return e instanceof GraphQLError ? String(e.extensions.code) : `RAW:${(e as Error).name}`;
  }
};
const dbDate = async () => (await db.$queryRaw<Array<{ d: string }>>`SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS d`)[0]!.d;
const link = (sourceId: string, targetId: string, name: string, extra: Record<string, unknown> = {}) =>
  db.edge.create({ data: { id: generateId(), memoryId: mem.id, sourceId, targetId, loc: `l-${generateId()}`, name, ...extra } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Retire Org', urn: 'retire.example' } });
  admin = await db.user.create({ data: { githubId: 342901, githubUsername: 'retire-admin', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 342902, githubUsername: 'retire-outsider', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  mem = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'specs-draft', draftCorpus: true }, as(admin.id));
  otherMem = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'other-draft', draftCorpus: true }, as(admin.id));
});

describe('#3429 rescind', () => {
  it('tags, bannered, abstracted, one revision, no edge; the date is the database clock', async () => {
    const x = await spec('t:010:01');
    const before = await rev(x.id);
    const d0 = await dbDate();
    const out = await rescind(x.id, { reason: '  Not   needed\nany more ', summary: 'Old\n  rule  text ' });
    const d1 = await dbDate();
    const date = [d0, d1].find((d) => out.node.abstract?.startsWith(`RESCINDED (${d})`));
    expect(date).toBeDefined();
    expect(out.node.abstract).toBe(`RESCINDED (${date}); do not apply. Not needed any more Historical: Old rule text`);
    expect(out.node.tags).toEqual(['spec', 'superseded']);
    expect(out.node.content).toBe(
      `# Title t:010:01\n\n> **⚠️ Rescinded** (${date}, Not needed any more), no successor. **Do not apply.** Retained as a tombstone; the citation is never renumbered.\n\nBody of t:010:01.`,
    );
    expect(out.successorEdge).toBeNull();
    expect(await rev(x.id)).toBe(before + 1);
    expect(await db.edge.count({ where: { sourceId: x.id } })).toBe(0);
  });

  it('withdrawn wording, and a body with no leading title puts the banner at the top', async () => {
    const x = await spec('t:010:02', { content: 'No title line.' });
    const out = await rescind(x.id, { withdrawn: true, reason: 'draft' });
    const date = out.node.abstract!.match(/^WITHDRAWN \((\d{4}-\d\d-\d\d)\); do not apply\. draft Historical: The old rule\.$/)?.[1];
    expect(date).toBeDefined();
    expect(out.node.content).toBe(`> **⚠️ Withdrawn, never in force** (${date}, draft). **Do not apply.** Retained as a tombstone; the citation is never renumbered.\n\nNo title line.`);
  });

  it('superseded is appended once and the tag order is kept', async () => {
    const x = await spec('t:010:03', { tags: ['b', 'superseded-ish', 'a'] });
    const out = await rescind(x.id);
    expect(out.node.tags).toEqual(['b', 'superseded-ish', 'a', 'superseded']);
  });
});

describe('#3429 supersede', () => {
  it('writes the tag, banner under the title, abstract and exactly one superseded-by edge, in one revision', async () => {
    const x = await spec('t:020:01');
    const y = await spec('t:020:02');
    const before = await rev(x.id);
    const out = await supersede(x.id, y.id, { reason: ' because ' });
    const date = out.node.abstract!.match(/^SUPERSEDED \((\d{4}-\d\d-\d\d)\) by t:020:02 \(Spec t:020:02\); do not apply\. Historical: About t:020:01\.$/)?.[1];
    expect(date).toBeDefined();
    expect(out.node.content).toBe(
      `# Title t:020:01\n\n> **⚠️ Superseded** (${date}, because) by t:020:02 (Spec t:020:02). **Do not apply.** Retained as a tombstone; the citation is never renumbered.\n\nBody of t:020:01.`,
    );
    expect(out.node.tags).toEqual(['spec', 'superseded']);
    expect(out.successorEdge).toMatchObject({ name: 'superseded-by' });
    expect(out.successorEdge?.target?.id ?? (await db.edge.findUniqueOrThrow({ where: { id: out.successorEdge!.id } })).targetId).toBe(y.id);
    expect(await rev(x.id)).toBe(before + 1);
    expect(await db.edge.count({ where: { sourceId: x.id, name: 'superseded-by', deletedAt: null } })).toBe(1);
  });

  it('without a reason the banner has no reason clause, and a stated summary replaces the stored abstract', async () => {
    const x = await spec('t:020:03');
    const y = await spec('t:020:04');
    const out = await supersede(x.id, y.id, { summary: 'Custom  history' });
    const date = out.node.abstract!.match(/^SUPERSEDED \((\d{4}-\d\d-\d\d)\) by t:020:04 \(Spec t:020:04\); do not apply\. Historical: Custom history$/)?.[1];
    expect(date).toBeDefined();
    expect(out.node.content).toContain(`> **⚠️ Superseded** (${date}) by t:020:04 (Spec t:020:04). **Do not apply.**`);
  });

  it('a chain is allowed: retiring the successor later leaves X to Y to Z', async () => {
    const x = await spec('t:020:05'); const y = await spec('t:020:06'); const z = await spec('t:020:07');
    await supersede(x.id, y.id);
    await supersede(y.id, z.id);
    expect(await db.edge.count({ where: { name: 'superseded-by', deletedAt: null } })).toBe(2);
  });

  it('a successor that is not a spec type is accepted (no type check)', async () => {
    const x = await spec('t:020:08');
    const y = await spec('t:020:09', { role: undefined, nodeType: 'info', tags: [] });
    expect((await supersede(x.id, y.id)).successorEdge).not.toBeNull();
  });
});

describe('#3429 refusals write nothing (acceptance 1)', () => {
  const refused = async (id: string, run: () => Promise<unknown>, code = 'NODE_WRITE_CONFLICT') => {
    const before = await snap(id);
    expect(await codeOf(run())).toBe(code);
    expect(await snap(id)).toBe(before);
  };

  it('an already retired spec, including an inconsistent older one with no abstract and no successor', async () => {
    const x = await spec('t:030:01');
    await rescind(x.id);
    await refused(x.id, () => rescind(x.id));
    const old = await spec('t:030:02', { tags: ['spec', 'superseded'], abstract: null });
    await refused(old.id, () => rescind(old.id));
  });

  it('a live superseded-by edge, a prefixed one, and one whose target is soft-deleted', async () => {
    const t = await spec('t:030:03');
    for (const [i, name] of ['superseded-by', 'superseded-by-x', 'superseded-by_y'].entries()) {
      const x = await spec(`t:031:0${i}`);
      await link(x.id, t.id, name);
      await refused(x.id, () => rescind(x.id));
    }
    const gone = await spec('t:030:04'); const x2 = await spec('t:030:05');
    await link(x2.id, gone.id, 'superseded-by');
    await db.node.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    await refused(x2.id, () => rescind(x2.id));
  });

  it('a non-deleted superseded-by PendingEdge (0214); a deleted one and a tombstoned edge do not count', async () => {
    const x = await spec('t:030:06');
    await db.pendingEdge.create({ data: { id: generateId(), sourceId: x.id, name: 'superseded-by', targetId: 'unresolved:nowhere' } as never });
    await refused(x.id, () => rescind(x.id));
    const y = await spec('t:030:07'); const t = await spec('t:030:08');
    await db.pendingEdge.create({ data: { id: generateId(), sourceId: y.id, name: 'superseded-by', targetId: 'unresolved:nowhere', deletedAt: new Date() } as never });
    await link(y.id, t.id, 'superseded-by', { deletedAt: new Date() });
    expect(await rescind(y.id)).toBeDefined();
  });

  it.each([
    ['itself', async (x: { id: string }) => x.id],
    ['in another memory (0218)', async () => (await spec('t:040:90', {}, otherMem.id)).id],
    ['retired (0219)', async () => { const r = await spec('t:040:91'); await rescind(r.id); return r.id; }],
    ['with a live link of its own (0219)', async () => { const r = await spec('t:040:92'); const q = await spec('t:040:93'); await link(r.id, q.id, 'superseded-by'); return r.id; }],
    ['with a pending link of its own (0219)', async () => { const r = await spec('t:040:94'); await db.pendingEdge.create({ data: { id: generateId(), sourceId: r.id, name: 'superseded-by', targetId: 'unresolved:z' } as never }); return r.id; }],
  ])('a successor %s is NODE_WRITE_CONFLICT', async (label, make) => {
    const x = await spec(`t:040:${label.length}`);
    const succ = await make(x);
    await refused(x.id, () => supersede(x.id, succ));
  });

  it('an unreadable, missing or soft-deleted successor is NODE_NOT_FOUND, whichever applies', async () => {
    const x = await spec('t:041:01');
    const gone = await spec('t:041:02');
    await db.node.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    await refused(x.id, () => supersede(x.id, gone.id), 'NODE_NOT_FOUND');
    await refused(x.id, () => supersede(x.id, generateId()), 'NODE_NOT_FOUND');
  });
});

describe('#3429 ladder and order (acceptance 4)', () => {
  it('input-shape refusals are BAD_USER_INPUT and read nothing, including for an unreadable or missing ref', async () => {
    const x = await spec('t:050:01'); const y = await spec('t:050:02');
    const ok = { ref: x.id, form: 'RESCIND', expectedRevision: await rev(x.id), reason: 'r', summary: 's' };
    const bad: Retire[] = [
      { ...ok, successorRef: y.id },
      { ...ok, reason: '   ' }, { ...ok, reason: undefined }, { ...ok, summary: ' ' }, { ...ok, summary: undefined },
      { ref: x.id, form: 'SUPERSEDE', expectedRevision: ok.expectedRevision },
      { ref: x.id, form: 'SUPERSEDE', successorRef: y.id, withdrawn: true, expectedRevision: ok.expectedRevision },
      { ...ok, expectedRevision: 0 }, { ...ok, expectedRevision: undefined }, { ...ok, ref: '' },
    ];
    for (const input of bad) expect(await codeOf(retire(input))).toBe('BAD_USER_INPUT');
    expect(await codeOf(retire({ ...ok, ref: generateId(), reason: ' ' }, as(outsider.id)))).toBe('BAD_USER_INPUT');
  });

  it('a stale expectedRevision is NODE_WRITE_CONFLICT with nothing written', async () => {
    const x = await spec('t:050:03');
    const before = await snap(x.id);
    expect(await codeOf(retire({ ref: x.id, form: 'RESCIND', expectedRevision: (await rev(x.id)) + 5, reason: 'r', summary: 's' }))).toBe('NODE_WRITE_CONFLICT');
    expect(await snap(x.id)).toBe(before);
  });

  it('adjacent pairs of the refusal order, the higher item wins', async () => {
    const x = await spec('t:051:01');
    const outsiderInput = { ref: x.id, form: 'RESCIND', expectedRevision: await rev(x.id), reason: 'r', summary: 's' };
    await rescind(x.id);
    // 1 over 4: an unreadable spec that is also retired answers NODE_NOT_FOUND.
    expect(await codeOf(retire({ ...outsiderInput, expectedRevision: await rev(x.id) }, as(outsider.id)))).toBe('NODE_NOT_FOUND');
    // 3 over 4: a retired spec with an unreadable successor answers NODE_NOT_FOUND.
    expect(await codeOf(retire({ ref: x.id, form: 'SUPERSEDE', successorRef: generateId(), expectedRevision: await rev(x.id) }))).toBe('NODE_NOT_FOUND');
    // 4 over 5: a retired spec with a readable but retired successor answers NODE_WRITE_CONFLICT.
    const r = await spec('t:051:02'); await rescind(r.id);
    expect(await codeOf(supersede(x.id, r.id))).toBe('NODE_WRITE_CONFLICT');
  });

  it('cap order: not-found, then unusable, only then NodeAbstractTooLongError; nothing written', async () => {
    const x = await spec('t:052:01', { abstract: 'a'.repeat(1990) });
    const unusable = await spec('t:052:02'); await rescind(unusable.id);
    const usable = await spec('t:052:03');
    const before = await snap(x.id);
    expect(await codeOf(supersede(x.id, generateId()))).toBe('NODE_NOT_FOUND');
    expect(await codeOf(supersede(x.id, unusable.id))).toBe('NODE_WRITE_CONFLICT');
    expect(await codeOf(supersede(x.id, usable.id))).toBe('NodeAbstractTooLongError');
    expect(await snap(x.id)).toBe(before);
  });

  it('a retired spec has no refusal that carries an edge or pending-edge id, target, label or count', async () => {
    const x = await spec('t:053:01'); const t = await spec('t:053:02');
    const e = await link(x.id, t.id, 'superseded-by-secret');
    try { await rescind(x.id); throw new Error('expected a refusal'); } catch (err) {
      const text = JSON.stringify([(err as Error).message, (err as GraphQLError).extensions]);
      for (const leak of [e.id, e.loc, t.id, 'superseded-by-secret', 't:053:02']) expect(text).not.toContain(leak);
    }
  });
});

describe('#3429 one winner under real concurrency (acceptance 2)', () => {
  const settle = async (a: () => Promise<unknown>, b: () => Promise<unknown>) => {
    const [ra, rb] = await Promise.allSettled([a(), b()]);
    return [ra, rb].map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason instanceof GraphQLError ? String(r.reason.extensions.code) : String(r.reason)));
  };

  it('rescind vs rescind, rescind vs supersede, supersede vs supersede: exactly one winner, the other NODE_WRITE_CONFLICT', async () => {
    const pairs: Array<[string, (x: { id: string }, y: { id: string }, z: { id: string }, rv: number) => [() => Promise<unknown>, () => Promise<unknown>]]> = [
      ['rescind/rescind', (x, _y, _z, rv) => [() => rescind(x.id, { expectedRevision: rv }), () => rescind(x.id, { expectedRevision: rv })]],
      ['rescind/supersede', (x, y, _z, rv) => [() => rescind(x.id, { expectedRevision: rv }), () => supersede(x.id, y.id, { expectedRevision: rv })]],
      ['supersede/supersede', (x, y, z, rv) => [() => supersede(x.id, y.id, { expectedRevision: rv }), () => supersede(x.id, z.id, { expectedRevision: rv })]],
    ];
    for (const [i, [label, make]] of pairs.entries()) {
      for (const flip of [false, true]) {
        const x = await spec(`r:${i}:${flip ? 1 : 0}:x`); const y = await spec(`r:${i}:${flip ? 1 : 0}:y`); const z = await spec(`r:${i}:${flip ? 1 : 0}:z`);
        // ONE revision read, passed to both calls: the loser is a stale-read or already-retired conflict, never a fresh read.
        const rv = await rev(x.id);
        const [a, b] = make(x, y, z, rv);
        const run = flip ? [b, a] : [a, b];
        const outcome = await settle(run[0]!, run[1]!);
        expect(outcome.filter((o) => o === 'ok'), label).toHaveLength(1);
        expect(outcome.filter((o) => o === 'NODE_WRITE_CONFLICT'), label).toHaveLength(1);
      }
    }
  });

  it('cycle: X-by-Y against Y-by-X, in both orders, never commits a cycle', async () => {
    for (const flip of [false, true]) {
      const x = await spec(`c:${flip ? 1 : 0}:x`); const y = await spec(`c:${flip ? 1 : 0}:y`);
      const a = () => supersede(x.id, y.id); const b = () => supersede(y.id, x.id);
      const outcome = flip ? (await settle(b, a)).reverse() : await settle(a, b);
      expect(outcome.filter((o) => o === 'ok')).toHaveLength(1);
      expect(await db.edge.count({ where: { name: 'superseded-by', deletedAt: null, sourceId: { in: [x.id, y.id] } } })).toBe(1);
    }
  });

  it('the door takes the spec memory channel key: held by another transaction, the door waits and then proceeds', async () => {
    const x = await spec('k:x');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'channel-host:' + mem.id}))`;
      locked();
      await held;
    });
    await lockedP;
    const observed = observeTransactionBackend(db);
    const door = resolvers.Mutation.retireSpec(null, { input: { ref: x.id, form: 'RESCIND', expectedRevision: await rev(x.id), reason: 'r', summary: 's' } } as never, { ...as(admin.id), db: observed.db });
    const pid = await observed.backendFor(door);
    await waitForAdvisoryWaiter(db, { pid, key: { form: 'hashed-bigint', value: 'channel-host:' + mem.id } });
    release();
    await holder;
    await door;
    expect((await db.node.findUniqueOrThrow({ where: { id: x.id } })).tags).toContain('superseded');
  });
});

describe('#3429 writers outside the door (acceptance 3, writer first)', () => {
  it('a standalone createEdge of superseded-by*, committed first, makes the door refuse', async () => {
    const x = await spec('w:x'); const y = await spec('w:y');
    await resolvers.Mutation.createEdge(null, { sourceRef: x.id, targetRef: y.id, name: 'superseded-by-late' } as never, as(admin.id));
    expect(await codeOf(rescind(x.id))).toBe('NODE_WRITE_CONFLICT');
  });

  it('door first: the writer still succeeds (the stated limit) and the door was not refused', async () => {
    const x = await spec('w2:x'); const y = await spec('w2:y');
    await rescind(x.id);
    await resolvers.Mutation.createEdge(null, { sourceRef: x.id, targetRef: y.id, name: 'superseded-by' } as never, as(admin.id));
    expect(await db.edge.count({ where: { sourceId: x.id, name: 'superseded-by', deletedAt: null } })).toBe(1);
  });
});

describe('#3429 authoring (acceptance 4)', () => {
  it('a governed spec memory with no authoredWith is REFUSED, as updateSpecNode refuses it, and nothing is written', async () => {
    const x = await spec('g:x'); const y = await spec('g:y');
    // The rule: a node of role spec needs an author-task claim. Human portal sign-in is exempt, a plain caller is not.
    const task = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'author-task', name: 'Author task', isRunnable: true, content: 'how' } });
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: mem.id } });
    await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'spec', authorTaskId: task.id, authorTaskRequired: true } });
    // Snapshots FIRST, so a write updateSpecNode makes before it refuses would show.
    const before = await snap(x.id);
    const beforeY = await snap(y.id);
    const viaUpdate = await codeOf(resolvers.Mutation.updateSpecNode(null, { input: { id: x.id, abstract: 'zzz', expectedRevision: await rev(x.id) } } as never, as(admin.id)));
    expect(viaUpdate, 'the fixture must actually govern: updateSpecNode has to refuse').toBe('AUTHORING_ATTESTATION_MISSING');
    expect(await snap(x.id)).toBe(before);
    const viaDoor = await codeOf(retire({ ref: x.id, form: 'RESCIND', expectedRevision: await rev(x.id), reason: 'r', summary: 's' }));
    const viaSupersede = await codeOf(retire({ ref: x.id, form: 'SUPERSEDE', successorRef: y.id, expectedRevision: await rev(x.id) }));
    expect(viaDoor).toBe('AUTHORING_ATTESTATION_MISSING');
    expect(viaSupersede).toBe('AUTHORING_ATTESTATION_MISSING');
    expect(await snap(x.id)).toBe(before);
    expect(await snap(y.id)).toBe(beforeY);
  });
});

/** A transaction held open by test code, standing in for a writer that has taken its locks but not committed. */
async function holding(work: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ready!: () => void;
  const readyP = new Promise<void>((r) => { ready = r; });
  const tx = db.$transaction(async (t) => { await work(t); ready(); await gate; }, { timeout: 30_000 });
  await readyP;
  return { release, done: tx };
}
const stillPending = async (p: Promise<unknown>, ms = 400) => {
  let settled = false;
  void p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, ms));
  return !settled;
};

describe('#3429 the door waits for a writer that holds its locks (acceptance 3, two connections)', () => {
  it('a writer holding the spec row (createEdge in flight): the door waits, then sees the committed edge and refuses', async () => {
    const x = await spec('h:row:x'); const y = await spec('h:row:y');
    const writer = await holding(async (t) => {
      await t.$queryRaw`SELECT id FROM nodes WHERE id = ${x.id} FOR UPDATE`;
      await t.edge.create({ data: { id: generateId(), memoryId: mem.id, sourceId: x.id, targetId: y.id, loc: 'h-row', name: 'superseded-by-late' } });
    });
    const door = rescind(x.id);
    const outcome = codeOf(door);
    try { await waitForLockWaiters(db, 1); } finally { writer.release(); }
    await writer.done;
    expect(await outcome).toBe('NODE_WRITE_CONFLICT');
  });

  it('system-memory restore running: it holds the spec row and revives a superseded-by edge; the door waits then refuses', async () => {
    const x = await spec('h:restore:x'); const y = await spec('h:restore:y');
    const dead = await link(x.id, y.id, 'superseded-by', { deletedAt: new Date() });
    const restore = await holding(async (t) => {
      await t.$queryRaw`SELECT id FROM nodes WHERE id = ${x.id} FOR UPDATE`;
      await t.edge.update({ where: { id: dead.id }, data: { deletedAt: null } });
    });
    const door = rescind(x.id);
    const outcome = codeOf(door);
    try { await waitForLockWaiters(db, 1); } finally { restore.release(); }
    await restore.done;
    expect(await outcome).toBe('NODE_WRITE_CONFLICT');
  });

  it('a writer holding only the spec loc key (the exact key pendingEdgePromotion takes): the door waits for it', async () => {
    const x = await spec('h:loc:x');
    const promo = await holding(async (t) => { await acquireLockSet(t, [{ memoryId: mem.id, loc: 'h:loc:x' }]); });
    const door = rescind(x.id);
    try {
      await waitForLockWaiters(db, 1);
      // The loc key comes BEFORE the row lock (writeNodeCore's order): while the door waits on it, it holds no row lock yet.
      // (writeNodeCore re-takes the key later, so only this probe tells the early key from the late one.)
      await expect(db.$transaction(async (t) => { await t.$queryRaw`SELECT id FROM nodes WHERE id = ${x.id} FOR UPDATE NOWAIT`; })).resolves.toBeUndefined();
    } finally { promo.release(); await promo.done.catch(() => undefined); }
    expect((await door).node.tags).toContain('superseded');
  });

  it('the door in flight (spec row held): a standalone createEdge waits on the source FOR SHARE, then succeeds (the stated limit)', async () => {
    const x = await spec('h:edge:x'); const y = await spec('h:edge:y');
    // FOR NO KEY UPDATE does not conflict with the insert's own FK key-share, only with assertEdgeSourceWritersById's FOR SHARE.
    const holder = await holding(async (t) => { await t.$queryRaw`SELECT id FROM nodes WHERE id = ${x.id} FOR NO KEY UPDATE`; });
    const writer = resolvers.Mutation.createEdge(null, { sourceRef: x.id, targetRef: y.id, name: 'superseded-by-after' } as never, as(admin.id));
    try { await waitForLockWaiters(db, 1); } finally { holder.release(); }
    await holder.done;
    expect(await codeOf(writer)).toBe('NO_ERROR');
  });
});

describe('#3429 other writers, committed first, make the door refuse (acceptance 3)', () => {
  it('an updateEdge rename to superseded-by*', async () => {
    const x = await spec('w3:x'); const y = await spec('w3:y');
    const e = await link(x.id, y.id, 'related');
    await resolvers.Mutation.updateEdge(null, { edgeRef: e.id, name: 'superseded-by-renamed' } as never, as(admin.id));
    expect(await codeOf(rescind(x.id))).toBe('NODE_WRITE_CONFLICT');
  });

  it('an inline edges: write through updateSpecNode', async () => {
    const x = await spec('w4:x'); const y = await spec('w4:y');
    await resolvers.Mutation.updateSpecNode(null, { input: { id: x.id, edges: [{ sourceLoc: 'w4:x', targetLoc: 'w4:y', targetId: y.id, name: 'superseded-by' }] } } as never, as(admin.id));
    const linked = await db.edge.count({ where: { sourceId: x.id, name: 'superseded-by', deletedAt: null } });
    if (linked > 0) expect(await codeOf(rescind(x.id))).toBe('NODE_WRITE_CONFLICT');
    void y;
    expect(linked, 'the inline write must land for this pin to mean anything').toBeGreaterThan(0);
  });
});

describe('#3429 survivors of the first mutant sweep', () => {
  it('a non-deleted PENDING edge whose label only STARTS WITH superseded-by also counts (prefix, not exact)', async () => {
    const x = await spec('s:p:x');
    await db.pendingEdge.create({ data: { id: generateId(), sourceId: x.id, name: 'superseded-by-later', targetId: 'unresolved:q' } as never });
    expect(await codeOf(rescind(x.id))).toBe('NODE_WRITE_CONFLICT');
  });

  it('an unreadable successor answers NODE_NOT_FOUND, ahead of the other-memory conflict (item 3 over item 5)', async () => {
    const x = await spec('s:u:x');
    const foreignOrg = await db.organization.create({ data: { id: generateId(), name: 'Foreign', urn: 'foreign.example' } });
    const hidden = await db.memory.create({ data: { id: generateId(), organizationId: foreignOrg.id, urn: 'foreign.example:hidden', name: 'hidden', class: 'knowledge', visibility: 'ORGANIZATION' } });
    const hiddenNode = await db.node.create({ data: { id: generateId(), memoryId: hidden.id, loc: 'h:1', name: 'h', content: 'x' } });
    const before = await snap(x.id);
    expect(await codeOf(supersede(x.id, hiddenNode.id))).toBe('NODE_NOT_FOUND');
    expect(await snap(x.id)).toBe(before);
  });

  it('a stale expectedRevision answers NODE_WRITE_CONFLICT ahead of the cap (item 4 over item 6)', async () => {
    const x = await spec('s:r:x', { abstract: 'a'.repeat(1990) });
    const y = await spec('s:r:y');
    expect(await codeOf(retire({ ref: x.id, form: 'SUPERSEDE', successorRef: y.id, expectedRevision: (await rev(x.id)) + 3 }))).toBe('NODE_WRITE_CONFLICT');
  });
});

describe('#3429 an impersonated session is read-only (#876, the #4669 CI failure)', () => {
  const impersonated = (): Context => ({
    ...as(admin.id),
    impersonation: { sessionId: 's', actorUserId: admin.id, orgId: 'o', expiresAt: new Date('2099-01-01') },
  } as Context);

  it('the door refuses with the plugin\'s IMPERSONATION_READ_ONLY and writes nothing, even when called past the plugin', async () => {
    const x = await spec('i:x'); const y = await spec('i:y');
    const before = await snap(x.id);
    expect(await codeOf(retire({ ref: x.id, form: 'RESCIND', expectedRevision: await rev(x.id), reason: 'r', summary: 's' }, impersonated()))).toBe('IMPERSONATION_READ_ONLY');
    expect(await codeOf(retire({ ref: x.id, form: 'SUPERSEDE', successorRef: y.id, expectedRevision: await rev(x.id) }, impersonated()))).toBe('IMPERSONATION_READ_ONLY');
    expect(await snap(x.id)).toBe(before);
  });

  it('the refusal comes before input-shape and read refusals, so it reveals nothing about any node', async () => {
    expect(await codeOf(retire({ ref: generateId(), form: 'RESCIND', expectedRevision: 1 }, impersonated()))).toBe('IMPERSONATION_READ_ONLY');
  });
});

describe('#3429 the over-cap refusal is typed on the wire, with the helpful text (#4669 QA P2)', () => {
  it('a composed abstract over the cap is a GraphQLError with the typed envelope, as updateNode answers it', async () => {
    const x = await spec('cap:x');
    const before = await snap(x.id);
    let caught: unknown;
    try {
      await retire({ ref: x.id, form: 'RESCIND', expectedRevision: await rev(x.id), reason: 'r', summary: 's'.repeat(1990) });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GraphQLError);
    const err = caught as GraphQLError;
    expect(err.extensions).toMatchObject({ code: 'NodeAbstractTooLongError', max: 2000 });
    expect(typeof err.extensions.length).toBe('number');
    expect(err.message).toContain('Abstract exceeds 2000-character cap');
    expect(await snap(x.id)).toBe(before);
  });
});

describe('#3429 rollback after the node write (blind P3)', () => {
  it('an edge insert that fails AFTER the spec write leaves the node, its revisions and its edges exactly as before', async () => {
    const x = await spec('rb:x'); const y = await spec('rb:y');
    const before = await snap(x.id);
    try {
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_retire_edge_3429() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          -- Fails only when the retirement UPDATE of the SOURCE is already visible in this transaction.
          IF EXISTS (SELECT 1 FROM nodes WHERE id = NEW.source_id AND tags::text LIKE '%superseded%') THEN
            RAISE EXCEPTION 'forced failure after the node write';
          END IF;
          RAISE EXCEPTION 'trigger fired BEFORE the node write';
        END $f$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER fail_retire_edge_3429 BEFORE INSERT ON edges FOR EACH ROW WHEN (NEW.name = 'superseded-by') EXECUTE FUNCTION fail_retire_edge_3429()`);
      let message = '';
      try { await supersede(x.id, y.id); } catch (e) { message = String((e as Error).message); }
      expect(message).toContain('forced failure after the node write');
      expect(message).not.toContain('BEFORE the node write');
      expect(await snap(x.id)).toBe(before);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_retire_edge_3429 ON edges');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_retire_edge_3429()');
    }
    expect((await supersede(x.id, y.id)).successorEdge).not.toBeNull();
  });
});

describe('#3429 the banner cannot be changed by the text put in it (blind P2)', () => {
  it('Markdown and raw HTML in the reason and the successor name are neutralised; the fixed warning stays', async () => {
    const x = await spec('md:x');
    const y = await spec('md:y', { name: 'Hostile <b>name</b> *x*' });
    const out = await supersede(x.id, y.id, { reason: 'because <!-- hide *this* [x](http://e) & more' });
    const banner = (out.node.content ?? '').split('\n').find((l) => l.startsWith('> '))!;
    expect(banner).not.toContain('<!--');
    expect(banner).not.toContain('<b>');
    expect(banner).toContain('&lt;!--');
    expect(banner).toContain('\\*this\\*');
    expect(banner).toContain('\\[x\\]');
    expect(banner).toContain('&amp; more');
    expect(banner).toContain('**Do not apply.** Retained as a tombstone; the citation is never renumbered.');
  });

  it('a stored successor LOC with Markdown or HTML characters is escaped too (blind P2: location interpolated verbatim)', async () => {
    const x = await spec('md:loc');
    // Stored by an older writer; the loc validator would refuse it today (the logs show `tasks:unsafe-->source`).
    const hostile = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'md:h<!--x*y_z', name: 'Plain name', role: 'spec', content: 'c', abstract: 'a' } });
    const out = await supersede(x.id, hostile.id);
    const banner = (out.node.content ?? '').split('\n').find((l) => l.startsWith('> '))!;
    expect(banner).not.toContain('<!--');
    expect(banner).toContain('md:h&lt;!--x\\*y\\_z');
    expect(banner).toContain('**Do not apply.** Retained as a tombstone; the citation is never renumbered.');
  });

  it('ordinary text is written as is', async () => {
    const x = await spec('md:z');
    const out = await rescind(x.id, { reason: 'Replaced by policy 7, see the memo.' });
    expect(out.node.content).toContain('Replaced by policy 7, see the memo.), no successor.');
  });
});

describe('#3429 no second connection is requested while the transaction holds its locks (blind P2)', () => {
  it('the door reads the encryption metadata and everything else through the transaction client', async () => {
    const x = await spec('pool:x');
    let inTx = false;
    const outer: string[] = [];
    const probed = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === '$transaction') {
          return (fn: unknown, opts?: unknown) => typeof fn === 'function'
            ? target.$transaction(async (tx) => { inTx = true; try { return await (fn as (t: unknown) => Promise<unknown>)(tx); } finally { inTx = false; } }, opts as never)
            : (target.$transaction as (...a: unknown[]) => unknown)(fn, opts);
        }
        if (inTx && typeof prop === 'string' && !prop.startsWith('$')) outer.push(prop);
        return Reflect.get(target, prop, receiver);
      },
    });
    await retire({ ref: x.id, form: 'RESCIND', expectedRevision: await rev(x.id), reason: 'r', summary: 's' }, { ...as(admin.id), db: probed } as Context);
    expect(outer, 'a model read on the pooled client while the transaction held its connection').toEqual([]);
  });
});

describe('#3429 access lost while the door waits for its locks (blind, unresolved item 1)', () => {
  it('the door judges access again on its transaction: a caller who lost it gets NODE_NOT_FOUND, not a state refusal', async () => {
    const x = await spec('rv:x');
    await rescind(x.id);                       // so a state refusal (NODE_WRITE_CONFLICT) is what a caller WITH access would get
    const holder = await holding(async (t) => { await t.$queryRaw`SELECT id FROM nodes WHERE id = ${x.id} FOR UPDATE`; });
    const door = retire({ ref: x.id, form: 'RESCIND', expectedRevision: await rev(x.id), reason: 'r', summary: 's' });
    const outcome = codeOf(door);
    try {
      await waitForLockWaiters(db, 1);
      await db.orgMember.deleteMany({ where: { userId: admin.id } });
    } finally { holder.release(); }
    await holder.done;
    expect(await outcome).toBe('NODE_NOT_FOUND');
  });
});
