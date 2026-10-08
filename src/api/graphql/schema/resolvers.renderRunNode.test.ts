/**
 * #818 — `renderRunNode`, the GraphQL twin of `hadron_run_action` (which,
 * despite the name, executes nothing — it loads, resolves dependency edges,
 * and renders).
 *
 * The property that matters most is the LAST describe: the preview must be
 * byte-identical to what the MCP run tools produce. A preview that disagrees
 * with the run is worse than no preview, which is why both surfaces now call
 * one shared `renderRunNodeBundle`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { assembleRunNodePrompt } from '../../../lib/runNodeRender.js';
import { compileTemplate } from '../../../lib/template.js';
import { drainNodeUsage } from '../../../lib/usageRecorder.js';

/**
 * Wait for the fire-and-forget usage recorder to write a read event for each of
 * `ids` (#1069).
 *
 * Scoped to THESE node ids on purpose. The previous form polled an unscoped
 * `count({ type: 'read' }) >= n`, which any read event satisfies — including
 * stale ones from another test — so the wait could finish before this test's
 * own writes landed and the assertion would then read somebody else's rows.
 * That is the #1069 flake: `expected [ null, null ] to include <id>`, where the
 * nulls are `nodeId` blanked by the node FK's `SetNull`.
 *
 * A count is the wrong question. "Have MY events arrived?" is the right one, and
 * it is the question `mcp/server.batchRead.test.ts` was already asking — which
 * is why that file never flaked.
 */
