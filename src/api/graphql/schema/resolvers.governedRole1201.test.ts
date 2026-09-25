/**
 * #1201 — govern authored kinds by what a write PRODUCES.
 *
 * Replaces `resolvers.protectedLocs1180.test.ts`, which tested governing by
 * ADDRESS (`Memory.protectedLocs`, one day old). That axis was wrong: a task
 * node is dangerous because it is RUNNABLE, not because of where it sits. The
 * Channel half of that file — address protection, which survives and is a
 * different mechanism — is ported here rather than dropped.
 *
 * WHAT MUST HOLD, and each has its own case below because each has been got
 * wrong at least once on this feature:
 *
 *   1. The gate reads the RESULTING STATE, never what the write declares.
 *      Otherwise two legal writes evade it: create unmarked, then set the
 *      marker in a second generic update against a node that was not governed
 *      when it was written.
 *   2. Editing an ALREADY-governed node is gated even when the edit touches
 *      neither signal — the result is still a governed node.
 *   3. A door is exempt from its OWN kind only. Never a boolean: #1190 shipped
 *      that boolean and it let an authoring door write under `chats:team` and
 *      forge chat authorship (@codex + @copilot, both P1).
 *   4. NO door is an MCP tool. That absence IS the mechanism — an agent's node
 *      surface is `hadron_create_node` / `hadron_update_node`, which refuse.
 *      Asserted over the REGISTER, not per door, because nobody writes the test
 *      for the door they forgot.
 *   5. The MCP handlers are inline parity implementations of `writeNodeCore`
 *      (#206), NOT delegates — so they are driven directly here. A gate that
 *      only covered the GraphQL surface would miss the surface that matters.
 *
 * The three entries are deliberately NOT equally strong (capability / security
 * / diligence). The register records that, and `governedRole.ts` explains why;
 * tests cannot assert a strength, so the point is made where it is readable.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import {
  GOVERNED_KINDS,
  governedKindsOf,
  mergedGovernedState,
} from '../../../lib/governedRole.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let orgId: string;
let memoryId: string;
let adminId: string;

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` });

/** Every mutation here returns a code or 'OK', so a refusal reads as data. */
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return `ERR:${(e as { extensions?: { code?: string } }).extensions?.code ?? 'unknown'}`;
  }
}

const genericCreate = (input: Record<string, unknown>) =>
  code(resolvers.Mutation.createNode({}, { input: { memoryId, ...input } as never }, ctx()));

const genericUpdate = (input: Record<string, unknown>) =>
  code(resolvers.Mutation.updateNode({}, { input: input as never }, ctx()));

const door = (name: string, input: Record<string, unknown>) =>
  code(
    (resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](
      {},
      { input: { memoryId, ...input } },
      ctx(),
    ),
  );

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'gov-org', urn: 'gov-org.test' },
  });
  orgId = org.id;
  const admin = await db.user.create({
    data: { id: generateId(), githubId: 12010, githubUsername: 'gov-admin', roles: ['ADMIN'] },
  });
  adminId = admin.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  memoryId = (await resolvers.Mutation.createMemory({}, { orgId, name: 'corpus' }, ctx())).id;
});

describe('the register — small, closed, and unequal on purpose', () => {
  it('governs exactly three kinds, two by role and one by capability', () => {
    expect(GOVERNED_KINDS.map((k) => k.kind).sort()).toEqual(['review', 'spec', 'task']);
    // The task entry keys on the CAPABILITY, not on a label. If this ever flips
    // to `role: 'task'` the security case is gone — a label can be omitted for
    // free, and omitting it would then buy a runnable node nobody gated.
    expect(GOVERNED_KINDS.find((k) => k.kind === 'task')!.signal).toEqual({
      field: 'isRunnable',
    });
  });

  it('leaves every UNgoverned role inert — the field is open', () => {
    expect(governedKindsOf({ role: 'weather-widget' })).toEqual([]);
    expect(governedKindsOf({ role: 'special' })).toEqual([]);
    expect(governedKindsOf({ role: 'specification' })).toEqual([]);
    expect(governedKindsOf({ role: null })).toEqual([]);
    expect(governedKindsOf({})).toEqual([]);
  });

  it('governs dotted descendants by the base role, on a dot boundary', () => {
    expect(governedKindsOf({ role: 'spec.rule' }).map((k) => k.kind)).toEqual(['spec']);
    expect(governedKindsOf({ role: 'spec.rule.detail' }).map((k) => k.kind)).toEqual(['spec']);
    expect(governedKindsOf({ role: 'review.security' }).map((k) => k.kind)).toEqual(['review']);
  });

  it('matches BOTH kinds for a runnable review — governance is not exclusive', () => {
    expect(governedKindsOf({ role: 'review', isRunnable: true }).map((k) => k.kind).sort()).toEqual([
      'review',
      'task',
    ]);
  });
});

