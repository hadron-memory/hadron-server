/**
 * #4929 (follow-up to #860 / #4910) — the pins the review left for later, and two small hardenings of
 * `hadron_update_node` `addEdges` / `removeEdges`:
 * - lock pins: the memory-level edge lock for `addEdges` and the `edges` replace, and the install authority the removal
 *   takes first (each pin holds the lock from a second connection and shows the call waits);
 * - the comment-anchor removal refusal, a boot-prompt source (remove and add), a soft-deleted occupant of an edge loc, and
 *   a `hadron_delete_edge` regression after the `deleteEdgeInDoorTx` extraction;
 * - item 4: an empty `addEdges` / `removeEdges` is absent (no write, snapshot, event or receipt line), `edges: []` is not;
 * - item 5: at most 200 items in each of the two lists, refused whole before any work.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { publishNodeWritten } from '../lib/events/nodeWritten.js';
import { lockAuthorityAnchors } from '../lib/auth/authorityAnchors.js';
import { UPDATE_NODE_EDGE_LIST_MAX } from './toolShapes.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock('../lib/events/nodeWritten.js', async (orig) => ({
  ...(await orig<typeof import('../lib/events/nodeWritten.js')>()),
  publishNodeWritten: vi.fn().mockResolvedValue(undefined),
}));

type N = { id: string; loc: string };
let adminId: string;
let orgId: string;
let memId: string;
let memUrn: string;
let source: N;
let t1: N;
let t2: N;
let t4: N;
let e1: N;
let e2: N;

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: adminId } as Context);
const adminAuth = (): AuthContext => ({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
const call = (tool: string, args: Record<string, unknown>) => createTestableMcpServer(adminAuth()).callToolText(tool, args);
const urnIn = (urn: string, loc: string) => `${urn.replace(':', '::')}::${loc}`;
const nodeUrnOf = (loc: string) => urnIn(memUrn, loc);
const node = (loc: string, name: string, extra: Record<string, unknown> = {}, memoryId = memId) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name, ownerRepo: 'test/repo', tags: [], ...extra } });
const edgeFrom = async (src: N, target: N, name: string, extra: Record<string, unknown> = {}, memoryId = memId) => {
  const loc = `${src.loc}:${name}:${target.id.slice(0, 6)}`;
  const row = await db.edge.create({ data: { id: generateId(), memoryId, sourceId: src.id, targetId: target.id, name, loc, ...extra } });
  return { id: row.id, loc };
};
const edgesOf = (src = source) => db.edge.findMany({ where: { sourceId: src.id, deletedAt: null }, orderBy: { name: 'asc' } });
const namesOf = async (src = source) => (await edgesOf(src)).map((e) => e.name);
const revisions = (src = source) => db.nodeRevision.count({ where: { nodeId: src.id } });

/** Hold `lock` from a second connection, start `run`, show it waits, release, and return what it answered. */
async function waitsBehind(lock: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>, run: () => Promise<string>): Promise<string> {
  let signalHeld!: () => void;
  let signalRelease!: () => void;
  const held = new Promise<void>((r) => { signalHeld = r; });
  const release = new Promise<void>((r) => { signalRelease = r; });
  const holder = db.$transaction(async (tx) => { await lock(tx); signalHeld(); await release; }, { timeout: 30_000 });
  await held;
  let done = false;
  let out: string;
  try {
    const running = run().then((o) => { done = true; return o; });
    await new Promise((r) => setTimeout(r, 700));
    expect(done ? await running : 'waiting', 'the call must wait behind the held lock').toBe('waiting');
    signalRelease();
    out = await running;
  } finally {
    signalRelease();
    await holder;
  }
  return out;
}

