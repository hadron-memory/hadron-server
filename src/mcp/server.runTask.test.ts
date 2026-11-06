/**
 * Behavioral coverage for hadron_run_task — run a task by loose name (spec
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
 *     byte-identical to hadron_run_action (the extracted run core).
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

describe('hadron_run_task — runnable predicate (cor:api:060:01)', () => {
  it('runs a unique match, substitutes args, and inlines edge dependencies', async () => {
    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_run_task', {
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
    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_run_task', {
      task: 'draft',
      memory: 'Alpha',
    });
    // 'draft' matches only the non-runnable node → no runnable match in Alpha.
    expect(text).toContain('No runnable task matching "draft" in Alpha');
    expect(text).not.toContain('# Node: Add review draft');
  });
});

describe('hadron_run_task — disambiguation (cor:api:060:03, fallback/list path)', () => {
  it('returns the candidate list when a task hint is ambiguous', async () => {
    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_run_task', {
      task: 'add',
      memory: 'Alpha',
    });
    expect(text).toContain('Multiple tasks match "add" in Alpha');
    expect(text).toContain('Add review');
    expect(text).toContain('Add note');
    expect(text).toContain('Re-run hadron_run_task with `urn`');
    // The non-runnable "Add review draft" must not appear.
    expect(text).not.toContain('notes:draft');
  });

  it('lists the runnable tasks when no task hint is given', async () => {
    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_run_task', {
      memory: 'Alpha',
    });
    expect(text).toContain('Tasks in Alpha — pick one to run');
    expect(text).toContain('Add review');
    expect(text).toContain('Add note');
    expect(text).not.toContain('docs:policy'); // non-runnable dependency excluded
    expect(text).not.toContain('notes:draft');
  });

  it('reports cleanly when a memory has no runnable tasks', async () => {
    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_run_task', {
      memory: 'Gamma',
    });
    expect(text).toContain('No runnable tasks in Gamma');
  });

  /**
   * A runnable node whose loc has no v2 URN cannot be addressed, so it cannot be
   * run. It used to throw out of the strict emitter and take the WHOLE picker
   * down with it; now it is dropped, and the omission is disclosed rather than
   * silent. Inserted via raw Prisma because `validateLoc` rejects the loc.
   */
  it('drops an unaddressable task from the picker instead of failing the call', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.alpha.id,
        loc: 'tasks:add broken',
        name: 'Add broken',
        nodeType: 'task',
        isRunnable: true,
      },
    });

    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_run_task', {
      task: 'add',
      memory: 'Alpha',
    });

    // The healthy candidates still render…
    expect(text).toContain('Add review');
    expect(text).toContain('Add note');
    // …the unaddressable one does not…
    expect(text).not.toContain('Add broken');
    // …and the shortened list says so rather than passing itself off as complete.
    expect(text).toContain('1 unaddressable task hidden');
  });

  it('says so when every matching task is unaddressable (never an empty picker)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const loc of ['zed one', 'zed two']) {
      await db.node.create({
        data: {
          id: generateId(),
          memoryId: fx.alpha.id,
          loc,
          name: `Zed ${loc}`,
          nodeType: 'task',
          isRunnable: true,
        },
      });
    }
    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_run_task', {
      task: 'zed',
      memory: 'Alpha',
    });
    expect(text).toContain('none can be addressed to run');
  });
});