describe('the generic surface is refused, per kind', () => {
  it('refuses a create that would produce a governed node', async () => {
    expect(await genericCreate({ loc: 'a:1', name: 'n', role: 'review' })).toBe('ERR:ROLE_GOVERNED');
    expect(await genericCreate({ loc: 'a:2', name: 'n', role: 'spec' })).toBe('ERR:ROLE_GOVERNED');
    expect(await genericCreate({ loc: 'a:2:rule', name: 'n', role: 'spec.rule' })).toBe(
      'ERR:ROLE_GOVERNED',
    );
    expect(await genericCreate({ loc: 'a:2:detail', name: 'n', role: 'spec.rule.detail' })).toBe(
      'ERR:ROLE_GOVERNED',
    );
    expect(await genericCreate({ loc: 'a:3', name: 'n', isRunnable: true })).toBe(
      'ERR:ROLE_GOVERNED',
    );
  });

  it('leaves ordinary writes alone — the gate is not a blanket refusal', async () => {
    // The opposite failure: a gate refusing everything satisfies every
    // assertion above while breaking the product.
    expect(await genericCreate({ loc: 'b:1', name: 'n' })).toBe('OK');
    expect(await genericCreate({ loc: 'b:2', name: 'n', role: 'weather-widget' })).toBe('OK');
    expect(await genericCreate({ loc: 'b:3', name: 'n', isRunnable: false })).toBe('OK');
  });

  it('refuses the TWO-STEP evasion: create unmarked, then mark', async () => {
    // Worth having, but NOT for the reason I first wrote on it. I claimed this
    // was "the case the resulting-state rule exists for" — a mutation making
    // the gate read the INPUT instead of the merged state left this test GREEN
    // and failed only the one below. Step 2 *does* declare the marker, so an
    // input-reading gate catches it too.
    //
    // What this actually pins is that the second step is refused at all: the
    // create being legal must not buy a later promotion. The resulting-state
    // rule earns its keep on EXISTING governed nodes — the next case.
    expect(await genericCreate({ loc: 'c:1', name: 'n' })).toBe('OK');
    expect(await genericUpdate({ memoryId, loc: 'c:1', isRunnable: true })).toBe(
      'ERR:ROLE_GOVERNED',
    );
    expect(await genericUpdate({ memoryId, loc: 'c:1', role: 'review' })).toBe('ERR:ROLE_GOVERNED');

    const row = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'c:1' } });
    expect(row.isRunnable).not.toBe(true);
    expect(row.role).toBeNull();
  });

  it('refuses an edit to an ALREADY-governed node that touches neither signal', async () => {
    // THE case the resulting-state rule exists for, established by mutation
    // rather than asserted: making the gate read the input instead of the
    // merged state fails HERE and nowhere else. The edit mentions neither
    // signal, so an input-reading gate sees an ordinary write — while the
    // result is still a review node.
    //
    // Which is the attack the review entry exists for: a safety check that can
    // be rewritten through the generic surface is not a check.
    expect(await door('createReviewNode', { loc: 'd:1', name: 'check', role: 'review' })).toBe('OK');

    expect(await genericUpdate({ memoryId, loc: 'd:1', name: 'tampered' })).toBe(
      'ERR:ROLE_GOVERNED',
    );
    expect(await genericUpdate({ memoryId, loc: 'd:1', content: 'tampered' })).toBe(
      'ERR:ROLE_GOVERNED',
    );

    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'd:1' } })).name).toBe('check');
  });
});