beforeEach(async () => {
  vi.mocked(publishNodeWritten).mockClear();
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'e4929-org', urn: 'e4929-org' } });
  orgId = org.id;
  const a = await db.user.create({ data: { githubId: 49291, githubUsername: 'e4929-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: a.id, role: 'ADMIN' } });
  adminId = a.id;
  const mem = await resolvers.Mutation.createMemory({}, { orgRef: org.id, name: 'edges4929' }, admin());
  memId = mem.id;
  memUrn = mem.urn;
  source = await node('review:item', 'Item');
  t1 = await node('review', 'Review');
  t2 = await node('docs:guide', 'Guide');
  t4 = await node('rel:fresh', 'Fresh');
  e1 = await edgeFrom(source, t1, 'applies-when');
  e2 = await edgeFrom(source, t2, 'documented-by');
});

describe('item 1: the locks the edge writes take (a second connection holds each; the call waits)', () => {
  const channelHost = (id: string) => (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'channel-host:' + id}))`.then(() => undefined);

  it('addEdges takes the memory-level edge lock (lockOutgoingEdgeMemories): it waits behind a holder of the source memory\'s lock', async () => {
    const out = await waitsBehind(channelHost(memId), () => call('hadron_update_node', { urn: nodeUrnOf(source.loc), addEdges: [{ targetUrn: t4.id, name: 'seen-with' }] }));
    expect(out).toMatch(/1 added/);
    expect(await namesOf()).toEqual(['applies-when', 'documented-by', 'seen-with']);
  });

  it('the pre-existing `edges` replace takes the same lock', async () => {
    const out = await waitsBehind(channelHost(memId), () => call('hadron_update_node', { urn: nodeUrnOf(source.loc), edges: [{ targetUrn: t1.id, name: 'applies-when' }] }));
    expect(out).toContain('Node updated');
    expect(await namesOf()).toEqual(['applies-when']);
  });

  it('an INSTALL memory is not writable through this tool at all (canWriteToMemory refuses it), so removeEdges removes nothing there and takes no install lock to pin', async () => {
    // lockInstallAuthoritiesFirst's install arm is defensive on this door: an install memory is written through the GraphQL
    // `install: { app, agent }` door, and hadron_update_node is refused before any transaction. Pinned so a later opening of
    // that door has to revisit the lock.
    const app = await db.app.create({ data: { organizationId: orgId, name: 'App 4929', urn: 'e4929-org:app' } });
    const target = await db.agent.create({ data: { id: generateId(), organizationId: orgId, urn: 'e4929-org:installed', name: 'Installed 4929' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: target.id } });
    const install = await db.memory.create({ data: { organizationId: orgId, appId: app.id, installOfAgentId: target.id, isInstallMemory: true, class: 'system', name: 'Install 4929', urn: 'e4929-org:install' } });
    const s = await node('inst:src', 'Src', {}, install.id);
    const t = await node('inst:tgt', 'Tgt', {}, install.id);
    const e = await edgeFrom(s, t, 'rel', {}, install.id);
    const out = await call('hadron_update_node', { urn: urnIn(install.urn, s.loc), removeEdges: [e.id] });
    expect(out).toMatch(/^Write access denied/);
    expect(await db.edge.count({ where: { id: e.id } })).toBe(1);
  });

  it('removeEdges on an Agent\'s own system memory waits behind an exclusive holder of the Agent\'s anchor', async () => {
    const sys = await db.memory.create({ data: { organizationId: orgId, class: 'system', name: 'Agent system 4929', urn: 'e4929-org:agent-sys' } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, urn: 'e4929-org:agent', name: 'Agent 4929', systemMemoryId: sys.id } });
    const s = await node('sys:src', 'Src', {}, sys.id);
    const t = await node('sys:tgt', 'Tgt', {}, sys.id);
    const e = await edgeFrom(s, t, 'rel', {}, sys.id);
    const out = await waitsBehind(
      (tx) => lockAuthorityAnchors(tx as never, [{ kind: 'agent', id: agent.id }], 'exclusive'),
      () => call('hadron_update_node', { urn: urnIn(sys.urn, s.loc), removeEdges: [e.id] }),
    );
    expect(out).toMatch(/1 removed/);
    expect(await db.edge.count({ where: { id: e.id } })).toBe(0);
  });
});

describe('item 1 (order): removeEdges takes the Agent authority BEFORE the memory row, as the revokers do', () => {
  it('a writer that locks the Agent anchor then the memory row (the canonical order) never deadlocks with removeEdges', async () => {
    const sys = await db.memory.create({ data: { organizationId: orgId, class: 'system', name: 'Agent system 4929b', urn: 'e4929-org:agent-sys-b' } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, urn: 'e4929-org:agent-b', name: 'Agent 4929b', systemMemoryId: sys.id } });
    const s = await node('sys:src', 'Src', {}, sys.id);
    const t = await node('sys:tgt', 'Tgt', {}, sys.id);
    const e = await edgeFrom(s, t, 'rel', {}, sys.id);
    let signalHeld!: () => void;
    const held = new Promise<void>((r) => { signalHeld = r; });
    const holder = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx as never, [{ kind: 'agent', id: agent.id }], 'exclusive');
      signalHeld();
      // Long enough for removeEdges to have taken whatever it takes before the anchor: with the authority first it holds nothing
      // yet; with the memory row first it holds a share lock this FOR UPDATE then waits behind, and the two deadlock (40P01).
      await new Promise((r) => setTimeout(r, 900));
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${sys.id} FOR UPDATE`;
    }, { timeout: 30_000 });
    await held;
    const removing = call('hadron_update_node', { urn: urnIn(sys.urn, s.loc), removeEdges: [e.id] });
    const [removed, held2] = await Promise.allSettled([removing, holder]);
    expect(held2.status, held2.status === 'rejected' ? String(held2.reason) : '').toBe('fulfilled');
    expect(removed.status, removed.status === 'rejected' ? String(removed.reason) : '').toBe('fulfilled');
    expect(removed.status === 'fulfilled' ? removed.value : '').toMatch(/1 removed/);
    expect(await db.edge.count({ where: { id: e.id } })).toBe(0);
  }, 40_000);
});

