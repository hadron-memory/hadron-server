/**
 * Removal follows a role's writer level (cor:acl:130:07, #1331).
 *
 * A role rule's writer level narrows who may write nodes of that role, and
 * removing a node is writing it. So the generic delete doors judge the role of
 * every node they remove with the shared #1331 predicate
 * (`assertRoleWritersForNodes`), over the WHOLE locked affected set, before any
 * write, after the governed-kind guard.
 *
 * What must hold, one case each:
 *   1. GraphQL `deleteNode` (soft, hard, recursive) and `deleteObject`: a node of
 *      an ADMIN role is removed only by its ADMIN audience; an OWNER rule refuses
 *      everyone; ALL and unruled roles keep the memory-write audience.
 *   2. The same on MCP `hadron_delete_node`, an independent inline transaction.
 *   3. A refused removal writes nothing, however deep the restricted node sits.
 *   4. The governed refusal comes first; refusals reveal nothing new to a caller
 *      without memory write access.
 *   5. Races, judged on the committed state in both orders: a rule change, an
 *      audience change, and a role change on a row the delete removes.
 *   6. The removal paths that already judge the level keep doing so.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { lockMemoryConfigExclusive } from '../../../lib/governedRole.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

type U = { id: string };
let orgId: string;
let memoryId: string;
let memoryUrn: string;
let admin: U;
let owner: U;
let contrib: U;
let reader: U;
let platform: U;

const REFUSED = 'ROLE_WRITER_LEVEL_REQUIRED';
const UNSUPPORTED = 'ROLE_WRITERS_UNSUPPORTED';

const as = (u: U, roles: Context['roles'] = []): Context => ({ db, userId: u.id, roles, clientId: `user:${u.id}` });
const M = resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
}

async function rule(role: string, writers: 'ALL' | 'ADMIN' | 'OWNER', memId = memoryId) {
  const config = (await db.memoryConfig.findUnique({ where: { memoryId: memId } }))
    ?? await db.memoryConfig.create({ data: { id: generateId(), memoryId: memId } });
  return db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role, writers } });
}
const node = (loc: string, extra: Record<string, unknown> = {}, memId = memoryId) =>
  db.node.create({ data: { id: generateId(), memoryId: memId, loc, name: loc, content: 'body', ...extra } });
const at = (loc: string, memId = memoryId) => db.node.findFirst({ where: { memoryId: memId, loc } });

type DeleteOpts = { hard?: boolean; recursive?: boolean };
const del = async (u: U, loc: string, opts: DeleteOpts = {}, roles: Context['roles'] = []) => {
  const n = await at(loc);
  return code(M.deleteNode({}, { nodeRef: n!.id, ...opts }, as(u, roles)));
};
const mcp = (u: U, roles: string[] = []) => createTestableMcpServer({ userId: u.id, roles: roles as never, clientId: `user:${u.id}` });
const mcpDel = (u: U, loc: string, opts: DeleteOpts = {}, roles: string[] = []) =>
  mcp(u, roles).callToolText('hadron_delete_node', { urn: `hrn:node:${memoryUrn}:${loc}`, ...opts });

/** Everything a refused removal must leave alone. */
async function snapshot(memId = memoryId) {
  return {
    nodes: await db.node.findMany({
      where: { memoryId: memId },
      orderBy: { loc: 'asc' },
      select: { id: true, loc: true, role: true, deletedAt: true },
    }),
    revisions: await db.nodeRevision.count({ where: { node: { memoryId: memId } } }),
    edges: await db.edge.count({ where: { source: { memoryId: memId } } }),
  };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'rr-org', urn: 'rr-org' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 133200, githubUsername: 'rr-admin', handle: 'rr-admin' } });
  owner = await db.user.create({ data: { githubId: 133201, githubUsername: 'rr-owner', handle: 'rr-owner' } });
  contrib = await db.user.create({ data: { githubId: 133202, githubUsername: 'rr-contrib', handle: 'rr-contrib' } });
  reader = await db.user.create({ data: { githubId: 133203, githubUsername: 'rr-reader', handle: 'rr-reader' } });
  platform = await db.user.create({ data: { githubId: 133204, githubUsername: 'rr-platform', handle: 'rr-platform', roles: ['ADMIN'] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: owner.id, role: 'OWNER' },
    { organizationId: org.id, userId: contrib.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
  ] });
  memoryUrn = `${org.urn}:mem`;
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: memoryUrn, name: 'mem', class: 'knowledge' },
  })).id;
  await rule('policy', 'ADMIN');
  await rule('vault', 'OWNER');
  await rule('open', 'ALL');
});

