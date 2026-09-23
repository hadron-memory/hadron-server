/**
 * #1177 §3 — the seam.
 *
 * Driven through the resolver against a real database, because the things
 * worth pinning here are the ones the pure domain tests cannot see: the access
 * gate, the discovery predicate, and the two guarantees the surface exists to
 * make structural — that lint/status cannot write, and that a node failing
 * lint is never handed a body.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const { resolvers } = await import('./resolvers.js');
type Ctx = Parameters<typeof resolvers.Mutation.createMemory>[2];

let org: { id: string; urn: string };
let admin: { id: string };
let outsider: { id: string };
let mem: { id: string; urn: string };

const ctx = (): Ctx => ({ db, roles: ['ADMIN'], userId: admin.id }) as Ctx;
/** A caller who is a member of NO org — the access-gate control. */
const strangerCtx = (): Ctx => ({ db, roles: [], userId: outsider.id }) as Ctx;

const declaration = (over: Record<string, unknown> = {}) => ({
  exports: { claudeSkill: { name: 'my-skill', description: 'Does a thing. Use when you need it.', enable: true, ...over } },
});

const mkNode = (loc: string, fields: Record<string, unknown> = {}) =>
  db.node.create({
    data: {
      id: generateId(),
      memoryId: mem.id,
      loc,
      name: loc,
      isRunnable: true,
      content: '# Body\n\nSteps.',
      ...fields,
    },
  });

const plan = (input: Record<string, unknown>, c: Ctx = ctx()) =>
  (resolvers.Query as Record<string, (p: unknown, a: unknown, c: Ctx) => Promise<any>>).skillPlan(
    {},
    { input },
    c,
  );

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'sp', urn: `sp-${t}` } });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 66230, githubUsername: `sp-${t}`, roles: ['ADMIN'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 66231, githubUsername: `sp-out-${t}`, roles: [] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  mem = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: `sp-mem-${t}` }, ctx());
});

describe('discovery — what the plan considers', () => {
  it('selects a DECLARING node and ignores an ordinary one', async () => {
    await mkNode('tasks:declared', { properties: declaration() });
    await mkNode('tasks:plain');

    const got = await plan({ intent: 'LINT' });

    expect(got.entries).toHaveLength(1);
    expect(got.entries[0].urn).toContain('tasks:declared');
    // The positive control travels on the wire: an empty plan and a denied
    // plan are otherwise the same empty list.
    expect(got.scanned).toBe(1);
  });

  it('selects a node whose declaration is MALFORMED', async () => {
    // The predicate matches the KEY's existence, not its shape — a predicate
    // requiring a well-formed object would hide exactly the nodes
    // `skill-declaration-malformed` exists to report.
    await mkNode('tasks:broken', { properties: { exports: 'yes' } });

    const got = await plan({ intent: 'LINT' });

    expect(got.entries).toHaveLength(1);
    expect(got.entries[0].findings.map((f: { rule: string }) => f.rule)).toContain(
      'skill-declaration-malformed',
    );
  });

  it('selects a declaration on a node that is NOT runnable', async () => {
    // `skill-not-runnable` is a rule, so narrowing the query to runnable nodes
    // would make the corpus look clean by hiding the nodes the rule is for.
    await mkNode('tasks:not-runnable', { isRunnable: false, properties: declaration() });

    const got = await plan({ intent: 'LINT' });

    expect(got.entries).toHaveLength(1);
    expect(got.entries[0].findings.map((f: { rule: string }) => f.rule)).toContain('skill-not-runnable');
  });
});

describe('the access gate', () => {
  it('shows a stranger nothing, and says so with scanned: 0', async () => {
    await mkNode('tasks:declared', { properties: declaration() });

    const mine = await plan({ intent: 'LINT' });
    const theirs = await plan({ intent: 'LINT' }, strangerCtx());

    // Both halves matter: the gate must hide the node AND the control must
    // show that the same call sees it for someone who may.
    expect(mine.entries).toHaveLength(1);
    expect(theirs.entries).toHaveLength(0);
    expect(theirs.scanned).toBe(0);
  });

  it('REFUSES a named memory the caller cannot read rather than returning empty', async () => {
    // Silently dropping it would read as "nothing declared there", which is
    // the same wrong answer as a short read.
    await expect(plan({ intent: 'LINT', memories: [mem.id] }, strangerCtx())).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
  });
});

