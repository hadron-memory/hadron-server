/**
 * #528 / #529 — running a task server-side via the spec-040 app-run kernel.
 *
 *   - runTask(appRef:) EXECUTES the resolved task (mints a MANUAL AppRun) and
 *     returns the run id, instead of rendering the prompt string.
 *   - importNode(taskRef:) hands the just-stored node to a task run.
 *
 * Both reuse triggerAppRun's mint path (extracted as triggerManualRun) and so
 * keep its current org-ADMIN gate — relaxing that for interactive/import
 * callers is tracked in #530.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { composeNodeUrn } from '../../../lib/urn.js';
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let orgId: string;
let app: { id: string; urn: string };
let adminId: string;
let taskUrn: string;
let taskEntryUrnV2: string;
let targetMemoryId: string;
let targetMemoryUrn: string;

/** #2712: serving is always on, and a manual run is served as the App's single installed Agent (#2735), which needs an
 * approved prompt. Installs one (or serves `agentId` when the test installed its own). */
async function installServedAgent(agentId?: string): Promise<string> {
  const id = agentId ?? (await db.agent.create({ data: { id: generateId(), organizationId: orgId, urn: 'tr-org::runner', name: 'runner' } })).id;
  if (!agentId) await db.appAgent.create({ data: { appId: app.id, agentId: id } });
  await serveAgentBootPrompt(db, id, 'You run tasks.');
  return id;
}