/** The GraphQL shapes: the target itself, or a recursive delete whose deep descendant carries the role. */
const GQL_SHAPES: Array<[string, DeleteOpts, boolean]> = [
  ['soft delete', {}, false],
  ['hard delete', { hard: true }, false],
  ['recursive soft delete reaching a deep descendant', { recursive: true }, true],
  ['recursive hard delete reaching a deep descendant', { recursive: true, hard: true }, true],
];

/** Seed the case: `t` is the target; with `deep`, the role sits on t:a:b and t itself is ordinary. */
async function seed(role: string | null, deep: boolean) {
  if (deep) {
    await node('t');
    await node('t:a');
    await node('t:a:b', role ? { role } : {});
  } else {
    await node('t', role ? { role } : {});
  }
  await node('other');
}

describe('GraphQL deleteNode follows the writer level of every node it removes', () => {
  for (const [label, opts, deep] of GQL_SHAPES) {
    describe(label, () => {
      it('ADMIN role: a contributor is refused and nothing is written', async () => {
        await seed('policy', deep);
        const before = await snapshot();
        expect(await del(contrib, 't', opts)).toBe(REFUSED);
        expect(await snapshot()).toEqual(before);
      });

      it('ADMIN role: an org ADMIN, an org OWNER and a platform admin remove it', async () => {
        for (const [u, roles] of [[admin, []], [owner, []], [platform, ['ADMIN']]] as Array<[U, Context['roles']]>) {
          await cleanSeed('policy', deep);
          expect(await del(u, 't', opts, roles)).toBe('OK');
        }
      });

      it('OWNER rule: refused for everyone with the unsupported code, never read as ALL', async () => {
        await seed('vault', deep);
        const before = await snapshot();
        expect(await del(contrib, 't', opts)).toBe(UNSUPPORTED);
        expect(await del(admin, 't', opts)).toBe(UNSUPPORTED);
        expect(await snapshot()).toEqual(before);
      });

      it('ALL rule and an unruled role: a contributor still removes it (positive controls)', async () => {
        for (const role of ['open', 'misc', null]) {
          await cleanSeed(role, deep);
          expect(await del(contrib, 't', opts)).toBe('OK');
        }
      });
    });
  }

  it('a dotted sub-role of an ADMIN role is judged by its rule', async () => {
    await node('t', { role: 'policy.security' });
    expect(await del(contrib, 't')).toBe(REFUSED);
    expect((await at('t'))!.deletedAt).toBeNull();
  });
});

/** Reset the memory's nodes between principals in one case. */
async function cleanSeed(role: string | null, deep: boolean) {
  await db.node.deleteMany({ where: { memoryId } });
  await seed(role, deep);
}

describe('deleteObject delegates to deleteNode and inherits the level', () => {
  it('a contributor cannot delete an object node of an ADMIN role; an admin can', async () => {
    const n = await node('obj', { role: 'policy' });
    expect(await code(M.deleteObject(null, { ref: n.id }, as(contrib)))).toBe(REFUSED);
    expect((await at('obj'))!.deletedAt).toBeNull();
    expect(await code(M.deleteObject(null, { ref: n.id }, as(admin)))).toBe('OK');
  });
});