describe('the doors', () => {
  it('each writes its own kind where the generic surface is refused', async () => {
    expect(await door('createSpecNode', { loc: 'e:1', name: 'n', role: 'spec' })).toBe('OK');
    expect(await door('createSpecNode', { loc: 'e:1:rule', name: 'n', role: 'spec.rule' })).toBe('OK');
    expect(await door('createSpecNode', { loc: 'e:1:detail', name: 'n', role: 'spec.rule.detail' })).toBe('OK');
    expect(await door('createReviewNode', { loc: 'e:2', name: 'n', role: 'review' })).toBe('OK');
    expect(await door('createTaskNode', { loc: 'e:3', name: 'n', isRunnable: true })).toBe('OK');

    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'e:1' } })).role).toBe('spec');
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'e:1:rule' } })).role).toBe('spec.rule');
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'e:1:detail' } })).role).toBe('spec.rule.detail');
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'e:3' } })).isRunnable).toBe(
      true,
    );
  });

  it('the owning door can move within its dotted family; generic edits still cannot', async () => {
    expect(await door('createSpecNode', { loc: 'e:4', name: 'n', role: 'spec.rule' })).toBe('OK');
    expect(await genericUpdate({ memoryId, loc: 'e:4', content: 'generic edit' })).toBe(
      'ERR:ROLE_GOVERNED',
    );
    expect(
      await door('updateSpecNode', {
        memoryId,
        loc: 'e:4',
        role: 'spec.rule.detail',
        content: 'door edit',
      }),
    ).toBe('OK');
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'e:4' } })).role).toBe(
      'spec.rule.detail',
    );
  });

  it('is exempt from its OWN kind only — never a universal bypass', async () => {
    // The #1190 P1 in its new clothes. A door that skipped the whole gate would
    // satisfy every "writes its own kind" assertion above.
    expect(await door('createSpecNode', { loc: 'f:1', name: 'n', role: 'review' })).toBe(
      'ERR:ROLE_GOVERNED',
    );
    expect(await door('createReviewNode', { loc: 'f:2', name: 'n', role: 'spec' })).toBe(
      'ERR:ROLE_GOVERNED',
    );
    // And the sharpest pair: neither label door may mint something RUNNABLE.
    expect(await door('createSpecNode', { loc: 'f:3', name: 'n', isRunnable: true })).toBe(
      'ERR:ROLE_GOVERNED',
    );
    expect(await door('createReviewNode', { loc: 'f:4', name: 'n', isRunnable: true })).toBe(
      'ERR:ROLE_GOVERNED',
    );
    // ...nor may the task door mint a review.
    expect(await door('createTaskNode', { loc: 'f:5', name: 'n', role: 'review' })).toBe(
      'ERR:ROLE_GOVERNED',
    );
  });

  it('a RUNNABLE REVIEW needs both kinds, so no single door can author it', async () => {
    // Governance is not exclusive, and the conservative reading is the safe
    // one: a caller must own every kind the result matches.
    expect(
      await door('createReviewNode', { loc: 'g:1', name: 'n', role: 'review', isRunnable: true }),
    ).toBe('ERR:ROLE_GOVERNED');
    expect(
      await door('createTaskNode', { loc: 'g:2', name: 'n', role: 'review', isRunnable: true }),
    ).toBe('ERR:ROLE_GOVERNED');
  });

  it('the update doors edit their own kind, and preserve on omit', async () => {
    expect(
      await door('createSpecNode', { loc: 'h:1', name: 'first', role: 'spec', content: 'BODY' }),
    ).toBe('OK');

    expect(
      await code(
        (resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)
          .updateSpecNode({}, { input: { memoryId, loc: 'h:1', name: 'edited' } }, ctx()),
      ),
    ).toBe('OK');

    const row = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'h:1' } });
    expect(row.name).toBe('edited');
    expect(row.content).toBe('BODY');
    expect(row.role).toBe('spec');
  });

  it('still enforces write access — a door is not an auth bypass', async () => {
    const outsider = await db.user.create({
      data: { id: generateId(), githubId: 12011, githubUsername: 'gov-outsider', roles: [] },
    });
    await expect(
      (
        resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
      ).createSpecNode(
        {},
        { input: { memoryId, loc: 'i:1', name: 'n', role: 'spec' } },
        { db, roles: [], userId: outsider.id, clientId: `user:${outsider.id}` } as Context,
      ),
    ).rejects.toThrow();
    expect(await db.node.count({ where: { memoryId, loc: 'i:1' } })).toBe(0);
  });

  it('CANNOT write under a Channel — address protection is a separate gate', async () => {
    // The two mechanisms must stay independent. A door exempt from its own KIND
    // is still fully subject to a Channel's ADDRESS, or the review door becomes
    // a way to forge a chat message — which is exactly what the #1190 boolean
    // allowed.
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

    for (const d of ['createSpecNode', 'createReviewNode', 'createTaskNode']) {
      const kind = d === 'createTaskNode' ? { isRunnable: true } : { role: d === 'createSpecNode' ? 'spec' : 'review' };
      expect(await door(d, { loc: 'chats:team:messages:0001', name: 'forged', ...kind })).toBe(
        'ERR:LOC_PROTECTED',
      );
    }
    expect(
      await db.node.count({ where: { memoryId, loc: { startsWith: 'chats:team:messages' } } }),
    ).toBe(0);
  });
});