describe('item 2: a comment anchor is refused as hadron_delete_edge refuses it', () => {
  it('removeEdges of a COMMENT_ANCHOR edge refuses the whole call with deleteEdge\'s text and removes nothing', async () => {
    const anchor = await edgeFrom(source, t4, 'comment-anchor', { governedKind: 'COMMENT_ANCHOR', anchorRevNo: 1, anchorApprovalHash: 'a'.repeat(64) });
    try {
      const viaDelete = await call('hadron_delete_edge', { edgeRef: anchor.id });
      expect(viaDelete).toMatch(/comment/i);
      const out = await call('hadron_update_node', { urn: nodeUrnOf(source.loc), removeEdges: [e1.id, anchor.id] });
      expect(out).toBe(viaDelete);
      expect(await db.edge.count({ where: { id: { in: [e1.id, e2.id, anchor.id] } } })).toBe(3);
      expect(vi.mocked(publishNodeWritten)).not.toHaveBeenCalled();
    } finally {
      // The database lets a comment edge go only with its comment, so ungovern the row before the fixture is cleaned up.
      await db.$executeRaw`ALTER TABLE edges DISABLE TRIGGER USER`;
      await db.edge.deleteMany({ where: { id: anchor.id } });
      await db.$executeRaw`ALTER TABLE edges ENABLE TRIGGER USER`;
    }
  });
});

