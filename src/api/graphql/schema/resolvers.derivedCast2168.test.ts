/** #2168 / cor:dmo:050:06,:11: one-hop installation without an AppAgent row. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { compileBootPrompt } from './compileBootPrompt.js';
import { resolveServedBootPrompt } from '../../../lib/bootPrompt/serve.js';
import { resolveRegister } from '../../../lib/resolveRegister.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { loadOfferedMemberRoles } from '../../../lib/memberRoles.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
const M = resolvers.Mutation as any;
let user: { id: string },
  org: { id: string },
  app: { id: string },
  parent: { id: string },
  role: { id: string };
const ctx = (): Context => ({ db, userId: user.id, roles: ['READER'] });
async function agent(name: string, personaRole: string) {
  const a = await M.createAgent(
    {},
    { orgId: org.id, name, personaRole },
    ctx(),
  );
  await serveAgentBootPrompt(db, a.id, 'DERIVED {{worker.role}}');
  return a;
}
async function edge(p = parent.id, child = role.id, required = true) {
  await db.agentOrgGrant.upsert({
    where: { orgId_agentId: { orgId: org.id, agentId: child } },
    create: {
      orgId: org.id,
      agentId: child,
      activatedAt: new Date(),
      revokedAt: null,
    },
    update: { activatedAt: new Date(), revokedAt: null },
  });
  return db.agentImport.create({
    data: {
      parentAgentId: p,
      importedAgentId: child,
      position: 100,
      required,
      agentOrgGrantOrgId: org.id,
      agentOrgGrantAgentId: child,
    },
  });
}
const cast = (extra: Record<string, unknown> = {}) =>
  M.castWorker(
    {},
    { appRef: app.id, agentRef: role.id, name: 'Derived', ...extra },
    ctx(),
  );
const refuse = async () => {
  await expect(cast()).rejects.toMatchObject({
    extensions: { code: 'WORKER_AGENT_NOT_INSTALLED', appId: app.id },
  });
  expect(await db.worker.count({ where: { appId: app.id } })).toBe(0);
};
beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: {
      name: 'Derived',
      urn: `derived-${generateId().toLowerCase()}.example`,
    },
  });
  user = await db.user.create({
    data: { handle: `derived-${generateId()}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: user.id, role: 'ADMIN' },
  });
  app = await db.app.create({
    data: {
      organizationId: org.id,
      name: 'Derived',
      urn: `derived-${generateId().toLowerCase()}.example:team`,
    },
  });
  parent = await agent('Importer', 'suite');
  role = await agent('Imported', 'engineer');
  await db.appAgent.create({ data: { appId: app.id, agentId: parent.id } });
  await edge();
});
it.each([true, false])(
  'casts a direct import (required=%s), renders its own prompt, and writes no install row',
  async (required) => {
    await db.agentImport.update({
      where: {
        parentAgentId_importedAgentId: {
          parentAgentId: parent.id,
          importedAgentId: role.id,
        },
      },
      data: { required },
    });
    const preview = await (resolvers.Query as any).castWorkerPreview(
      {},
      { appRef: app.id, agentRef: role.id, name: 'Derived' },
      ctx(),
    );
    expect(preview.prompt).toContain('DERIVED engineer');
    const w = await cast();
    expect(await db.worker.findUnique({ where: { id: w.id } })).toMatchObject({
      agentId: role.id,
      role: 'engineer',
    });
    expect(
      await db.appAgent.count({ where: { appId: app.id, agentId: role.id } }),
    ).toBe(0);
  },
);
it('casts by role from the derived tier', async () => {
  const w = await cast({ agentRef: undefined, role: ' ENGINEER ' });
  expect(await db.worker.findUnique({ where: { id: w.id } })).toMatchObject({
    agentId: role.id,
  });
});
it('prefers an installed role over its derived twin', async () => {
  await db.agent.update({
    where: { id: parent.id },
    data: { personaRole: 'engineer' },
  });
  const w = await cast({ agentRef: undefined, role: 'engineer' });
  expect(await db.worker.findUnique({ where: { id: w.id } })).toMatchObject({
    agentId: parent.id,
  });
});
it('refuses ambiguity within the derived tier', async () => {
  const twin = await agent('Twin', 'engineer');
  await db.agentOrgGrant.create({
    data: {
      orgId: org.id,
      agentId: twin.id,
      activatedAt: new Date(),
      revokedAt: null,
    },
  });
  await db.agentImport.create({
    data: {
      parentAgentId: parent.id,
      importedAgentId: twin.id,
      position: 200,
      agentOrgGrantOrgId: org.id,
      agentOrgGrantAgentId: twin.id,
    },
  });
  await expect(
    cast({ agentRef: undefined, role: 'engineer' }),
  ).rejects.toMatchObject({ extensions: { code: 'WORKER_AGENT_AMBIGUOUS' } });
});
it('refuses a non-imported agent', async () => {
  await db.agentImport.deleteMany({});
  await refuse();
});
it('removal stops new casts but leaves the existing Worker unchanged', async () => {
  const w = await cast();
  const before = await db.worker.findUnique({ where: { id: w.id } });
  await db.agentImport.deleteMany({});
  await expect(cast({ name: 'Second' })).rejects.toMatchObject({
    extensions: { code: 'WORKER_AGENT_NOT_INSTALLED' },
  });
  expect(await db.worker.findUnique({ where: { id: w.id } })).toEqual(before);
});
it('does not borrow an importer installed in another App', async () => {
  const other = await db.app.create({
    data: {
      organizationId: org.id,
      name: 'Other',
      urn: `other-${generateId().toLowerCase()}.example:team`,
    },
  });
  await db.appAgent.update({
    where: { appId_agentId: { appId: app.id, agentId: parent.id } },
    data: { appId: other.id },
  });
  await refuse();
});
it('does not derive through another derived import', async () => {
  const next = await agent('Next', 'next');
  await edge(role.id, next.id);
  role = next;
  await refuse();
});
it('refuses a deleted importer', async () => {
  await db.agent.update({
    where: { id: parent.id },
    data: { deletedAt: new Date() },
  });
  await refuse();
});
it('uses the App org grant and never reactivates a revoked grant', async () => {
  await db.agentOrgGrant.update({
    where: { orgId_agentId: { orgId: org.id, agentId: role.id } },
    data: { revokedAt: new Date() },
  });
  await expect(cast()).rejects.toMatchObject({
    extensions: { code: 'AGENT_ORG_GRANT_INACTIVE' },
  });
  expect(await db.worker.count()).toBe(0);
});
it('offers the derived Agent member roles', async () => {
  await db.agent.update({
    where: { id: role.id },
    data: { installationPolicy: { memberRoles: ['derived-member'] } },
  });
  expect((await loadOfferedMemberRoles(db, app.id)).roles).toContain(
    'derived-member',
  );
});
it('explicit install survives import removal', async () => {
  await db.appAgent.create({ data: { appId: app.id, agentId: role.id } });
  await db.agentImport.deleteMany({});
  const w = await cast();
  expect(w.id).toBeTruthy();
});

it('customises a derived install lazily without writing an AppAgent row', async () => {
  expect(
    await db.memory.count({
      where: { appId: app.id, installOfAgentId: role.id },
    }),
  ).toBe(0);
  const node = await M.createNode(
    {},
    {
      input: {
        install: { appRef: app.id, agentRef: role.id },
        loc: 'prompts:derived',
        name: 'Derived',
        content: 'custom',
      },
    },
    ctx(),
  );
  const memories = await db.memory.findMany({
    where: { appId: app.id, installOfAgentId: role.id, isInstallMemory: true },
  });
  expect(memories).toHaveLength(1);
  expect(node.memoryId).toBe(memories[0].id);
  expect(
    await db.appAgent.count({ where: { appId: app.id, agentId: role.id } }),
  ).toBe(0);
});
it('exposes derived installations in the App roster with their kind', async () => {
  const rows = await (resolvers.App as any).appAgents(app, {}, ctx());
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        agentId: role.id,
        installationKind: 'DERIVED',
      }),
    ]),
  );
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ agentId: parent.id, installationKind: 'ROW' }),
    ]),
  );
});
it('keeps installed-tier role ambiguity even when a derived role matches', async () => {
  const twin = await agent('Installed twin', 'engineer');
  await db.appAgent.create({ data: { appId: app.id, agentId: twin.id } });
  await db.agent.update({
    where: { id: parent.id },
    data: { personaRole: 'engineer' },
  });
  await expect(
    cast({ agentRef: undefined, role: 'engineer' }),
  ).rejects.toMatchObject({ extensions: { code: 'WORKER_AGENT_AMBIGUOUS' } });
});
it('adds no derived installations to a user-owned App', async () => {
  await db.app.update({
    where: { id: app.id },
    data: { organizationId: null, ownerUserId: user.id },
  });
  await refuse();
});
it.each(['ROW', 'DERIVED'])(
  'keeps the staffing gate unchanged for %s installations',
  async (kind) => {
    if (kind === 'ROW')
      await db.appAgent.create({ data: { appId: app.id, agentId: role.id } });
    await db.orgMember.update({
      where: {
        organizationId_userId: { organizationId: org.id, userId: user.id },
      },
      data: { role: 'READER' },
    });
    await expect(cast()).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
    expect(await db.worker.count()).toBe(0);
  },
);
it('an explicit install later writes its row and survives removal', async () => {
  await M.installAgentIntoApp({}, { appRef: app.id, agentRef: role.id }, ctx());
  expect(
    await db.appAgent.count({ where: { appId: app.id, agentId: role.id } }),
  ).toBe(1);
  await db.agentImport.deleteMany({});
  const w = await cast();
  expect(w.id).toBeTruthy();
});

it('compiles and serves an App-level prompt for a derived Agent, retaining it on explicit install', async () => {
  const own = await db.agent.findUniqueOrThrow({ where: { id: role.id } });
  await db.node.create({
    data: {
      memoryId: own.systemMemoryId!,
      loc: 'boot:source',
      name: 'Source',
      content: 'App compiled text',
      role: 'boot-prompt',
    },
  });
  const compiled = await compileBootPrompt(ctx(), {
    kind: 'APP_AGENT',
    appId: app.id,
    agentId: role.id,
  });
  const node = await db.node.findUniqueOrThrow({
    where: { id: compiled.nodeId },
  });
  await db.node.update({
    where: { id: node.id },
    data: {
      approvedRevNo: node.revSeq,
      approvedAt: new Date(),
      approvedByInfo: 'test',
      approvalHash: computeApprovalHash({
        title: node.name,
        abstract: node.abstract,
        content: node.content,
      }),
    },
  });
  const memory = await db.memory.findUniqueOrThrow({
    where: { id: compiled.memoryId },
  });
  expect(
    (
      await db.appAgentCustomization.findUniqueOrThrow({
        where: { appId_agentId: { appId: app.id, agentId: role.id } },
      })
    ).bootPromptNodeId,
  ).toBe(node.id);
  expect(
    await db.appAgent.count({ where: { appId: app.id, agentId: role.id } }),
  ).toBe(0);
  const agentRow = await db.agent.findUniqueOrThrow({ where: { id: role.id } });
  const before = await resolveServedBootPrompt(db, {
    appId: app.id,
    agent: agentRow,
    surface: 'bind',
  });
  expect(before).toMatchObject({
    pointerLevel: 'APP_AGENT',
    compiledNodeId: node.id,
  });
  await M.installAgentIntoApp({}, { appRef: app.id, agentRef: role.id }, ctx());
  await db.agentImport.deleteMany({});
  const after = await resolveServedBootPrompt(db, {
    appId: app.id,
    agent: agentRow,
    surface: 'bind',
  });
  expect(after).toMatchObject({
    pointerLevel: 'APP_AGENT',
    compiledNodeId: node.id,
  });
});

for (const removal of ['import', 'importer-install'] as const) {
  it(`does not cast from a stale witness when ${removal} removal wins the row-lock race`, async () => {
    let release!: () => void, ready!: () => void;
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      ready = r;
    });
    let blocker = 0;
    const removing = db.$transaction(
      async (tx) => {
        blocker = (
          await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`
        )[0].pid;
        if (removal === 'import')
          await tx.agentImport.deleteMany({
            where: { parentAgentId: parent.id, importedAgentId: role.id },
          });
        else
          await tx.appAgent.deleteMany({
            where: { appId: app.id, agentId: parent.id },
          });
        ready();
        await wait;
      },
      { timeout: 15000 },
    );
    await started;
    const pending = cast().then(
      (value: unknown) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await vi.waitFor(
        async () => {
          const rows = await db.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pid FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))`;
          expect(rows.length).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 10 },
      );
      expect(await db.worker.count({ where: { appId: app.id } })).toBe(0);
    } finally {
      release();
      await removing;
    }
    expect(await pending).toMatchObject({
      error: { extensions: { code: 'WORKER_AGENT_NOT_INSTALLED' } },
    });
    expect(await db.worker.count({ where: { appId: app.id } })).toBe(0);
  });
}

it('uses the App org license, never the importing org license', async () => {
  const customer = await db.organization.create({
    data: {
      name: 'Customer',
      urn: `customer-${generateId().toLowerCase()}.example`,
    },
  });
  await db.orgMember.create({
    data: { organizationId: customer.id, userId: user.id, role: 'ADMIN' },
  });
  await db.app.update({
    where: { id: app.id },
    data: { organizationId: customer.id },
  });
  await db.agent.update({
    where: { id: role.id },
    data: { visibility: 'PUBLIC' },
  });
  await expect(cast()).rejects.toMatchObject({
    extensions: { code: 'AGENT_ORG_GRANT_REQUIRED' },
  });
  expect(await db.worker.count()).toBe(0);
  await db.agentOrgGrant.create({
    data: { orgId: customer.id, agentId: role.id, activatedAt: new Date() },
  });
  expect((await cast()).id).toBeTruthy();
});
it('a non-reader App member can cast a derived Agent without the explicit-install CONTRIBUTOR floor', async () => {
  await db.orgMember.update({
    where: {
      organizationId_userId: { organizationId: org.id, userId: user.id },
    },
    data: { role: 'READER' },
  });
  await db.appMember.create({
    data: { appId: app.id, userId: user.id, role: 'member' },
  });
  expect((await cast()).id).toBeTruthy();
  await expect(
    M.installAgentIntoApp({}, { appRef: app.id, agentRef: role.id }, ctx()),
  ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  expect(
    await db.appAgent.count({ where: { appId: app.id, agentId: role.id } }),
  ).toBe(0);
});

it('recognises a derived Agent as a register attendee without an install row', async () => {
  const register = await resolveRegister(db, {
    attendee: { agentId: role.id, appId: app.id },
    actor: ctx(),
  });
  expect(register).not.toBeNull();
});
it('reports a derived Worker live session through the existing activity gate', async () => {
  const w = await cast();
  expect(
    await (resolvers.Worker as any).hasLiveSession(
      { id: w.id, appId: app.id },
      {},
      ctx(),
    ),
  ).toBe(false);
  await db.session.create({
    data: {
      id: generateId(),
      type: 'DEVELOPER',
      userId: user.id,
      appId: app.id,
      workerId: w.id,
      agentId: role.id,
    },
  });
  expect(
    await (resolvers.Worker as any).hasLiveSession(
      { id: w.id, appId: app.id },
      {},
      ctx(),
    ),
  ).toBe(true);
});

it.each(['node', 'memory'] as const)(
  'never falls through when a derived App prompt target %s is deleted',
  async (deleted) => {
    const own = await db.agent.findUniqueOrThrow({ where: { id: role.id } });
    await db.node.create({
      data: {
        memoryId: own.systemMemoryId!,
        loc: 'boot:source',
        name: 'Source',
        content: 'Custom',
        role: 'boot-prompt',
      },
    });
    const compiled = await compileBootPrompt(ctx(), {
      kind: 'APP_AGENT',
      appId: app.id,
      agentId: role.id,
    });
    if (deleted === 'node')
      await db.node.delete({ where: { id: compiled.nodeId } });
    else
      await db.memory.update({
        where: { id: compiled.memoryId },
        data: { deletedAt: new Date() },
      });
    await expect(
      resolveServedBootPrompt(db, {
        appId: app.id,
        agent: own,
        surface: 'bind',
      }),
    ).rejects.toMatchObject({ code: 'BOOT_PROMPT_TARGET_DELETED' });
  },
);