function adminCtx(overrides: Partial<Context> = {}): Context {
  return { db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}`, ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'tr-org', urn: 'tr-org' },
  });
  orgId = org.id;
  app = await db.app.create({
    data: { id: generateId(), organizationId: orgId, name: 'tr-app', urn: 'tr-org::tr-app' },
  });
  const admin = await db.user.create({
    data: { githubId: 9701, githubUsername: 'tr-admin', roles: ['ADMIN'] },
  });
  adminId = admin.id;
  await db.orgMember.create({
    data: { organizationId: orgId, userId: adminId, role: 'ADMIN' },
  });
  // A runnable task node in a memory.
  const taskMemory = await db.memory.create({
    data: { id: generateId(), organizationId: orgId, name: 'tr-tasks', urn: 'tr-org::tr-tasks', class: 'knowledge' },
  });
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: taskMemory.id,
      loc: 'tasks:distill',
      isLink: false,
      name: 'distill',
      nodeType: 'task',
      isRunnable: true,
      content: 'Distill {{importedNodeUrn}}',
      tags: [],
    },
  });
  taskUrn = composeNodeUrn(taskMemory.urn, 'tasks:distill');
  // The entry-node URN the resolver now emits is flat v2 (single colon),
  // even though the request `nodeRef`/`taskRef` above stays the legacy `::` form.
  taskEntryUrnV2 = emitNodeUrnV2(taskMemory.urn, 'tasks:distill');
  // A target memory the admin can write imports into.
  const target = await resolvers.Mutation.createMemory({}, { orgId, name: 'tr-import' }, adminCtx());
  targetMemoryId = target.id;
  targetMemoryUrn = target.urn;
});

// ───── #529 — runTask(appRef:) executes ──────────────────────────────────────

describe('#529 — runTask(appRef:) mints a MANUAL app run', () => {
  it('a manual run names no Agent, so it is refused BOOT_PROMPT_NOT_SET and writes no run (#2712, R74)', async () => {
    await expect(
      resolvers.Mutation.runTask({}, { nodeRef: taskUrn, appRef: app.id }, adminCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'BOOT_PROMPT_NOT_SET' } });
    expect(await db.appRun.count()).toBe(0);
  });

  it('without appRef renders the prompt (backward compatible)', async () => {
    const rendered = await resolvers.Mutation.runTask(
      {},
      { nodeRef: taskUrn },
      adminCtx(),
    );
    // The rendered template, not a run id.
    expect(rendered).toContain('Distill');
    expect(await db.appRun.count()).toBe(0);
  });

  it('a caller with no App relationship (and not org-admin) is rejected (#530)', async () => {
    const plain = await db.user.create({ data: { githubId: 9702, githubUsername: 'tr-plain' } });
    await db.orgMember.create({
      data: { organizationId: orgId, userId: plain.id, role: 'READER' },
    });
    await expect(
      resolvers.Mutation.runTask(
        {},
        { nodeRef: taskUrn, appRef: app.id },
        { db, roles: [], userId: plain.id },
      ),
    ).rejects.toThrow();
    expect(await db.appRun.count()).toBe(0);
  });

  it('#530: a non-admin AppMember can trigger an interactive run', async () => {
    await installServedAgent();
    const member = await db.user.create({ data: { githubId: 9703, githubUsername: 'tr-member' } });
    await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
    const runId = await resolvers.Mutation.runTask(
      {},
      { nodeRef: taskUrn, appRef: app.id },
      { db, roles: [], userId: member.id },
    );
    const run = await db.appRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.appId).toBe(app.id);
    expect(run.triggerKind).toBe('MANUAL');
  });

  it('#530: a non-admin with an active AgentSubscription to an App agent can trigger', async () => {
    // Install an agent in the App, then subscribe a plain user to it.
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: orgId, urn: 'tr-org::sub-agent', name: 'sub-agent' },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await installServedAgent(agent.id);
    const subscriber = await db.user.create({ data: { githubId: 9704, githubUsername: 'tr-sub' } });
    await db.agentSubscription.create({
      data: { agentId: agent.id, userId: subscriber.id, activatedAt: new Date() },
    });
    const runId = await resolvers.Mutation.runTask(
      {},
      { nodeRef: taskUrn, appRef: app.id },
      { db, roles: [], userId: subscriber.id },
    );
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runId } })).appId).toBe(app.id);
  });

  it('#530: a revoked AgentSubscription does NOT authorize a trigger', async () => {
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: orgId, urn: 'tr-org::rev-agent', name: 'rev-agent' },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const exSub = await db.user.create({ data: { githubId: 9705, githubUsername: 'tr-exsub' } });
    // Was active, now revoked → the active predicate (revokedAt: null) excludes it.
    await db.agentSubscription.create({
      data: { agentId: agent.id, userId: exSub.id, activatedAt: new Date(), revokedAt: new Date() },
    });
    await expect(
      resolvers.Mutation.runTask({}, { nodeRef: taskUrn, appRef: app.id }, { db, roles: [], userId: exSub.id }),
    ).rejects.toThrow();
    expect(await db.appRun.count()).toBe(0);
  });

  it('rejects a cross-org entry node — tenant boundary (#531 review)', async () => {
    const orgB = await db.organization.create({
      data: { id: generateId(), name: 'tr-org-b', urn: 'tr-org-b' },
    });
    const memB = await db.memory.create({
      data: { id: generateId(), organizationId: orgB.id, name: 'b-tasks', urn: 'tr-org-b::b-tasks', class: 'knowledge' },
    });
    await db.node.create({
      data: { id: generateId(), memoryId: memB.id, loc: 'tasks:x', isLink: false, name: 'x', nodeType: 'task', isRunnable: true, tags: [] },
    });
    const crossUrn = composeNodeUrn(memB.urn, 'tasks:x');
    // App is in tr-org; task is in tr-org-b → rejected before mint.
    await expect(
      resolvers.Mutation.runTask({}, { nodeRef: crossUrn, appRef: app.id }, adminCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await db.appRun.count()).toBe(0);
  });

  it('passes structured args through to eventData (not stringified) — #531 review', async () => {
    await installServedAgent();
    const runId = await resolvers.Mutation.runTask(
      {},
      { nodeRef: taskUrn, appRef: app.id, args: { count: 3, tag: 'x' } },
      adminCtx(),
    );
    const run = await db.appRun.findUniqueOrThrow({ where: { id: runId } });
    // Number stays a number in eventData (would be "3" if stringified).
    expect((run.eventData as Record<string, unknown>).count).toBe(3);
    expect((run.eventData as Record<string, unknown>).tag).toBe('x');
  });
});

// ───── #528 — importNode(taskRef:) runs a task on the imported node ───────────

describe('#528 — importNode(taskRef:) runs a task on the imported node', () => {
  it('the hand-off run names no Agent, so it is refused BOOT_PROMPT_NOT_SET and mints no run (#2712, R74)', async () => {
    await expect(
      resolvers.Mutation.importNode(
        {},
        {
          input: {
            memoryId: targetMemoryId,
            loc: 'clip:page',
            content: '# Clipped',
            contentType: 'text/markdown',
            taskRef: taskUrn,
            appRef: app.id,
          },
        },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BOOT_PROMPT_NOT_SET' } });
    expect(await db.appRun.count()).toBe(0);
  });

  it('taskArgs are merged into the run eventData', async () => {
    await installServedAgent();
    const res = await resolvers.Mutation.importNode(
      {},
      {
        input: {
          memoryId: targetMemoryId,
          loc: 'clip:args',
          content: '# A',
          contentType: 'text/markdown',
          taskRef: taskUrn,
          appRef: app.id,
          taskArgs: { tone: 'brief' },
        },
      },
      adminCtx(),
    );
    const run = await db.appRun.findUniqueOrThrow({ where: { id: res.jobId! } });
    expect((run.eventData as Record<string, unknown>).tone).toBe('brief');
  });

  it('taskRef with no App (no appRef, no ctx.appId) → BAD_USER_INPUT, fails fast (no write)', async () => {
    await expect(
      resolvers.Mutation.importNode(
        {},
        {
          input: {
            memoryId: targetMemoryId,
            loc: 'clip:noapp',
            content: '# B',
            contentType: 'text/markdown',
            taskRef: taskUrn,
          },
        },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    // #531 review: the precondition is validated BEFORE the write — no run,
    // and no orphaned node.
    expect(await db.appRun.count()).toBe(0);
    expect(await db.node.findFirst({ where: { memoryId: targetMemoryId, loc: 'clip:noapp' } })).toBeNull();
  });

  it('taskRef that is not a runnable task → BAD_USER_INPUT (no write)', async () => {
    // A regular, non-runnable node in the target memory.
    const plain = await db.node.create({
      data: { id: generateId(), memoryId: targetMemoryId, loc: 'notes:plain', isLink: false, name: 'plain', tags: [] },
    });
    const plainUrn = composeNodeUrn(targetMemoryUrn, 'notes:plain');
    await expect(
      resolvers.Mutation.importNode(
        {},
        {
          input: {
            memoryId: targetMemoryId,
            loc: 'clip:nonrunnable',
            content: '# D',
            contentType: 'text/markdown',
            taskRef: plainUrn,
            appRef: app.id,
          },
        },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(plain).toBeTruthy(); // (silence unused)
    expect(await db.appRun.count()).toBe(0);
    expect(await db.node.findFirst({ where: { memoryId: targetMemoryId, loc: 'clip:nonrunnable' } })).toBeNull();
  });

  it('#533: a denied task hand-off (cross-org App) writes no node', async () => {
    // The run's launch prerequisites (App liveness, same-org entry boundary,
    // interactive gate) are now validated BEFORE writeNodeCore, so a hand-off
    // that can't launch never leaves an orphaned imported node.
    const orgB = await db.organization.create({
      data: { id: generateId(), name: 'tr-org-imp', urn: 'tr-org-imp' },
    });
    const appB = await db.app.create({
      data: { id: generateId(), organizationId: orgB.id, name: 'tr-app-imp', urn: 'tr-org-imp::tr-app-imp' },
    });
    // taskUrn is in tr-org; appB is in tr-org-imp → cross-org, denied pre-write.
    await expect(
      resolvers.Mutation.importNode(
        {},
        {
          input: {
            memoryId: targetMemoryId,
            loc: 'clip:denied',
            content: '# X',
            contentType: 'text/markdown',
            taskRef: taskUrn,
            appRef: appB.id,
          },
        },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    // No orphaned node, no run.
    expect(await db.node.findFirst({ where: { memoryId: targetMemoryId, loc: 'clip:denied' } })).toBeNull();
    expect(await db.appRun.count()).toBe(0);
  });

  it('runAsSelf on a personal-memory import; app-only on a knowledge import', async () => {
    await installServedAgent();
    // Knowledge target (the default fixture memory) → app-only, no user.
    const know = await resolvers.Mutation.importNode(
      {},
      { input: { memoryId: targetMemoryId, loc: 'clip:know', content: '# K', contentType: 'text/markdown', taskRef: taskUrn, appRef: app.id } },
      adminCtx(),
    );
    expect((await db.appRun.findUniqueOrThrow({ where: { id: know.jobId! } })).userId).toBeNull();

    // Personal target (owner-only) → attributed to the importing user, which
    // requires an App relationship (mintAppRun re-verifies it).
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: orgId, urn: 'tr-org::pa', name: 'pa' },
    });
    const personal = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, urn: 'tr-org::p-mem', name: 'p',
        class: 'personal', userId: adminId, appId: app.id, userMemoryOfAgentId: agent.id,
      },
    });
    await db.appMember.create({ data: { appId: app.id, userId: adminId, role: 'member' } });

    const res = await resolvers.Mutation.importNode(
      {},
      { input: { memoryId: personal.id, loc: 'clip:self', content: '# E', contentType: 'text/markdown', taskRef: taskUrn, appRef: app.id } },
      adminCtx(),
    );
    expect((await db.appRun.findUniqueOrThrow({ where: { id: res.jobId! } })).userId).toBe(adminId);
  });

  it('#566: owner-only import whose on-behalf-of user lacks an App relationship is denied pre-write (no orphan)', async () => {
    // Personal (owner-only) target ⇒ runAsSelf=true ⇒ the run is on-behalf-of
    // the importing user, whom mintAppRun requires to have a live App
    // relationship. Here the owner passes the trigger gate but is NOT an
    // AppMember/subscriber, so assertManualRunAllowed must reject PRE-write —
    // otherwise the node is written then the mint fails, orphaning it.
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: orgId, urn: 'tr-org::pa2', name: 'pa2' },
    });
    const personal = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, urn: 'tr-org::p-mem2', name: 'p2',
        class: 'personal', userId: adminId, appId: app.id, userMemoryOfAgentId: agent.id,
      },
    });
    // NB: no AppMember / subscription for adminId → no on-behalf-of relationship.
    await expect(
      resolvers.Mutation.importNode(
        {},
        { input: { memoryId: personal.id, loc: 'clip:orphan', content: '# Z', contentType: 'text/markdown', taskRef: taskUrn, appRef: app.id } },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'RELATIONSHIP_MISSING' } });
    expect(await db.node.findFirst({ where: { memoryId: personal.id, loc: 'clip:orphan' } })).toBeNull();
    expect(await db.appRun.count()).toBe(0);
  });

  it('without taskRef stays STORED (backward compatible)', async () => {
    const res = await resolvers.Mutation.importNode(
      {},
      {
        input: {
          memoryId: targetMemoryId,
          loc: 'clip:plain',
          content: '# C',
          contentType: 'text/markdown',
        },
      },
      adminCtx(),
    );
    expect(res.status).toBe('STORED');
    expect(res.jobId).toBeNull();
    expect(await db.appRun.count()).toBe(0);
  });
});