describe('the MCP surface — the threat this exists for', () => {
  it('SPEC has no MCP tool, and task/review DO — the rule follows the threat', async () => {
    // The absence rule was written for one threat: an agent reaching for the
    // GENERIC tool by habit. That is still exactly right for spec, whose
    // authoring surface is `hadron spec` in the CLI — so neither spec door
    // appears here. It was wrong for the other two, and the register's own
    // strength column says why:
    //
    //   - TASK's threat is a PRINCIPAL (#1202), not a tool. A door no
    //     legitimate surface can reach does not mitigate it; it just removes
    //     the ability to author tasks, which is how this platform's own task
    //     corpus is written.
    //   - REVIEW is a component of any task or run rather than a coding
    //     convenience, so the agent doing the work must be able to author one.
    //
    // What still protects all three is unchanged and asserted elsewhere in this
    // file: the GENERIC surface refuses, so producing a governed node takes a
    // deliberate switch of tool.
    const mcpSource = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../../mcp/server.ts', import.meta.url), 'utf8'),
    );
    const spec = GOVERNED_KINDS.find((k) => k.kind === 'spec')!;
    expect(mcpSource).not.toContain(spec.doors.create);
    expect(mcpSource).not.toContain(spec.doors.update);

    // ...and the two that DO have tools have all four of them. Driven off the
    // register so a kind added without its tools fails here rather than
    // shipping unreachable.
    for (const kind of ['task', 'review'] as const) {
      expect(mcpSource).toContain(`'hadron_create_${kind}'`);
      expect(mcpSource).toContain(`'hadron_update_${kind}'`);
    }
  });

  it('the MCP doors set the governed signal themselves — the caller cannot disagree', async () => {
    // The tool IS the statement of intent, so accepting `role` or `isRunnable`
    // as an argument would let the two disagree — a node authored as one kind
    // and labelled another. The signal is derived from the register entry.
    const mcpSource = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../../mcp/server.ts', import.meta.url), 'utf8'),
    );
    const args = mcpSource.slice(
      mcpSource.indexOf('const governedDoorArgs = {'),
      mcpSource.indexOf('};', mcpSource.indexOf('const governedDoorArgs = {')),
    );
    expect(args).not.toContain('role:');
    expect(args).not.toContain('isRunnable:');
  });

  it('hadron_create_node and hadron_update_node carry the gate themselves', async () => {
    // They are INLINE parity implementations of writeNodeCore (#206), not
    // delegates — so a gate added only to the resolver would leave the agent
    // surface open. Asserted structurally because driving the MCP handlers
    // needs a full auth context; what matters is that the call exists in both.
    const mcpSource = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../../mcp/server.ts', import.meta.url), 'utf8'),
    );
    const calls = mcpSource.split('assertGovernedWrite(').length - 1;
    expect(calls).toBeGreaterThanOrEqual(2);

    // ...and neither ever claims to own a kind: there is no MCP door.
    //
    // Checked against CODE, not the file — the first version of this assertion
    // failed on the word `ownsKind` inside the comment explaining that MCP
    // never passes one. A guard that cannot tell prose from code reports the
    // documentation as the defect (@Gil's #564 lesson, reached from the other
    // side). Stripping comments is the cheap version of parsing and is enough
    // here: what would matter is the property form, `ownsKind:`.
    const codeOnly = mcpSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(codeOnly).toContain('assertGovernedWrite(');
    expect(codeOnly).not.toContain('ownsKind');
  });
});

