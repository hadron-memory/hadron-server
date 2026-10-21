/**
 * #2045 (S8 step 8b, R23/R24) — the three GraphQL pointer setters: the owner's
 * read gate first, then the authority gate, then the target checks, then the
 * write, in one transaction under the owner's anchors. The gate and the target
 * checks themselves are pinned in lib/bootPromptPointer2045.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember, createDbAppWithKey } from '../../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { generateId } from '../../../lib/id.js';
import { EntityNotFoundError } from '../../../lib/entityRef/errors.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

// Gene's #2219 BLIND P2: a test hook that runs once a setter holds its owner locks, just before it writes. Null = pass through.
const pointerHook: { beforeSet: null | (() => Promise<void>) } = { beforeSet: null };
vi.mock('../../../lib/bootPromptPointer.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/bootPromptPointer.js')>();
  return {
    ...real,
    setBootPromptPointer: async (...args: Parameters<typeof real.setBootPromptPointer>) => {
      if (pointerHook.beforeSet) await pointerHook.beforeSet();
      return real.setBootPromptPointer(...args);
    },
  };
});

const M = resolvers.Mutation as any;
let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'bs-org', urn: 'bs-org' } })).id;
});

const ctxOf = (userId: string, extra: Record<string, unknown> = {}) =>
  ({ db, userId, roles: [], clientId: `user:${userId}`, ...extra }) as unknown as Context;
const user = (name: string) => db.user.create({ data: { id: generateId(), name } });
const compiledIn = (memoryId: string, loc = 'boot:compiled') => withCompileWrite(() => db.node.create({
  data: { id: generateId(), memoryId, loc, name: 'Compiled', content: 'c', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
}));

async function fixture() {
  const admin = await user('admin');
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  const member = await user('member');
  const stranger = await user('stranger');
  const agentMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'agent-sys', urn: 'bs-org:agent-sys', organizationId: orgId } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'bs-org:agent', organizationId: orgId, systemMemoryId: agentMem.id } });
  const unused = await db.agent.create({ data: { id: generateId(), name: 'Unused', urn: 'bs-org:unused', organizationId: orgId } });
  const { app } = await createDbAppWithKey(db, 'bs-app', orgId);
  await createDbAppAgent(db, app.id, agent.id);
  await createDbAppMember(db, app.id, member.id, 'member');
  const install = await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: 'bs-org:install', organizationId: orgId, appId: app.id, installOfAgentId: agent.id, isInstallMemory: true },
  });
  const worker = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris', signature: '', trailer: '' } });
  const agentNode = await compiledIn(agentMem.id);
  const installNode = await compiledIn(install.id);
  return { admin, member, stranger, agent, unused, app, worker, agentNode, installNode };
}
type F = Awaited<ReturnType<typeof fixture>>;

const setters = {
  AGENT: (f: F, nodeRef: unknown, ctx: Context) =>
    M.setAgentBootPrompt(null, nodeRef === undefined ? { agentRef: f.agent.id } : { agentRef: f.agent.id, nodeRef }, ctx),
  APP_AGENT: (f: F, nodeRef: unknown, ctx: Context) =>
    M.setAppAgentBootPrompt(null, nodeRef === undefined ? { appRef: f.app.id, agentRef: f.agent.id } : { appRef: f.app.id, agentRef: f.agent.id, nodeRef }, ctx),
  WORKER: (f: F, nodeRef: unknown, ctx: Context) =>
    M.setWorkerBootPrompt(null, nodeRef === undefined ? { workerRef: f.worker.id } : { workerRef: f.worker.id, nodeRef }, ctx),
};
type Field = keyof typeof setters;
const FIELDS = Object.keys(setters) as Field[];
const nodeFor = (f: F, field: Field) => (field === 'AGENT' ? f.agentNode : f.installNode);
const typeOf = { AGENT: 'Agent', APP_AGENT: 'AppAgent', WORKER: 'Worker' } as const;

const errorOf = async (p: Promise<unknown>) => {
  try { await p; return null; } catch (e) {
    if (e instanceof GraphQLError) return { code: e.extensions.code, message: e.message };
    if (e instanceof EntityNotFoundError) return { code: e.code, message: e.message };
    throw e;
  }
};
const codeOf = async (p: Promise<unknown>) => (await errorOf(p))?.code ?? 'NO_ERROR';

async function storedId(f: F, field: Field) {
  if (field === 'AGENT') return (await db.agent.findUniqueOrThrow({ where: { id: f.agent.id } })).bootPromptNodeId;
  if (field === 'APP_AGENT') return (await db.appAgent.findUniqueOrThrow({ where: { appId_agentId: { appId: f.app.id, agentId: f.agent.id } } })).bootPromptNodeId;
  return (await db.worker.findUniqueOrThrow({ where: { id: f.worker.id } })).bootPromptNodeId;
}

describe('#2045 8b setters', () => {
  it.each(FIELDS)('%s: the manager sets (returning the owner, whose field reads the pointer) and an explicit null clears', async (field) => {
    const f = await fixture();
    const owner = await setters[field](f, nodeFor(f, field).id, ctxOf(f.admin.id));
    const ref = await (resolvers as any)[typeOf[field]].bootPromptRef(owner, {}, ctxOf(f.admin.id));
    expect(ref).toMatch(/^hrn:node:.*boot.*compiled/);
    expect(await storedId(f, field)).toBe(nodeFor(f, field).id);
    await setters[field](f, null, ctxOf(f.admin.id));
    expect(await storedId(f, field)).toBeNull();
  });

  it.each(FIELDS)('%s: an omitted nodeRef is BAD_USER_INPUT, never a clear', async (field) => {
    const f = await fixture();
    await setters[field](f, nodeFor(f, field).id, ctxOf(f.admin.id));
    expect(await codeOf(setters[field](f, undefined, ctxOf(f.admin.id)))).toBe('BAD_USER_INPUT');
    expect(await storedId(f, field)).toBe(nodeFor(f, field).id);
  });

  it.each([
    ['AGENT', 'AGENT_NOT_FOUND'],
    ['APP_AGENT', 'APP_NOT_FOUND'],
    ['WORKER', 'WORKER_NOT_FOUND'],
  ] as const)('%s: an owner the caller cannot read answers its usual not-found, before any gate', async (field, code) => {
    const f = await fixture();
    expect(await codeOf(setters[field](f, nodeFor(f, field).id, ctxOf(f.stranger.id)))).toBe(code);
  });

  it.each(FIELDS)('%s: an App participant who is not a manager is FORBIDDEN, identically for a good and a bad target', async (field) => {
    const f = await fixture();
    if (field === 'AGENT') await db.orgMember.create({ data: { organizationId: orgId, userId: f.member.id, role: 'READER' } });
    const good = await errorOf(setters[field](f, nodeFor(f, field).id, ctxOf(f.member.id)));
    const bad = await errorOf(setters[field](f, generateId(), ctxOf(f.member.id)));
    expect(good?.code).toBe('FORBIDDEN');
    expect(bad).toEqual(good);
    expect(await storedId(f, field)).toBeNull();
  });

  it.each(FIELDS)("%s: the manager's own bound worker session is SESSION_REFUSED", async (field) => {
    const f = await fixture();
    expect(await runAsActor({ workerId: f.worker.id, agentId: null }, () => codeOf(setters[field](f, nodeFor(f, field).id, ctxOf(f.admin.id)))))
      .toBe('BOOT_PROMPT_POINTER_SESSION_REFUSED');
    expect(await storedId(f, field)).toBeNull();
  });

  it('setAppAgentBootPrompt: an Agent the App has not installed answers like a missing Agent', async () => {
    const f = await fixture();
    const notInstalled = await errorOf(M.setAppAgentBootPrompt(null, { appRef: f.app.id, agentRef: f.unused.id, nodeRef: f.installNode.id }, ctxOf(f.admin.id)));
    const missing = await errorOf(M.setAppAgentBootPrompt(null, { appRef: f.app.id, agentRef: 'bs-org:nobody', nodeRef: f.installNode.id }, ctxOf(f.admin.id)));
    expect(notInstalled?.code).toBe('AGENT_NOT_FOUND');
    expect(missing?.code).toBe('AGENT_NOT_FOUND');
  });

  it.each(FIELDS)("%s: the manager's demotion racing the write: refused on the CURRENT role, nothing written", async (field) => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const demotion = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'org', id: orgId }, { kind: 'user', id: f.admin.id }], 'exclusive');
      await tx.orgMember.updateMany({ where: { organizationId: orgId, userId: f.admin.id }, data: { role: 'READER' } });
      held();
      await gate;
    }, { timeout: 20_000 });
    await isHeld;
    const writing = setters[field](f, nodeFor(f, field).id, ctxOf(f.admin.id)).then(() => 'wrote', (e: Error) => e);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
    } finally {
      release();
      await demotion;
    }
    expect(await writing).not.toBe('wrote');
    expect(await storedId(f, field)).toBeNull();
  });

  async function racedRevocation(
    f: F,
    field: Field,
    anchors: Array<{ kind: 'org' | 'app'; id: string }>,
    revoke: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>,
  ) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const revocation = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, anchors, 'exclusive');
      await revoke(tx);
      held();
      await gate;
    }, { timeout: 20_000 });
    await isHeld;
    const writing = setters[field](f, nodeFor(f, field).id, ctxOf(f.admin.id)).then(() => 'wrote', (e: Error) => e);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
    } finally {
      release();
      await revocation;
    }
    return writing;
  }

  it.each(FIELDS)("%s: the owner's org deleted racing the write (org anchor only): refused, nothing written", async (field) => {
    const f = await fixture();
    expect(await racedRevocation(f, field, [{ kind: 'org', id: orgId }],
      (tx) => tx.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } }))).not.toBe('wrote');
    expect(await storedId(f, field)).toBeNull();
  });

  it.each(['APP_AGENT', 'WORKER'] as const)("%s: the App deleted racing the write (App anchor only): refused, nothing written", async (field) => {
    const f = await fixture();
    expect(await racedRevocation(f, field, [{ kind: 'app', id: f.app.id }],
      (tx) => tx.app.update({ where: { id: f.app.id }, data: { deletedAt: new Date() } }))).not.toBe('wrote');
    expect(await storedId(f, field)).toBeNull();
  });

  it('CONTROL: with no revocation in flight the same write lands', async () => {
    const f = await fixture();
    await setters.WORKER(f, f.installNode.id, ctxOf(f.admin.id));
    expect(await storedId(f, 'WORKER')).toBe(f.installNode.id);
  });
});

describe('#2219 §10 (Rook): revoked authority and the tenancy-move retry', () => {
  it.each(FIELDS)('%s: a REVOKED org admin (OrgMember.deletedAt) is FORBIDDEN, nothing written', async (field) => {
    const f = await fixture();
    // Past the owner's read gate (a PUBLIC Agent; an App member for the App fields), so the manager predicate decides.
    await db.agent.update({ where: { id: f.agent.id }, data: { visibility: 'PUBLIC' } });
    await createDbAppMember(db, f.app.id, f.admin.id, 'member');
    await db.orgMember.updateMany({ where: { organizationId: orgId, userId: f.admin.id }, data: { deletedAt: new Date() } });
    expect(await codeOf(setters[field](f, nodeFor(f, field).id, ctxOf(f.admin.id)))).toBe('FORBIDDEN');
    expect(await storedId(f, field)).toBeNull();
  });

  /** Move the Agent (and its system memory) to a new org WHILE the write waits on the Agent anchor, after its pre-read. */
  async function movedDuringWrite(f: F, newOrgId: string, callerId: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const move = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'agent', id: f.agent.id }], 'exclusive');
      held();
      await gate;
      const agent = await tx.agent.findUniqueOrThrow({ where: { id: f.agent.id }, select: { systemMemoryId: true } });
      await tx.memory.update({ where: { id: agent.systemMemoryId! }, data: { organizationId: newOrgId } });
      await tx.agent.update({ where: { id: f.agent.id }, data: { organizationId: newOrgId } });
    }, { timeout: 20_000 });
    await isHeld;
    const writing = setters.AGENT(f, f.agentNode.id, ctxOf(callerId)).then(() => 'wrote', (e: Error) => e);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
    } finally {
      release();
      await move;
    }
    return writing;
  }

  const newOrg = async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'bs-org-two', urn: 'bs-org-two' } });
    const admin = await user('new-admin');
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
    return { org, admin };
  };

  it("AGENT: the owner moved to another org mid-write: the OLD org's admin is refused under the new tenant, nothing written", async () => {
    const f = await fixture();
    await db.agent.update({ where: { id: f.agent.id }, data: { visibility: 'PUBLIC' } });
    const { org } = await newOrg();
    const out = await movedDuringWrite(f, org.id, f.admin.id);
    expect(out).not.toBe('wrote');
    expect((out as GraphQLError).extensions?.code).toBe('FORBIDDEN');
    expect(await storedId(f, 'AGENT')).toBeNull();
  });

  it("AGENT: the owner moved to another org mid-write: the NEW org's admin is decided under the new tenant and writes", async () => {
    const f = await fixture();
    await db.agent.update({ where: { id: f.agent.id }, data: { visibility: 'PUBLIC' } });
    const { org, admin } = await newOrg();
    expect(await movedDuringWrite(f, org.id, admin.id)).toBe('wrote');
    expect(await storedId(f, 'AGENT')).toBe(f.agentNode.id);
  });

  it("AGENT: after a mid-write move the retry holds the NEW org's anchor: a demotion there racing the write wins", async () => {
    const f = await fixture();
    await db.agent.update({ where: { id: f.agent.id }, data: { visibility: 'PUBLIC' } });
    const { org, admin } = await newOrg();
    const barrier = () => {
      let open!: () => void;
      const p = new Promise<void>((r) => { open = r; });
      return { p, open };
    };
    const moveGate = barrier(), moveHeld = barrier(), demoteGate = barrier(), demoteHeld = barrier();
    // The new org's revoker holds ITS anchor only, so only a writer anchored on the new tenant waits for it.
    const demotion = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'org', id: org.id }], 'exclusive');
      await tx.orgMember.updateMany({ where: { organizationId: org.id, userId: admin.id }, data: { role: 'READER' } });
      demoteHeld.open();
      await demoteGate.p;
    }, { timeout: 20_000 });
    const move = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'agent', id: f.agent.id }], 'exclusive');
      moveHeld.open();
      await moveGate.p;
      const agent = await tx.agent.findUniqueOrThrow({ where: { id: f.agent.id }, select: { systemMemoryId: true } });
      await tx.memory.update({ where: { id: agent.systemMemoryId! }, data: { organizationId: org.id } });
      await tx.agent.update({ where: { id: f.agent.id }, data: { organizationId: org.id } });
    }, { timeout: 20_000 });
    await Promise.all([demoteHeld.p, moveHeld.p]);
    const writing = setters.AGENT(f, f.agentNode.id, ctxOf(admin.id)).then(() => 'wrote', (e: Error) => e);
    let settledEarly: unknown = 'pending';
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1); // the write, behind the move on the Agent anchor
      moveGate.open();
      await move;
      // The retry re-anchors on the new org and waits for the demotion; a writer that kept the old anchors finishes now.
      settledEarly = await Promise.race([writing, waitForLockWaitersOfType(db, 'advisory', 1, 3_000).then(() => 'pending')]);
    } finally {
      moveGate.open();
      demoteGate.open();
      await Promise.allSettled([move, demotion]);
    }
    expect(settledEarly).toBe('pending');
    expect(((await writing) as GraphQLError).extensions?.code).toBe('FORBIDDEN');
    expect(await storedId(f, 'AGENT')).toBeNull();
  });
});

describe('#2219 BLIND P2 (Gene): concurrent saves of one Agent pointer', () => {
  it('two valid saves of the same Agent pointer both land: the writer of the anchored Agent row never upgrades a shared hold', async () => {
    const f = await fixture();
    // Release each save once BOTH hold their owner locks, or after a bound: a shared hold upgraded by two writers at once
    // deadlocks (40P01, one save fails); serialized writers reach the hook one at a time and finish on the bound.
    let arrived = 0;
    let open!: () => void;
    const both = new Promise<void>((r) => { open = r; });
    pointerHook.beforeSet = async () => {
      if (++arrived === 2) open();
      await Promise.race([both, new Promise((r) => setTimeout(r, 1500))]);
    };
    try {
      const outcomes = await Promise.allSettled([
        setters.AGENT(f, f.agentNode.id, ctxOf(f.admin.id)),
        setters.AGENT(f, f.agentNode.id, ctxOf(f.admin.id)),
      ]);
      expect(outcomes.map((o) => (o.status === 'rejected' ? String((o.reason as Error).message) : 'ok'))).toEqual(['ok', 'ok']);
    } finally {
      pointerHook.beforeSet = null;
    }
    expect(await storedId(f, 'AGENT')).toBe(f.agentNode.id);
  });
});
