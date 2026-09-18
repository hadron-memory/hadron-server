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

/** Generic update with an arbitrary input — the raw form the differential test needs. */
async function genericUpdateRaw(fields: Record<string, unknown>): Promise<string> {
  try {
    await resolvers.Mutation.updateNode({}, { input: fields as never }, ctx());
    return 'OK';
  } catch (e) {
    return `ERR:${(e as { extensions?: { code?: string } }).extensions?.code ?? 'unknown'}`;
  }
}

/** Generic update — the path an agent's hadron_update_node reaches. */
const genericUpdate = (loc: string, name: string) => genericUpdateRaw({ memoryId, loc, name });

/** The authoring door for an EDIT (#1192). `fields` carries the partial update. */
async function authoredUpdate(fields: Record<string, unknown>): Promise<string> {
  try {
    await resolvers.Mutation.updateProtectedNode({}, { input: fields as never }, ctx());
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

  it('a bulk replaceSubtree cannot DELETE protected rows it was not handed', async () => {
    // @copilot, PR #1190 round 2. replaceSubtree deletes by ownerRepo, not by
    // the locs it receives — so the lock helper (which only sees INCOMING locs)
    // protects nothing on the way out. A payload containing no protected loc
    // would still wipe existing protected rows.
    await db.node.create({
      data: {
        id: generateId(),
        memoryId,
        loc: 'review:keep-me',
        name: 'Protected',
        tags: [],
        ownerRepo: 'acme/repo',
      },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId,
        loc: 'notes:replace-me',
        name: 'Ordinary',
        tags: [],
        ownerRepo: 'acme/repo',
      },
    });

    await protect(['review']);

    await resolvers.Mutation.replaceSubtree(
      {},
      {
        memoryId,
        ownerRepo: 'acme/repo',
        nodes: [{ memoryId, loc: 'notes:fresh', name: 'Fresh' }],
        edges: [],
      } as never,
      ctx(),
    );

    // The protected row survives a replacement that never mentioned it...
    expect(await db.node.findFirst({ where: { memoryId, loc: 'review:keep-me' } })).not.toBeNull();
    // ...and the ordinary one is still replaced, so this is not a no-op.
    expect(await db.node.findFirst({ where: { memoryId, loc: 'notes:replace-me' } })).toBeNull();
    expect(await db.node.findFirst({ where: { memoryId, loc: 'notes:fresh' } })).not.toBeNull();
  });

  it('a WHOLLY protected memory loses nothing to a bulk delete', async () => {
    // The `*` branch of protectedDeletionFilter, which a mutation showed was
    // otherwise unguarded. It is the branch git-sync cleanup depends on too —
    // that path is far harder to drive, and this exercises the same code.
    //
    // Why it needs its own case: the non-wildcard path builds NOT-clauses from
    // the literal loc, and `loc = '*'` / startsWith `'*:'` match nothing — so
    // without the branch the exclusion is empty and the delete takes the whole
    // memory, which is the exact inversion of what the declaration asked for.
    await db.node.create({
      data: {
        id: generateId(),
        memoryId,
        loc: 'cor:api:010:01',
        name: 'A cited rule',
        tags: [],
        ownerRepo: 'acme/repo',
      },
    });

    await protect(['*']);

    await resolvers.Mutation.replaceSubtree(
      {},
      { memoryId, ownerRepo: 'acme/repo', nodes: [], edges: [] } as never,
      ctx(),
    );

    expect(await db.node.findFirst({ where: { memoryId, loc: 'cor:api:010:01' } })).not.toBeNull();
  });

  it('PREMISE CHECK (#1192): the gate is NOT create-only, so an EDIT is refused too', async () => {
    // Measured rather than reasoned about — this is the premise the whole of
    // #1192 rests on, and it is worth a standing assertion because it is easy
    // to read the gate as a create-time check (it is named for a "write", and
    // its only door creates).
    await protect(['*']);
    expect(await authoredCreate('cor:api:010:01', 'first')).toBe('OK');

    // An ordinary edit of a node the authoring tool legitimately owns.
    expect(await genericUpdate('cor:api:010:01', 'edited')).toBe('ERR:LOC_PROTECTED');

    const row = await db.node.findFirst({ where: { memoryId, loc: 'cor:api:010:01' } });
    expect(row?.name).toBe('first');
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

describe('updateProtectedNode — the EDIT door (#1192)', () => {
  /** Seed a node through the create door, at a loc the generic surface cannot reach. */
  async function seed(loc = 'cor:api:010:01') {
    await protect(['*']);
    await resolvers.Mutation.authorProtectedNode(
      {},
      {
        input: {
          memoryId,
          loc,
          name: 'first',
          content: 'BODY',
          description: 'DESC',
          tags: ['t1'],
        } as never,
        upsert: false,
      },
      ctx(),
    );
    return db.node.findFirstOrThrow({ where: { memoryId, loc } });
  }

  it('edits where the generic update is refused', async () => {
    await seed();

    expect(await genericUpdate('cor:api:010:01', 'edited')).toBe('ERR:LOC_PROTECTED');
    expect(await authoredUpdate({ memoryId, loc: 'cor:api:010:01', name: 'edited' })).toBe('OK');

    const row = await db.node.findFirst({ where: { memoryId, loc: 'cor:api:010:01' } });
    expect(row?.name).toBe('edited');
  });

  it('PRESERVES what the caller omits — the contract the create door cannot express', async () => {
    // D4 omit-to-preserve, reached through the door. This is `spec edit`'s
    // working assumption, so it is asserted here rather than inherited from
    // updateNode's own tests: the two now share a core, and a future caller
    // passing the whole input through `authorProtectedNode` instead would
    // still satisfy every OTHER assertion in this block.
    await seed();

    expect(await authoredUpdate({ memoryId, loc: 'cor:api:010:01', name: 'renamed' })).toBe('OK');

    const row = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'cor:api:010:01' } });
    expect(row.name).toBe('renamed');
    expect(row.content).toBe('BODY');
    expect(row.description).toBe('DESC');
    expect(row.tags).toEqual(['t1']);
  });

  it('NEVER creates — a mistyped citation is refused, not fabricated', async () => {
    // The real reason this is a second door rather than `upsert: true`, and it
    // is the opposite of what #1192 assumed (it expected omitted fields to be
    // blanked; measured, they are preserved on both paths). An upsert at an
    // empty loc CREATES — so an authoring tool that routed its edits through
    // the create door would answer a typo by minting a node at a protected
    // address, in the corpus whose whole premise is that a citation is
    // permanent. The asymmetry is pinned in both directions below.
    await protect(['*']);

    expect(await authoredUpdate({ memoryId, loc: 'cor:api:999:99', name: 'typo' })).toBe(
      'ERR:NODE_NOT_FOUND',
    );
    expect(await db.node.count({ where: { memoryId, loc: 'cor:api:999:99' } })).toBe(0);

    // ...while the CREATE door's upsert does create there. Not an assertion
    // about a defect — it is the documented create/upsert contract — but it is
    // what makes routing an edit through it wrong.
    await resolvers.Mutation.authorProtectedNode(
      {},
      { input: { memoryId, loc: 'cor:api:999:99', name: 'typo' } as never, upsert: true },
      ctx(),
    );
    expect(await db.node.count({ where: { memoryId, loc: 'cor:api:999:99' } })).toBe(1);
  });

  it('takes the id selector too — the route the create door structurally lacks', async () => {
    // `id` is a forced create-PK on CreateNodeInput and THE selector on
    // UpdateNodeInput, so edit-by-PK/URN has no create-door equivalent at all.
    const seeded = await seed();

    expect(await authoredUpdate({ id: seeded.id, name: 'by-pk' })).toBe('OK');
    expect((await db.node.findFirstOrThrow({ where: { id: seeded.id } })).name).toBe('by-pk');
  });

  it('CANNOT edit under a Channel — the bypass is source-specific, not universal', async () => {
    // The create door shipped this defect in PR #1190's first revision (@codex
    // + @copilot, both P1): one boolean that skipped the whole gate, letting a
    // GUARDRAIL's door write under a SECURITY boundary's address. The edit door
    // is the second chance to make that mistake, and rewriting a chat message
    // is the sharper version of it — #1047 exists because chat authorship was
    // forgeable and not tamper-evident.
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
    const message = await db.node.create({
      data: {
        id: generateId(),
        memoryId,
        loc: 'chats:team:messages:0001',
        name: 'msg',
        content: 'as posted',
        tags: [],
      },
    });

    // Declared protection is in force too, so this proves the door is exempt
    // from ONE source while still refused by the other, rather than broken.
    await protect(['*']);
    await seed('cor:api:010:01');
    expect(await authoredUpdate({ memoryId, loc: 'cor:api:010:01', name: 'ok' })).toBe('OK');

    expect(await authoredUpdate({ memoryId, loc: 'chats:team', name: 'renamed' })).toBe(
      'ERR:LOC_PROTECTED',
    );
    expect(await authoredUpdate({ id: message.id, content: 'tampered' })).toBe('ERR:LOC_PROTECTED');

    expect((await db.node.findFirstOrThrow({ where: { id: message.id } })).content).toBe('as posted');
  });

  it('still enforces write access — the bypass is the LOC gate, not the auth gate', async () => {
    const seeded = await seed();
    const outsider = await db.user.create({
      data: { id: generateId(), githubId: 11802, githubUsername: 'p1192-outsider', roles: [] },
    });

    await expect(
      resolvers.Mutation.updateProtectedNode(
        {},
        { input: { memoryId, loc: 'cor:api:010:01', name: 'stolen' } as never },
        { db, roles: [], userId: outsider.id, clientId: `user:${outsider.id}` } as Context,
      ),
    ).rejects.toThrow();

    expect((await db.node.findFirstOrThrow({ where: { id: seeded.id } })).name).toBe('first');
  });

  it('shares ONE selector contract with updateNode — differentially, not by inspection', async () => {
    // cor:agt:020:11's shape applied to a smaller pair: two doors that must
    // decide the same thing should be ONE computation. They are
    // (`updateNodeCore`), and this pins the BEHAVIOUR rather than the sharing —
    // it catches a future copy that DRIFTS, not the act of copying (a faithful
    // copy passes, and that is the honest limit of a differential test).
    // Verified by mutation: diverging the two on the both-selectors rule fails
    // here and nowhere else, because every happy path above uses one
    // well-formed selector and cannot see the difference.
    const both = async (input: Record<string, unknown>) => [
      await genericUpdateRaw(input),
      await authoredUpdate(input),
    ];

    // Both selectors at once, and neither: the two D2 refusals.
    expect(await both({ id: 'x', memoryId, loc: 'a' })).toEqual([
      'ERR:BAD_USER_INPUT',
      'ERR:BAD_USER_INPUT',
    ]);
    expect(await both({ name: 'no selector' })).toEqual([
      'ERR:BAD_USER_INPUT',
      'ERR:BAD_USER_INPUT',
    ]);
    // A genuine miss on each selector form.
    expect(await both({ id: '00000000000000000000000000000000' })).toEqual([
      'ERR:NODE_NOT_FOUND',
      'ERR:NODE_NOT_FOUND',
    ]);
    expect(await both({ memoryId, loc: 'nothing:here' })).toEqual([
      'ERR:NODE_NOT_FOUND',
      'ERR:NODE_NOT_FOUND',
    ]);
  });

  it('is NOT exposed as an MCP tool either — the same reason as its create-side twin', async () => {
    // Pinned per door, not per issue: exposing EITHER on the agent surface
    // reopens the whole thing, and a test naming only the create door would
    // pass while the edit door sat in the tool list.
    const mcpSource = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../../mcp/server.ts', import.meta.url), 'utf8'),
    );
    expect(mcpSource).not.toContain('updateProtectedNode');
  });
});