describe('MCP hadron_delete_node follows the writer level', () => {
  const MCP_SHAPES: Array<[string, DeleteOpts, boolean]> = [
    ['soft', {}, false],
    ['hard', { hard: true }, false],
    ['recursive soft', { recursive: true }, true],
    ['recursive hard', { recursive: true, hard: true }, true],
  ];
  for (const [label, opts, deep] of MCP_SHAPES) {
    it(`${label}: a contributor is refused with the writer-level text and nothing is written; an admin removes it`, async () => {
      await seed('policy', deep);
      const before = await snapshot();
      const refused = await mcpDel(contrib, 't', opts);
      expect(refused).toContain('[role_writer_level_required]');
      expect(await snapshot()).toEqual(before);
      const ok = await mcpDel(admin, 't', opts);
      expect(ok).not.toContain('role_writer');
      expect(await snapshot()).not.toEqual(before);
    });
  }

  it('an OWNER rule is refused with the unsupported text', async () => {
    await node('t', { role: 'vault' });
    expect(await mcpDel(admin, 't')).toContain('[role_writers_unsupported]');
    expect((await at('t'))!.deletedAt).toBeNull();
  });

  it('ALL and unruled roles: a contributor removes them (positive control)', async () => {
    await node('a', { role: 'open' });
    await node('b');
    await mcpDel(contrib, 'a');
    await mcpDel(contrib, 'b');
    expect((await at('a'))!.deletedAt).not.toBeNull();
    expect((await at('b'))!.deletedAt).not.toBeNull();
  });
});

describe('an hdr_user_ API key carries its user and nothing more', () => {
  const keyFor = async (u: U) => (await db.userApiKey.create({
    data: {
      id: generateId(), userId: u.id, keyHash: generateId(), keyPreview: 'ab12',
      label: 'rr-key', createdBy: u.id, issuedVia: 'portal', oauthScopes: [],
    },
  })).id;

  it('GraphQL: a contributor key is refused on an ADMIN role; an admin key removes it', async () => {
    await node('t', { role: 'policy' });
    const before = await snapshot();
    const t = (await at('t'))!.id;
    const ctx = async (u: U) => ({ ...as(u), apiKeyId: await keyFor(u) });
    expect(await code(M.deleteNode({}, { nodeRef: t }, await ctx(contrib)))).toBe(REFUSED);
    expect(await snapshot()).toEqual(before);
    expect(await code(M.deleteNode({}, { nodeRef: t }, await ctx(admin)))).toBe('OK');
    expect((await at('t'))!.deletedAt).not.toBeNull();
  });

  it('MCP: a contributor key is refused on an ADMIN role; an admin key removes it', async () => {
    await node('t', { role: 'policy' });
    const before = await snapshot();
    const keyDel = async (u: U) => createTestableMcpServer({ userId: u.id, apiKeyId: await keyFor(u), clientId: `user:${u.id}` })
      .callToolText('hadron_delete_node', { urn: `hrn:node:${memoryUrn}:t` });
    expect(await keyDel(contrib)).toContain('[role_writer_level_required]');
    expect(await snapshot()).toEqual(before);
    expect(await keyDel(admin)).not.toContain('role_writer');
    expect((await at('t'))!.deletedAt).not.toBeNull();
  });
});

describe('a refused removal is atomic over the whole affected set', () => {
  for (const hard of [false, true]) {
    it(`a ${hard ? 'hard' : 'soft'} recursive delete of a 12-node subtree with one ADMIN-role node removes nothing`, async () => {
      await node('root');
      for (let i = 0; i < 10; i++) await node(`root:n${i}`);
      await node('root:n7:deep', { role: 'policy' });
      await db.edge.create({ data: {
        id: generateId(), memoryId, loc: 'root:n1:x:root:n2', name: 'x',
        sourceId: (await at('root:n1'))!.id, targetId: (await at('root:n2'))!.id,
      } });
      const before = await snapshot();
      expect(await del(contrib, 'root', { recursive: true, hard })).toBe(REFUSED);
      expect(await snapshot()).toEqual(before);
      expect(await mcpDel(contrib, 'root', { recursive: true, hard })).toContain('[role_writer_level_required]');
      expect(await snapshot()).toEqual(before);
    });
  }

  // A hard delete removes tombstones too, so it judges them; a soft delete
  // leaves them in place and does not.
  it('a hard recursive delete judges a tombstoned ADMIN-role descendant; a soft one does not touch it', async () => {
    await node('t');
    await node('t:a');
    await node('t:a:b', { role: 'policy', deletedAt: new Date(), deletedBy: admin.id });
    const before = await snapshot();
    expect(await del(contrib, 't', { recursive: true, hard: true })).toBe(REFUSED);
    expect(await snapshot()).toEqual(before);
    expect(await mcpDel(contrib, 't', { recursive: true, hard: true })).toContain('[role_writer_level_required]');
    expect(await snapshot()).toEqual(before);
    expect(await del(contrib, 't', { recursive: true })).toBe('OK');
    const after = await snapshot();
    expect(after.nodes.find((n) => n.loc === 't:a:b')).toEqual(before.nodes.find((n) => n.loc === 't:a:b'));
    expect(after.nodes.filter((n) => n.loc !== 't:a:b').every((n) => n.deletedAt !== null)).toBe(true);
  });
});