describe('mergedGovernedState — omit preserves, null clears (D4)', () => {
  // The merge is the part that is easy to get subtly wrong: `undefined` and
  // `null` mean different things here and a `??` chain collapses them, which
  // would silently make "clear the role" preserve it instead.
  const existing = { role: 'review', isRunnable: true };

  it('preserves what the input omits', () => {
    expect(mergedGovernedState(existing, {})).toEqual({ role: 'review', isRunnable: true });
  });

  it('clears on explicit null', () => {
    expect(mergedGovernedState(existing, { role: null })).toEqual({
      role: null,
      isRunnable: true,
    });
  });

  it('replaces on a value, and treats a missing row as empty', () => {
    expect(mergedGovernedState(existing, { role: 'spec' }).role).toBe('spec');
    expect(mergedGovernedState(null, {})).toEqual({ role: null, isRunnable: null });
  });
});

describe('the bypasses review found — each was a way in the gate did not cover', () => {
  it('RESURRECTION: a soft-deleted governed node cannot be revived by a generic create', async () => {
    // @codex P1. `createNode` resurrects a soft-deleted row at the target loc
    // and PRESERVES the fields the caller omits — so a create is not always a
    // create. Soft-delete a review, create at the same loc naming neither
    // signal, and an input-only check saw an ordinary create while the write
    // revived a still-governed node with fresh content.
    //
    // The fix is to merge on EVERY mode rather than special-case the tombstone:
    // with no row the merge is the input, and a live row is refused by the mode
    // gate anyway.
    expect(await door('createReviewNode', { loc: 'z:1', name: 'check', role: 'review' })).toBe('OK');
    const id = (await db.node.findFirstOrThrow({ where: { memoryId, loc: 'z:1' } })).id;
    await db.node.update({ where: { id }, data: { deletedAt: new Date() } });

    expect(await genericCreate({ loc: 'z:1', name: 'revived', content: 'mine' })).toBe(
      'ERR:ROLE_GOVERNED',
    );

    const row = await db.node.findFirstOrThrow({ where: { id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.content).toBeNull();
    expect(row.role).toBe('review');
  });

  it('...and the review door may still resurrect its own', async () => {
    // The opposite failure: refusing every resurrection would satisfy the case
    // above while making a soft-deleted review permanently unrecoverable.
    expect(await door('createReviewNode', { loc: 'z:2', name: 'check', role: 'review' })).toBe('OK');
    const id = (await db.node.findFirstOrThrow({ where: { memoryId, loc: 'z:2' } })).id;
    await db.node.update({ where: { id }, data: { deletedAt: new Date() } });

    expect(await door('createReviewNode', { loc: 'z:2', name: 'again', role: 'review' })).toBe('OK');
    expect((await db.node.findFirstOrThrow({ where: { id } })).deletedAt).toBeNull();
  });

  it('BULK SEARCH-REPLACE skips governed nodes instead of rewriting them', async () => {
    // @codex P1. searchReplaceInNodes writes with `tx.node.update` and never
    // reached the gate, so hadron_replace_text could rewrite a review or a
    // runnable task through a generic tool. Skipped rather than refused,
    // matching how the Channel gate treats bulk paths — failing a whole batch
    // on one governed row makes the tool unusable on any memory containing one.
    expect(await genericCreate({ loc: 'y:1', name: 'ordinary', content: 'OLD here' })).toBe('OK');
    expect(
      await door('createReviewNode', { loc: 'y:2', name: 'check', role: 'review', content: 'OLD here' }),
    ).toBe('OK');

    await resolvers.Mutation.searchReplaceInNodes(
      {},
      { input: { oldText: 'OLD', newText: 'NEW', memoryIds: [memoryId], fields: ['content'] } } as never,
      ctx(),
    );

    // The ordinary node changed...
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'y:1' } })).content).toContain(
      'NEW',
    );
    // ...and the review did not. Asserting BOTH, because a no-op replace would
    // satisfy the second alone.
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'y:2' } })).content).toContain(
      'OLD',
    );
  });

  it('a revision RESTORES the role it captured', async () => {
    // @codex + @copilot. `role` was captured but not restored, so restoring a
    // pre-review snapshot left the live node still marked as a review — the
    // restore silently disagreeing with the revision it claims to reproduce.
    expect(await genericCreate({ loc: 'x:1', name: 'plain' })).toBe('OK');
    const id = (await db.node.findFirstOrThrow({ where: { memoryId, loc: 'x:1' } })).id;

    // Become a review (through its door), which snapshots the pre-edit state.
    expect(
      await code(
        (resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)
          .updateReviewNode({}, { input: { id, role: 'review' } }, ctx()),
      ),
    ).toBe('OK');
    expect((await db.node.findFirstOrThrow({ where: { id } })).role).toBe('review');

    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: id } });
    expect(rev.role).toBeNull();

    // #1201 round 3: the restore is now REFUSED, because the node IS a review
    // at the time of the write. Restoring a pre-review revision would have
    // CLEARED the role — the un-governing escalation, reached through a generic
    // mutation. The revision still captures the role (asserted above); what
    // changed is that replaying it needs a door, and no door has a restore
    // variant yet (#1204).
    await expect(
      resolvers.Mutation.restoreNodeRevision({}, { revisionId: rev.id } as never, ctx()),
    ).rejects.toThrow();
    expect((await db.node.findFirstOrThrow({ where: { id } })).role).toBe('review');
  });

  it('UN-GOVERNING through the generic surface is refused — before UNION after', async () => {
    // Measured before it was fixed: `updateNode(role: null)` cleared a review
    // and `isRunnable: false` cleared a task, both SUCCEEDING. A gate reading
    // only the RESULT sees an ordinary write, and the safety check evaporates.
    //
    // That is the escalation #1202 describes — except #1202 assumes the door
    // was required to reach it, and it was not. Requiring the kind's door to
    // remove its own marker is a ROUTING rule, so it belongs here; who may then
    // do it through that door is still #1202's question.
    expect(await door('createReviewNode', { loc: 'w:1', name: 'check', role: 'review' })).toBe('OK');
    expect(await genericUpdate({ memoryId, loc: 'w:1', role: null })).toBe('ERR:ROLE_GOVERNED');
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'w:1' } })).role).toBe('review');

    expect(await door('createTaskNode', { loc: 'w:2', name: 'task', isRunnable: true })).toBe('OK');
    expect(await genericUpdate({ memoryId, loc: 'w:2', isRunnable: false })).toBe(
      'ERR:ROLE_GOVERNED',
    );
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'w:2' } })).isRunnable).toBe(
      true,
    );

    // ...and the kind's OWN door may still do it, or a governed node could
    // never be retired at all.
    expect(
      await code(
        (resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)
          .updateReviewNode({}, { input: { memoryId, loc: 'w:1', role: null } }, ctx()),
      ),
    ).toBe('OK');
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'w:1' } })).role).toBeNull();
  });
});

