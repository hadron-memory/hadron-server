/**
 * Issue #1180 — `Memory.protectedLocs` as the second predicate source for the
 * spec-049 §2 S4 protected-loc write gate, plus `authorProtectedNode`, the door
 * a memory-specific authoring tool writes through.
 *
 * WHAT THIS IS AND IS NOT, because the two sources share one mechanism and one
 * error code at DIFFERENT strengths:
 *
 *   - A Channel's protection is a SECURITY BOUNDARY. #1047 existed because chat
 *     authorship was forgeable and not tamper-evident, and the owning operation
 *     derives authorship the caller cannot supply.
 *   - A `Memory.protectedLocs` entry is a GUARDRAIL. `authorProtectedNode` is
 *     PURE ROUTING — it validates nothing and knows nothing about spec, review
 *     or task nodes, because those authoring RULES stay in `hadron spec` /
 *     `hadron coding`, which are closed-list exceptions on the audience ground.
 *     So a determined caller can author a malformed node THROUGH the door; what
 *     is refused is the ACCIDENTAL generic write.
 *
 * What keeps an agent away from the door is that it is not an MCP tool (the
 * same reason `createTeamChatMessage` is not one) — so `hadron_create_node` is
 * the only node door on that surface, and it refuses.
 *
 * EMPTY BY DEFAULT is load-bearing and pinned below: declaring a loc refuses
 * every generic writer of it at once, including the authoring CLI until it
 * moves to the door. Shipping the mechanism must break nothing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let orgId: string;
let memoryId: string;
let adminId: string;

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` });

/** Generic create — the path an agent's hadron_create_node reaches. */
async function genericCreate(loc: string, name = 'N'): Promise<string> {
  try {
    await resolvers.Mutation.createNode({}, { input: { memoryId, loc, name } as never }, ctx());
    return 'OK';
  } catch (e) {
    return `ERR:${(e as { extensions?: { code?: string } }).extensions?.code ?? 'unknown'}`;
  }
}

/** The authoring door. */
async function authoredCreate(loc: string, name = 'N', upsert = false): Promise<string> {
  try {
    await resolvers.Mutation.authorProtectedNode(
      {},
      { input: { memoryId, loc, name } as never, upsert },
      ctx(),
    );
    return 'OK';
  } catch (e) {
    return `ERR:${(e as { extensions?: { code?: string } }).extensions?.code ?? 'unknown'}`;
  }
}

const protect = (locs: string[]) =>
  db.memory.update({ where: { id: memoryId }, data: { protectedLocs: locs } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'p1180-org', urn: 'p1180-org.test' },
  });
  orgId = org.id;
  const admin = await db.user.create({
    data: { id: generateId(), githubId: 11800, githubUsername: 'p1180-admin', roles: ['ADMIN'] },
  });
  adminId = admin.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  const mem = await resolvers.Mutation.createMemory({}, { orgId, name: 'corpus' }, ctx());
  memoryId = mem.id;
});

describe('Memory.protectedLocs — the declared predicate source (#1180)', () => {
  it('EMPTY BY DEFAULT: shipping the mechanism protects nothing', async () => {
    // The assertion that makes this migration safe to deploy. If the default
    // were anything else, every existing corpus would start refusing its own
    // authoring tool the moment this landed.
    const mem = await db.memory.findUnique({ where: { id: memoryId } });
    expect(mem?.protectedLocs).toEqual([]);
    expect(await genericCreate('review:anything')).toBe('OK');
  });

  it('a declared loc refuses the generic writer, and its subtree with it', async () => {
    await protect(['review']);

    expect(await genericCreate('review')).toBe('ERR:LOC_PROTECTED');
    // The subtree, via locsOverlap — this is why a prefix needs no new logic.
    expect(await genericCreate('review:a-guard-must-fail')).toBe('ERR:LOC_PROTECTED');
    expect(await genericCreate('review:deep:nested:leaf')).toBe('ERR:LOC_PROTECTED');
  });

  it('leaves every OTHER loc in the same memory writable', async () => {
    // Guards the opposite failure: a predicate that protected too much would
    // satisfy every refusal assertion above.
    await protect(['review']);

    expect(await genericCreate('findings:something')).toBe('OK');
    expect(await genericCreate('reviewer-notes')).toBe('OK'); // NOT review:*
    expect(await genericCreate('tasks:whatever')).toBe('OK'); // not declared
  });

  it('`*` protects the WHOLE memory — the citation-corpus shape', async () => {
    await protect(['*']);

    expect(await genericCreate('cor:api:010:01')).toBe('ERR:LOC_PROTECTED');
    expect(await genericCreate('register')).toBe('ERR:LOC_PROTECTED');
    expect(await genericCreate('anything-at-all')).toBe('ERR:LOC_PROTECTED');
  });

  it('protection is per MEMORY — a sibling memory is untouched', async () => {
    await protect(['*']);
    const other = await resolvers.Mutation.createMemory({}, { orgId, name: 'other' }, ctx());

    const written = await resolvers.Mutation.createNode(
      {},
      { input: { memoryId: other.id, loc: 'cor:api:010:01', name: 'N' } as never },
      ctx(),
    );
    expect(written.loc).toBe('cor:api:010:01');
  });

  it('a platform ADMIN is refused too — the gate sits above the admin short-circuit', async () => {
    // ctx() is already ADMIN. Stated as its own case because an admin bypass
    // would make the protection meaningless for exactly the principal most
    // likely to be driving an agent.
    await protect(['review']);
    expect(await genericCreate('review:x')).toBe('ERR:LOC_PROTECTED');
  });
});