describe('classes and bodies', () => {
  it('never-exported, with a body only for EXPORT', async () => {
    await mkNode('tasks:declared', { properties: declaration() });

    const status = await plan({ intent: 'STATUS', files: [] });
    const exported = await plan({ intent: 'EXPORT', files: [] });

    expect(status.entries[0].class).toBe('never-exported');
    expect(status.entries[0].renderedBody).toBeNull();
    expect(status.entries[0].exportPlan).toBeNull();
    expect(exported.entries[0].class).toBe('never-exported');
    expect(exported.entries[0].renderedBody).toContain('# Body');
    expect(exported.entries[0].exportPlan).toEqual({
      action: 'WRITE',
      preservesExistingFile: false,
      reasons: [{ code: 'never-exported', message: 'No installed skill exists for this declaration.' }],
    });
    // The body is a real skill file, not just the node's content.
    expect(exported.entries[0].renderedBody).toContain('name: my-skill');
  });

  it('a node FAILING LINT is never given a body, even for EXPORT', async () => {
    // §5.1 step 2, made structural: a client cannot write a file the server
    // judged broken even by ignoring the findings handed to it alongside.
    await mkNode('tasks:declared', {
      properties: declaration({ name: 'Not_Kebab' }),
    });

    const got = await plan({ intent: 'EXPORT', files: [] });

    expect(got.entries[0].class).toBe('never-exported');
    expect(got.entries[0].findings.map((f: { rule: string }) => f.rule)).toContain('skill-name-invalid');
    expect(got.entries[0].renderedBody).toBeNull();
    expect(got.entries[0].exportPlan).toMatchObject({
      action: 'SKIP',
      preservesExistingFile: true,
      reasons: [{ code: 'skill-name-invalid' }],
    });
  });

  it('reports an over-limit description as out of export and preserves an installed file', async () => {
    const node = await mkNode('tasks:too-long', {
      properties: declaration({ description: 'x'.repeat(1083) }),
    });
    const urn = (await plan({ intent: 'LINT' })).entries[0].urn as string;

    const got = await plan({
      intent: 'EXPORT',
      files: [{
        dirName: 'my-skill',
        sourceUrn: urn,
        nodeId: node.id,
        headerHash: 'a'.repeat(16),
        fileHash: 'a'.repeat(16),
      }],
    });

    expect(got.entries[0].class).toBe('stale');
    expect(got.entries[0].renderedBody).toBeNull();
    expect(got.entries[0].exportPlan).toMatchObject({
      action: 'SKIP',
      preservesExistingFile: true,
      reasons: [{ code: 'skill-description-too-long' }],
    });
    expect(got.entries[0].exportPlan.reasons[0].message).toContain('1083 characters');
    expect(got.entries[0].exportPlan.reasons[0].message).toContain('1024');
    expect(got.orphans).toEqual([]);
  });

  it('reports an unsafe render as a failure with the renderer reason', async () => {
    await mkNode('tasks:unsafe-->source', { properties: declaration() });

    const got = await plan({ intent: 'EXPORT', files: [] });

    expect(got.entries[0].class).toBe('never-exported');
    expect(got.entries[0].renderedBody).toBeNull();
    expect(got.entries[0].exportPlan).toMatchObject({
      action: 'FAIL',
      preservesExistingFile: true,
      reasons: [{ code: 'render-failed' }],
    });
    expect(got.entries[0].exportPlan.reasons[0].message).toContain('provenance comment');
  });

  it('refuses a locally edited file and names the remedies', async () => {
    const node = await mkNode('tasks:locally-edited', { properties: declaration() });
    const exported = await plan({ intent: 'EXPORT', files: [] });
    const urn = exported.entries[0].urn as string;
    const headerHash = /hash=([0-9a-f]{16})/.exec(exported.entries[0].renderedBody as string)![1]!;

    const got = await plan({
      intent: 'EXPORT',
      files: [{
        dirName: 'my-skill',
        sourceUrn: urn,
        nodeId: node.id,
        headerHash,
        fileHash: 'f'.repeat(16),
      }],
    });

    expect(got.entries[0].class).toBe('locally-edited');
    expect(got.entries[0].renderedBody).toBeNull();
    expect(got.entries[0].exportPlan).toMatchObject({
      action: 'REFUSE',
      preservesExistingFile: true,
      reasons: [{ code: 'locally-edited' }],
    });
    expect(got.entries[0].exportPlan.reasons[0].message).toContain('one-invocation override');

    const forced = await plan({
      intent: 'EXPORT',
      force: true,
      files: [{
        dirName: 'my-skill',
        sourceUrn: urn,
        nodeId: node.id,
        headerHash,
        fileHash: 'f'.repeat(16),
      }],
    });
    expect(forced.entries[0].class).toBe('locally-edited');
    expect(forced.entries[0].renderedBody).toContain('# Body');
    expect(forced.entries[0].exportPlan).toMatchObject({
      action: 'WRITE',
      preservesExistingFile: false,
      reasons: [{ code: 'locally-edited-override' }],
    });

    await db.node.update({ where: { id: node.id }, data: { properties: declaration({ name: 'new-name' }) } });
    const moved = await plan({
      intent: 'EXPORT',
      force: true,
      files: [{
        dirName: 'my-skill', sourceUrn: urn, nodeId: node.id, headerHash, fileHash: 'f'.repeat(16),
      }],
    });
    expect(moved.entries[0].renderedBody).toContain('name: new-name');
    expect(moved.entries[0].movedFrom).toBe('my-skill');
    expect(moved.entries[0].exportPlan).toMatchObject({
      action: 'MOVE',
      preservesExistingFile: false,
      reasons: [{ code: 'locally-edited-override' }],
    });

    await db.node.update({
      where: { id: node.id },
      data: { properties: declaration({ name: 'new-name', enable: false }) },
    });
    const removed = await plan({
      intent: 'EXPORT',
      force: true,
      files: [{
        dirName: 'my-skill', sourceUrn: urn, nodeId: node.id, headerHash, fileHash: 'f'.repeat(16),
      }, {
        dirName: 'new-name',
        sourceUrn: 'hrn:node:other.example:skills:tasks:deleted',
        nodeId: 'deleted-node',
        headerHash: 'b'.repeat(16),
        fileHash: 'b'.repeat(16),
      }],
    });
    expect(removed.entries[0].renderedBody).toBeNull();
    expect(removed.entries[0].exportPlan).toMatchObject({
      action: 'REMOVE',
      preservesExistingFile: false,
      reasons: [{ code: 'locally-edited-override' }],
    });
    expect(removed.orphans.map((orphan: { dirName: string }) => orphan.dirName)).toEqual(['new-name']);
  });

  it('a parse failure is reported as a FAILURE, with no class', async () => {
    await mkNode('tasks:declared', { properties: declaration() });

    // Take the URN from the server rather than composing it: a hand-built
    // `${memory.urn}:${loc}` is wrong for a compound or legacy memory
    // spelling, and a test that builds one is asserting against its own
    // arithmetic. (The resolver had this same defect until a moment ago.)
    const urn = (await plan({ intent: 'LINT' })).entries[0].urn as string;
    const got = await plan({
      intent: 'STATUS',
      files: [{ dirName: 'my-skill', sourceUrn: urn, parseFailed: true }],
    });

    expect(got.entries[0].parseFailure).toBe(true);
    expect(got.entries[0].class).toBeNull();

    const exported = await plan({
      intent: 'EXPORT',
      files: [{ dirName: 'my-skill', sourceUrn: urn, parseFailed: true }],
    });
    expect(exported.entries[0].exportPlan).toMatchObject({
      action: 'FAIL',
      preservesExistingFile: true,
      reasons: [{ code: 'parse-failed' }],
    });
  });

  it('pairs a file by its source URN and reports it current when everything agrees', async () => {
    const node = await mkNode('tasks:declared', { properties: declaration() });

    // Take the hash from the server's own EXPORT plan rather than recomputing
    // it here: a test that recomputes the hash is testing its own arithmetic.
    const exported = await plan({ intent: 'EXPORT', files: [] });
    const urn = exported.entries[0].urn as string;
    const body = exported.entries[0].renderedBody as string;
    const headerHash = /hash=([0-9a-f]{16})/.exec(body)![1]!;

    const got = await plan({
      intent: 'EXPORT',
      files: [{ dirName: 'my-skill', sourceUrn: urn, nodeId: node.id, headerHash, fileHash: headerHash }],
    });

    expect(got.entries[0].class).toBe('current');
    expect(got.entries[0].renderedBody).toBeNull();
    expect(got.entries[0].exportPlan).toMatchObject({
      action: 'SKIP',
      preservesExistingFile: true,
      reasons: [{ code: 'current' }],
    });
    expect(got.orphans).toHaveLength(0);
  });

  it('a blocking lint finding outranks a current file relationship', async () => {
    const node = await mkNode('tasks:becomes-invalid', { properties: declaration() });
    const first = await plan({ intent: 'EXPORT', files: [] });
    const urn = first.entries[0].urn as string;
    const headerHash = /hash=([0-9a-f]{16})/.exec(first.entries[0].renderedBody as string)![1]!;
    // isRunnable is lint input but deliberately not part of the rendered-file
    // hash. The file therefore remains `current` while the node becomes
    // ineligible for export.
    await db.node.update({ where: { id: node.id }, data: { isRunnable: false } });

    const got = await plan({
      intent: 'EXPORT',
      files: [{ dirName: 'my-skill', sourceUrn: urn, nodeId: node.id, headerHash, fileHash: headerHash }],
    });

    expect(got.entries[0].class).toBe('current');
    expect(got.entries[0].exportPlan).toMatchObject({
      action: 'SKIP',
      preservesExistingFile: true,
      reasons: [{ code: 'skill-not-runnable' }],
    });
  });

  it.each(['my-skill', 'My-Skill'])(
    'refuses WRITE when an orphan at %s already occupies the target directory',
    async (occupiedDir) => {
      await mkNode('tasks:new-node', { properties: declaration() });

      const got = await plan({
        intent: 'EXPORT',
        files: [{
          dirName: occupiedDir,
          sourceUrn: 'hrn:node:other.example:skills:tasks:deleted',
          nodeId: 'deleted-node',
          headerHash: 'a'.repeat(16),
          fileHash: 'a'.repeat(16),
        }],
      });

      expect(got.entries[0].class).toBe('never-exported');
      expect(got.entries[0].renderedBody).toBeNull();
      expect(got.entries[0].exportPlan).toMatchObject({
        action: 'REFUSE',
        preservesExistingFile: true,
        reasons: [{ code: 'target-occupied' }],
      });
      expect(got.orphans.map((orphan: { dirName: string }) => orphan.dirName)).toEqual([occupiedDir]);
    },
  );

  it('plans MOVE for a rename, but refuses it when an orphan occupies the destination', async () => {
    const node = await mkNode('tasks:renamed', { properties: declaration({ name: 'old-name' }) });
    const first = await plan({ intent: 'EXPORT', files: [] });
    const urn = first.entries[0].urn as string;
    const headerHash = /hash=([0-9a-f]{16})/.exec(first.entries[0].renderedBody as string)![1]!;
    const oldFile = {
      dirName: 'old-name', sourceUrn: urn, nodeId: node.id, headerHash, fileHash: headerHash,
    };
    await db.node.update({ where: { id: node.id }, data: { properties: declaration({ name: 'new-name' }) } });

    const movable = await plan({ intent: 'EXPORT', files: [oldFile] });
    expect(movable.entries[0]).toMatchObject({
      class: 'renamed',
      movedFrom: 'old-name',
      exportPlan: { action: 'MOVE', preservesExistingFile: false },
    });
    expect(movable.entries[0].renderedBody).toContain('name: new-name');

    const blocked = await plan({
      intent: 'EXPORT',
      files: [oldFile, {
        dirName: 'new-name',
        sourceUrn: 'hrn:node:other.example:skills:tasks:deleted',
        nodeId: 'deleted-node',
        headerHash: 'b'.repeat(16),
        fileHash: 'b'.repeat(16),
      }],
    });
    expect(blocked.entries[0].class).toBe('renamed');
    expect(blocked.entries[0].renderedBody).toBeNull();
    expect(blocked.entries[0].exportPlan).toMatchObject({
      action: 'REFUSE',
      preservesExistingFile: true,
      reasons: [{ code: 'target-occupied' }],
    });
    expect(blocked.orphans.map((orphan: { dirName: string }) => orphan.dirName)).toEqual(['new-name']);
  });

  it('reports a file that pairs with nothing as an orphan', async () => {
    await mkNode('tasks:declared', { properties: declaration() });

    const got = await plan({
      intent: 'STATUS',
      files: [{ dirName: 'ghost', sourceUrn: 'hrn:node:other.com:mem:tasks:gone', headerHash: 'a'.repeat(16), fileHash: 'a'.repeat(16) }],
    });

    expect(got.orphans).toHaveLength(1);
    expect(got.orphans[0].dirName).toBe('ghost');
    // …and the declared node is still reported, rather than being displaced
    // by the orphan.
    expect(got.entries).toHaveLength(1);
  });

  it('disabled: declared and not switched on', async () => {
    await mkNode('tasks:off', { properties: declaration({ enable: false }) });

    const got = await plan({ intent: 'STATUS', files: [] });

    expect(got.entries[0].class).toBe('disabled');
    expect(got.entries[0].renderedBody).toBeNull();
  });

  it('plans removal for a disabled declaration only when a generated file exists', async () => {
    const node = await mkNode('tasks:disable-after-export', { properties: declaration() });
    const first = await plan({ intent: 'EXPORT', files: [] });
    const urn = first.entries[0].urn as string;
    const headerHash = /hash=([0-9a-f]{16})/.exec(first.entries[0].renderedBody as string)![1]!;
    await db.node.update({
      where: { id: node.id },
      data: { properties: declaration({ enable: false }) },
    });

    const withFile = await plan({
      intent: 'EXPORT',
      files: [{
        dirName: 'my-skill',
        sourceUrn: urn,
        nodeId: node.id,
        headerHash,
        fileHash: headerHash,
      }],
    });
    const withoutFile = await plan({ intent: 'EXPORT', files: [] });

    expect(withFile.entries[0].class).toBe('disabled');
    expect(withFile.entries[0].exportPlan).toMatchObject({
      action: 'REMOVE',
      preservesExistingFile: false,
      reasons: [{ code: 'disabled' }],
    });
    expect(withoutFile.entries[0].exportPlan).toMatchObject({
      action: 'SKIP',
      preservesExistingFile: true,
      reasons: [{ code: 'disabled' }],
    });
  });

  it('preserves an installed over-limit file even when the declaration is disabled', async () => {
    const node = await mkNode('tasks:disable-over-limit', { properties: declaration() });
    const first = await plan({ intent: 'EXPORT', files: [] });
    const urn = first.entries[0].urn as string;
    const headerHash = /hash=([0-9a-f]{16})/.exec(first.entries[0].renderedBody as string)![1]!;
    await db.node.update({
      where: { id: node.id },
      data: { properties: declaration({ enable: false, description: 'x'.repeat(1083) }) },
    });

    const got = await plan({
      intent: 'EXPORT',
      files: [{ dirName: 'my-skill', sourceUrn: urn, nodeId: node.id, headerHash, fileHash: headerHash }],
    });

    expect(got.entries[0].class).toBe('disabled');
    expect(got.entries[0].exportPlan).toMatchObject({
      action: 'SKIP',
      preservesExistingFile: true,
      reasons: [{ code: 'skill-description-too-long' }],
    });
  });

  it('preserves a disabled installed file when any blocking lint finding remains', async () => {
    const node = await mkNode('tasks:disable-invalid', { properties: declaration() });
    const first = await plan({ intent: 'EXPORT', files: [] });
    const urn = first.entries[0].urn as string;
    const headerHash = /hash=([0-9a-f]{16})/.exec(first.entries[0].renderedBody as string)![1]!;
    await db.node.update({
      where: { id: node.id },
      data: { properties: declaration({ enable: false }), content: '' },
    });

    const got = await plan({
      intent: 'EXPORT',
      files: [{ dirName: 'my-skill', sourceUrn: urn, nodeId: node.id, headerHash, fileHash: headerHash }],
    });
    expect(got.entries[0].class).toBe('disabled');
    expect(got.entries[0].exportPlan).toMatchObject({
      action: 'SKIP',
      preservesExistingFile: true,
      reasons: [{ code: 'skill-content-empty' }],
    });
  });
});

