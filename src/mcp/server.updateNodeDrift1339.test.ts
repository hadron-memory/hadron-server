/**
 * PR #1339 review — hadron_update_node takes the row lock BEFORE its
 * authoritative read and reconciles unrevisioned drift as its own revision
 * (@codex P1). The abstract fingerprint deliberately still binds to the
 * content the CALLER read, so a concurrent content change leaves the
 * staleness marker armed (#1127/#1139, pinned in
 * server.nodeAbstractStaleness.test.ts) — recomputing it from the locked row
 * would certify an abstract against content nobody reviewed.
 *
 * The race is made deterministic: a raw write lands after the tool read the
 * node and immediately before its write transaction starts — the window a
 * writer that does not take the address lock can hit.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let memory: { id: string; urn: string };
const auth = (): AuthContext => ({ userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` });

beforeEach(async () => {
  vi.restoreAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'mcpdr-org', urn: 'mcpdr-org' } });
  admin = await db.user.create({ data: { githubId: 13391, githubUsername: 'mcpdr-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'drift' }, {
    db, roles: ['ADMIN'], userId: admin.id,
  } as Context);
});

const seed = (loc: string, over: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId: memory.id, loc, name: loc, content: 'A', ...over } });

/** Run `raw` once, right before the next interactive transaction begins. */
function writeJustBeforeNextTransaction(raw: () => Promise<unknown>) {
  const original = db.$transaction.bind(db);
  let fired = false;
  vi.spyOn(db, '$transaction').mockImplementation((async (arg: unknown, opts?: unknown) => {
    if (!fired && typeof arg === 'function') {
      fired = true;
      await raw();
    }
    return (original as any)(arg, opts);
  }) as never);
}

describe('#1339 review — hadron_update_node reads under the row lock', () => {
  it('a raw write in the read→transaction window is reconciled, never folded or hidden', async () => {
    const node = await seed('drift:window');
    writeJustBeforeNextTransaction(() => db.node.update({ where: { id: node.id }, data: { content: 'B' } }));
    await createTestableMcpServer(auth()).callToolText('hadron_update_node', {
      urn: `hrn:node:${memory.urn}:${node.loc}`,
      name: 'renamed',
    });
    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    // Two transitions happened (A→B by the raw writer, then the rename), so
    // two revisions: the reconcile (of B, the prior bytes are gone) and the edit.
    expect(after.revSeq).toBe(3);
    const history = await db.nodeRevision.findMany({ where: { nodeId: node.id }, orderBy: { revNo: 'asc' } });
    expect(history.map((r) => r.revNo)).toEqual([1, 2]);
    expect(history[0]!.revLabel).toMatch(/Reconciled state changed outside a revisioned writer/);
    expect(history[1]!.content).toBe('B');
    expect(after.content).toBe('B');
  });
});

describe('#1339 review — hadron_create_parent_node re-save is a revisioned write', () => {
  it('re-saving a live section snapshots its real predecessor; a later read mints nothing', async () => {
    const node = await seed('section:docs', { description: 'old description' });
    await createTestableMcpServer(auth()).callToolText('hadron_create_parent_node', {
      urn: `hrn:node:${memory.urn}:${node.loc}`,
      description: 'new description',
    });
    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.description).toBe('new description');
    expect(after.revSeq).toBe(2);
    const history = await db.nodeRevision.findMany({ where: { nodeId: node.id } });
    expect(history).toHaveLength(1);
    expect(history[0]!.description).toBe('old description');
    expect(history[0]!.editedBy).toBe(admin.id);
    // The fingerprint was refreshed, so an exposed read has nothing to reconcile.
    const ctx = { db, roles: ['ADMIN'], userId: admin.id } as Context;
    expect(await resolvers.Node.revision(after as never, {}, ctx)).toBe(2);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(1);
  });
});