describe('order and disclosure', () => {
  it('a governed role whose rule says ADMIN stays ROLE_GOVERNED for a contributor (governed first)', async () => {
    await rule('review', 'ADMIN');
    await node('t', { role: 'review' });
    expect(await del(contrib, 't')).toBe('ROLE_GOVERNED');
  });

  it('a governed role with an ALL rule is still refused by the governed guard, for an admin too', async () => {
    await rule('spec', 'ALL');
    await node('t', { role: 'spec' });
    expect(await del(admin, 't')).toBe('ROLE_GOVERNED');
  });

  it('a reader gets the same refusal on an ADMIN-role node as on an ordinary one (nothing new disclosed)', async () => {
    await node('p', { role: 'policy' });
    await node('o');
    const onPolicy = await del(reader, 'p');
    expect(onPolicy).not.toBe('OK');
    expect(onPolicy).toBe(await del(reader, 'o'));
    expect(await mcpDel(reader, 'p')).toBe((await mcpDel(reader, 'o')).replace('"hrn:node:rr-org:mem:o"', '"hrn:node:rr-org:mem:p"'));
  });

  it('a revoked admin is refused as on an ordinary node, and removes nothing', async () => {
    await node('p', { role: 'policy' });
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: orgId, userId: admin.id } },
      data: { deletedAt: new Date() },
    });
    expect(await del(admin, 'p')).not.toBe('OK');
    expect((await at('p'))!.deletedAt).toBeNull();
  });

  it('a personal-memory owner is the ADMIN audience of their own memory', async () => {
    const own = await db.memory.create({
      data: { id: generateId(), ownerUserId: contrib.id, urn: 'rr-contrib:own', name: 'own', class: 'knowledge' },
    });
    await rule('policy', 'ADMIN', own.id);
    const n = await node('p', { role: 'policy' }, own.id);
    expect(await code(M.deleteNode({}, { nodeRef: n.id }, as(contrib)))).toBe('OK');
  });
});

/** A transaction that holds the memory's rulebook lock until released. */
function holdRulebook(work: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void> = async () => {}) {
  let held!: () => void;
  const holding = new Promise<void>((res) => (held = res));
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const done = db.$transaction(async (tx) => {
    await lockMemoryConfigExclusive(tx, memoryId);
    await work(tx);
    held();
    await gate;
  }, { timeout: 15_000 });
  return { holding, release, done };
}