describe('the MCP handlers, driven for real — they are parity implementations, not delegates', () => {
  // Structural assertions elsewhere in this file prove the gate CALL exists in
  // mcp/server.ts. These prove it WORKS, which is a different claim — and the
  // difference is exactly what round 2 of review caught: the call was there and
  // read only the input, so it passed every structural check while leaving the
  // resurrection bypass open on the surface agents actually use.
  const mcp = () =>
    createTestableMcpServer({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
  const nodeUrn = (loc: string) => `hrn:node:gov-org.test:corpus:${loc}`;

  it('hadron_create_node refuses a governed create', async () => {
    const text = await mcp().callToolText('hadron_create_node', {
      urn: nodeUrn('m:1'),
      name: 'n',
      role: 'review',
    });
    expect(text).toContain('[role_governed]');
    expect(await db.node.count({ where: { memoryId, loc: 'm:1' } })).toBe(0);
  });

  it('hadron_create_node cannot RESURRECT a tombstoned governed node', async () => {
    // @copilot round 2, and the same defect as the GraphQL one a commit
    // earlier: I fixed one consumer of the shared rule and not the other.
    expect(await door('createReviewNode', { loc: 'm:2', name: 'check', role: 'review' })).toBe('OK');
    const id = (await db.node.findFirstOrThrow({ where: { memoryId, loc: 'm:2' } })).id;
    await db.node.update({ where: { id }, data: { deletedAt: new Date() } });

    const text = await mcp().callToolText('hadron_create_node', {
      urn: nodeUrn('m:2'),
      name: 'revived',
      content: 'mine',
    });
    expect(text).toContain('[role_governed]');

    const row = await db.node.findFirstOrThrow({ where: { id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.content).toBeNull();
  });

  it('hadron_update_node refuses an edit to a governed node', async () => {
    expect(await door('createTaskNode', { loc: 'm:3', name: 'task', isRunnable: true })).toBe('OK');
    const text = await mcp().callToolText('hadron_update_node', {
      urn: nodeUrn('m:3'),
      description: 'tampered',
    });
    expect(text).toContain('[role_governed]');
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'm:3' } })).description).toBeNull();
  });

  it('hadron_create_parent_node cannot rewrite a governed node either', async () => {
    // @copilot round 2. It writes through a RAW upsert whose update branch
    // preserves omitted fields, so pointed at an existing review it rewrote the
    // node while keeping its role — a generic surface editing a governed node.
    expect(await door('createReviewNode', { loc: 'm:4', name: 'check', role: 'review' })).toBe('OK');
    const text = await mcp().callToolText('hadron_create_parent_node', {
      urn: nodeUrn('m:4'),
      name: 'hijacked',
    });
    expect(text).toContain('[role_governed]');
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'm:4' } })).name).toBe('check');
  });

  it('...and still creates an ordinary parent node', async () => {
    // The opposite failure: gating every parent-node write would satisfy the
    // case above while breaking the tool.
    const text = await mcp().callToolText('hadron_create_parent_node', {
      urn: nodeUrn('m:5'),
      name: 'ordinary parent',
    });
    expect(text).not.toContain('[role_governed]');
    expect(await db.node.count({ where: { memoryId, loc: 'm:5' } })).toBe(1);
  });

  it('a create through a door without a name is refused at the TOOL, not deeper', async () => {
    // `name` is optional in the shared arg set because an update preserves it,
    // and these tools call the resolver directly — so GraphQL's `String!` never
    // gets a chance to speak (@copilot). Without the explicit check the
    // omission surfaced from somewhere deeper, naming neither the field nor the
    // tool.
    const text = await mcp().callToolText('hadron_create_review', { urn: nodeUrn('m:7') });
    expect(text).toContain('"name" is required');
    expect(text).toContain('hadron_create_review');
    expect(await db.node.count({ where: { memoryId, loc: 'm:7' } })).toBe(0);
  });

  it('...and an UPDATE without a name is fine, because it preserves', async () => {
    expect(await door('createReviewNode', { loc: 'm:8', name: 'keep me', role: 'review' })).toBe('OK');
    const text = await mcp().callToolText('hadron_update_review', {
      urn: nodeUrn('m:8'),
      description: 'touched',
    });
    expect(text).not.toContain('"name" is required');
    const row = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'm:8' } });
    expect(row.name).toBe('keep me');
    expect(row.description).toBe('touched');
  });

  it('a governed node READS back with its role, so a caller can tell which door applies', async () => {
    expect(await door('createReviewNode', { loc: 'm:6', name: 'check', role: 'review' })).toBe('OK');
    const text = await mcp().callToolText('hadron_get_node', { urn: nodeUrn('m:6') });
    expect(text).toContain('Role: review');
  });
});