describe('review round 1 — @codex', () => {
  it('P1: a LOCKED encrypted node is unavailable, never hashed, linted or rendered', async () => {
    // `decryptNodesBatch` leaves ciphertext rather than throwing when a
    // readable encrypted memory has no session key. Hashing or rendering that
    // blob would hand an EXPORT client a file containing `enc:v1…` — which
    // overwrites a perfectly good local skill with ciphertext.
    await mkNode('tasks:locked', {
      properties: declaration(),
      content: 'enc:v1:AAAA:BBBB:CCCC',
    });

    const got = await plan({ intent: 'EXPORT', files: [] });

    expect(got.entries[0].class).toBe('unavailable');
    expect(got.entries[0].renderedBody).toBeNull();
    // No findings either: every rule would be judging ciphertext, and a
    // finding about a body nobody could read is worse than silence.
    expect(got.entries[0].findings).toEqual([]);
  });

  it('CONTROL: the same node with readable content is judged normally', async () => {
    // Without this, the case above would pass against a resolver that called
    // everything unavailable.
    await mkNode('tasks:plain-content', { properties: declaration() });
    const got = await plan({ intent: 'EXPORT', files: [] });
    expect(got.entries[0].class).toBe('never-exported');
    expect(got.entries[0].renderedBody).toContain('# Body');
  });

  it('P2: two directories claiming one node — one is kept, the other is an orphan', async () => {
    await mkNode('tasks:declared', { properties: declaration() });
    const urn = (await plan({ intent: 'LINT' })).entries[0].urn as string;
    const h = 'a'.repeat(16);

    const got = await plan({
      intent: 'STATUS',
      files: [
        { dirName: 'zz-old-copy', sourceUrn: urn, headerHash: h, fileHash: h },
        { dirName: 'my-skill', sourceUrn: urn, headerHash: h, fileHash: h },
      ],
    });

    // One entry, classified against ONE file…
    expect(got.entries).toHaveLength(1);
    // …and the loser is reported, so `--prune` can act on it. Without this
    // the stale copy stays live on disk with nothing ever naming it.
    expect(got.orphans.map((o: { dirName: string }) => o.dirName)).toEqual(['zz-old-copy']);
  });

  it('P2: the selection is stable under the order the client walked its disk', async () => {
    await mkNode('tasks:declared', { properties: declaration() });
    const urn = (await plan({ intent: 'LINT' })).entries[0].urn as string;
    const h = 'a'.repeat(16);
    const files = [
      { dirName: 'zz-old-copy', sourceUrn: urn, headerHash: h, fileHash: h },
      { dirName: 'my-skill', sourceUrn: urn, headerHash: h, fileHash: h },
    ];

    const forward = await plan({ intent: 'STATUS', files });
    const reversed = await plan({ intent: 'STATUS', files: [...files].reverse() });

    expect(forward.orphans).toEqual(reversed.orphans);
    expect(forward.entries[0].class).toBe(reversed.entries[0].class);
  });

  it('P2: records one read per node whose CONTENT is returned (#1061)', async () => {
    const node = await mkNode('tasks:declared', { properties: declaration() });

    // POLLED, not counted once. `recordNodeUsage` is fire-and-forget by
    // contract, so a bare count after the call is testing scheduler luck —
    // which is exactly how this assertion passed locally and failed in CI on
    // its first run. `resolvers.usageRecording.test.ts` says so in its own
    // helper's comment; I wrote the count first and read the comment after.
    const readCount = async (): Promise<number> =>
      db.usageEvent.count({ where: { nodeId: node.id, type: 'read' } });
    const waitFor = async (want: number): Promise<number> => {
      for (let i = 0; i < 50; i++) {
        const n = await readCount();
        if (n >= want) return n;
        await new Promise((r) => setTimeout(r, 20));
      }
      return readCount();
    };

    await plan({ intent: 'EXPORT', files: [] });
    expect(await waitFor(1)).toBe(1);

    // …and a plan that returns NO body records nothing: an event naming a node
    // nobody read is the inverse defect. A negative needs a bounded wait
    // rather than an immediate read — otherwise it passes by being fast.
    await plan({ intent: 'STATUS', files: [] });
    await new Promise((r) => setTimeout(r, 300));
    expect(await readCount()).toBe(1);
  });
});

