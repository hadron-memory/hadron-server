/**
 * #1330 — H1 strict sub-roles enforced at the shared write boundary
 * (`writeNodeCore`). A write that ASSIGNS a role undeclared under a strict
 * parent is refused; unrelated roles stay free, runnable and platform writes
 * are exempt, and an existing node is never refused for an unrelated edit.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { type Context } from './resolvers.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { generateId } from '../../../lib/id.js';
import { lockMemoryConfigExclusive, lockMemoryConfigShared } from '../../../lib/governedRole.js';
import { resolvers } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let memoryId: string;
const ctx = (): Context => ({ db, roles: [], userId: admin.id }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'ss-org', urn: 'ss-org' } });
  admin = await db.user.create({ data: { githubId: 13300, githubUsername: 'ss-admin', handle: 'ss-admin' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`, name: 'mem', class: 'knowledge' },
  })).id;
});

async function rules(...rs: Array<{ role: string; strictSubRoles?: boolean; enabled?: boolean }>) {
  const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId } });
  for (const r of rs) await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, ...r } });
  return config;
}

const create = (loc: string, extra: Record<string, unknown> = {}, opts?: Parameters<typeof writeNodeCore>[3]) =>
  writeNodeCore({ memoryId, loc, name: loc, content: 'x', ...extra } as never, ctx(), 'create', opts);
const update = (loc: string, extra: Record<string, unknown>) =>
  writeNodeCore({ memoryId, loc, ...extra } as never, ctx(), 'update');

async function refusal(p: Promise<unknown>) {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(GraphQLError);
  return (e as GraphQLError).extensions;
}

describe('#1330 — strictSubRoles at writeNodeCore', () => {
  it('no rules: any role is free', async () => {
    await expect(create('a', { role: 'doc.anything' })).resolves.toBeTruthy();
  });

  it('a strict parent refuses an undeclared sub-role, naming the parent; nothing is written', async () => {
    await rules({ role: 'doc', strictSubRoles: true }, { role: 'doc.guide' });
    expect(await refusal(create('a', { role: 'doc.unknown' }))).toMatchObject({ code: 'ROLE_NOT_DECLARED', role: 'doc.unknown', strictParent: 'doc' });
    expect(await refusal(create('b', { role: 'doc.x.y' }))).toMatchObject({ code: 'ROLE_NOT_DECLARED', strictParent: 'doc' });
    expect(await db.node.count({ where: { memoryId } })).toBe(0);
    // The parent itself, a declared sub-role, and unrelated roles are free.
    await expect(create('c', { role: 'doc' })).resolves.toBeTruthy();
    await expect(create('d', { role: 'doc.guide' })).resolves.toBeTruthy();
    await expect(create('e', { role: 'notes.whatever' })).resolves.toBeTruthy();
    await expect(create('f', { role: 'document' })).resolves.toBeTruthy();
  });

  it('a non-strict parent lends its rule instead (nearest-ancestor fallback); a disabled strict rule governs nothing', async () => {
    await rules({ role: 'doc' }, { role: 'memo', strictSubRoles: true, enabled: false });
    await expect(create('a', { role: 'doc.unknown' })).resolves.toBeTruthy();
    await expect(create('b', { role: 'memo.unknown' })).resolves.toBeTruthy();
  });

  it('nested: strictness is the nearest enabled rule\'s, and a disabled declared sub-role falls through to the strict parent', async () => {
    await rules({ role: 'doc', strictSubRoles: true }, { role: 'doc.guide' }, { role: 'doc.draft', enabled: false });
    await expect(create('a', { role: 'doc.guide.part' })).resolves.toBeTruthy();
    await expect(create('b', { role: 'doc.draft' })).resolves.toBeTruthy();
    expect(await refusal(create('c', { role: 'doc.draft.x' }))).toMatchObject({ code: 'ROLE_NOT_DECLARED', strictParent: 'doc' });
  });

  it('an update ASSIGNING an undeclared role is refused and leaves the node; an unrelated edit of a legacy role is not (no retroactive effect)', async () => {
    await create('a', { role: 'doc.legacy' });
    await rules({ role: 'doc', strictSubRoles: true });
    expect(await refusal(update('a', { role: 'doc.other' }))).toMatchObject({ code: 'ROLE_NOT_DECLARED' });
    expect(await db.node.findFirstOrThrow({ where: { memoryId, loc: 'a' } })).toMatchObject({ role: 'doc.legacy' });
    await expect(update('a', { content: 'edited' })).resolves.toBeTruthy();
    await expect(update('a', { role: 'doc.legacy', content: 'again' })).resolves.toBeTruthy();
    // Clearing a role is never refused.
    await expect(update('a', { role: null })).resolves.toBeTruthy();
  });

  it('a resurrection keeps its tombstone\'s role without re-judging it, but a role it names is judged', async () => {
    await create('a', { role: 'doc.legacy' });
    await db.node.updateMany({ where: { memoryId, loc: 'a' }, data: { deletedAt: new Date() } });
    await rules({ role: 'doc', strictSubRoles: true });
    await expect(create('a', { content: 'back' })).resolves.toBeTruthy();
    await db.node.updateMany({ where: { memoryId, loc: 'a' }, data: { deletedAt: new Date() } });
    expect(await refusal(create('a', { role: 'doc.newer' }))).toMatchObject({ code: 'ROLE_NOT_DECLARED' });
  });

  it('exempt: a node runnable after the write, and a platform write (server-only option)', async () => {
    await rules({ role: 'doc', strictSubRoles: true });
    await expect(create('t', { role: 'doc.task', isRunnable: true }, { ownsKind: 'task' })).resolves.toBeTruthy();
    await expect(create('p', { role: 'doc.system' }, { platformWrite: true })).resolves.toBeTruthy();
  });

  it('a first rule write in flight is waited for, even with no config row to lock yet (#1400 review)', async () => {
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // A rule write materializing this memory's FIRST config: it holds the
    // exclusive config lock until it commits.
    const ruleWrite = db.$transaction(
      async (tx) => {
        await lockMemoryConfigExclusive(tx, memoryId);
        const config = await tx.memoryConfig.create({ data: { id: generateId(), memoryId } });
        await tx.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'doc', strictSubRoles: true } });
        held();
        await gate;
      },
      { timeout: 15_000 },
    );
    await holding; // a barrier, not a sleep (#1400 review)
    const nodeWrite = create('race', { role: 'doc.unknown' }).then(() => null, (e: unknown) => e);
    await pause(400);
    release();
    await ruleWrite;
    const err = await nodeWrite;
    expect((err as GraphQLError | null)?.extensions?.code).toBe('ROLE_NOT_DECLARED');
    expect(await db.node.count({ where: { memoryId, loc: 'race' } })).toBe(0);
  });

  it('the real rule writers take the exclusive side: createNodeRoleRule waits while a node write holds the shared lock (#1400 review)', async () => {
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const nodeSide = db.$transaction(
      async (tx) => {
        await lockMemoryConfigShared(tx, memoryId);
        held();
        await gate;
      },
      { timeout: 15_000 },
    );
    await holding; // a barrier, not a sleep (#1400 review)
    let settled = false;
    const created = (resolvers.Mutation as any)
      .createNodeRoleRule({}, { memoryRef: memoryId, input: { role: 'doc', strictSubRoles: true } }, ctx())
      .finally(() => (settled = true));
    await pause(400);
    expect(settled).toBe(false);
    release();
    await nodeSide;
    await expect(created).resolves.toMatchObject({ rule: { role: 'doc', strictSubRoles: true } });
  });
});
