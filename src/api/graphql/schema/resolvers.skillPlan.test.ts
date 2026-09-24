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
import { splitNodeUrn } from '../../../lib/urn.js';

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
    expect(removed.entries[0].movedFrom).toBe('my-skill');
    expect(removed.entries[0].exportPlan).toMatchObject({
      action: 'REMOVE',
      preservesExistingFile: false,
      reasons: [{ code: 'locally-edited-override' }],
    });
    expect(removed.orphans.map((orphan: { dirName: string }) => orphan.dirName)).toEqual(['new-name']);
  });

  it('refuses an ambiguous case-only local-edit target even with force', async () => {
    const node = await mkNode('tasks:case-only-local-edit', {
      properties: declaration({ name: 'my-skill' }),
    });
    const first = await plan({ intent: 'EXPORT', files: [] });
    const urn = first.entries[0].urn as string;
    const headerHash = /hash=([0-9a-f]{16})/.exec(first.entries[0].renderedBody as string)![1]!;

    const got = await plan({
      intent: 'EXPORT',
      force: true,
      files: [{
        dirName: 'My-Skill',
        sourceUrn: urn,
        nodeId: node.id,
        headerHash,
        fileHash: 'f'.repeat(16),
      }],
    });

    expect(got.entries[0]).toMatchObject({
      class: 'locally-edited',
      movedFrom: null,
      renderedBody: null,
      exportPlan: {
        action: 'REFUSE',
        preservesExistingFile: true,
        reasons: [{ code: 'filesystem-alias-ambiguous' }],
      },
    });
  });

  it('refuses a clean case-only rename whose filesystem semantics are ambiguous', async () => {
    const node = await mkNode('tasks:case-only-rename', { properties: declaration() });
    const first = await plan({ intent: 'EXPORT', files: [] });
    const urn = first.entries[0].urn as string;
    const headerHash = /hash=([0-9a-f]{16})/.exec(first.entries[0].renderedBody as string)![1]!;

    const got = await plan({
      intent: 'EXPORT',
      files: [{
        dirName: 'My-Skill',
        sourceUrn: urn,
        nodeId: node.id,
        headerHash,
        fileHash: headerHash,
      }],
    });

    expect(got.entries[0]).toMatchObject({
      class: 'renamed',
      movedFrom: 'My-Skill',
      renderedBody: null,
      exportPlan: {
        action: 'REFUSE',
        preservesExistingFile: true,
        reasons: [{ code: 'filesystem-alias-ambiguous' }],
      },
    });
  });

  it('moves an ID-bearing file with a missing hash when its directory truly changed', async () => {
    const node = await mkNode('tasks:legacy-rename', { properties: declaration() });
    const first = await plan({ intent: 'EXPORT', files: [] });
    const urn = first.entries[0].urn as string;

    const got = await plan({
      intent: 'EXPORT',
      files: [{
        dirName: 'old-name',
        sourceUrn: urn,
        nodeId: node.id,
        headerHash: '',
        fileHash: 'f'.repeat(16),
      }],
    });

    expect(got.entries[0]).toMatchObject({
      class: 'unhashed',
      movedFrom: 'old-name',
      exportPlan: {
        action: 'MOVE',
        preservesExistingFile: false,
        reasons: [{ code: 'unhashed' }],
      },
    });
    expect(got.entries[0].renderedBody).toContain('# Body');
  });

  it.each([
    { change: 'rewrite', localEdit: false, force: false, action: 'SKIP', reason: 'missing-node-id' },
    { change: 'rewrite', localEdit: false, force: true, action: 'WRITE', reason: 'missing-node-id-override' },
    { change: 'rewrite', localEdit: true, force: false, action: 'REFUSE', reason: 'locally-edited' },
    { change: 'rewrite', localEdit: true, force: true, action: 'WRITE', reason: 'locally-edited-override' },
    { change: 'move', localEdit: false, force: false, action: 'SKIP', reason: 'missing-node-id' },
    { change: 'move', localEdit: false, force: true, action: 'MOVE', reason: 'missing-node-id-override' },
    { change: 'move', localEdit: true, force: false, action: 'REFUSE', reason: 'locally-edited' },
    { change: 'move', localEdit: true, force: true, action: 'MOVE', reason: 'locally-edited-override' },
    { change: 'remove', localEdit: false, force: false, action: 'REMOVE', reason: 'disabled' },
    { change: 'remove', localEdit: false, force: true, action: 'REMOVE', reason: 'disabled' },
    { change: 'remove', localEdit: true, force: false, action: 'REFUSE', reason: 'locally-edited' },
    { change: 'remove', localEdit: true, force: true, action: 'REMOVE', reason: 'locally-edited-override' },
  ] as const)(
    'P08: no-ID $change (localEdit=$localEdit, force=$force) plans $action',
    async ({ change, localEdit, force, action, reason }) => {
      const node = await mkNode(`tasks:no-id-${change}-${localEdit}-${force}`, { properties: declaration() });
      const first = await plan({ intent: 'EXPORT', files: [] });
      const urn = first.entries[0].urn as string;
      const headerHash = /hash=([0-9a-f]{16})/.exec(first.entries[0].renderedBody as string)![1]!;

      if (change === 'move') {
        await db.node.update({
          where: { id: node.id },
          data: { properties: declaration({ name: 'new-name' }) },
        });
      } else if (change === 'remove') {
        await db.node.update({
          where: { id: node.id },
          data: { properties: declaration({ enable: false }) },
        });
      }

      const got = await plan({
        intent: 'EXPORT',
        force,
        files: [{
          dirName: 'my-skill',
          sourceUrn: urn,
          // P08's predicate is the missing provenance ID, not a missing
          // hash. A valid hash also lets the local-edit cases prove that the
          // ordinary hash evidence still outranks disabled/remove behavior.
          headerHash,
          fileHash: localEdit ? 'f'.repeat(16) : headerHash,
        }],
      });

      expect(got.entries[0].exportPlan).toMatchObject({
        action,
        preservesExistingFile: action === 'SKIP' || action === 'REFUSE',
        reasons: [{ code: reason }],
      });
      expect(got.entries[0].renderedBody === null).toBe(
        action === 'SKIP' || action === 'REFUSE' || action === 'REMOVE',
      );
      expect(got.entries[0].movedFrom).toBe(
        action === 'MOVE' || action === 'REMOVE' || (change === 'move' && !localEdit)
          ? 'my-skill'
          : null,
      );
    },
  );

  it('P08: a source-only legacy header is preserved until force explicitly rewrites it', async () => {
    await mkNode('tasks:no-id-source-only', { properties: declaration() });
    const urn = (await plan({ intent: 'LINT' })).entries[0].urn as string;
    const file = {
      dirName: 'my-skill',
      sourceUrn: urn,
      headerHash: '',
      fileHash: 'f'.repeat(16),
    };

    const protectedPlan = await plan({ intent: 'EXPORT', files: [file] });
    expect(protectedPlan.entries[0]).toMatchObject({
      class: 'unhashed',
      renderedBody: null,
      exportPlan: {
        action: 'SKIP',
        preservesExistingFile: true,
        reasons: [{ code: 'missing-node-id' }],
      },
    });

    const forcedPlan = await plan({ intent: 'EXPORT', force: true, files: [file] });
    expect(forcedPlan.entries[0]).toMatchObject({
      class: 'unhashed',
      exportPlan: {
        action: 'WRITE',
        preservesExistingFile: false,
        reasons: [{ code: 'missing-node-id-override' }],
      },
    });
    expect(forcedPlan.entries[0].renderedBody).toContain('# Body');
  });

  it('protects extra frontmatter on an unhashed legacy file unless force is explicit', async () => {
    const node = await mkNode('tasks:legacy-extra-frontmatter', { properties: declaration() });
    const first = await plan({ intent: 'EXPORT', files: [] });
    const urn = first.entries[0].urn as string;
    const file = {
      dirName: 'my-skill',
      sourceUrn: urn,
      nodeId: node.id,
      headerHash: '',
      fileHash: 'f'.repeat(16),
      hasExtraFrontmatter: true,
    };

    const protectedPlan = await plan({ intent: 'EXPORT', files: [file] });
    expect(protectedPlan.entries[0]).toMatchObject({
      class: 'unhashed',
      renderedBody: null,
      exportPlan: {
        action: 'REFUSE',
        preservesExistingFile: true,
        reasons: [{ code: 'locally-edited' }],
      },
    });

    const forcedPlan = await plan({ intent: 'EXPORT', force: true, files: [file] });
    expect(forcedPlan.entries[0]).toMatchObject({
      class: 'unhashed',
      exportPlan: {
        action: 'WRITE',
        preservesExistingFile: false,
        reasons: [{ code: 'locally-edited-override' }],
      },
    });
    expect(forcedPlan.entries[0].renderedBody).toContain('# Body');

    await db.node.update({
      where: { id: node.id },
      data: { properties: declaration({ enable: false }) },
    });
    const disabledProtected = await plan({ intent: 'EXPORT', files: [file] });
    expect(disabledProtected.entries[0]).toMatchObject({
      class: 'disabled',
      renderedBody: null,
      exportPlan: {
        action: 'REFUSE',
        preservesExistingFile: true,
        reasons: [{ code: 'locally-edited' }],
      },
    });

    const disabledForced = await plan({ intent: 'EXPORT', force: true, files: [file] });
    expect(disabledForced.entries[0]).toMatchObject({
      class: 'disabled',
      movedFrom: 'my-skill',
      renderedBody: null,
      exportPlan: {
        action: 'REMOVE',
        preservesExistingFile: false,
        reasons: [{ code: 'disabled' }],
      },
    });
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

  it.each(['my-skill', 'My-Skill', 'my-ſkill'])(
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

  it('removes the paired disabled file even when an orphan occupies the renamed target', async () => {
    const node = await mkNode('tasks:disable-renamed', {
      properties: declaration({ name: 'old-name' }),
    });
    const first = await plan({ intent: 'EXPORT', files: [] });
    const urn = first.entries[0].urn as string;
    const headerHash = /hash=([0-9a-f]{16})/.exec(first.entries[0].renderedBody as string)![1]!;
    await db.node.update({
      where: { id: node.id },
      data: { properties: declaration({ name: 'new-name', enable: false }) },
    });

    const got = await plan({
      intent: 'EXPORT',
      files: [{
        dirName: 'old-name',
        sourceUrn: urn,
        nodeId: node.id,
        headerHash,
        fileHash: headerHash,
      }, {
        dirName: 'new-name',
        sourceUrn: 'hrn:node:other.example:skills:tasks:deleted',
        nodeId: 'deleted-node',
        headerHash: 'b'.repeat(16),
        fileHash: 'b'.repeat(16),
      }],
    });

    expect(got.entries[0]).toMatchObject({
      class: 'disabled',
      movedFrom: 'old-name',
      exportPlan: {
        action: 'REMOVE',
        preservesExistingFile: false,
        reasons: [{ code: 'disabled' }],
      },
    });
    expect(got.orphans.map((orphan: { dirName: string }) => orphan.dirName)).toEqual(['new-name']);
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
    const node = await mkNode('tasks:locked', {
      properties: declaration(),
      content: 'enc:v1:AAAA:BBBB:CCCC',
    });

    const got = await plan({ intent: 'EXPORT', files: [] });

    expect(got.entries[0].class).toBe('unavailable');
    expect(got.entries[0].renderedBody).toBeNull();
    // No findings either: every rule would be judging ciphertext, and a
    // finding about a body nobody could read is worse than silence.
    expect(got.entries[0].findings).toEqual([]);

    // A legacy file with extra frontmatter normally gains local-edit
    // protection, but even an explicit override cannot make an unreadable
    // source safe to render. The unavailable verdict wins and ciphertext is
    // never returned as an export body.
    const forced = await plan({
      intent: 'EXPORT',
      force: true,
      files: [{
        dirName: 'my-skill',
        sourceUrn: got.entries[0].urn,
        nodeId: node.id,
        headerHash: '',
        fileHash: 'f'.repeat(16),
        hasExtraFrontmatter: true,
      }],
    });
    expect(forced.entries[0]).toMatchObject({
      class: 'unavailable',
      renderedBody: null,
      exportPlan: {
        action: 'SKIP',
        preservesExistingFile: true,
        reasons: [{ code: 'unavailable' }],
      },
    });

    // The no-ID override is no broader than the local-edit override. In
    // particular, `force` must not make an unreadable legacy source renderable.
    const forcedNoId = await plan({
      intent: 'EXPORT',
      force: true,
      files: [{
        dirName: 'my-skill',
        sourceUrn: got.entries[0].urn,
        headerHash: '',
        fileHash: 'f'.repeat(16),
      }],
    });
    expect(forcedNoId.entries[0]).toMatchObject({
      class: 'unavailable',
      renderedBody: null,
      exportPlan: {
        action: 'SKIP',
        preservesExistingFile: true,
        reasons: [{ code: 'unavailable' }],
      },
    });
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

  it('refuses an unknown host by name, never answering with an empty plan (hadron-cli#622 P02)', async () => {
    // `codex` is the spelling the portal first shipped (portal#888). An empty
    // plan here would read as "nothing declared for this host", and --prune
    // acting on it deletes that host's files.
    await mkNode('tasks:declared', { properties: declaration() });
    await expect(plan({ intent: 'LINT', host: 'codex' })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT', host: 'codex', supportedHosts: ['claudeSkill', 'codexSkill'] },
    });
  });

  it('CONTROL: every registered host is accepted', async () => {
    await mkNode('tasks:declared', { properties: declaration() });
    await expect(plan({ intent: 'LINT', host: 'claudeSkill' })).resolves.toBeTruthy();
    await expect(plan({ intent: 'LINT', host: 'codexSkill' })).resolves.toBeTruthy();
  });

  it('accepts force only for an export invocation', async () => {
    await mkNode('tasks:declared', { properties: declaration() });
    await expect(plan({ intent: 'STATUS', force: true })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});

/**
 * #1254 part 2 — one host per call, and the host decides which declaration is
 * read, which limits apply and which names collide. The renderer is shared.
 * Case ids cite the hadron-cli#622 cross-host matrix, whose declaration, lint
 * and collision columns run separately in skilldoc/crosshost.acceptance.test.ts.
 */
describe('hosts (#1254)', () => {
  /** The literal the portal checkbox, the CLI matrix and this suite all pin (portal#888). */
  const SHARED_PAYLOAD = {
    exports: {
      claudeSkill: { name: 'hadron-demo', description: 'Use when demoing.', enable: true },
      codexSkill: { name: 'hadron-demo', description: 'Use when demoing.', enable: true },
    },
  };
  const hashOf = (body: string) => /hash=([0-9a-f]{16})/.exec(body)![1]!;

  it('judges the shared checkbox payload for BOTH hosts, from one renderer (P01, D01, R01)', async () => {
    await mkNode('tasks:demo', { properties: SHARED_PAYLOAD });

    const claude = await plan({ intent: 'EXPORT', host: 'claudeSkill', files: [] });
    const codex = await plan({ intent: 'EXPORT', host: 'codexSkill', files: [] });

    for (const got of [claude, codex]) {
      expect(got.judged).toBe(1);
      expect(got.entries).toHaveLength(1);
      expect(got.entries[0]).toMatchObject({ name: 'hadron-demo', class: 'never-exported', exportPlan: { action: 'WRITE' } });
    }
    // Equal per-host metadata renders byte-identically: there is one
    // renderer, and a host changes only what it is given.
    expect(codex.entries[0].renderedBody).toBe(claude.entries[0].renderedBody);
  });

  it("renders each host's own name and description when they differ (D06)", async () => {
    await mkNode('tasks:demo', {
      properties: {
        exports: {
          claudeSkill: { name: 'hadron-demo', description: 'Use when demoing.', enable: true },
          codexSkill: { name: 'hadron-demo-codex', description: 'Use when demoing in Codex.', enable: true },
        },
      },
    });

    const codex = await plan({ intent: 'EXPORT', host: 'codexSkill', files: [] });
    const claude = await plan({ intent: 'EXPORT', host: 'claudeSkill', files: [] });

    expect(codex.entries[0].name).toBe('hadron-demo-codex');
    expect(codex.entries[0].renderedBody).toContain('name: hadron-demo-codex');
    expect(codex.entries[0].renderedBody).toContain('Use when demoing in Codex.');
    expect(claude.entries[0].name).toBe('hadron-demo');
    // Different inputs, different provenance: each host's file is judged on its own.
    expect(hashOf(codex.entries[0].renderedBody)).not.toBe(hashOf(claude.entries[0].renderedBody));
  });

  it('an unrecognized host key (`codex`) is judged by NO host (D02)', async () => {
    await mkNode('tasks:demo', {
      properties: { exports: { codex: { name: 'hadron-demo', description: 'Use when demoing.', enable: true } } },
    });

    for (const host of ['claudeSkill', 'codexSkill']) {
      const got = await plan({ intent: 'LINT', host });
      // Scanned (the `exports` key exists) and judged by nobody — the gap
      // between the two numbers is the only trace of the silent failure.
      expect(got.scanned).toBe(1);
      expect(got.judged).toBe(0);
      expect(got.entries).toHaveLength(0);
    }
  });

  it('a legacy alias is a Claude declaration only (D07)', async () => {
    await mkNode('tasks:legacy', {
      properties: { skill: { name: 'hadron-demo', description: 'Use when demoing.', enable: true } },
    });

    const claude = await plan({ intent: 'LINT', host: 'claudeSkill' });
    const codex = await plan({ intent: 'LINT', host: 'codexSkill' });

    expect(claude.judged).toBe(1);
    expect(claude.entries[0].findings.map((f: { rule: string }) => f.rule)).toContain('skill-legacy-key');
    expect(codex.judged).toBe(0);
    expect(codex.entries).toHaveLength(0);
  });

  it('enable is per host: Codex switched off REMOVES its file while Claude still writes (D03, P04)', async () => {
    const node = await mkNode('tasks:demo', { properties: SHARED_PAYLOAD });
    const first = await plan({ intent: 'EXPORT', host: 'codexSkill', files: [] });
    const urn = first.entries[0].urn as string;
    const headerHash = hashOf(first.entries[0].renderedBody);

    await db.node.update({
      where: { id: node.id },
      data: {
        properties: {
          exports: { ...SHARED_PAYLOAD.exports, codexSkill: { ...SHARED_PAYLOAD.exports.codexSkill, enable: false } },
        },
      },
    });
    const codexFile = { dirName: 'hadron-demo', sourceUrn: urn, nodeId: node.id, headerHash, fileHash: headerHash };

    const codex = await plan({ intent: 'EXPORT', host: 'codexSkill', files: [codexFile] });
    const claude = await plan({ intent: 'EXPORT', host: 'claudeSkill', files: [] });

    expect(codex.entries[0]).toMatchObject({ class: 'disabled', exportPlan: { action: 'REMOVE', reasons: [{ code: 'disabled' }] } });
    expect(claude.entries[0]).toMatchObject({ class: 'never-exported', exportPlan: { action: 'WRITE' } });
  });

  it("applies the host's own limits: over 1,024 on Codex only is SKIPPED for Codex and preserves its file (L01, P09)", async () => {
    const long = 'Use when demoing. ' + 'x'.repeat(1025 - 'Use when demoing. '.length);
    const node = await mkNode('tasks:demo', { properties: SHARED_PAYLOAD });
    const first = await plan({ intent: 'EXPORT', host: 'codexSkill', files: [] });
    const urn = first.entries[0].urn as string;
    const headerHash = hashOf(first.entries[0].renderedBody);
    await db.node.update({
      where: { id: node.id },
      data: {
        properties: {
          exports: { ...SHARED_PAYLOAD.exports, codexSkill: { ...SHARED_PAYLOAD.exports.codexSkill, description: long } },
        },
      },
    });

    const codex = await plan({
      intent: 'EXPORT',
      host: 'codexSkill',
      files: [{ dirName: 'hadron-demo', sourceUrn: urn, nodeId: node.id, headerHash, fileHash: headerHash }],
    });
    const claude = await plan({ intent: 'EXPORT', host: 'claudeSkill', files: [] });

    expect(codex.entries[0].renderedBody).toBeNull();
    expect(codex.entries[0].exportPlan).toMatchObject({
      action: 'SKIP',
      preservesExistingFile: true,
      reasons: [{ code: 'skill-description-too-long' }],
    });
    expect(claude.entries[0].exportPlan).toMatchObject({ action: 'WRITE' });
  });

  it('collisions are per host: a shared Codex name collides for Codex only (C03)', async () => {
    await mkNode('tasks:a', {
      properties: {
        exports: {
          claudeSkill: { name: 'hadron-a', description: 'Use when a.', enable: true },
          codexSkill: { name: 'hadron-x', description: 'Use when x.', enable: true },
        },
      },
    });
    await mkNode('tasks:b', {
      properties: {
        exports: {
          claudeSkill: { name: 'hadron-b', description: 'Use when b.', enable: true },
          codexSkill: { name: 'hadron-x', description: 'Use when x.', enable: true },
        },
      },
    });

    const codex = await plan({ intent: 'EXPORT', host: 'codexSkill', files: [] });
    const claude = await plan({ intent: 'EXPORT', host: 'claudeSkill', files: [] });

    expect(codex.entries).toHaveLength(2);
    for (const e of codex.entries) {
      expect(e).toMatchObject({ class: 'collision', renderedBody: null, exportPlan: { action: 'REFUSE' } });
    }
    for (const e of claude.entries) {
      expect(e).toMatchObject({ class: 'never-exported', exportPlan: { action: 'WRITE' } });
    }
  });

  describe('only ENABLED declarations claim a name (cor:agt:030:06, D-2026-09-23-C; #1289)', () => {
    const decl = (name: string, enable?: boolean) => ({
      exports: {
        codexSkill: {
          name,
          description: 'Use when x.',
          ...(enable === undefined ? {} : { enable }),
        },
      },
    });
    const collisionRules = (entries: { findings: { rule: string }[] }[]) =>
      entries.flatMap((e) => e.findings.map((f) => f.rule)).filter((r) => r === 'skill-name-collision');

    it.each([
      ['switched off', false],
      ['never switched on (enable absent)', undefined],
    ])('an old declaration %s hands its name to a new enabled one', async (_label, enable) => {
      await mkNode('tasks:old', { properties: decl('hadron-x', enable) });
      await mkNode('tasks:new', { properties: decl('hadron-x', true) });

      const got = await plan({ intent: 'EXPORT', host: 'codexSkill', files: [] });
      const byLoc = (loc: string) => got.entries.find((e: { urn: string }) => e.urn.endsWith(loc));

      expect(collisionRules(got.entries)).toEqual([]);
      expect(byLoc('tasks:old')).toMatchObject({ class: 'disabled', renderedBody: null });
      expect(byLoc('tasks:new')).toMatchObject({ class: 'never-exported', exportPlan: { action: 'WRITE' } });
      expect(byLoc('tasks:new').renderedBody).toContain('name: hadron-x');
    });

    it('two ENABLED declarations in different organisations still collide', async () => {
      // The control for the two cases above: the rule narrowed WHICH
      // declarations count, not whether a collision spans orgs.
      const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
      const org2 = await db.organization.create({ data: { id: generateId(), name: 'sp2', urn: `sp2-${t}` } });
      await db.orgMember.create({ data: { organizationId: org2.id, userId: admin.id, role: 'ADMIN' } });
      const mem2 = await resolvers.Mutation.createMemory({}, { orgId: org2.id, name: `sp2-mem-${t}` }, ctx());
      await mkNode('tasks:here', { properties: decl('hadron-x', true) });
      await mkNode('tasks:there', { memoryId: mem2.id, properties: decl('hadron-x', true) });

      const got = await plan({ intent: 'EXPORT', host: 'codexSkill', files: [] });

      expect(got.entries).toHaveLength(2);
      expect(new Set(got.entries.map((e: { urn: string }) => e.urn.split(':')[2])).size).toBe(2);
      for (const e of got.entries) {
        expect(e).toMatchObject({ class: 'collision', renderedBody: null, exportPlan: { action: 'REFUSE' } });
      }
      expect(collisionRules(got.entries)).toHaveLength(2);
    });

    it.each([
      // The old file was hand-edited: `:01` refuses to remove it, and the new
      // node must not overwrite it either.
      ['hand-edited', 'b'.repeat(16), 'REFUSE'],
      // An unedited old file is removed in this run. The new node is still
      // refused THIS run: the plan is computed against the disk as the client
      // saw it, and the directory is occupied until the removal happens.
      ['unedited', 'a'.repeat(16), 'REMOVE'],
    ])('the old node\'s %s file still protects its directory', async (_label, fileHash, oldAction) => {
      const old = await mkNode('tasks:old', { properties: decl('hadron-x', false) });
      await mkNode('tasks:new', { properties: decl('hadron-x', true) });

      const got = await plan({
        intent: 'EXPORT',
        host: 'codexSkill',
        files: [{
          dirName: 'hadron-x',
          sourceUrn: 'hrn:node:example.com:demo:tasks:old',
          nodeId: old.id,
          headerHash: 'a'.repeat(16),
          fileHash,
        }],
      });
      const byLoc = (loc: string) => got.entries.find((e: { urn: string }) => e.urn.endsWith(loc));

      expect(collisionRules(got.entries)).toEqual([]);
      expect(byLoc('tasks:old').exportPlan).toMatchObject({ action: oldAction });
      expect(byLoc('tasks:new').renderedBody).toBeNull();
      expect(byLoc('tasks:new').exportPlan).toMatchObject({
        action: 'REFUSE',
        preservesExistingFile: true,
        reasons: [{ code: 'target-occupied' }],
      });
    });
  });

  describe('an unrecognised exports key is reported, never blocks (#1292, cor:agt:030:06)', () => {
    const ok = { name: 'hadron-demo', description: 'Use when demoing.', enable: true };

    it('a node declaring ONLY an unknown key has no entry, and is in `unrecognized` for every host', async () => {
      await mkNode('tasks:codex-only', { properties: { exports: { codex: ok } } });

      const claude = await plan({ intent: 'EXPORT', host: 'claudeSkill', files: [] });
      const codex = await plan({ intent: 'EXPORT', host: 'codexSkill', files: [] });

      for (const p of [claude, codex]) {
        expect(p.entries).toEqual([]);
        // The scanned-minus-judged gap is now explained, not a bare number.
        expect(p).toMatchObject({ scanned: 1, judged: 0 });
        expect(p.unrecognized).toHaveLength(1);
        expect(p.unrecognized[0]).toMatchObject({
          keys: ['codex'],
          findings: [{ rule: 'skill-unknown-host-key', severity: 'warning' }],
        });
        expect(p.unrecognized[0].urn).toContain('tasks:codex-only');
        // Labelled by the node's name (mkNode sets name = loc), so a report can
        // show a node that has no entry anywhere without deriving a label.
        expect(p.unrecognized[0].name).toBe('tasks:codex-only');
      }
      // Host-independent: the same report whichever host was asked for.
      expect(claude.unrecognized).toEqual(codex.unrecognized);
    });

    it('a MALFORMED unknown key beside a valid Claude declaration no longer blocks it', async () => {
      // Before #1292 `codex: "yes"` was a malformed ERROR on every host, so
      // this valid Claude skill was SKIPPED.
      await mkNode('tasks:mixed', { properties: { exports: { claudeSkill: ok, codex: 'yes' } } });

      const got = await plan({ intent: 'EXPORT', host: 'claudeSkill', files: [] });

      expect(got.entries).toHaveLength(1);
      expect(got.entries[0].findings).toEqual([]);
      expect(got.entries[0]).toMatchObject({ class: 'never-exported', exportPlan: { action: 'WRITE' } });
      expect(got.entries[0].renderedBody).toContain('name: hadron-demo');
      expect(got.unrecognized.map((u: { keys: string[] }) => u.keys)).toEqual([['codex']]);
    });

    it('CONTROL: known hosts only means nothing unrecognised', async () => {
      await mkNode('tasks:both', { properties: { exports: { claudeSkill: ok, codexSkill: ok } } });

      const got = await plan({ intent: 'LINT' });

      expect(got.entries).toHaveLength(1);
      expect(got.unrecognized).toEqual([]);
    });

    // @codex P1 then @copilot on PR #1296: `properties` is writer-controlled,
    // so the REPORT is bounded, and the bound never blocks the plan: an
    // unknown key must not cost a valid entry its export (cor:agt:030:06).
    const manyKeys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${String(i).padStart(4, '0')}`, 0]));

    it('a node with thousands of unknown keys: the valid entry still exports, and nothing is dropped silently', async () => {
      await mkNode('tasks:noisy', { properties: { exports: { claudeSkill: ok, ...manyKeys(5_000) } } });

      const got = await plan({ intent: 'EXPORT', host: 'claudeSkill', files: [] });

      expect(got.entries).toHaveLength(1);
      expect(got.entries[0]).toMatchObject({ findings: [], exportPlan: { action: 'WRITE' } });
      const u = got.unrecognized[0];
      expect(u.keyCount).toBe(5_000);
      expect(u.keys).toEqual(Object.keys(manyKeys(10)));
      expect(u.findings).toHaveLength(11);
      expect(u.findings.every((f: { severity: string }) => f.severity === 'warning')).toBe(true);
      expect(u.findings[10].message).toMatch(/carries 4990 more unrecognised key\(s\) not listed/);
    });

    it('one enormous key is counted, not listed, and blocks nothing', async () => {
      await mkNode('tasks:huge', { properties: { exports: { claudeSkill: ok, ['x'.repeat(129)]: 0, codex: 0 } } });

      const got = await plan({ intent: 'EXPORT', host: 'claudeSkill', files: [] });

      expect(got.entries[0]).toMatchObject({ exportPlan: { action: 'WRITE' } });
      expect(got.unrecognized[0]).toMatchObject({ keyCount: 2, keys: ['codex'] });
      expect(got.unrecognized[0].findings[1].message).toMatch(/carries 1 more unrecognised key\(s\)/);
    });

    it('CONTROL: an ordinary node lists every key, with no summary warning', async () => {
      await mkNode('tasks:plain', { properties: { exports: { claudeSkill: ok, codex: 0, cursor: 0 } } });
      const got = await plan({ intent: 'LINT' });
      expect(got.unrecognized[0]).toMatchObject({ keyCount: 2, keys: ['codex', 'cursor'] });
      expect(got.unrecognized[0].findings).toHaveLength(2);
    });

    it('goes through the same access gate as the entries', async () => {
      await mkNode('tasks:codex-only', { properties: { exports: { codex: ok } } });

      const mine = await plan({ intent: 'LINT' });
      const theirs = await plan({ intent: 'LINT' }, strangerCtx());

      expect(mine.unrecognized).toHaveLength(1);
      expect(theirs.unrecognized).toEqual([]);
      expect(theirs.scanned).toBe(0);
    });
  });

  it('a malformed Codex entry is reported by the Codex plan (matrix D10)', async () => {
    await mkNode('tasks:demo', {
      properties: { exports: { claudeSkill: SHARED_PAYLOAD.exports.claudeSkill, codexSkill: true } },
    });

    const codex = await plan({ intent: 'LINT', host: 'codexSkill' });

    expect(codex.judged).toBe(1);
    expect(codex.entries[0].findings).toEqual([
      expect.objectContaining({ rule: 'skill-declaration-malformed', severity: 'error' }),
    ]);
  });
});

// ── #1309 — the CLI's REAL legacy payload, in every accepted spelling ─────
//
// D-2026-09-24-A (cor:agt:030:01, Holger via Vera, team chat #1368): a file
// with no `id=` pairs with the node AT its header's source URN; an id-bearing
// file pairs by id only; a URN that no longer resolves is an orphan; one file
// reported as both refused and orphaned is invalid.
//
// The P08 table above submits the CANONICAL spelling, which is why it was
// green while production refused Tove's legacy file (team chat #1346/#1366):
// hadron-cli's `legacyHeaderRE` accepts the `::` grammar and `status.go` sends
// the token verbatim, with no nodeId and — for a no-id file — no hashes at all.
// These cases send exactly that payload.
describe('#1309 — a no-id legacy file pairs by its source URN in every accepted spelling (D-2026-09-24-A)', () => {
  /** The spellings a legacy `<!-- Generated from <urn> -->` header can carry. */
  const spellings = (canonical: string) => {
    const { memoryUrn, loc } = splitNodeUrn(canonical);
    const doubleColon = `${memoryUrn.replace(':', '::')}::${loc}`;
    return {
      canonical,
      'double-colon': doubleColon,
      'v1-prefixed': `urn:node:${doubleColon}`,
    } as Record<string, string>;
  };
  const SPELLINGS = ['canonical', 'double-colon', 'v1-prefixed'] as const;

  /** A declared node, and its canonical URN as the planner states it. */
  const declared = async (loc: string) => {
    const node = await mkNode(loc, { properties: declaration() });
    const urn = (await plan({ intent: 'LINT' })).entries.find((e: { nodeId: string }) => e.nodeId === node.id).urn as string;
    return { node, urn };
  };

  it.each(SPELLINGS)('P08 (%s): preserved and reported — never an orphan, never target-occupied', async (spelling) => {
    const { urn } = await declared('tasks:legacy-p08');
    const file = { dirName: 'my-skill', sourceUrn: spellings(urn)[spelling] };

    const got = await plan({ intent: 'EXPORT', files: [file] });
    expect(got.orphans).toEqual([]);
    expect(got.entries[0]).toMatchObject({
      urn,
      class: 'unhashed',
      renderedBody: null,
      exportPlan: { action: 'SKIP', preservesExistingFile: true, reasons: [{ code: 'missing-node-id' }] },
    });

    const forced = await plan({ intent: 'EXPORT', force: true, files: [file] });
    expect(forced.orphans).toEqual([]);
    expect(forced.entries[0].exportPlan).toMatchObject({ action: 'WRITE', reasons: [{ code: 'missing-node-id-override' }] });
    expect(forced.entries[0].renderedBody).toContain('# Body');
  });

  it.each(SPELLINGS)('P12 (%s): a rename is SKIPPED; --force MOVES it from the legacy directory', async (spelling) => {
    const { node, urn } = await declared('tasks:legacy-p12');
    await db.node.update({ where: { id: node.id }, data: { properties: declaration({ name: 'new-name' }) } });
    const file = { dirName: 'my-skill', sourceUrn: spellings(urn)[spelling] };

    const got = await plan({ intent: 'EXPORT', files: [file] });
    expect(got.orphans).toEqual([]);
    expect(got.entries[0].exportPlan).toMatchObject({ action: 'SKIP', reasons: [{ code: 'missing-node-id' }] });

    const forced = await plan({ intent: 'EXPORT', force: true, files: [file] });
    expect(forced.entries[0]).toMatchObject({
      movedFrom: 'my-skill',
      exportPlan: { action: 'MOVE', reasons: [{ code: 'missing-node-id-override' }] },
    });
  });

  it.each(SPELLINGS)('P13 (%s): a disabled declaration REMOVES it without --force', async (spelling) => {
    const { node, urn } = await declared('tasks:legacy-p13');
    await db.node.update({ where: { id: node.id }, data: { properties: declaration({ enable: false }) } });

    const got = await plan({ intent: 'EXPORT', files: [{ dirName: 'my-skill', sourceUrn: spellings(urn)[spelling] }] });
    expect(got.orphans).toEqual([]);
    expect(got.entries[0]).toMatchObject({
      movedFrom: 'my-skill',
      exportPlan: { action: 'REMOVE', reasons: [{ code: 'disabled' }] },
    });
  });

  it.each(SPELLINGS)('P14 (%s): evidence of a hand edit REFUSES without --force', async (spelling) => {
    const { urn } = await declared('tasks:legacy-p14');
    const file = { dirName: 'my-skill', sourceUrn: spellings(urn)[spelling], hasExtraFrontmatter: true };

    const got = await plan({ intent: 'EXPORT', files: [file] });
    expect(got.orphans).toEqual([]);
    expect(got.entries[0].exportPlan).toMatchObject({ action: 'REFUSE', reasons: [{ code: 'locally-edited' }] });

    const forced = await plan({ intent: 'EXPORT', force: true, files: [file] });
    expect(forced.entries[0].exportPlan).toMatchObject({ action: 'WRITE', reasons: [{ code: 'locally-edited-override' }] });
  });

  describe('controls: the fallback widens only the SPELLING, never the identity rule', () => {
    it('an id-bearing file still pairs by id ONLY: a dead id with a live `::` source is an orphan', async () => {
      const { urn } = await declared('tasks:legacy-id-first');
      const got = await plan({
        intent: 'EXPORT',
        files: [{ dirName: 'elsewhere', nodeId: generateId(), sourceUrn: spellings(urn)['double-colon'] }],
      });
      expect(got.orphans.map((o: { dirName: string }) => o.dirName)).toEqual(['elsewhere']);
      expect(got.entries[0].class).toBe('never-exported');
    });

    it('a URN that no longer resolves is an orphan, in any spelling', async () => {
      const { urn } = await declared('tasks:legacy-live');
      const gone = urn.replace(/tasks:legacy-live$/, 'tasks:moved-away');
      const got = await plan({
        intent: 'EXPORT',
        files: SPELLINGS.map((s, i) => ({ dirName: `gone-${i}`, sourceUrn: spellings(gone)[s] })),
      });
      expect(got.orphans.map((o: { dirName: string }) => o.dirName).sort()).toEqual(['gone-0', 'gone-1', 'gone-2']);
      expect(got.entries[0].class).toBe('never-exported');
    });

    it('a source that is not a node URN at all is an orphan, and never throws', async () => {
      await declared('tasks:legacy-garbage');
      for (const sourceUrn of ['not a urn', 'tasks:legacy-garbage', 'hrn:memory:x:y', generateId(), '::::']) {
        const got = await plan({ intent: 'EXPORT', files: [{ dirName: 'junk', sourceUrn }] });
        expect(got.orphans.map((o: { dirName: string }) => o.dirName), sourceUrn).toEqual(['junk']);
      }
    });

    it('the orphan report keeps the spelling the client SENT, so a client can find its own file', async () => {
      const { urn } = await declared('tasks:legacy-echo');
      const sent = spellings(urn.replace(/legacy-echo$/, 'nope'))['double-colon'];
      const got = await plan({ intent: 'EXPORT', files: [{ dirName: 'x', sourceUrn: sent }] });
      expect(got.orphans).toEqual([{ dirName: 'x', sourceUrn: sent, nodeId: null }]);
    });
  });
});

// ── #1310 review round 2 (@codex P1): identity survives PAST pairing ──────
//
// Two DIFFERENT nodes can emit ONE URN (the emitter flattens a compound
// memory). Pairing now picks the right one, but every per-node lookup after it
// — the paired file, the rendered content, the lint findings — was keyed by
// that URN, so a disabled twin could claim the other node's file and plan an
// unforced REMOVE of it. Built from real rows, not stubs.
describe('#1310 — two nodes that emit ONE URN stay two nodes, end to end', () => {
  const setup = async () => {
    // Plain memory `<mem>` + loc `tasks:b`, and compound memory `<mem>:tasks`
    // + loc `b`: both emit `hrn:node:<mem>:tasks:b`.
    const plain = await mkNode('tasks:b', {
      content: '# PLAIN body',
      properties: declaration({ name: 'plain-skill' }),
    });
    const compoundMem = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, name: 'compound', urn: `${mem.urn}:tasks`, class: 'knowledge' },
    });
    const compound = await db.node.create({
      data: {
        id: generateId(), memoryId: compoundMem.id, loc: 'b', name: 'b', isRunnable: true,
        content: '# COMPOUND body',
        properties: declaration({ name: 'compound-skill', enable: false }),
      },
    });
    return { plain, compound };
  };
  const entryFor = (p: { entries: { nodeId: string }[] }, id: string) => p.entries.find((e) => e.nodeId === id) as any;
  // The file names the PLAIN node unambiguously (`::` grammar), carries no id.
  const legacyFile = () => ({ dirName: 'plain-skill', sourceUrn: `${mem.urn.replace(':', '::')}::tasks:b` });

  it('PRECONDITION: the two entries really do share one emitted URN', async () => {
    const { plain, compound } = await setup();
    const p = await plan({ intent: 'LINT' });
    expect(entryFor(p, plain.id).urn).toBe(entryFor(p, compound.id).urn);
  });

  it('the disabled twin does NOT claim the other node\'s file: no REMOVE of a directory it does not own', async () => {
    const { plain, compound } = await setup();
    const p = await plan({ intent: 'EXPORT', files: [legacyFile()] });
    expect(p.orphans).toEqual([]);
    expect(entryFor(p, plain.id).exportPlan).toMatchObject({ action: 'SKIP', reasons: [{ code: 'missing-node-id' }] });
    expect(entryFor(p, compound.id)).toMatchObject({
      class: 'disabled',
      movedFrom: null,
      exportPlan: { action: 'SKIP', preservesExistingFile: true },
    });
  });

  it('each node renders ITS OWN content', async () => {
    const { plain, compound } = await setup();
    await db.node.update({ where: { id: compound.id }, data: { properties: declaration({ name: 'compound-skill' }) } });
    const p = await plan({ intent: 'EXPORT', files: [] });
    expect(entryFor(p, plain.id).renderedBody).toContain('# PLAIN body');
    expect(entryFor(p, plain.id).renderedBody).not.toContain('COMPOUND');
    expect(entryFor(p, compound.id).renderedBody).toContain('# COMPOUND body');
  });

  it('each node keeps ITS OWN lint findings: one twin\'s error is not overwritten by the other\'s clean result', async () => {
    const { plain, compound } = await setup();
    // An empty body is a lint error; give it to the node linted FIRST.
    const [first] = [plain, compound];
    await db.node.update({ where: { id: first.id }, data: { content: '' } });
    await db.node.update({ where: { id: compound.id }, data: { properties: declaration({ name: 'compound-skill' }) } });
    const p = await plan({ intent: 'EXPORT', files: [] });
    const rules = (id: string) => (entryFor(p, id).findings as { rule: string }[]).map((f) => f.rule);
    expect(rules(first.id)).toContain('skill-content-empty');
    expect(rules(compound.id)).not.toContain('skill-content-empty');
    expect(entryFor(p, first.id).renderedBody).toBeNull();
  });
});
