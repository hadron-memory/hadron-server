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
    expect(exported.entries[0].class).toBe('never-exported');
    expect(exported.entries[0].renderedBody).toContain('# Body');
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
      intent: 'STATUS',
      files: [{ dirName: 'my-skill', sourceUrn: urn, nodeId: node.id, headerHash, fileHash: headerHash }],
    });

    expect(got.entries[0].class).toBe('current');
    expect(got.orphans).toHaveLength(0);
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
});