// A red run (no writer check yet) fails each race at the lock-wait barrier, after its 10s wait.
describe('races: the removal is judged on the committed state', { timeout: 20_000 }, () => {
  it('a delete queued behind a rule change ALL->ADMIN is refused when the change commits', async () => {
    const open = await db.nodeRoleRule.findFirstOrThrow({ where: { role: 'open' } });
    await node('t', { role: 'open' });
    const h = holdRulebook(async (tx) => {
      await tx.nodeRoleRule.update({ where: { id: open.id }, data: { writers: 'ADMIN' } });
    });
    await h.holding;
    const pending = del(contrib, 't');
    await waitForLockWaiters(db);
    h.release();
    await h.done;
    expect(await pending).toBe(REFUSED);
    expect((await at('t'))!.deletedAt).toBeNull();
  });

  it('an admin demoted while their delete is queued is refused: the audience is read after the lock', async () => {
    await node('t', { role: 'policy' });
    const h = holdRulebook();
    await h.holding;
    const pending = del(admin, 't');
    await waitForLockWaiters(db);
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: orgId, userId: admin.id } },
      data: { role: 'CONTRIBUTOR' },
    });
    h.release();
    await h.done;
    expect(await pending).toBe(REFUSED);
    expect((await at('t'))!.deletedAt).toBeNull();
  });

  it('a role change INTO an ADMIN role that commits while the delete waits on the row is seen', async () => {
    const t = await node('t', { role: 'misc' });
    let held!: () => void;
    const holding = new Promise<void>((res) => (held = res));
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const roleChange = db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE nodes SET role = 'policy' WHERE id = ${t.id}`;
      held();
      await gate;
    }, { timeout: 15_000 });
    await holding;
    const pending = del(contrib, 't');
    await waitForLockWaiters(db);
    release();
    await roleChange;
    expect(await pending).toBe(REFUSED);
    expect((await at('t'))!.deletedAt).toBeNull();
  });

  it('a role change OUT of an ADMIN role that arrives after the delete holds the row waits, and the delete judges the role it locked', async () => {
    const t = await node('t', { role: 'policy' });
    const h = holdRulebook();
    await h.holding;
    // The delete locks the row, then waits on the rulebook lock held above.
    const pending = del(contrib, 't');
    await waitForLockWaiters(db);
    // A declassification by a direct row write now waits behind the delete's row lock.
    // A Prisma raw query is lazy: `.then` sends it now, without awaiting it.
    const declassify = db.$executeRaw`UPDATE nodes SET role = NULL WHERE id = ${t.id}`.then((n) => n);
    await waitForLockWaiters(db, 2);
    h.release();
    await h.done;
    expect(await pending).toBe(REFUSED);
    await declassify;
    expect((await at('t'))!.deletedAt).toBeNull();
  });

  // A hard delete's ON DELETE SET NULL writes every rule row that references a
  // removed node. A rule writer holds that row and then waits for the rulebook
  // exclusively, so the delete must lock those rows before the rulebook.
  for (const door of ['GraphQL', 'MCP'] as const) {
    it(`${door}: a hard delete of a node a rule references does not deadlock with that rule's writer`, async () => {
      const t = await node('t', { role: 'open' });
      const policy = await db.nodeRoleRule.findFirstOrThrow({ where: { role: 'policy' } });
      await db.nodeRoleRule.update({ where: { id: policy.id }, data: { descriptionNodeId: t.id } });
      let held!: () => void;
      const holding = new Promise<void>((res) => (held = res));
      let release!: () => void;
      const gate = new Promise<void>((res) => (release = res));
      const ruleWrite = db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM node_role_rules WHERE id = ${policy.id} FOR UPDATE`;
        held();
        await gate;
        await lockMemoryConfigExclusive(tx, memoryId);
        await tx.nodeRoleRule.update({ where: { id: policy.id }, data: { writers: 'ADMIN' } });
      }, { timeout: 15_000 });
      await holding;
      const pending = door === 'GraphQL' ? del(admin, 't', { hard: true }) : mcpDel(admin, 't', { hard: true });
      await waitForLockWaiters(db);
      release();
      await ruleWrite;
      const result = await pending;
      if (door === 'GraphQL') expect(result).toBe('OK');
      else expect(result).toContain('Hard-deleted');
      expect(await at('t')).toBeNull();
      expect((await db.nodeRoleRule.findUniqueOrThrow({ where: { id: policy.id } })).descriptionNodeId).toBeNull();
    });
  }
});

describe('removal paths that already judge the level keep doing so (regression controls)', () => {
  it('mergeNodes with deleteSource: a contributor cannot fold away a source of an ADMIN role', async () => {
    const src = await node('src', { role: 'policy' });
    const tgt = await node('tgt');
    expect(await code(M.mergeNodes(null, {
      input: { source: src.id, target: tgt.id, include: ['CONTENT'], deleteSource: true },
    }, as(contrib)))).toBe(REFUSED);
    expect((await at('src'))!.deletedAt).toBeNull();
  });

  it('MCP hadron_move_node overwrite: a contributor cannot evict an occupant of an ADMIN role', async () => {
    await node('from');
    await node('to', { role: 'policy' });
    const out = await mcp(contrib).callToolText('hadron_move_node', {
      urn: `hrn:node:${memoryUrn}:from`, targetUrn: `hrn:node:${memoryUrn}:to`, overwrite: true,
    });
    expect(out).toContain('role_writer_level_required');
    expect((await at('to'))!.role).toBe('policy');
    expect((await at('to'))!.deletedAt).toBeNull();
  });
});