describe('item 3: the missing cases', () => {
  it('a compiled boot-prompt source: removeEdges and addEdges are refused, and nothing is written', async () => {
    const boot = await node('boot:compiled', 'Compiled', { nodeType: 'compiled-boot-prompt', role: 'boot-prompt' });
    const be = await edgeFrom(boot, t1, 'rel');
    const viaDelete = await call('hadron_delete_edge', { edgeRef: be.id });
    expect(viaDelete).toMatch(/boot/i);
    // The update door's own boot-prompt guard judges the compiled source first and throws its typed refusal (the SDK's
    // handling of a typed refusal), for both verbs; neither reaches the edge door.
    await expect(call('hadron_update_node', { urn: nodeUrnOf(boot.loc), removeEdges: [be.id] })).rejects.toThrow(/BOOT_PROMPT_COMPILED_WRITE/);
    await expect(call('hadron_update_node', { urn: nodeUrnOf(boot.loc), addEdges: [{ targetUrn: t4.id, name: 'x' }] })).rejects.toThrow(/BOOT_PROMPT_COMPILED_WRITE/);
    expect(await namesOf(boot)).toEqual(['rel']);
  });

  it('empty addEdges / removeEdges are absent: no write, no snapshot, no event, no receipt line', async () => {
    const before = { revs: await revisions(), edges: await namesOf(), row: await db.node.findUniqueOrThrow({ where: { id: source.id } }) };
    for (const args of [{ addEdges: [] }, { removeEdges: [] }, { addEdges: [], removeEdges: [] }]) {
      const out = await call('hadron_update_node', { urn: nodeUrnOf(source.loc), ...args });
      expect(out).not.toMatch(/edges:/);
    }
    expect(await revisions()).toBe(before.revs);
    expect(await namesOf()).toEqual(before.edges);
    expect((await db.node.findUniqueOrThrow({ where: { id: source.id } })).updatedAt).toEqual(before.row.updatedAt);
    expect(vi.mocked(publishNodeWritten)).not.toHaveBeenCalled();
  });

  it('an empty list beside another change is that change alone: one event, no receipt line, the edges untouched', async () => {
    const out = await call('hadron_update_node', { urn: nodeUrnOf(source.loc), description: 'only this', addEdges: [], removeEdges: [] });
    expect(out).toContain('Node updated');
    expect(out).not.toMatch(/edges:/);
    expect((await db.node.findUniqueOrThrow({ where: { id: source.id } })).description).toBe('only this');
    expect(await namesOf()).toEqual(['applies-when', 'documented-by']);
    expect(vi.mocked(publishNodeWritten)).toHaveBeenCalledTimes(1);
  });

  it('an empty addEdges beside `edges` is absent, so it is not the "cannot be combined" refusal; `edges: []` still clears the outgoing edges', async () => {
    const withEmpty = await call('hadron_update_node', { urn: nodeUrnOf(source.loc), edges: [{ targetUrn: t1.id, name: 'applies-when' }], addEdges: [] });
    expect(withEmpty).not.toMatch(/cannot be combined/);
    expect(await namesOf()).toEqual(['applies-when']);
    const cleared = await call('hadron_update_node', { urn: nodeUrnOf(source.loc), edges: [] });
    expect(cleared).toContain('Node updated');
    expect(await namesOf()).toEqual([]);
  });

  it('a soft-deleted edge still occupies its loc (the unique index spans tombstones): addEdges at that loc is an edge_loc_conflict and writes nothing', async () => {
    await db.edge.update({ where: { id: e1.id }, data: { deletedAt: new Date() } });
    const out = await call('hadron_update_node', { urn: nodeUrnOf(source.loc), addEdges: [{ targetUrn: t4.id, name: 'fresh-one' }, { targetUrn: t4.id, name: 'fresh', loc: e1.loc }] });
    expect(out).toContain('edge_loc_conflict');
    expect(await namesOf()).toEqual(['documented-by']);
    expect((await db.edge.findUniqueOrThrow({ where: { id: e1.id } })).deletedAt).not.toBeNull();
  });

  it('hadron_delete_edge still deletes an edge, answers an unknown one as not found, and refuses a derived include edge', async () => {
    expect(await call('hadron_delete_edge', { edgeRef: e1.id })).toMatch(/deleted|removed/i);
    expect(await db.edge.count({ where: { id: e1.id } })).toBe(0);
    const unknown = generateId();
    expect(await call('hadron_delete_edge', { edgeRef: unknown })).toBe(`Edge not found: "${unknown}"`);
    const inc = await edgeFrom(source, t4, 'include', { governedKind: 'INCLUDE' });
    expect(await call('hadron_delete_edge', { edgeRef: inc.id })).toMatch(/include/i);
    expect(await db.edge.count({ where: { id: inc.id } })).toBe(1);
    expect(await db.edge.count({ where: { id: e2.id } })).toBe(1);
  });
});

describe('item 5: at most 200 items in each of addEdges and removeEdges', () => {
  const adds = (n: number, tag = 'a') => Array.from({ length: n }, (_, i) => ({ targetUrn: t4.id, name: `${tag}-${i}` }));

  it('a call of exactly 200 addEdges passes', async () => {
    expect(UPDATE_NODE_EDGE_LIST_MAX).toBe(200);
    const out = await call('hadron_update_node', { urn: nodeUrnOf(source.loc), addEdges: adds(200) });
    expect(out).toMatch(/edges: 200 added/);
    expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(202);
  }, 60_000);

  // callTool skips the SDK's argument parsing (see toolParamSchema), so the refusal is pinned on the registered schema the SDK
  // applies before the handler runs: a 201-item list never reaches it, so nothing is resolved or written.
  const param = (name: 'addEdges' | 'removeEdges') => createTestableMcpServer(adminAuth()).toolParamSchema('hadron_update_node', name);

  it('201 addEdges is refused by the tool\'s argument validation, naming the argument and the limit; 200 is accepted', () => {
    expect(() => param('addEdges').parse(adds(201))).toThrow(/addEdges takes at most 200 items/);
    expect(() => param('addEdges').parse(adds(200))).not.toThrow();
  });

  it('201 removeEdges is refused by the tool\'s argument validation, naming the argument and the limit; 200 is accepted', () => {
    const refs = (n: number) => Array.from({ length: n }, () => generateId());
    expect(() => param('removeEdges').parse(refs(201))).toThrow(/removeEdges takes at most 200 items/);
    expect(() => param('removeEdges').parse(refs(200))).not.toThrow();
  });

  it('200 removeEdges pass the cap (the refs are judged one by one after it)', async () => {
    const out = await call('hadron_update_node', { urn: nodeUrnOf(source.loc), removeEdges: [e1.id, ...Array.from({ length: 199 }, () => generateId())] });
    expect(out).toMatch(/^Edge not found/);
    expect(await namesOf()).toEqual(['applies-when', 'documented-by']);
  });
});
