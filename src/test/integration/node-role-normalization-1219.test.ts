/**
 * #1219 — Node.role empty-string normalization (cor:dmo:060:02, Holger
 * ruling "A" via Vera, team chat #13094): an empty or whitespace-only role
 * is the same as no role, so the write seam stores null — exactly the
 * contract objectType has had since #725, beside which this normalization
 * sits.
 *
 * Drives the PUBLIC createNode/updateNode mutations and the shared
 * writeNodeCore directly (mirrors src/test/integration/node-abstract.test.ts),
 * so the pin covers every write path that consumes input.role: the payload
 * build, mergedGovernedState's before/after judgment, the #1330/#1450
 * locked-row re-checks and the resurrection path all read the normalized
 * value.
 *
 * The discriminator sweep (#1219's same-pass ask, mandatory per the gate):
 *   - role:          normalized HERE (red without the fix — a create stored
 *                    '' verbatim, the second spelling of "ungoverned").
 *   - objectType:    normalized since #725 — pinned here as the positive
 *                    control, proving the two discriminators now agree.
 *   - nodeType:      NOT NULL with default 'info' and free-form — an empty
 *                    nodeType has no ruled semantics (null is not
 *                    representable), so it is OUT of this PR and routed for
 *                    its own ruling; see the PR body's sweep table.
 *   - abstract:      already normalizes empty/whitespace to null (spec 031,
 *                    FR-009 extended) — not re-pinned here.
 *   - contentType:   closed-set guarded (BAD_USER_INPUT on anything but
 *                    text/markdown, text/html, application/pdf) and consumed
 *                    at write time, never persisted — no gap.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { writeNodeCore } from '../../api/graphql/schema/resolvers.mutation.node.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { generateId } from '../../lib/id.js';

// The write core fires writeNodeToGit asynchronously; pin to a no-op so the
// test doesn't try to push to a real remote.
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

interface Fixture {
  ctx: Context;
  memory: { id: string; urn: string };
}

let fx: Fixture;

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'role-norm-org', urn: 'role-norm-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 9901, githubUsername: 'role-norm-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });

  fx = {
    ctx: { db, roles: ['ADMIN'], userId: admin.id, clientId: `user:${admin.id}` },
    memory: await resolvers.Mutation.createMemory(
      {},
      { orgId: org.id, name: 'rolemem' },
      { db, roles: ['ADMIN'], userId: admin.id, clientId: `user:${admin.id}` } as Context,
    ),
  };
});

async function persisted(loc: string): Promise<{ role: string | null; objectType: string | null }> {
  const node = await db.node.findFirst({
    where: { loc, memoryId: fx.memory.id, deletedAt: null },
    select: { role: true, objectType: true },
  });
  if (!node) throw new Error(`node not found: ${loc}`);
  return node;
}

describe('#1219 Node.role empty normalization (cor:dmo:060:02, ruling A)', () => {
  it('createNode: an empty role is stored as null, not ""', async () => {
    await resolvers.Mutation.createNode(
      {},
      { input: { memoryId: fx.memory.id, loc: 'r-empty', name: 'Empty role', role: '' } },
      fx.ctx,
    );
    expect((await persisted('r-empty')).role).toBeNull();
  });

  it('createNode: a whitespace-only role is stored as null', async () => {
    await resolvers.Mutation.createNode(
      {},
      { input: { memoryId: fx.memory.id, loc: 'r-ws', name: 'Whitespace role', role: '   ' } },
      fx.ctx,
    );
    expect((await persisted('r-ws')).role).toBeNull();
  });

  it('createNode: a real role is stored verbatim (whitespace inside kept)', async () => {
    await resolvers.Mutation.createNode(
      {},
      { input: { memoryId: fx.memory.id, loc: 'r-real', name: 'Real role', role: 'scheduling anchor' } },
      fx.ctx,
    );
    expect((await persisted('r-real')).role).toBe('scheduling anchor');
  });

  it('updateNode: an empty role CLEARS an existing role to null', async () => {
    await resolvers.Mutation.createNode(
      {},
      { input: { memoryId: fx.memory.id, loc: 'r-clear', name: 'To clear', role: 'ordinary-role' } },
      fx.ctx,
    );
    expect((await persisted('r-clear')).role).toBe('ordinary-role');

    await resolvers.Mutation.updateNode(
      {},
      { input: { id: (await db.node.findFirstOrThrow({ where: { loc: 'r-clear', memoryId: fx.memory.id }, select: { id: true } })).id, role: '' } },
      fx.ctx,
    );
    expect((await persisted('r-clear')).role).toBeNull();
  });

  it('the shared write core (upsert) sees the same normalization', async () => {
    await writeNodeCore(
      { memoryId: fx.memory.id, loc: 'r-core', name: 'Core path', role: '  ' } as never,
      fx.ctx,
      'upsert',
    );
    expect((await persisted('r-core')).role).toBeNull();
  });

  it('positive control: objectType empty behaves identically (the #725 contract)', async () => {
    await resolvers.Mutation.createNode(
      {},
      { input: { memoryId: fx.memory.id, loc: 'ot-empty', name: 'Empty objectType', objectType: '' } },
      fx.ctx,
    );
    expect((await persisted('ot-empty')).objectType).toBeNull();
  });

  it('governed control: clearing a governed role with "" is refused exactly like null (unchanged)', async () => {
    // A pre-governed row written directly (the generic surface refuses to create
    // one): '' must not open a new un-govern path, same as before the fix.
    const id = generateId();
    await db.node.create({
      data: { id, memoryId: fx.memory.id, loc: 'r-gov', name: 'Governed', role: 'spec.rule', nodeType: 'record' },
    });
    await expect(
      resolvers.Mutation.updateNode({}, { input: { id, role: '' } }, fx.ctx),
    ).rejects.toMatchObject({ extensions: { code: 'ROLE_GOVERNED' } });
    expect((await persisted('r-gov')).role).toBe('spec.rule');
  });

  it('restoreNodeRevision: a historical empty role restores as null, not ""', async () => {
    // A revision captured before the fix could store ''. Restoring it must not
    // resurrect the illegal shape.
    const id = generateId();
    await resolvers.Mutation.createNode(
      {},
      { input: { id, memoryId: fx.memory.id, loc: 'r-hist', name: 'History', role: 'first' } },
      fx.ctx,
    );
    await resolvers.Mutation.updateNode(
      {},
      { input: { id, role: 'second' } },
      fx.ctx,
    );
    // Revisions snapshot the PRE-write state, so one more write is what puts
    // the 'second' state into history.
    await resolvers.Mutation.updateNode(
      {},
      { input: { id, role: 'third' } },
      fx.ctx,
    );
    const revs = await db.nodeRevision.findMany({ where: { nodeId: id } });
    const second = revs.find((r) => r.role === 'second');
    if (!second) throw new Error('second revision not snapshotted');
    await db.nodeRevision.update({ where: { id: second.id }, data: { role: '' } });
    await resolvers.Mutation.restoreNodeRevision({}, { revisionId: second.id }, fx.ctx);
    expect((await persisted('r-hist')).role).toBeNull();
  });
});

describe('#1219 MCP: hadron_create_node / hadron_update_node (inline parity writers, #206)', () => {
  // The MCP node tools are NOT writeNodeCore delegates — they are inline
  // parity writers, so the writeNodeCore normalization does not reach them
  // (Xavier #13258 / Celine #13261, the P2 of the first head). These pins
  // drive the REAL handlers.
  const mcp = () =>
    createTestableMcpServer({ userId: (fx.ctx as { userId: string }).userId, roles: ['ADMIN'] });

  it('create: an empty or whitespace role stores null, not verbatim', async () => {
    await mcp().callToolText('hadron_create_node', { urn: `hrn:node:${fx.memory.urn}:m-empty`, name: 'M empty', role: '' });
    await mcp().callToolText('hadron_create_node', { urn: `hrn:node:${fx.memory.urn}:m-ws`, name: 'M ws', role: '   ' });
    expect((await persisted('m-empty')).role).toBeNull();
    expect((await persisted('m-ws')).role).toBeNull();
  });

  it('create: a real role is stored verbatim, and omit leaves it unset', async () => {
    await mcp().callToolText('hadron_create_node', { urn: `hrn:node:${fx.memory.urn}:m-real`, name: 'M real', role: 'anchor' });
    await mcp().callToolText('hadron_create_node', { urn: `hrn:node:${fx.memory.urn}:m-omit`, name: 'M omit' });
    expect((await persisted('m-real')).role).toBe('anchor');
    expect((await persisted('m-omit')).role).toBeNull();
  });

  it('update: an empty role CLEARS; omit PRESERVES', async () => {
    await mcp().callToolText('hadron_create_node', { urn: `hrn:node:${fx.memory.urn}:m-clr`, name: 'M clr', role: 'anchor' });
    await mcp().callToolText('hadron_update_node', { urn: `hrn:node:${fx.memory.urn}:m-clr`, name: 'M clr' });
    expect((await persisted('m-clr')).role).toBe('anchor');
    await mcp().callToolText('hadron_update_node', { urn: `hrn:node:${fx.memory.urn}:m-clr`, role: '' });
    expect((await persisted('m-clr')).role).toBeNull();
  });
});