describe('hadron_run_task — resolution by name (cor:api:060:02)', () => {
  it('defaults to the session active memory when no memory hint is given', async () => {
    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('hadron_set_active_memory', { memoryUrn: fx.alpha.urn });
    // Three memories exist; without the active-memory default this would prompt
    // for a memory pick. With it set, the task resolves inside Alpha and runs.
    const text = await srv.callToolText('hadron_run_task', { task: 'Add note' });
    expect(text).toContain('# Node: Add note');
    expect(text).toContain('Add a note here');
  });

  it('widens to other readable memories on a miss but never auto-runs', async () => {
    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_run_task', {
      task: 'Deploy',
      memory: 'Alpha',
    });
    expect(text).toContain('No match in Alpha');
    expect(text).toContain('other memories');
    expect(text).toContain('Deploy');
    expect(text).toContain('hrn:node:run-task-org:beta:tasks:deploy');
    // Surfaced for an explicit pick — not executed.
    expect(text).not.toContain('Deploy it');
  });

  it('never discloses memories the caller cannot read', async () => {
    const text = await createTestableMcpServer(viewerAuth()).callToolText('hadron_run_task', {
      task: 'add',
    });
    expect(text).toContain('No memories you can read');
    expect(text).not.toContain('Alpha');
    expect(text).not.toContain('Add review');
  });

  it('discovers a personal task for an ADMIN who is its strict owner despite a different tenant owner (#1217)', async () => {
    const memory = await db.memory.create({
      data: {
        id: generateId(),
        class: 'personal',
        name: 'Strict Tasks',
        urn: `rt-viewer:strict-tasks-${generateId()}`,
        ownerUserId: fx.viewer.id,
        userId: fx.admin.id,
      },
    });
    await mkNode(memory.id, 'tasks:strict-owner', 'Strict owner task', {
      content: 'strict-owner content',
      isRunnable: true,
    });

    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_run_task', {
      task: 'Strict owner task',
      memory: 'Strict Tasks',
    });

    expect(text).toContain('# Node: Strict owner task');
    expect(text).toContain('strict-owner content');
  });

  it('does not disclose task candidates from another App personal memory to its ADMIN owner', async () => {
    const org = await db.organization.findFirstOrThrow({ where: { urn: 'run-task-org' } });
    const appA = await db.app.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        name: 'Discovery App A',
        urn: `${org.urn}:discovery-app-a`,
      },
    });
    const appB = await db.app.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        name: 'Discovery App B',
        urn: `${org.urn}:discovery-app-b`,
      },
    });
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        name: 'Discovery Agent',
        urn: `${org.urn}:discovery-agent`,
      },
    });
    const memory = await db.memory.create({
      data: {
        id: generateId(),
        class: 'personal',
        name: 'App B secret task memory',
        urn: `${org.urn}:app-b-secret-tasks`,
        ownerUserId: fx.viewer.id,
        userId: fx.admin.id,
        appId: appB.id,
        userMemoryOfAgentId: agent.id,
      },
    });
    await mkNode(memory.id, 'tasks:cross-app-secret', 'Cross App Secret', {
      content: 'must stay inside App B',
      isRunnable: true,
    });

    const text = await createTestableMcpServer({
      ...adminAuth(),
      appId: appA.id,
    }).callToolText('hadron_run_task', { task: 'Cross App Secret' });

    expect(text).not.toContain('App B secret task memory');
    expect(text).not.toContain('Cross App Secret');
    expect(text).not.toContain('must stay inside App B');
  });
});

describe('hadron_run_task — URN bypass + shared run core', () => {
  it('runs a fully-qualified URN directly, identical to hadron_run_action', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const urn = nodeUrnOf(fx.alpha, 'tasks:add-note');
    const viaTask = await srv.callToolText('hadron_run_task', { urn });
    const viaAction = await srv.callToolText('hadron_run_action', { urn });
    expect(viaTask).toContain('# Node: Add note');
    expect(viaTask).toEqual(viaAction); // byte-identical via the extracted core
  });

  it('URN bypass ignores the runnable predicate (runs any readable node)', async () => {
    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_run_task', {
      urn: nodeUrnOf(fx.alpha, 'notes:draft'),
    });
    expect(text).toContain('# Node: Add review draft');
    expect(text).toContain('draft body');
  });
});