describe('refusal ORDER — the remedy has to be one the caller can follow (@copilot)', () => {
  it('a create over a LIVE governed node reports the COLLISION, not the door', async () => {
    // The governed gate ran first and answered ROLE_GOVERNED, naming a create
    // door — which cannot create over a live node either, so the remedy could
    // not be followed. The collision is the real answer here.
    expect(await door('createReviewNode', { loc: 'o:1', name: 'check', role: 'review' })).toBe('OK');
    expect(await genericCreate({ loc: 'o:1', name: 'again' })).toBe('ERR:NodeLocConflictError');
  });

  it('...but an UPDATE to a governed node still names the door', async () => {
    // The opposite order, and the reason this is a per-mode decision rather
    // than a blanket one: for an update "you need the review door" is exactly
    // what the caller can act on.
    expect(await door('createReviewNode', { loc: 'o:2', name: 'check', role: 'review' })).toBe('OK');
    expect(await genericUpdate({ memoryId, loc: 'o:2', name: 'x' })).toBe('ERR:ROLE_GOVERNED');
  });

  it('and a create over a TOMBSTONED governed node still reports the door', async () => {
    // The resurrection case is NOT a collision — the mode gate lets a tombstone
    // through — so the governed refusal is both correct and followable there.
    // Without this, hoisting the collision check could have been widened to all
    // creates and quietly reopened the resurrection bypass.
    expect(await door('createReviewNode', { loc: 'o:3', name: 'check', role: 'review' })).toBe('OK');
    const id = (await db.node.findFirstOrThrow({ where: { memoryId, loc: 'o:3' } })).id;
    await db.node.update({ where: { id }, data: { deletedAt: new Date() } });

    expect(await genericCreate({ loc: 'o:3', name: 'revived' })).toBe('ERR:ROLE_GOVERNED');
  });
});