describe('review round 2 — @copilot', () => {
  it('HONOURS an explicit memory scope instead of widening to everything readable', async () => {
    // `memoryAccessFilter` returns `{ memoryId: { in: … } }`, so spreading it
    // beside the requested scope made the last key win and silently dropped
    // the narrowing. A client running --prune against one memory would then
    // receive entries for files it never meant to touch.
    const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    const other = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: `sp-other-${t}` }, ctx());
    await mkNode('tasks:in-scope', { properties: declaration() });
    await db.node.create({
      data: {
        id: generateId(), memoryId: other.id, loc: 'tasks:out-of-scope', name: 'out',
        isRunnable: true, content: '# Other', properties: declaration({ name: 'other-skill' }),
      },
    });

    // Both are readable by this caller — the control that makes the narrowing
    // meaningful rather than an access check in disguise.
    const everything = await plan({ intent: 'LINT' });
    expect(everything.entries).toHaveLength(2);

    const scoped = await plan({ intent: 'LINT', memories: [mem.id] });
    expect(scoped.entries).toHaveLength(1);
    expect(scoped.entries[0].urn).toContain('tasks:in-scope');
  });

  it('reports scanned and judged separately when a node declares only another host', async () => {
    // Discovery matches any declaration KEY, so a node declaring only
    // `codexSkill` is selected and produces no entry. One number could not be
    // right for both.
    await mkNode('tasks:declared', { properties: declaration() });
    await mkNode('tasks:other-host', {
      properties: { exports: { codexSkill: { name: 'x-y', description: 'd. Use when x.' } } },
    });

    const got = await plan({ intent: 'LINT' });

    expect(got.scanned).toBe(2);
    expect(got.judged).toBe(1);
    expect(got.entries).toHaveLength(1);
  });

  it('refuses on loaded CONTENT bytes, for LINT too — not only on rendered bodies', async () => {
    // LINT returns no body, so a response-side ceiling left it unbounded while
    // the nodes were still decrypted, hashed and linted. The cost is paid at
    // load, so the refusal belongs at load.
    await mkNode('tasks:huge', { properties: declaration(), content: 'x'.repeat(1_100_000) });

    await expect(plan({ intent: 'LINT' })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('CONTROL: an ordinary corpus is nowhere near the ceiling', async () => {
    // Or the case above would pass against a resolver that refused everything.
    await mkNode('tasks:small', { properties: declaration() });
    await expect(plan({ intent: 'LINT' })).resolves.toBeTruthy();
  });
});

describe('the surface itself', () => {
  it('is a QUERY, not a mutation — status and lint cannot write by construction', () => {
    // The guarantee §3 asks for. A mutation that promises not to write is a
    // promise; this is the structural version, and it is worth an assertion
    // because a future "just add a mutation for export" would quietly remove
    // it.
    expect((resolvers.Query as Record<string, unknown>).skillPlan).toBeTypeOf('function');
    expect((resolvers.Mutation as Record<string, unknown>).skillPlan).toBeUndefined();
  });

  it('refuses a host it has no renderer for', async () => {
    await mkNode('tasks:declared', { properties: declaration() });
    await expect(plan({ intent: 'LINT', host: 'codexSkill' })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('accepts force only for an export invocation', async () => {
    await mkNode('tasks:declared', { properties: declaration() });
    await expect(plan({ intent: 'STATUS', force: true })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});