describe('isRunnable write path (hadron_create_node / hadron_update_node / GraphQL createNode)', () => {
  it('hadron_create_task creates a runnable node that hadron_run_task then finds and runs', async () => {
    // #1201 moved this off hadron_create_node, which now REFUSES a write that
    // would produce a runnable node — authoring something the platform will
    // EXECUTE is not the same act as writing prose. The end-to-end contract is
    // unchanged and is what this asserts: the tool that authors a task and the
    // tool that runs it still meet.
    //
    // Note there is no `isRunnable` argument any more. The tool IS the
    // statement of intent, so it sets the signal; a caller that could also pass
    // it could disagree with the tool it chose.
    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('hadron_create_task', {
      urn: nodeUrnOf(fx.alpha, 'tasks:brand-new'),
      name: 'Brand new task',
      nodeType: 'info',
      content: 'do the new thing',
    });
    const row = await db.node.findFirst({
      where: { memoryId: fx.alpha.id, loc: 'tasks:brand-new' },
      select: { isRunnable: true },
    });
    expect(row?.isRunnable).toBe(true);

    const text = await srv.callToolText('hadron_run_task', { task: 'Brand new', memory: 'Alpha' });
    expect(text).toContain('# Node: Brand new task');
    expect(text).toContain('do the new thing');
  });

  it('hadron_update_task can clear isRunnable, removing the node from the task list', async () => {
    // #1201 — moved off the generic tool, and this test WAS the hole: clearing
    // `isRunnable` un-governs a node, so allowing it on `hadron_update_node`
    // meant the safety gate could be removed by the surface it protects
    // against. Retiring a task is legitimate; it just needs the task door.
    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('hadron_update_task', {
      urn: nodeUrnOf(fx.alpha, 'tasks:add-note'),
      isRunnable: false,
    });
    const row = await db.node.findFirst({
      where: { memoryId: fx.alpha.id, loc: 'tasks:add-note' },
      select: { isRunnable: true },
    });
    expect(row?.isRunnable).toBe(false);

    const text = await srv.callToolText('hadron_run_task', { task: 'Add note', memory: 'Alpha' });
    expect(text).toContain('No runnable task matching "Add note" in Alpha');
  });

  it('hadron_update_task edits a runnable node, preserving what is omitted', async () => {
    // Also moved off the generic tool, and for a sharper reason than the create
    // case: the gate reads the RESULTING state, so hadron_update_node refuses
    // even an edit that touches neither signal. A procedure the platform
    // executes must not be rewritable through the generic surface.
    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('hadron_update_task', {
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

  it('GraphQL createTaskNode threads isRunnable into the node', async () => {
    // The GraphQL half of the same move: createNode refuses isRunnable now, and
    // createTaskNode is the door. Kept as a separate case from the MCP one
    // because the two are independent implementations (#206) — the MCP tool
    // delegates here, but a regression in either would otherwise hide.
    const ctx: Context = { db, roles: ['ADMIN'], userId: fx.admin.id };
    await (
      resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    ).createTaskNode(
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

// #2712: serving is always on, and a manual run names no Agent, so it is refused BOOT_PROMPT_NOT_SET (cor:agt:040:07,
// R74), as production already does. These pin the refusal; a manual run that can name its Agent is a separate change.
describe('hadron_run_task — execute mode (#529, appRef)', () => {
  it('a MANUAL app run with no Agent is refused BOOT_PROMPT_NOT_SET and writes no run (R74)', async () => {
    const org = await db.organization.findFirstOrThrow({ where: { urn: 'run-task-org' } });
    const app = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'rt-app', urn: 'run-task-org::rt-app' },
    });
    const urn = nodeUrnOf(fx.alpha, 'tasks:add-note');

    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_run_task', {
      urn,
      appRef: app.id,
    });
    expect(text).toContain('Could not start run: No boot prompt is set for this Agent, so it cannot be served.');
    // Executed, not rendered — the task body must NOT be inlined.
    expect(text).not.toContain('Add a note here');
    expect(await db.appRun.count()).toBe(0);
  });

  it('resolves the task+memory hint path for a CANONICAL (org::mem) memory URN, then refuses the run (R74)', async () => {
    // Codex #549 review: a memory row whose stored urn is the canonical
    // double-colon form (as migrations produce) must still be runnable in
    // execute mode. The hint path composes the nodeRef from memory.urn — a
    // naive first-colon slice would mangle `org::mem` into `org:::mem::loc`
    // and resolveNodeRef would reject it, so no run could start.
    const org = await db.organization.findFirstOrThrow({ where: { urn: 'run-task-org' } });
    const canon = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        name: 'Canon',
        urn: 'run-task-org::canon', // canonical double-colon, not the createMemory single-colon
        class: 'knowledge',
      },
    });
    await mkNode(canon.id, 'tasks:ship', 'Ship it', { isRunnable: true, content: 'ship' });
    const app = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'canon-app', urn: 'run-task-org::canon-app' },
    });

    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_run_task', {
      task: 'Ship it',
      memory: 'Canon',
      appRef: app.id,
    });
    // The hint resolved: a mangled `org:::mem::loc` would fail resolution before the run's boot-prompt refusal.
    expect(text).toContain('Could not start run: No boot prompt is set for this Agent, so it cannot be served.');
    expect(await db.appRun.count()).toBe(0);
  });
});