async function waitForReads(ids: string[]): Promise<void> {
  let seen: string[] = [];
  for (let i = 0; i < 50; i++) {
    seen = (
      await db.usageEvent.findMany({
        where: { type: 'read', nodeId: { in: ids } },
        select: { nodeId: true },
        distinct: ['nodeId'],
      })
    ).map((r) => r.nodeId!);
    if (seen.length >= ids.length) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  // Throw rather than fall through (@copilot, PR #1138). Falling through hands
  // the failure to whatever assertion runs next, which reports a missing id and
  // not the fact that the recorder never wrote — and a future edit that stops
  // asserting on the ids would turn a broken recorder into a passing test.
  const missing = ids.filter((id) => !seen.includes(id));
  throw new Error(
    `Timed out after 1s waiting for read UsageEvents on ${missing.length} node(s): ` +
      `${missing.join(', ')}. Recording is fire-and-forget, so either it never ran or it failed ` +
      `silently in the recorder's .catch().`,
  );
}

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const Q = resolvers.Query as any;

const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context =>
  ({ db, userId, roles });

let org: { id: string; urn: string };
let member: { id: string };
let stranger: { id: string };
let mem: { id: string; urn: string };
let action: { id: string; loc: string };
let dep: { id: string; loc: string };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'rr', urn: `rr-${generateId()}` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 51101, githubUsername: 'rr-member' } });
  stranger = await db.user.create({ data: { id: generateId(), githubId: 51102, githubUsername: 'rr-stranger' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' } });
  mem = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`,
      name: 'rr mem', class: 'knowledge', visibility: 'ORGANIZATION',
    },
  });
  action = await createDbNode(db, {
    loc: 'actions:review', memoryId: mem.id, name: 'Review',
    content: 'Review the {{subject}} carefully.',
  });
  dep = await createDbNode(db, {
    loc: 'reference:playbook', memoryId: mem.id, name: 'Playbook',
    content: 'PLAYBOOK BODY',
  });
  await db.edge.create({
    data: {
      id: generateId(), memoryId: mem.id, sourceId: action.id, targetId: dep.id,
      name: 'documents', loc: 'actions:review:documents:reference:playbook',
    },
  });
});

it('#1189 drains the MCP action-run writer before cleanDb deletes its FK parents', async () => {
  const { createTestableMcpServer } = await import('../../../mcp/server.js');
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const pass = db.usageEvent.create.bind(db.usageEvent);
  const slow = vi.spyOn(db.usageEvent, 'create').mockImplementation((async (args: Parameters<typeof pass>[0]) => {
    if (args.data.type === 'action-run') { enter(); await held; }
    return pass(args);
  }) as unknown as typeof db.usageEvent.create);
  let cleanup: Promise<void> | undefined;
  let done = false;
  const firstDelete = vi.spyOn(db.pendingLoginState, 'deleteMany');
  try {
    const server = createTestableMcpServer({ userId: member.id, roles: ['READER'], clientId: `user:${member.id}` });
    await server.callToolText('hadron_run_action', { urn: `hrn:node:${mem.urn}:${action.loc}`, args: { subject: 'cleanup boundary' } });
    await entered;
    await waitForReads([action.id, dep.id]);
    cleanup = cleanDb(db).then(() => { done = true; });
    // Let ordinary recorder work settle; the held action-run must still block cleanup.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(firstDelete).not.toHaveBeenCalled();
    expect(done).toBe(false);
    expect(await db.node.findUnique({ where: { id: action.id } })).not.toBeNull();
    release();
    await cleanup;
    expect(await db.usageEvent.count()).toBe(0);
  } finally {
    release();
    await cleanup;
    await drainNodeUsage(db);
    slow.mockRestore();
    firstDelete.mockRestore();
  }
});

const render = (nodeRef: string, args?: Record<string, unknown>, c: Context = ctx(member.id)) =>
  Q.renderRunNode(null, { nodeRef, args }, c);

describe('renderRunNode — the render half of the run pipeline (#818)', () => {
  it('substitutes args and inlines referenced-node content', async () => {
    const out = await render(action.id, { subject: 'incident report' });
    expect(out).toContain('# Node: Review');
    expect(out).toContain('Review the incident report carefully.');
    expect(out).toContain('# Referenced Nodes');
    expect(out).toContain('PLAYBOOK BODY');
  });

  it('renders an unsupplied variable as EMPTY, exactly as runTask does', async () => {
    // Changed by the #858 review: the preview now assembles with Mustache via
    // compileTemplate, like the executor, instead of a literal replaceAll. A
    // missing variable therefore collapses to '' rather than surviving as
    // `{{subject}}` — which is what the real run would send to the LLM.
    const out = await render(action.id);
    expect(out).not.toContain('{{subject}}');
    expect(out).toContain('Review the  carefully.');
  });

  it('does NOT inline flow-ROUTING edges (they are rails, not references)', async () => {
    // runTask skips `next*` edges so a multi-node flow does not pollute every
    // hop with the following step's prompt. The legacy MCP bundle inlined
    // them; the preview must not.
    const nextStep = await createDbNode(db, {
      loc: 'flow:step2', memoryId: mem.id, name: 'Step 2', content: 'NEXT STEP PROMPT',
    });
    await db.edge.create({
      data: {
        id: generateId(), memoryId: mem.id, sourceId: action.id, targetId: nextStep.id,
        name: 'next', loc: 'actions:review:next:flow:step2',
      },
    });
    const out = await render(action.id, { subject: 'x' });
    expect(out).not.toContain('NEXT STEP PROMPT');
    // ...while a genuine reference edge is still inlined.
    expect(out).toContain('PLAYBOOK BODY');
  });

  it('omits the Referenced Nodes section when nothing is linked', async () => {
    const solo = await createDbNode(db, {
      loc: 'actions:solo', memoryId: mem.id, name: 'Solo', content: 'Just this.',
    });
    const out = await render(solo.id);
    expect(out).toContain('Just this.');
    expect(out).not.toContain('# Referenced Nodes');
  });

  it('accepts a fully-qualified URN as well as a PK (cor:api:140)', async () => {
    const urn = `${mem.urn.replace(':', '::')}::${action.loc}`;
    expect(await render(urn, { subject: 'x' })).toContain('# Node: Review');
  });

  it('coerces non-string args rather than rendering [object Object]', async () => {
    const numbered = await createDbNode(db, {
      loc: 'actions:n', memoryId: mem.id, name: 'N', content: 'count={{count}} flag={{flag}}',
    });
    const out = await render(numbered.id, { count: 3, flag: true });
    expect(out).toContain('count=3');
    expect(out).toContain('flag=true');
  });
});

describe('renderRunNode — it is a READ (#818)', () => {
  it('records NO action-run UsageEvent, unlike the MCP tool', async () => {
    await render(action.id, { subject: 'x' });
    // Metering a preview would inflate the ledger with actions nobody took.
    expect(await db.usageEvent.count({ where: { type: 'action-run' } })).toBe(0);
  });

  it('records reads ONLY for dependencies actually inlined, not every edge (#1061)', async () => {
    // The assembler skips a target with no content, so recording from the edge
    // list would inflate the read series for a node the bundle never carried
    // (PR #1062 review — Codex P2, Copilot).
    const empty = await createDbNode(db, {
      loc: 'reference:empty', memoryId: mem.id, name: 'Empty', content: '',
    });
    await db.edge.create({
      data: {
        id: generateId(), memoryId: mem.id, sourceId: action.id, targetId: empty.id,
        name: 'documents', loc: 'actions:review:documents:reference:empty',
      },
    });

    const out = await render(action.id, { subject: 'x' });
    expect(out).toContain('PLAYBOOK BODY');
    expect(out).not.toContain('Empty');

    await waitForReads([action.id, dep.id]);
    // Read EVERY event for the negative assertion — the wait above is scoped to
    // what must appear, this is scoped to nothing so `empty` cannot hide.
    const reads = await db.usageEvent.findMany({
      where: { type: 'read' },
      select: { nodeId: true },
    });
    const ids = reads.map((r) => r.nodeId);
    expect(ids).toContain(action.id); // the run node
    expect(ids).toContain(dep.id);    // the inlined dependency
    expect(ids).not.toContain(empty.id); // skipped by the assembler → no read
  });

  it('is not fooled by stale read events left by another test (#1069)', async () => {
    // The CI flake this pins, reproduced rather than imagined: two `[null,
    // null]` read events plus a recorder slower than the poll.
    //
    // Where the stale rows come from: usage recording is fire-and-forget, so a
    // previous test's write could land in the middle of `cleanDb` — after the
    // usage wipe, in time for `node.deleteMany()` to blank its `nodeId` through
    // the FK's SetNull. `cleanDb` now clears usage events LAST so that window is
    // gone, but the wait must not depend on that: an unscoped
    // `count({type:'read'}) >= 2` is satisfied by ANY two events, so it stops
    // waiting before this test's own writes land and then asserts on them.
    await db.usageEvent.createMany({
      data: [
        { id: generateId(), type: 'read', nodeId: null, memoryId: mem.id },
        { id: generateId(), type: 'read', nodeId: null, memoryId: mem.id },
      ],
    });

    // Make the real insert lose the race deterministically — 400ms against a
    // 20ms poll interval — instead of hoping to catch it, which is what made
    // this a once-in-CI flake rather than a test.
    const passThrough = db.usageEvent.createMany.bind(db.usageEvent);
    const slow = vi
      .spyOn(db.usageEvent, 'createMany')
      .mockImplementation((async (args: Parameters<typeof passThrough>[0]) => {
        await new Promise((r) => setTimeout(r, 400));
        return passThrough(args);
      }) as typeof db.usageEvent.createMany);
    try {
      await render(action.id, { subject: 'x' });
      await waitForReads([action.id, dep.id]);
    } finally {
      slow.mockRestore();
    }

    const ids = (
      await db.usageEvent.findMany({ where: { type: 'read' }, select: { nodeId: true } })
    ).map((r) => r.nodeId);
    expect(ids).toContain(action.id);
    expect(ids).toContain(dep.id);
    // The stale rows are still sitting there: the wait stepped over them rather
    // than being satisfied by them, which is the whole property.
    expect(ids.filter((i) => i === null)).toHaveLength(2);
  });

  it('DOES record read events — a preview still returns node content (#1061)', async () => {
    // #1061 narrowed the assertion above from "no UsageEvent at all" to "no
    // action-run". The two are different questions: the #818 contract is that
    // a preview must not be metered as an EXECUTION, which it still isn't.
    // But the render hands the caller the run node's content plus every
    // inlined dependency, and those reads genuinely happened — so leaving them
    // out would make this the one content-returning surface on the whole
    // GraphQL API that stays invisible in the usage series.
    await render(action.id, { subject: 'x' });
    await waitForReads([action.id]);
    const reads = await db.usageEvent.findMany({
      where: { type: 'read' },
      select: { nodeId: true },
    });
    expect(reads.map((r) => r.nodeId)).toContain(action.id);
  });

  it('writes nothing to the node', async () => {
    const before = await db.node.findUniqueOrThrow({ where: { id: action.id } });
    await render(action.id, { subject: 'x' });
    const after = await db.node.findUniqueOrThrow({ where: { id: action.id } });
    expect(after.content).toBe(before.content);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});

describe('renderRunNode — access (#818)', () => {
  it('a non-member is refused, indistinguishably from a miss', async () => {
    await expect(render(action.id, {}, ctx(stranger.id))).rejects.toThrow(/Node not found/);
    await expect(render(generateId())).rejects.toThrow(/Node not found/);
  });

  it('an anonymous caller is refused', async () => {
    await expect(render(action.id, {}, ctx())).rejects.toThrow(/Node not found/);
  });

  it('a referenced node in an UNREADABLE memory is omitted, not inlined', async () => {
    // An edge can cross memories (#781) — the bundle must not become a way to
    // read a foreign node's content through a dependency link.
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'rr-o', urn: `rr-o-${generateId()}` },
    });
    const foreignMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: otherOrg.id, urn: `${otherOrg.urn}:secret`,
        name: 'secret', class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    const foreignNode = await createDbNode(db, {
      loc: 'crown', memoryId: foreignMem.id, name: 'Crown', content: 'CROSS-TENANT-SECRET',
    });
    await db.edge.create({
      data: {
        id: generateId(), memoryId: mem.id, sourceId: action.id, targetId: foreignNode.id,
        name: 'leak', loc: 'actions:review:leak:crown',
      },
    });
    const out = await render(action.id, { subject: 'x' });
    expect(out).not.toContain('CROSS-TENANT-SECRET');
    // The readable dependency is still inlined.
    expect(out).toContain('PLAYBOOK BODY');
  });
});

describe('renderRunNode predicts what runTask EXECUTES (#818)', () => {
  it('is byte-identical to the assembler runTask itself calls', async () => {
    // The #858 review found the original claim false: this used to compare
    // against the legacy MCP bundle (literal replaceAll, every edge inlined)
    // while runTask assembles with Mustache and skips routing edges. Both now
    // call assembleRunNodePrompt, so the comparison is against the real thing.
    const node = await db.node.findUniqueOrThrow({
      where: { id: action.id },
      include: { outgoingEdges: { include: { target: true } } },
    });
    const viaExecutor = await assembleRunNodePrompt(
      { ...node, loc: action.loc } as never,
      { subject: 'incident report' },
      {
        memoryUrnOf: async (memoryId: string) =>
          (await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { urn: true } })).urn,
        compileTemplate: (content: string, data: Record<string, string> | null, memoryId: string) =>
          compileTemplate(content, data, memoryId, db, {}),
      },
    );
    const viaGraphql = await render(action.id, { subject: 'incident report' });
    // If these ever diverge, a dry run stops predicting the real run.
    expect(viaGraphql).toBe(viaExecutor);
  });
});