describe('the refusal says WHICH way the write touched governance (@copilot)', () => {
  // The message said a write "would produce" a governed node even when it was
  // CLEARING one — plainly wrong for `updateNode(role: null)`, where the result
  // is explicitly not a review. The gate went before-union-after and the
  // sentence did not follow it.
  async function refusal(p: Promise<unknown>) {
    try {
      await p;
      throw new Error('expected a refusal');
    } catch (e) {
      return e as { message: string; extensions?: { refusal?: string } };
    }
  }

  it('PRODUCES — a generic write that would create governance', async () => {
    const e = await refusal(
      resolvers.Mutation.createNode(
        {},
        { input: { memoryId, loc: 'p:1', name: 'n', role: 'review' } } as never,
        ctx(),
      ),
    );
    expect(e.extensions?.refusal).toBe('produces');
    expect(e.message).toContain('would produce');
  });

  it('REMOVES — a generic write that would un-govern', async () => {
    expect(await door('createReviewNode', { loc: 'p:2', name: 'check', role: 'review' })).toBe('OK');
    const e = await refusal(
      resolvers.Mutation.updateNode({}, { input: { memoryId, loc: 'p:2', role: null } } as never, ctx()),
    );
    expect(e.extensions?.refusal).toBe('removes');
    expect(e.message).toContain('un-governing');
    expect(e.message).not.toContain('would produce');
  });

  it('EDITS — a generic write against a node that stays governed', async () => {
    expect(await door('createReviewNode', { loc: 'p:3', name: 'check', role: 'review' })).toBe('OK');
    const e = await refusal(
      resolvers.Mutation.updateNode({}, { input: { memoryId, loc: 'p:3', name: 'x' } } as never, ctx()),
    );
    expect(e.extensions?.refusal).toBe('edits');
    expect(e.message).toContain('edits');
    expect(e.message).not.toContain('would produce');
  });
});
