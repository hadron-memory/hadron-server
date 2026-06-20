/**
 * Behavioral coverage for h-run-task — run a task by loose name (spec
 * cor:api:060). Drives the real production closure via createTestableMcpServer,
 * which never connects a transport, so getClientCapabilities() is undefined and
 * the tool takes the FALLBACK (list-relay) path — exactly the surface these
 * tests assert against. The interactive (elicitation) branch is the same
 * candidate set behind a capability flag.
 *
 * What this pins:
 *   - Runnable predicate (cor:api:060:01) keys on `isRunnable`, NOT nodeType:
 *     a nodeType:'info' node with isRunnable=true runs; a nodeType:'task' node
 *     with isRunnable=false is never offered or run by name.
 *   - Resolution by name (cor:api:060:02): unique hint runs; active memory is
 *     the no-hint default; conservative cross-memory widening never auto-runs;
 *     unreadable memories are never disclosed.
 *   - Disambiguation (cor:api:060:03): ambiguous / absent hint returns the
 *     candidate list for re-invocation by `urn`.
 *   - URN bypass + shared core: a fully-qualified `urn` runs directly and is
 *     byte-identical to h-run-action (the extracted run core).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

interface Mem {
  id: string;
  urn: string;
  name: string;
}

interface Fixture {
  admin: { id: string };
  viewer: { id: string };
  alpha: Mem;
  beta: Mem;
  gamma: Mem;
}

let fx: Fixture;

function adminAuth(): AuthContext {
  return { userId: fx.admin.id, roles: ['ADMIN'], clientId: `user:${fx.admin.id}` };
}
function viewerAuth(): AuthContext {
  // No roles, no AppMember, no org membership → empty access map.
  return { userId: fx.viewer.id, roles: [], clientId: `user:${fx.viewer.id}` };
}

// Memory URNs are stored single-colon (org:memory); node URNs are
// org::memory::loc. Compose a canonical node URN the way the server does.
function nodeUrnOf(mem: Mem, loc: string): string {
  const i = mem.urn.indexOf(':');
  return `${mem.urn.slice(0, i)}::${mem.urn.slice(i + 1)}::${loc}`;
}

function mkNode(
  memoryId: string,
  loc: string,
  name: string,
  opts: { nodeType?: string; content?: string; isRunnable?: boolean } = {},
) {
  return db.node.create({
    data: {
      id: generateId(),
      memoryId,
      loc,
      name,
      nodeType: opts.nodeType ?? 'task',
      content: opts.content ?? null,
      isRunnable: opts.isRunnable ?? false,
      tags: [],
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'run-task-org', urn: 'run-task-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 7701, githubUsername: 'rt-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  const viewer = await db.user.create({
    data: { githubId: 7702, githubUsername: 'rt-viewer', roles: [] },
  });

  const ctx: Context = { db, roles: ['ADMIN'], userId: admin.id };
  // Re-read the canonical bare URN (org::memory) from the DB — the resolver's
  // returned object exposes a different `urn` shape than the stored row.
  const mkMem = async (name: string): Promise<Mem> => {
    const created = (await resolvers.Mutation.createMemory(
      {},
      { orgId: org.id, name },
      ctx,
    )) as { id: string };
    return db.memory.findUniqueOrThrow({
      where: { id: created.id },
      select: { id: true, urn: true, name: true },
    });
  };
  const alpha = await mkMem('Alpha');
  const beta = await mkMem('Beta');
  const gamma = await mkMem('Gamma');

  // Alpha: two runnable tasks (one nodeType:'info' to prove the predicate keys
  // on isRunnable), a nodeType:'task' node that is NOT runnable, and a
  // non-runnable dependency the runnable one inlines via an edge.
  const addReview = await mkNode(alpha.id, 'tasks:add-review', 'Add review', {
    nodeType: 'info',
    content: 'Do the review {{who}}',
    isRunnable: true,
  });
  await mkNode(alpha.id, 'tasks:add-note', 'Add note', {
    content: 'Add a note here',
    isRunnable: true,
  });
  await mkNode(alpha.id, 'notes:draft', 'Add review draft', {
    nodeType: 'task',
    content: 'draft body',
    isRunnable: false,
  });
  const policy = await mkNode(alpha.id, 'docs:policy', 'Policy', {
    nodeType: 'info',
    content: 'Policy text',
    isRunnable: false,
  });
  await db.edge.create({
    data: {
      id: generateId(),
      memoryId: addReview.memoryId,
      sourceId: addReview.id,
      targetId: policy.id,
      loc: deriveEdgeLoc(addReview.loc, 'depends-on', policy.loc),
      name: 'depends-on',
    },
  });

  // Beta: a single runnable task (for cross-memory widening + memory scoping).
  await mkNode(beta.id, 'tasks:deploy', 'Deploy', { content: 'Deploy it', isRunnable: true });

  // Gamma: no runnable tasks.
  await mkNode(gamma.id, 'notes:x', 'Note X', { nodeType: 'task', isRunnable: false });

  fx = { admin, viewer, alpha, beta, gamma };
});

describe('h-run-task — runnable predicate (cor:api:060:01)', () => {
  it('runs a unique match, substitutes args, and inlines edge dependencies', async () => {
    const text = await createTestableMcpServer(adminAuth()).callToolText('h-run-task', {
      task: 'Add review',
      memory: 'Alpha',
      args: { who: 'Alice' },
    });
    expect(text).toContain('# Node: Add review'); // nodeType:'info' but isRunnable → runs
    expect(text).toContain('Do the review Alice'); // {{who}} substitution
    expect(text).toContain('# Referenced Nodes');
    expect(text).toContain('Policy text'); // edge-inlined dependency
  });

  it('never offers or runs a nodeType:"task" node that is not isRunnable', async () => {
    const text = await createTestableMcpServer(adminAuth()).callToolText('h-run-task', {
      task: 'draft',
      memory: 'Alpha',
    });
    // 'draft' matches only the non-runnable node → no runnable match in Alpha.
    expect(text).toContain('No runnable task matching "draft" in Alpha');
    expect(text).not.toContain('# Node: Add review draft');
  });
});

describe('h-run-task — disambiguation (cor:api:060:03, fallback/list path)', () => {
  it('returns the candidate list when a task hint is ambiguous', async () => {
    const text = await createTestableMcpServer(adminAuth()).callToolText('h-run-task', {
      task: 'add',
      memory: 'Alpha',
    });
    expect(text).toContain('Multiple tasks match "add" in Alpha');
    expect(text).toContain('Add review');
    expect(text).toContain('Add note');
    expect(text).toContain('Re-run h-run-task with `urn`');
    // The non-runnable "Add review draft" must not appear.
    expect(text).not.toContain('notes:draft');
  });

  it('lists the runnable tasks when no task hint is given', async () => {
    const text = await createTestableMcpServer(adminAuth()).callToolText('h-run-task', {
      memory: 'Alpha',
    });
    expect(text).toContain('Tasks in Alpha — pick one to run');
    expect(text).toContain('Add review');
    expect(text).toContain('Add note');
    expect(text).not.toContain('docs:policy'); // non-runnable dependency excluded
    expect(text).not.toContain('notes:draft');
  });

  it('reports cleanly when a memory has no runnable tasks', async () => {
    const text = await createTestableMcpServer(adminAuth()).callToolText('h-run-task', {
      memory: 'Gamma',
    });
    expect(text).toContain('No runnable tasks in Gamma');
  });
});

describe('h-run-task — resolution by name (cor:api:060:02)', () => {
  it('defaults to the session active memory when no memory hint is given', async () => {
    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('h-set-active-memory', { memoryUrn: fx.alpha.urn });
    // Three memories exist; without the active-memory default this would prompt
    // for a memory pick. With it set, the task resolves inside Alpha and runs.
    const text = await srv.callToolText('h-run-task', { task: 'Add note' });
    expect(text).toContain('# Node: Add note');
    expect(text).toContain('Add a note here');
  });

  it('widens to other readable memories on a miss but never auto-runs', async () => {
    const text = await createTestableMcpServer(adminAuth()).callToolText('h-run-task', {
      task: 'Deploy',
      memory: 'Alpha',
    });
    expect(text).toContain('No match in Alpha');
    expect(text).toContain('other memories');
    expect(text).toContain('Deploy');
    expect(text).toContain(nodeUrnOf(fx.beta, 'tasks:deploy'));
    // Surfaced for an explicit pick — not executed.
    expect(text).not.toContain('Deploy it');
  });

  it('never discloses memories the caller cannot read', async () => {
    const text = await createTestableMcpServer(viewerAuth()).callToolText('h-run-task', {
      task: 'add',
    });
    expect(text).toContain('No memories you can read');
    expect(text).not.toContain('Alpha');
    expect(text).not.toContain('Add review');
  });
});

describe('h-run-task — URN bypass + shared run core', () => {
  it('runs a fully-qualified URN directly, identical to h-run-action', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const urn = nodeUrnOf(fx.alpha, 'tasks:add-note');
    const viaTask = await srv.callToolText('h-run-task', { urn });
    const viaAction = await srv.callToolText('h-run-action', { urn });
    expect(viaTask).toContain('# Node: Add note');
    expect(viaTask).toEqual(viaAction); // byte-identical via the extracted core
  });

  it('URN bypass ignores the runnable predicate (runs any readable node)', async () => {
    const text = await createTestableMcpServer(adminAuth()).callToolText('h-run-task', {
      urn: nodeUrnOf(fx.alpha, 'notes:draft'),
    });
    expect(text).toContain('# Node: Add review draft');
    expect(text).toContain('draft body');
  });
});

describe('isRunnable write path (h-add-node / h-update-node / GraphQL upsertNode)', () => {
  it('h-add-node creates a runnable node that h-run-task then finds and runs', async () => {
    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('h-add-node', {
      urn: nodeUrnOf(fx.alpha, 'tasks:brand-new'),
      name: 'Brand new task',
      nodeType: 'info',
      isRunnable: true,
      content: 'do the new thing',
    });
    const row = await db.node.findFirst({
      where: { memoryId: fx.alpha.id, loc: 'tasks:brand-new' },
      select: { isRunnable: true },
    });
    expect(row?.isRunnable).toBe(true);

    const text = await srv.callToolText('h-run-task', { task: 'Brand new', memory: 'Alpha' });
    expect(text).toContain('# Node: Brand new task');
    expect(text).toContain('do the new thing');
  });

  it('h-update-node can clear isRunnable, removing the node from the task list', async () => {
    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('h-update-node', {
      urn: nodeUrnOf(fx.alpha, 'tasks:add-note'),
      isRunnable: false,
    });
    const row = await db.node.findFirst({
      where: { memoryId: fx.alpha.id, loc: 'tasks:add-note' },
      select: { isRunnable: true },
    });
    expect(row?.isRunnable).toBe(false);

    const text = await srv.callToolText('h-run-task', { task: 'Add note', memory: 'Alpha' });
    expect(text).toContain('No runnable task matching "Add note" in Alpha');
  });

  it('h-update-node preserves isRunnable when the field is omitted (partial update)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('h-update-node', {
      urn: nodeUrnOf(fx.alpha, 'tasks:add-review'),
      description: 'touched',
    });
    const row = await db.node.findFirst({
      where: { memoryId: fx.alpha.id, loc: 'tasks:add-review' },
      select: { isRunnable: true, description: true },
    });
    expect(row?.isRunnable).toBe(true);
    expect(row?.description).toBe('touched');
  });

  it('GraphQL upsertNode threads isRunnable into the node', async () => {
    const ctx: Context = { db, roles: ['ADMIN'], userId: fx.admin.id };
    await resolvers.Mutation.upsertNode(
      {},
      { input: { memoryId: fx.alpha.id, loc: 'tasks:via-gql', name: 'Via GQL', isRunnable: true } },
      ctx,
    );
    const row = await db.node.findFirst({
      where: { memoryId: fx.alpha.id, loc: 'tasks:via-gql' },
      select: { isRunnable: true },
    });
    expect(row?.isRunnable).toBe(true);
  });
});
