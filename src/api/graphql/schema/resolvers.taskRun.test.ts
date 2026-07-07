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
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { composeNodeUrn } from '../../../lib/urn.js';
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
let targetMemoryId: string;
let targetMemoryUrn: string;

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
  // A target memory the admin can write imports into.
  const target = await resolvers.Mutation.createMemory({}, { orgId, name: 'tr-import' }, adminCtx());
  targetMemoryId = target.id;
  targetMemoryUrn = target.urn;
});

// ───── #529 — runTask(appRef:) executes ──────────────────────────────────────

describe('#529 — runTask(appRef:) mints a MANUAL app run', () => {
  it('returns the run id and creates a PENDING AppRun for the task', async () => {
    const runId = await resolvers.Mutation.runTask(
      {},
      { urn: taskUrn, appRef: app.id },
      adminCtx(),
    );
    expect(typeof runId).toBe('string');
    const run = await db.appRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('PENDING');
    expect(run.triggerKind).toBe('MANUAL');
    expect(run.appId).toBe(app.id);
    expect(run.entryNodeUrn).toBe(taskUrn);
  });

  it('without appRef renders the prompt (backward compatible)', async () => {
    const rendered = await resolvers.Mutation.runTask(
      {},
      { urn: taskUrn },
      adminCtx(),
    );
    // The rendered template, not a run id.
    expect(rendered).toContain('Distill');
    expect(await db.appRun.count()).toBe(0);
  });

  it('appRef path keeps the admin gate (#530): a non-admin is rejected', async () => {
    const plain = await db.user.create({ data: { githubId: 9702, githubUsername: 'tr-plain' } });
    await db.orgMember.create({
      data: { organizationId: orgId, userId: plain.id, role: 'READER' },
    });
    await expect(
      resolvers.Mutation.runTask(
        {},
        { urn: taskUrn, appRef: app.id },
        { db, roles: [], userId: plain.id },
      ),
    ).rejects.toThrow();
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
      resolvers.Mutation.runTask({}, { urn: crossUrn, appRef: app.id }, adminCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await db.appRun.count()).toBe(0);
  });

  it('passes structured args through to eventData (not stringified) — #531 review', async () => {
    const runId = await resolvers.Mutation.runTask(
      {},
      { urn: taskUrn, appRef: app.id, args: { count: 3, tag: 'x' } },
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
  it('stores the node and mints a run (FETCH_PENDING + jobId, imported URN in eventData)', async () => {
    const res = await resolvers.Mutation.importNode(
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
    );
    expect(res.status).toBe('FETCH_PENDING');
    expect(res.node).toBeTruthy();
    expect(res.jobId).toBeTruthy();

    const run = await db.appRun.findUniqueOrThrow({ where: { id: res.jobId! } });
    expect(run.entryNodeUrn).toBe(taskUrn);
    expect(run.triggerKind).toBe('MANUAL');
    expect(run.appId).toBe(app.id);
    const importedUrn = composeNodeUrn(targetMemoryUrn, 'clip:page');
    expect((run.eventData as Record<string, unknown>).importedNodeUrn).toBe(importedUrn);
  });

  it('taskArgs are merged into the run eventData', async () => {
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

  it('runAsSelf on a personal-memory import; app-only on a knowledge import', async () => {
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
