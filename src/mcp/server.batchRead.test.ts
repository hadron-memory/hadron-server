/**
 * Spec cor:api:040 — batch node read (hadron_get_nodes). Behavioral coverage for
 * the MCP surface, driving the production closure via createTestableMcpServer.
 *
 * What this file pins:
 *   - Explicit-set form: full per-node projection (content + edges) for many
 *     URNs in one call, returned in INPUT order (cor:api:040:01).
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
 *   - Form validation: exactly one of (urns) XOR (memoryUrn + locPrefix).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

// ───── helpers ──────────────────────────────────────────────────────────────

// Address nodes by the canonical org::memory::loc form (createMemory stores the
// memory urn in legacy single-colon form, so `${fx.memory.urn}::loc` would be
// the mixed `org:memory::loc` that assertFullyQualifiedUrn rejects).
const MEM_URN = 'batch-org::batchmem';
const PMEM_URN = 'batch-org::pmem';
const nodeUrn = (loc: string) => `${MEM_URN}::${loc}`;

async function addNode(args: {
  loc: string;
  name: string;
  content?: string;
  abstract?: string;
  edges?: Array<{ targetUrn: string; name: string }>;
}) {
  const srv = createTestableMcpServer(adminAuth());
  const params: Record<string, unknown> = { urn: nodeUrn(args.loc), name: args.name };
  if (args.content !== undefined) params.content = args.content;
  if (args.abstract !== undefined) params.abstract = args.abstract;
  if (args.edges !== undefined) params.edges = args.edges;
  return srv.callToolText('hadron_create_node', params);
}

function batchRead(params: Record<string, unknown>, auth: AuthContext = adminAuth()) {
  return createTestableMcpServer(auth).callToolText('hadron_get_nodes', params);
}

function readNode(urn: string, contentScope: 'content' | 'abstract' | 'all') {
  return createTestableMcpServer(adminAuth()).callToolText('hadron_get_node', { urn, contentScope });
}

// ───── explicit-set form ──────────────────────────────────────────────────

describe('hadron_get_nodes — explicit set', () => {
  it('returns all nodes with content + edges, in INPUT order', async () => {
    await addNode({ loc: 'beta', name: 'NodeBeta', content: 'beta body' });
    await addNode({ loc: 'alpha', name: 'NodeAlpha', content: 'alpha body', edges: [{ targetUrn: nodeUrn('beta'), name: 'links-to' }] });
    await addNode({ loc: 'gamma', name: 'NodeGamma', content: 'gamma body' });

    // Request in a deliberately non-loc order.
    const out = await batchRead({ urns: [nodeUrn('gamma'), nodeUrn('alpha'), nodeUrn('beta')] });

    expect(out).toContain('returned 3 node(s)');
    // Bodies present.
    expect(out).toContain('alpha body');
    expect(out).toContain('beta body');
    expect(out).toContain('gamma body');
    // Edge surfaced on alpha's projection.
    expect(out).toContain('Related:');
    expect(out).toContain('links-to');
    // Input order: gamma, then alpha, then beta.
    const iG = out.indexOf('**NodeGamma**');
    const iA = out.indexOf('**NodeAlpha**');
    const iB = out.indexOf('**NodeBeta**');
    expect(iG).toBeGreaterThanOrEqual(0);
    expect(iG).toBeLessThan(iA);
    expect(iA).toBeLessThan(iB);
  });

  it('per-node projection is byte-identical to a single hadron_get_node', async () => {
    await addNode({ loc: 'leaf', name: 'NodeLeaf', content: 'leaf body' });
    await addNode({
      loc: 'par',
      name: 'NodePar',
      content: 'par body',
      abstract: 'par abstract',
      edges: [{ targetUrn: nodeUrn('leaf'), name: 'child' }],
    });

    const single = await readNode(nodeUrn('par'), 'all');
    const batch = await batchRead({ urns: [nodeUrn('par')], contentScope: 'all' });

    // The batch wraps the identical single-read projection with a header.
    expect(batch).toContain(single);
  });

  it("contentScope: 'abstract' returns abstracts, omits bodies", async () => {
    await addNode({ loc: 'abs', name: 'NodeAbs', content: 'secret body text', abstract: 'the abstract' });
    const out = await batchRead({ urns: [nodeUrn('abs')], contentScope: 'abstract' });
    expect(out).toContain('the abstract');
    expect(out).not.toContain('secret body text');
  });

  it('dedups a repeated URN — renders it once (no double UsageEvent)', async () => {
    await addNode({ loc: 'dup', name: 'NodeDup', content: 'dup body' });
    const out = await batchRead({ urns: [nodeUrn('dup'), nodeUrn('dup')] });
    expect(out).toContain('returned 1 node(s)');
  });
});

// ───── per-node authorization + partial success (cor:api:040:03) ───────────

describe('hadron_get_nodes — partial success', () => {
  it('returns the readable subset; lists denied + not-found as Unavailable without leaking content', async () => {
    await addNode({ loc: 'ok', name: 'NodeOk', content: 'readable body' });
    // A node in user2's personal memory — denied for the admin caller.
    const secretUrn = `${PMEM_URN}::secret`;
    await createTestableMcpServer(user2Auth()).callToolText('hadron_create_node', {
      urn: secretUrn,
      name: 'SecretNode',
      content: 'SECRET personal content',
    });
    const missingUrn = nodeUrn('does-not-exist');

    const out = await batchRead({ urns: [nodeUrn('ok'), secretUrn, missingUrn] });

    // Readable one returned; batch did NOT fail wholesale.
    expect(out).toContain('readable body');
    expect(out).toContain('returned 1 node(s)');
    expect(out).toContain('2 unavailable');
    // Both the denied and the missing ref are listed under Unavailable.
    expect(out).toContain('Unavailable (denied or not found):');
    expect(out).toContain(secretUrn);
    expect(out).toContain(missingUrn);
    // No content leak from the denied memory.
    expect(out).not.toContain('SECRET personal content');
  });
});

// ───── prefix-subtree form ─────────────────────────────────────────────────

describe('hadron_get_nodes — prefix subtree', () => {
  it('returns every node under the prefix in loc order, with content', async () => {
    await addNode({ loc: 'sec:03', name: 'Sec03', content: 'third' });
    await addNode({ loc: 'sec:01', name: 'Sec01', content: 'first' });
    await addNode({ loc: 'sec:02', name: 'Sec02', content: 'second' });
    await addNode({ loc: 'other', name: 'Other', content: 'unrelated' });

    const out = await batchRead({ memoryUrn: MEM_URN, locPrefix: 'sec:' });

    expect(out).toContain('returned 3 node(s)');
    expect(out).not.toContain('unrelated'); // outside the prefix
    const i1 = out.indexOf('**Sec01**');
    const i2 = out.indexOf('**Sec02**');
    const i3 = out.indexOf('**Sec03**');
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  it('an unreadable memory is reported as not found (no existence leak)', async () => {
    const out = await batchRead({ memoryUrn: PMEM_URN, locPrefix: '' });
    expect(out).toContain('Memory not found');
  });
});

// ───── hard caps (cor:api:040:02) ──────────────────────────────────────────

describe('hadron_get_nodes — hard caps', () => {
  it('over the node-count cap is a LOUD error, not a silent short read', async () => {
    const tooMany = Array.from({ length: BATCH_READ_MAX_NODES + 1 }, (_, i) => nodeUrn(`d${i}`));
    const out = await batchRead({ urns: tooMany });
    expect(out).toContain(`exceeds the ${BATCH_READ_MAX_NODES}-node cap`);
    expect(out).not.toContain('returned'); // no partial render
  });

  it('over the response-size cap returns a partial result flagged truncated', async () => {
    const big = 'x'.repeat(600_000); // two of these blow the 1MB size cap
    await addNode({ loc: 'big1', name: 'Big1', content: big });
    await addNode({ loc: 'big2', name: 'Big2', content: big });

    const out = await batchRead({ urns: [nodeUrn('big1'), nodeUrn('big2')] });

    expect(out).toContain('returned 1 node(s)');
    expect(out).toContain('truncated');
    expect(out).toContain('Omitted');
    expect(out).toContain(nodeUrn('big2'));
  });
});

// ───── form validation ─────────────────────────────────────────────────────

describe('hadron_get_nodes — form validation', () => {
  it('rejects neither form', async () => {
    const out = await batchRead({});
    expect(out).toContain('provide EITHER');
  });
  it('rejects both forms at once', async () => {
    const out = await batchRead({ urns: [nodeUrn('x')], memoryUrn: MEM_URN, locPrefix: 'a' });
    expect(out).toContain('provide EITHER');
  });
});