describe('authorProtectedNode — the door (#1180)', () => {
  it('writes where the generic surface is refused', async () => {
    await protect(['*']);

    expect(await genericCreate('cor:api:010:01')).toBe('ERR:LOC_PROTECTED');
    expect(await authoredCreate('cor:api:010:01')).toBe('OK');

    const row = await db.node.findFirst({ where: { memoryId, loc: 'cor:api:010:01' } });
    expect(row?.name).toBe('N');
  });

  it('is create-only by default — it does not inherit an overwrite licence', async () => {
    // The bypass is about WHERE it may write, not about the create/update
    // contract. Without this, the door would quietly be the one caller that
    // can clobber a live node (#1181/#1183).
    await protect(['*']);
    expect(await authoredCreate('cor:api:010:01', 'first')).toBe('OK');
    expect(await authoredCreate('cor:api:010:01', 'second')).toBe('ERR:NodeLocConflictError');

    const row = await db.node.findFirst({ where: { memoryId, loc: 'cor:api:010:01' } });
    expect(row?.name).toBe('first');
  });

  it('upsert: true lets the authoring tool re-run over its own corpus', async () => {
    await protect(['*']);
    expect(await authoredCreate('cor:api:010:01', 'first')).toBe('OK');
    expect(await authoredCreate('cor:api:010:01', 'rewritten', true)).toBe('OK');

    const row = await db.node.findFirst({ where: { memoryId, loc: 'cor:api:010:01' } });
    expect(row?.name).toBe('rewritten');
  });

  it('still enforces write access — the bypass is the LOC gate, not the auth gate', async () => {
    // The one thing that would make this door genuinely dangerous.
    await protect(['*']);
    const outsider = await db.user.create({
      data: { id: generateId(), githubId: 11801, githubUsername: 'p1180-outsider', roles: [] },
    });

    await expect(
      resolvers.Mutation.authorProtectedNode(
        {},
        { input: { memoryId, loc: 'cor:api:010:01', name: 'N' } as never, upsert: false },
        { db, roles: [], userId: outsider.id, clientId: `user:${outsider.id}` } as Context,
      ),
    ).rejects.toThrow();

    // Scoped to the LOC: createMemory seeds a root node, so a memory-wide
    // count is not zero and would pass here for the wrong reason.
    expect(await db.node.count({ where: { memoryId, loc: 'cor:api:010:01' } })).toBe(0);
  });

  it('CANNOT write under a Channel — the bypass is source-specific, not universal', async () => {
    // @codex and @copilot, independently, both P1 on PR #1190's first revision.
    // The bypass was one boolean that skipped the WHOLE gate, so the authoring
    // door — a GUARDRAIL's door, fronted by pure routing — could write under a
    // Channel address and forge chat authorship, which is the SECURITY boundary
    // #1047 exists to provide. The PR documented that the two sources differ in
    // strength and then collapsed them in code.
    //
    // `owns: 'declared'` now exempts only a Memory.protectedLocs entry; a
    // Channel entry still refuses.
    const chatRoot = await db.node.create({
      data: { id: generateId(), memoryId, loc: 'chats:team', name: 'Team chat', tags: [] },
    });
    await db.channel.create({
      data: {
        id: generateId(),
        memoryId,
        loc: 'chats:team',
        name: 'Team chat',
        chatRootNodeId: chatRoot.id,
      },
    });

    // Declared protection is in force too — this proves the door is exempt from
    // ONE source while still refused by the other, rather than simply broken.
    await protect(['*']);
    expect(await authoredCreate('cor:api:010:01')).toBe('OK');

    expect(await authoredCreate('chats:team')).toBe('ERR:LOC_PROTECTED');
    expect(await authoredCreate('chats:team:messages:0001')).toBe('ERR:LOC_PROTECTED');
    expect(await genericCreate('chats:team:messages:0002')).toBe('ERR:LOC_PROTECTED');

    // Scoped past the fixture: the chat ROOT is seeded above, so a `chats:`-wide
    // count is 1 and would fail for the wrong reason. What must not exist is
    // anything the refused writes would have created.
    expect(
      await db.node.count({ where: { memoryId, loc: { startsWith: 'chats:team:messages' } } }),
    ).toBe(0);
  });

  it('is NOT exposed as an MCP tool — that is what keeps agents on the refused path', async () => {
    // The protection is a guardrail, and this is the mechanism that makes the
    // guardrail effective rather than decorative: an agent's node surface is
    // hadron_create_node, which refuses. Pinned because exposing this door as
    // an MCP tool later would silently undo the whole issue.
    const mcpSource = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../../mcp/server.ts', import.meta.url), 'utf8'),
    );
    expect(mcpSource).not.toContain('authorProtectedNode');
  });
});
