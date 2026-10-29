/**
 * Spec cor:api:040 — batch node read (hadron_get_nodes). Behavioral coverage for
 * the MCP surface, driving the production closure via createTestableMcpServer.
 *
 * What this file pins:
 *   - Explicit-set form: full per-node projection (content + edges) for many
 *     refs in one call, returned in INPUT order (cor:api:040:01).
 *   - A ref is a PK or a fully-qualified node URN (cor:api:140, #822): both read
 *     in the SAME call and produce the same projection, dedup happens on the
 *     RESOLVED node so one node named two ways renders (and bills) once, and a
 *     ref whose SHAPE is wrong is a loud error rather than an Unavailable entry.
 *   - Prefix-subtree form: every readable node under a loc-prefix, in LOC order.
 *   - Per-node projection parity with hadron_get_node — the batch block for a node
 *     is byte-identical to a single hadron_get_node of that node (the shared
 *     renderNodeReadProjection contract).
 *   - contentScope: 'abstract' returns abstracts, omits bodies.
 *   - Per-node authorization + partial success (cor:api:040:03): a mix of
 *     readable / denied / not-found returns the readable subset and lists the
 *     rest as Unavailable — denied and not-found indistinguishable, no content
 *     leak, the batch never fails wholesale.
 *   - Hard caps (cor:api:040:02): over the node-count cap is a LOUD error;
 *     over the response-size cap returns a partial result flagged `truncated`
 *     with the omitted refs — never a silent short read.
 *   - Form validation: exactly one of (refs) XOR (memoryUrn + locPrefix).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { BATCH_READ_MAX_NODES } from '../lib/batchRead.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

interface Fixture {
  admin: { id: string };
  user2: { id: string };
  memory: { id: string; urn: string };
  pmem: { id: string; urn: string };
}

let fx: Fixture;

function adminAuth(): AuthContext {
  return { userId: fx.admin.id, roles: ['ADMIN'], clientId: `user:${fx.admin.id}` };
}
function user2Auth(): AuthContext {
  return { userId: fx.user2.id, roles: ['READER'], clientId: `user:${fx.user2.id}` };
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'batch-org', urn: 'batch-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 9801, githubUsername: 'batch-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  const user2 = await db.user.create({
    data: { githubId: 9802, githubUsername: 'batch-user2', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: user2.id, role: 'ADMIN' },
  });

  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'batchmem' },
    { db, roles: ['ADMIN'], userId: admin.id } as Context,
  );
  // A personal memory owned by user2 — ADMIN does NOT bypass personal
  // ownership, so it is the clean "denied" case for the partial-success test.
  const pmem = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'pmem', memoryClass: 'personal' },
    { db, roles: ['READER'], userId: user2.id } as Context,
  );

  fx = {
    admin: { id: admin.id },
    user2: { id: user2.id },
    memory,
    pmem,
  };
});


import { createHash } from 'node:crypto';
import * as contentHash from '../lib/contentHash.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
afterEach(() => sessionKeyCache.clear());

async function denseFixture() {
  const nodes: Array<{ id: string; loc: string }> = [];
  for (let i = 0; i < 12; i++) nodes.push(await db.node.create({ data: {
    id: `01a188c${i.toString(16).padStart(25, '0')}`,
    memoryId: fx.memory.id, loc: `dense:${i.toString().padStart(2, '0')}`,
    name: `Synthetic ${i}`, abstract: 'small abstract', content: 'X'.repeat(96 * 1024),
  } }));
  await db.edge.createMany({ data: nodes.flatMap((a, i) => nodes.map((b, j) => ({
    id: generateId(), memoryId: fx.memory.id, sourceId: a.id, targetId: b.id,
    loc: `dense-edge:${i}:${j}`, name: 'synthetic-link',
  }))) });
  return nodes;
}

async function measuredRead(scope: 'abstract' | 'all', refs: string[], form: 'pk' | 'urn' | 'prefix', raw = true) {
  const loads: Array<{phase: string; rows: number; bytes: number; rootBodyBytes: number; endpointBodyBytes: number}> = [];
  let pendingBodies = 0, maxPendingBodies = 0;
  const staleCheck = contentHash.isAbstractUnverified;
  const renderSpy = vi.spyOn(contentHash, 'isAbstractUnverified').mockImplementation((node) => {
    pendingBodies = 0;
    return staleCheck(node);
  });
  function record(value: any, phase: string) {
    const rows = Array.isArray(value) ? value : value ? [value] : [];
    const projected = rows.filter((n: any) => Array.isArray(n.outgoingEdges) && Array.isArray(n.incomingEdges));
    if (phase === 'current') {
      pendingBodies += projected.filter((n: any) => !!n.content).length;
      maxPendingBodies = Math.max(maxPendingBodies, pendingBodies);
    }
    if (projected.length) loads.push({ phase, rows: projected.length,
      bytes: Buffer.byteLength(JSON.stringify(projected)),
      rootBodyBytes: projected.reduce((n: number, r: any) => n + Buffer.byteLength(r.content ?? ''), 0),
      endpointBodyBytes: projected.reduce((n: number, r: any) => n + [...r.outgoingEdges.map((e: any) => e.target), ...r.incomingEdges.map((e: any) => e.source)].reduce((m: number, e: any) => m + Buffer.byteLength(e.content ?? ''), 0), 0),
    });
    return value;
  }
  const findMany = db.node.findMany.bind(db.node);
  const many = vi.spyOn(db.node, 'findMany').mockImplementation((async (args: any) => record(await findMany(args), 'initial')) as typeof db.node.findMany);
  const transaction = db.$transaction.bind(db);
  const txSpy = vi.spyOn(db, '$transaction').mockImplementation((async (fn: any, options: any) => {
    if (typeof fn !== 'function') return (transaction as any)(fn, options);
    return (transaction as any)(async (tx: any) => {
      const original = tx.node.findFirst.bind(tx.node);
      const first = vi.spyOn(tx.node, 'findFirst').mockImplementation(async (args: any) => record(await original(args), 'current'));
      try { return await fn(tx); } finally { first.mockRestore(); }
    }, options);
  }) as typeof db.$transaction);
  try {
    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_get_nodes', { ...(form === 'prefix' ? { memoryUrn: 'hrn:mem:batch-org:batchmem', locPrefix: 'dense:' } : { refs: form === 'urn' ? refs.map((_, i) => `hrn:node:batch-org:batchmem:dense:${i.toString().padStart(2, '0')}`) : refs }), contentScope: scope, raw });
    return { text, hash: createHash('sha256').update(text).digest('hex'), loads, maxPendingBodies };
  } finally { many.mockRestore(); txSpy.mockRestore(); renderSpy.mockRestore(); }
}

it.each([['abstract', 'pk'], ['abstract', 'urn'], ['abstract', 'prefix'], ['all', 'pk'], ['all', 'urn'], ['all', 'prefix']] as const)('#2774 bounds endpoint/root payloads with byte-identical %s/%s output', async (scope, form) => {
  const nodes = await denseFixture();
  const result = await measuredRead(scope, nodes.map(n => n.id), form);
  console.log(JSON.stringify({ probe: 'mcpBatch2774', scope, ...result, text: undefined }));
  expect(result.text).not.toMatch(/^Error/);
  expect(result.loads.some(l => l.phase === 'initial' && l.rows === 12)).toBe(true);
  expect(result.loads.filter(l => l.phase === 'current').every(l => l.rows === 1)).toBe(true);
  expect.soft(result.maxPendingBodies).toBeLessThanOrEqual(1);
  // The main-source output hashes are captured on these same deterministic rows before the fix.
  const baseline = { abstract: '8a33ebc7bc8d148e45a9b7ed590d8cd79a79a2e4f213ecae21fb9d5598c8d952', all: 'ee49b72e6151cf6c1b2717d0ca18d3b6f5b5c1af60a19c7ae15bbe8b60e6c94e' };
  expect(result.hash).toBe(baseline[scope]);
  expect.soft(result.loads.reduce((n, l) => n + l.endpointBodyBytes, 0)).toBe(0);
  if (scope === 'abstract') {
    expect.soft(result.loads.filter(l => l.phase === 'initial').reduce((n, l) => n + l.rootBodyBytes, 0)).toBe(0);
    expect.soft(result.loads.filter(l => l.phase === 'initial').reduce((n, l) => n + l.bytes, 0)).toBeLessThanOrEqual(1_310_720);
    expect(result.text).toContain('returned 12 node(s)');
  } else expect(result.text).toContain('truncated: response-size cap reached');
}, 60_000);

it.each(['abstract', 'all'] as const)('#2774 preserves PK/URN/prefix and single/batch %s projections', async (contentScope) => {
  const nodes = await denseFixture();
  const server = createTestableMcpServer(adminAuth());
  const options = { contentScope, raw: true };
  const byPk = await server.callToolText('hadron_get_nodes', { refs: nodes.map(n => n.id), ...options });
  const byUrn = await server.callToolText('hadron_get_nodes', { refs: nodes.map(n => `hrn:node:batch-org:batchmem:${n.loc}`), ...options });
  const byPrefix = await server.callToolText('hadron_get_nodes', { memoryUrn: 'hrn:mem:batch-org:batchmem', locPrefix: 'dense:', ...options });
  expect(byUrn).toBe(byPk);
  expect(byPrefix).toBe(byPk);
  const single = await server.callToolText('hadron_get_node', { urn: `hrn:node:batch-org:batchmem:${nodes[0].loc}`, ...options });
  expect(byPk).toContain(single);
});


it.each([
  { scope: 'abstract', raw: true, encrypted: false },
  { scope: 'all', raw: false, encrypted: false },
  { scope: 'abstract', raw: true, encrypted: true },
  { scope: 'all', raw: false, encrypted: true },
] as const)('#2774 preserves stale/decrypt/expansion parity: %j', async ({ scope, raw, encrypted }) => {
  const home = await db.memory.findUniqueOrThrow({ where: { id: fx.memory.id } });
  const memory = await db.memory.create({ data: { organizationId: home.organizationId, class: 'private', userId: fx.user2.id, name: 'parity', urn: 'batch-org:parity' } });
  const content = 'before {{> leaf}} after {{word}}';
  await db.node.create({ data: { memoryId: memory.id, loc: 'leaf', name: 'Leaf', content: 'EXPANDED' } });
  const root = await db.node.create({ data: { memoryId: memory.id, loc: 'root', name: 'Root', content, abstract: 'A short summary', abstractOriginHash: contentHash.computeContentHash('old content'), data: { word: 'world' } } });
  const server = createTestableMcpServer(user2Auth(), { sessionId: 'batch2774-parity' });
  const options = { contentScope: scope, raw };
  const single = () => server.callToolText('hadron_get_node', { urn: 'hrn:node:batch-org:parity:root', ...options });
  const batch = () => server.callToolText('hadron_get_nodes', { refs: [root.id], ...options });
  if (encrypted) {
    await resolvers.Mutation.encryptMemory({}, { memoryId: memory.id, passphrase: 'synthetic2774' }, { db, roles: ['ADMIN'], userId: fx.user2.id } as Context);
    const locked = await single();
    expect(await batch()).toContain(locked);
    expect(locked).toContain('Locked:');
    expect(locked).not.toContain('enc:v1:');
    expect(await server.callToolText('hadron_unlock_memory', { memoryUrn: memory.urn, passphrase: 'synthetic2774' })).toContain('unlocked');
  }
  const expected = await single();
  expect(await batch()).toContain(expected);
  expect(expected).toContain('A short summary');
  expect(expected).toContain('abstract-stale');
  if (!raw) {
    expect(expected).toContain('EXPANDED');
    expect(expected).toContain('world');
    expect(expected).not.toContain('{{> leaf}}');
  }
});

it('#2774 refreshes provenance if the body revision changes after metadata prefetch', async () => {
  const task = await db.node.create({ data: { memoryId: fx.memory.id, loc: 'validator', name: 'Validator', isRunnable: true } });
  const node = await db.node.create({ data: { memoryId: fx.memory.id, loc: 'racy', name: 'Racy', content: 'old', revSeq: 1, authorshipKind: 'HUMAN', authoredByHuman: fx.admin.id, authoredAt: new Date('2026-09-26T20:00:00Z') } });
  await db.nodeContentValidationReport.create({ data: { nodeId: node.id, memoryId: fx.memory.id, nodeRevSeq: 1, validationTaskId: task.id, validationTaskRevSeq: 1, outcome: 'FAIL' } });
  let changed = false;
  const original = db.user.findMany.bind(db.user);
  const spy = vi.spyOn(db.user, 'findMany').mockImplementation(((args: any) => {
    const result = original(args);
    // Human-name prefetch runs after report prefetch, before body hydration.
    if (changed || !args?.select?.handle) return result;
    return result.then(async (rows) => {
      changed = true;
      await db.node.update({ where: { id: node.id }, data: { content: 'new', abstract: 'new summary', revSeq: 2 } });
      await db.nodeContentValidationReport.create({ data: { nodeId: node.id, memoryId: fx.memory.id, nodeRevSeq: 2, validationTaskId: task.id, validationTaskRevSeq: 1, outcome: 'PASS' } });
      return rows;
    });
  }) as typeof db.user.findMany);
  try {
    const output = await createTestableMcpServer(adminAuth()).callToolText('hadron_get_nodes', { refs: [node.id], contentScope: 'abstract', raw: true });
    expect(changed, output).toBe(true);
    // Reconciliation advances the directly edited row once more; report r2
    // is the latest eligible report, rather than the prefetched r1 FAIL.
    expect(output).toContain('Validation: stale (node revision 2;');
    expect(output).not.toContain('Validation: fail');
    expect(output).toContain('Source: abstract-stale');
    expect(output).toContain('new');
  } finally { spy.mockRestore(); }
});

it.each(['pk', 'prefix'] as const)('#2774 preserves first-oversized progress and omitted order (%s)', async (form) => {
  const rows: Array<{ id: string }> = [];
  for (let i = 0; i < 3; i++) rows.push(await db.node.create({ data: { memoryId: fx.memory.id, loc: `oversize:${i}`, name: `Large${i}`, content: 'x'.repeat(1_200_000) } }));
  const output = await createTestableMcpServer(adminAuth()).callToolText('hadron_get_nodes', {
    ...(form === 'pk' ? { refs: rows.map(n => n.id) } : { memoryUrn: 'hrn:mem:batch-org:batchmem', locPrefix: 'oversize:' }),
    contentScope: 'all', raw: true,
  });
  expect(output).toContain('returned 1 node(s)');
  expect(output).toContain('truncated: response-size cap reached, 2 omitted');
  expect(output).toContain('**Large0**');
  expect(output).not.toContain('**Large1**');
  expect(output).not.toContain('**Large2**');
  expect(output).toMatch(/hrn:node:batch-org:batchmem:oversize:1[\s\S]*hrn:node:batch-org:batchmem:oversize:2/);
});


it.each([[true, false], [false, false], [true, true], [false, true]] as const)('#2774 omits an unused body when no abstract exists (raw=%s encrypted=%s)', async (raw, encrypted) => {
  const home = await db.memory.findUniqueOrThrow({ where: { id: fx.memory.id } });
  const memory = await db.memory.create({ data: { organizationId: home.organizationId, class: 'private', userId: fx.admin.id, name: 'noabstract', urn: 'batch-org:noabstract' } });
  const node = await db.node.create({ data: { memoryId: memory.id, loc: 'no-abstract', name: 'No abstract', content: 'UNNEEDED'.repeat(16_384), abstract: null, data: { note: 'VISIBLE DATA' } } });
  const server = createTestableMcpServer(adminAuth(), { sessionId: 'batch2774-empty' });
  if (encrypted) {
    await resolvers.Mutation.encryptMemory({}, { memoryId: memory.id, passphrase: 'synthetic2774' }, { db, roles: ['ADMIN'], userId: fx.admin.id } as Context);
    expect(await server.callToolText('hadron_unlock_memory', { memoryUrn: memory.urn, passphrase: 'synthetic2774' })).toContain('unlocked');
  }
  const result = await measuredRead('abstract', [node.id], 'pk', raw);
  const single = await server.callToolText('hadron_get_node', { urn: 'hrn:node:batch-org:noabstract:no-abstract', contentScope: 'abstract', raw });
  expect(result.text).toContain(single);
  expect(result.loads.filter(l => l.phase === 'current').reduce((n, l) => n + l.rootBodyBytes, 0)).toBe(0);
  expect(result.text).not.toContain('UNNEEDED');
  expect(result.text).toContain('VISIBLE DATA');
});

it('#2774 preserves denied/deleted root and endpoint concealment with narrowed projections', async () => {
  const root = await db.node.create({ data: { memoryId: fx.memory.id, loc: 'safe-root', name: 'Safe root', abstract: 'Summary', content: 'ROOT' } });
  const live = await db.node.create({ data: { memoryId: fx.memory.id, loc: 'visible-end', name: 'Visible end', content: 'UNSELECTED ENDPOINT'.repeat(8192) } });
  const deadTarget = await db.node.create({ data: { memoryId: fx.memory.id, loc: 'dead-target', name: 'DELETED TARGET', content: 'DELETED CONTENT', deletedAt: new Date() } });
  const deadSource = await db.node.create({ data: { memoryId: fx.memory.id, loc: 'dead-source', name: 'DELETED SOURCE', content: 'DELETED CONTENT', deletedAt: new Date() } });
  const deadRoot = await db.node.create({ data: { memoryId: fx.memory.id, loc: 'dead-root', name: 'DELETED ROOT', content: 'DELETED ROOT CONTENT', deletedAt: new Date() } });
  const hidden = await db.node.create({ data: { memoryId: fx.pmem.id, loc: 'hidden-end', name: 'DENIED ENDPOINT', content: 'DENIED CONTENT' } });
  await db.edge.createMany({ data: [
    { sourceId: root.id, targetId: live.id, loc: 'live' },
    { sourceId: root.id, targetId: deadTarget.id, loc: 'deleted-out' },
    { sourceId: deadSource.id, targetId: root.id, loc: 'deleted-in' },
    { sourceId: root.id, targetId: hidden.id, loc: 'denied-out' },
    { sourceId: hidden.id, targetId: root.id, loc: 'denied-in' },
  ].map(edge => ({ id: generateId(), memoryId: fx.memory.id, ...edge })) });
  const server = createTestableMcpServer(adminAuth());
  const single = await server.callToolText('hadron_get_node', { urn: 'hrn:node:batch-org:batchmem:safe-root', contentScope: 'abstract', raw: true });
  const result = await measuredRead('abstract', [root.id, deadRoot.id], 'pk');
  expect(result.text).toContain(single);
  expect(result.text).toContain('Visible end');
  expect(result.text).toContain('1 unavailable');
  expect(result.text).toContain(deadRoot.id);
  expect(result.text).not.toMatch(/DELETED|DENIED|hidden-end|dead-target|dead-source/);
  expect(result.loads.reduce((n, l) => n + l.endpointBodyBytes, 0)).toBe(0);
});
