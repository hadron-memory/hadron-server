/**
 * #2045 (S8 step 8a, cor:agt:040:07) — the boot-prompt pointers: the gate
 * (R23), the target checks and per-field placement, the one read derivation
 * (deleted / moved targets), the pair CHECK, the read exposure, atomicity, and
 * the closed code inventory.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import type { Prisma } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from './id.js';
import { requestActorStorage, runAsActor, publishAmbiguousActor, emptyActor } from './requestActor.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from './bootPrompt.js';
import {
  BOOT_PROMPT_POINTER_CODES,
  loadBootPromptPointerOwner,
  resolveBootPromptPointer,
  setBootPromptPointer,
  type BootPromptPointerCaller,
  type BootPromptPointerTarget,
} from './bootPromptPointer.js';
import { isMemoryReadableFresh, type Context } from '../api/graphql/schema/resolvers.helpers.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../mcp/server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let orgId: string;
let otherOrgId: string;

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'bp-org', urn: 'bp-org' } })).id;
  otherOrgId = (await db.organization.create({ data: { id: generateId(), name: 'bp-other', urn: 'bp-other' } })).id;
});

const user = (name: string) => db.user.create({ data: { id: generateId(), name } });
const sysMemory = (org: string, name: string, extra: Record<string, unknown> = {}) =>
  db.memory.create({ data: { id: generateId(), class: 'system', name, urn: `${org === orgId ? 'bp-org' : 'bp-other'}:${name}`, organizationId: org, ...extra } });
const compiledIn = (memoryId: string, loc = 'boot:compiled') => withCompileWrite(() => db.node.create({
  data: { id: generateId(), memoryId, loc, name: 'Compiled', content: 'You are {{worker.name}}.', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
}));

async function fixture() {
  const admin = await user('admin');
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  const member = await user('member');
  await db.orgMember.create({ data: { organizationId: orgId, userId: member.id, role: 'CONTRIBUTOR' } });
  const stranger = await user('stranger');

  const baseMem = await sysMemory(orgId, 'base-sys');
  const base = await db.agent.create({ data: { id: generateId(), name: 'Base', urn: 'bp-org:base', organizationId: orgId, systemMemoryId: baseMem.id } });
  const agentMem = await sysMemory(orgId, 'agent-sys');
  const agent = await db.agent.create({
    data: { id: generateId(), name: 'Agent', urn: 'bp-org:agent', organizationId: orgId, systemMemoryId: agentMem.id, extendsAgentId: base.id },
  });
  const otherMem = await sysMemory(orgId, 'other-sys');
  const other = await db.agent.create({ data: { id: generateId(), name: 'Other', urn: 'bp-org:other', organizationId: orgId, systemMemoryId: otherMem.id } });

  const install = async (name: string, agentId: string, appId: string) => db.memory.create({
    data: { id: generateId(), class: 'system', name, urn: `bp-org:${name}`, organizationId: orgId, appId, installOfAgentId: agentId, isInstallMemory: true },
  });
  const { app } = await createDbAppWithKey(db, 'bp-app', orgId);
  const { app: app2 } = await createDbAppWithKey(db, 'bp-app-two', orgId);
  await createDbAppAgent(db, app.id, agent.id);
  await createDbAppAgent(db, app.id, other.id);
  await createDbAppAgent(db, app2.id, agent.id);
  await createDbAppMember(db, app.id, member.id, 'member');
  // Rook's #2219 P3: the competing install memories are created FIRST, so a lookup that lost its appId or installOfAgentId
  // filter would find one of them before install-one and the WRONG_MEMORY pins would catch it.
  const installOther = await install('install-other', other.id, app.id);
  const install2 = await install('install-two', agent.id, app2.id);
  const install1 = await install('install-one', agent.id, app.id);
  const worker = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris', signature: '', trailer: '' } });

  const foreignMem = await sysMemory(otherOrgId, 'foreign-sys');

  const nodes = {
    agent: await compiledIn(agentMem.id),
    base: await compiledIn(baseMem.id),
    other: await compiledIn(otherMem.id),
    install1: await compiledIn(install1.id),
    install1b: await compiledIn(install1.id, 'boot:second'),
    installOther: await compiledIn(installOther.id),
    install2: await compiledIn(install2.id),
    foreign: await compiledIn(foreignMem.id),
    source: await db.node.create({ data: { id: generateId(), memoryId: agentMem.id, loc: 'boot:source', name: 'Source', content: 'src', role: 'boot-prompt' } }),
  };
  const targets = {
    AGENT: { field: 'AGENT', agentId: agent.id } as BootPromptPointerTarget,
    APP_AGENT: { field: 'APP_AGENT', appId: app.id, agentId: agent.id } as BootPromptPointerTarget,
    WORKER: { field: 'WORKER', workerId: worker.id } as BootPromptPointerTarget,
  };
  return { admin, member, stranger, base, agent, other, app, app2, worker, agentMem, install1, nodes, targets };
}

type F = Awaited<ReturnType<typeof fixture>>;
type Field = 'AGENT' | 'APP_AGENT' | 'WORKER';
const FIELDS: Field[] = ['AGENT', 'APP_AGENT', 'WORKER'];

const ctxOf = (userId: string | undefined, extra: Partial<Context> = {}): Context =>
  ({ db, userId, roles: [], clientId: userId ? `user:${userId}` : undefined, ...extra }) as Context;

/** The seam as a caller holding its transaction would run it. */
function write(ctx: Context, target: BootPromptPointerTarget, nodeRef: string | null) {
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const owner = await loadBootPromptPointerOwner(tx, target);
    if (!owner) throw new Error('owner gone');
    const txCtx = { ...ctx, db: tx } as Context;
    return setBootPromptPointer(tx, txCtx as BootPromptPointerCaller, owner, nodeRef, (m) => isMemoryReadableFresh(txCtx, m, tx));
  });
}

async function stored(f: F, field: Field) {
  const select = { bootPromptNodeId: true, bootPromptUrn: true } as const;
  if (field === 'AGENT') return db.agent.findUniqueOrThrow({ where: { id: f.agent.id }, select });
  if (field === 'APP_AGENT') return db.appAgent.findUniqueOrThrow({ where: { appId_agentId: { appId: f.app.id, agentId: f.agent.id } }, select });
  return db.worker.findUniqueOrThrow({ where: { id: f.worker.id }, select });
}

/** The valid compiled node for each field: the Agent's own, or this install's. */
const validNode = (f: F, field: Field) => (field === 'AGENT' ? f.nodes.agent : f.nodes.install1);
const altNode = (f: F, field: Field) => (field === 'AGENT' ? null : f.nodes.install1b);

const errorOf = async (p: Promise<unknown>) => {
  try { await p; return null; } catch (e) {
    if (!(e instanceof GraphQLError)) throw e;
    return { code: e.extensions.code, message: e.message, extensions: e.extensions };
  }
};
const codeOf = async (p: Promise<unknown>) => (await errorOf(p))?.code ?? 'NO_ERROR';

describe('#2045 gate (R23): the manager as themselves, never a worker session', () => {
  it.each(FIELDS)('%s: the manager sets and clears; the stored pair is the node id and its canonical URN', async (field) => {
    const f = await fixture();
    const node = validNode(f, field);
    const set = await write(ctxOf(f.admin.id), f.targets[field], node.id);
    expect(set).toMatchObject({ nodeId: node.id, deleted: false });
    expect(await stored(f, field)).toEqual({ bootPromptNodeId: node.id, bootPromptUrn: set!.urn });
    expect(set!.urn).toMatch(/^hrn:node:/);
    expect(await write(ctxOf(f.admin.id), f.targets[field], null)).toBeNull();
    expect(await stored(f, field)).toEqual({ bootPromptNodeId: null, bootPromptUrn: null });
  });

  it.each(FIELDS)('%s: a non-manager member is FORBIDDEN, for a set and for a clear', async (field) => {
    const f = await fixture();
    await write(ctxOf(f.admin.id), f.targets[field], validNode(f, field).id);
    const before = await stored(f, field);
    expect(await codeOf(write(ctxOf(f.member.id), f.targets[field], validNode(f, field).id))).toBe('FORBIDDEN');
    expect(await codeOf(write(ctxOf(f.member.id), f.targets[field], null))).toBe('FORBIDDEN');
    expect(await stored(f, field)).toEqual(before);
  });

  it.each(FIELDS)("%s: a manager's own bound worker session, an ambiguous binding and a refused binding are SESSION_REFUSED", async (field) => {
    const f = await fixture();
    const ref = validNode(f, field).id;
    expect(await runAsActor({ workerId: f.worker.id, agentId: null }, () => codeOf(write(ctxOf(f.admin.id), f.targets[field], ref))))
      .toBe('BOOT_PROMPT_POINTER_SESSION_REFUSED');
    expect(await requestActorStorage.run(emptyActor(), async () => {
      publishAmbiguousActor(['s1', 's2']);
      return codeOf(write(ctxOf(f.admin.id), f.targets[field], ref));
    })).toBe('BOOT_PROMPT_POINTER_SESSION_REFUSED');
    expect(await codeOf(write(ctxOf(f.admin.id, { sessionBindingRefused: true } as Partial<Context>), f.targets[field], ref)))
      .toBe('BOOT_PROMPT_POINTER_SESSION_REFUSED');
    expect(await stored(f, field)).toEqual({ bootPromptNodeId: null, bootPromptUrn: null });
  });

  it.each(FIELDS)('%s: an App key, an impersonation and a run principal are FORBIDDEN, even carrying the manager\'s user id', async (field) => {
    const f = await fixture();
    const ref = validNode(f, field).id;
    expect(await codeOf(write(ctxOf(undefined, { appId: f.app.id, appKeyId: 'k1' } as Partial<Context>), f.targets[field], ref))).toBe('FORBIDDEN');
    expect(await codeOf(write(ctxOf(f.admin.id, { appId: f.app.id, appKeyId: 'k1' } as Partial<Context>), f.targets[field], ref))).toBe('FORBIDDEN');
    expect(await codeOf(write(ctxOf(f.admin.id, { impersonation: { orgId } } as Partial<Context>), f.targets[field], ref))).toBe('FORBIDDEN');
    expect(await codeOf(write(ctxOf(f.admin.id, { clientId: 'run:r1', appId: f.app.id } as Partial<Context>), f.targets[field], ref))).toBe('FORBIDDEN');
    expect(await stored(f, field)).toEqual({ bootPromptNodeId: null, bootPromptUrn: null });
  });

  it.each(FIELDS)('%s: a denied caller gets the IDENTICAL refusal for a missing, a source and a foreign compiled target (no oracle)', async (field) => {
    const f = await fixture();
    const errors = await Promise.all([generateId(), f.nodes.source.id, f.nodes.other.id, f.nodes.foreign.id]
      .map((ref) => errorOf(write(ctxOf(f.member.id), f.targets[field], ref))));
    expect(errors[0]?.code).toBe('FORBIDDEN');
    for (const e of errors) expect(e).toEqual(errors[0]);
  });

  it('a user-owned Agent: its owner manages it; a platform admin passes the manager gate but cannot read the compiled prompt (#1734); an org admin does not manage it', async () => {
    const f = await fixture();
    const owner = await user('owner');
    const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'u-sys', urn: 'u:u-sys', ownerUserId: owner.id } });
    const agent = await db.agent.create({ data: { id: generateId(), name: 'Mine', urn: 'u:mine', ownerUserId: owner.id, systemMemoryId: mem.id } });
    const node = await compiledIn(mem.id);
    const target: BootPromptPointerTarget = { field: 'AGENT', agentId: agent.id };
    expect(await codeOf(write(ctxOf(f.admin.id), target, node.id))).toBe('FORBIDDEN');
    const platform = await db.user.create({ data: { id: generateId(), name: 'platform', roles: ['ADMIN'] } });
    // cor:dmo:050:13: the admin manages it, but the read boundary stands, so the unreadable compiled node answers as missing.
    expect(await codeOf(write(ctxOf(platform.id, { roles: ['ADMIN'] } as Partial<Context>), target, node.id))).toBe('BOOT_PROMPT_POINTER_NOT_FOUND');
    expect(await write(ctxOf(owner.id), target, node.id)).toMatchObject({ nodeId: node.id });
  });

  it('an org-owned Agent: a platform ADMIN manages it, like managesApp', async () => {
    const f = await fixture();
    const platform = await db.user.create({ data: { id: generateId(), name: 'platform', roles: ['ADMIN'] } });
    expect(await write(ctxOf(platform.id, { roles: ['ADMIN'] } as Partial<Context>), f.targets.AGENT, f.nodes.agent.id)).toMatchObject({ nodeId: f.nodes.agent.id });
  });
});

describe('#2045 target checks, after the gate', () => {
  it.each(FIELDS)('%s: each refusal answers its typed code and leaves the pointer unchanged', async (field) => {
    const f = await fixture();
    const good = validNode(f, field);
    await write(ctxOf(f.admin.id), f.targets[field], good.id);
    const before = await stored(f, field);
    const deleted = await compiledIn(field === 'AGENT' ? f.agentMem.id : f.install1.id, 'boot:deleted');
    await db.node.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    const cases: Array<[string, string]> = [
      ['not-a-qualified-urn', 'BAD_USER_INPUT'],
      [generateId(), 'BOOT_PROMPT_POINTER_NOT_FOUND'],
      [deleted.id, 'BOOT_PROMPT_POINTER_NOT_FOUND'],
      [f.nodes.foreign.id, 'BOOT_PROMPT_POINTER_NOT_FOUND'],
      [f.nodes.source.id, 'BOOT_PROMPT_POINTER_NOT_COMPILED'],
      [f.nodes.other.id, 'BOOT_PROMPT_POINTER_WRONG_MEMORY'],
      [f.nodes.base.id, 'BOOT_PROMPT_POINTER_WRONG_MEMORY'],
      [f.nodes.install2.id, 'BOOT_PROMPT_POINTER_WRONG_MEMORY'],
      [f.nodes.installOther.id, 'BOOT_PROMPT_POINTER_WRONG_MEMORY'],
      [field === 'AGENT' ? f.nodes.install1.id : f.nodes.agent.id, 'BOOT_PROMPT_POINTER_WRONG_MEMORY'],
    ];
    for (const [ref, code] of cases) {
      expect([ref, await codeOf(write(ctxOf(f.admin.id), f.targets[field], ref))]).toEqual([ref, code]);
    }
    expect(await stored(f, field)).toEqual(before);
  });

  it('an unreadable target answers exactly like a missing one', async () => {
    const f = await fixture();
    const missing = await errorOf(write(ctxOf(f.admin.id), f.targets.AGENT, generateId()));
    const unreadable = await errorOf(write(ctxOf(f.admin.id), f.targets.AGENT, f.nodes.foreign.id));
    expect(unreadable).toEqual(missing);
  });

  it('a target named by its canonical URN is accepted, and an unapproved compiled node is accepted (approval is a serve-time check)', async () => {
    const f = await fixture();
    expect((await db.node.findUniqueOrThrow({ where: { id: f.nodes.agent.id } })).approvedRevNo).toBeNull();
    const set = await write(ctxOf(f.admin.id), f.targets.AGENT, f.nodes.agent.id);
    await write(ctxOf(f.admin.id), f.targets.AGENT, null);
    expect(await write(ctxOf(f.admin.id), f.targets.AGENT, set!.urn)).toMatchObject({ nodeId: f.nodes.agent.id });
  });

  it('a recompile (a new unapproved revision of the same node) keeps the pointer set and live', async () => {
    const f = await fixture();
    await write(ctxOf(f.admin.id), f.targets.WORKER, f.nodes.install1.id);
    await withCompileWrite(() => resolvers.Mutation.updateNode(null, { input: { id: f.nodes.install1.id, content: 'recompiled' } }, ctxOf(f.admin.id)));
    const after = await stored(f, 'WORKER');
    expect(after.bootPromptNodeId).toBe(f.nodes.install1.id);
    expect(await resolveBootPromptPointer(db, after)).toMatchObject({ deleted: false });
  });

  it('a pointer refusal inside a compile-and-point transaction rolls back the compiled node with it', async () => {
    const f = await fixture();
    await expect(db.$transaction(async (tx: Prisma.TransactionClient) => {
      const node = await withCompileWrite(() => tx.node.create({
        data: { id: generateId(), memoryId: f.install1.id, loc: 'boot:new', name: 'New', content: 'x', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
      }));
      const owner = (await loadBootPromptPointerOwner(tx, f.targets.APP_AGENT))!;
      const txCtx = { ...ctxOf(f.member.id), db: tx } as Context;
      await setBootPromptPointer(tx, txCtx as BootPromptPointerCaller, owner, node.id, (m) => isMemoryReadableFresh(txCtx, m, tx));
    })).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await db.node.count({ where: { memoryId: f.install1.id, loc: 'boot:new' } })).toBe(0);
  });
});

describe('#2045 owners: reinstall and custom-worker-only', () => {
  it('a newly cast worker has no pointer (set for customised workers only)', async () => {
    const f = await fixture();
    expect(await stored(f, 'WORKER')).toEqual({ bootPromptNodeId: null, bootPromptUrn: null });
  });

  it('uninstall then reinstall leaves the install pointer empty until the next compile', async () => {
    const f = await fixture();
    await write(ctxOf(f.admin.id), f.targets.APP_AGENT, f.nodes.install1.id);
    await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.agent.id } } });
    expect(await db.$transaction((tx) => loadBootPromptPointerOwner(tx, f.targets.APP_AGENT))).toBeNull();
    await createDbAppAgent(db, f.app.id, f.agent.id);
    expect(await stored(f, 'APP_AGENT')).toEqual({ bootPromptNodeId: null, bootPromptUrn: null });
  });
});

describe('#2045 resolveBootPromptPointer: the one derivation (deleted, moved)', () => {
  it('no pointer is null', async () => {
    expect(await resolveBootPromptPointer(db, { bootPromptNodeId: null, bootPromptUrn: null })).toBeNull();
  });

  it('a moved live node reads its new URN; soft-deleted and memory-deleted read true; hard-deleted reads the snapshot', async () => {
    const f = await fixture();
    const set = await write(ctxOf(f.admin.id), f.targets.AGENT, f.nodes.agent.id);
    await db.node.update({ where: { id: f.nodes.agent.id }, data: { loc: 'boot:moved' } });
    const moved = await resolveBootPromptPointer(db, await stored(f, 'AGENT'));
    expect(moved).toMatchObject({ nodeId: f.nodes.agent.id, deleted: false });
    expect(moved!.urn).not.toBe(set!.urn);
    expect(moved!.urn).toContain('moved');

    await db.node.update({ where: { id: f.nodes.agent.id }, data: { deletedAt: new Date() } });
    expect(await resolveBootPromptPointer(db, await stored(f, 'AGENT'))).toEqual({ ...moved, deleted: true });
    await db.node.update({ where: { id: f.nodes.agent.id }, data: { deletedAt: null } });
    await db.memory.update({ where: { id: f.agentMem.id }, data: { deletedAt: new Date() } });
    expect(await resolveBootPromptPointer(db, await stored(f, 'AGENT'))).toMatchObject({ deleted: true });

    await db.node.delete({ where: { id: f.nodes.agent.id } });
    expect(await resolveBootPromptPointer(db, await stored(f, 'AGENT'))).toEqual({ nodeId: f.nodes.agent.id, urn: set!.urn, deleted: true });
  });
});

describe('#2045 the pair CHECK refuses a half-set pointer on every owner table', () => {
  it.each(FIELDS)('%s', async (field) => {
    const f = await fixture();
    const half = (data: Record<string, unknown>) => field === 'AGENT'
      ? db.agent.update({ where: { id: f.agent.id }, data })
      : field === 'APP_AGENT'
        ? db.appAgent.update({ where: { appId_agentId: { appId: f.app.id, agentId: f.agent.id } }, data })
        : db.worker.update({ where: { id: f.worker.id }, data });
    const table = field === 'AGENT' ? 'agents' : field === 'APP_AGENT' ? 'app_agents' : 'workers';
    await expect(half({ bootPromptNodeId: f.nodes.agent.id })).rejects.toThrow(new RegExp(`chk_${table}_boot_prompt_pointer_pair`));
    await expect(half({ bootPromptUrn: 'hrn:node:x:y' })).rejects.toThrow(new RegExp(`chk_${table}_boot_prompt_pointer_pair`));
  });
});

describe('#2045 read exposure: one gate per owner, null in both fields when masked', () => {
  const read = async (type: 'Agent' | 'AppAgent' | 'Worker', parent: unknown, ctx: Context) => {
    const r = (resolvers as any)[type];
    return [await r.bootPromptRef(parent, {}, ctx), await r.bootPromptTargetDeleted(parent, {}, ctx)];
  };

  it('Agent: a reader of its system memory sees it; a PUBLIC Agent\'s outsider sees null in both', async () => {
    const f = await fixture();
    const set = await write(ctxOf(f.admin.id), f.targets.AGENT, f.nodes.agent.id);
    await db.agent.update({ where: { id: f.agent.id }, data: { visibility: 'PUBLIC' } });
    const row = await db.agent.findUniqueOrThrow({ where: { id: f.agent.id } });
    expect(await read('Agent', row, ctxOf(f.admin.id))).toEqual([set!.urn, false]);
    expect(await read('Agent', row, ctxOf(f.stranger.id))).toEqual([null, null]);
    expect(await read('Agent', row, ctxOf(undefined))).toEqual([null, null]);
    // A slim parent without the columns is re-read, never mistaken for "no pointer".
    expect(await read('Agent', { id: f.agent.id }, ctxOf(f.admin.id))).toEqual([set!.urn, false]);
  });

  it('AppAgent: the App\'s participants see it; a stranger sees null', async () => {
    const f = await fixture();
    const set = await write(ctxOf(f.admin.id), f.targets.APP_AGENT, f.nodes.install1.id);
    const row = await db.appAgent.findUniqueOrThrow({ where: { appId_agentId: { appId: f.app.id, agentId: f.agent.id } } });
    expect(await read('AppAgent', row, ctxOf(f.member.id))).toEqual([set!.urn, false]);
    expect(await read('AppAgent', row, ctxOf(f.stranger.id))).toEqual([null, null]);
  });

  it('Worker: behind the worker read gate; a deleted target shows true to a reader and stays masked to a stranger', async () => {
    const f = await fixture();
    const set = await write(ctxOf(f.admin.id), f.targets.WORKER, f.nodes.install1.id);
    await db.node.delete({ where: { id: f.nodes.install1.id } });
    const row = await db.worker.findUniqueOrThrow({ where: { id: f.worker.id } });
    expect(await read('Worker', row, ctxOf(f.admin.id))).toEqual([set!.urn, true]);
    expect(await read('Worker', row, ctxOf(f.stranger.id))).toEqual([null, null]);
  });


});

describe('#2045 surfaces and code inventory', () => {
  it('R24: no MCP tool writes a boot-prompt pointer', () => {
    const mcp = createTestableMcpServer({ userId: 'u', roles: [], clientId: 'user:u' });
    expect(mcp.toolNames().filter((n) => /boot.?prompt/i.test(n))).toEqual([]);
  });

  it('every BOOT_PROMPT_* code the server source can emit is on the agreed lists (6259928375 / 6259930578)', () => {
    // S6's three codes, as agreed in the #2043 attach (6247074854; hadron-cli#916 maps all three).
    const S6 = ['BOOT_PROMPT_COMPILED_WRITE', 'BOOT_PROMPT_WORKER_SESSION_REFUSED', 'BOOT_PROMPT_APPROVAL_FORBIDDEN'];
    const SERVE = ['BOOT_PROMPT_NOT_SET', 'BOOT_PROMPT_TARGET_DELETED', 'BOOT_PROMPT_NOT_APPROVED', 'BOOT_PROMPT_NOT_SIGNED', 'BOOT_PROMPT_RECORDED_REVISION_DELETED'];
    expect([...BOOT_PROMPT_POINTER_CODES].sort()).toEqual([
      'BOOT_PROMPT_POINTER_NOT_COMPILED', 'BOOT_PROMPT_POINTER_NOT_FOUND', 'BOOT_PROMPT_POINTER_SESSION_REFUSED',
      'BOOT_PROMPT_POINTER_WRONG_MEMORY', 'BOOT_PROMPT_POINTER_WRONG_ROLE',
    ]);
    // S9's compile refusal map (#2046: Baloo 6258596409, SOURCE_INVALID in 6258629173, the limit in Xavier 6258672877).
    const S9 = ['BOOT_PROMPT_COMPILE_NOT_PERMITTED', 'BOOT_PROMPT_TARGET_RETIRED', 'BOOT_PROMPT_NO_SOURCE', 'BOOT_PROMPT_SOURCE_INVALID',
      'BOOT_PROMPT_INCLUDE_UNAVAILABLE', 'BOOT_PROMPT_INCLUDE_RETIRED', 'BOOT_PROMPT_INCLUDE_REVISION_UNAVAILABLE', 'BOOT_PROMPT_INCLUDE_CYCLE',
      'BOOT_PROMPT_INCLUDE_TOO_DEEP', 'BOOT_PROMPT_INCLUDE_SOURCE_DISALLOWED', 'BOOT_PROMPT_GRANT_REQUIRED', 'BOOT_PROMPT_INCLUDE_MALFORMED',
      'BOOT_PROMPT_COMPILE_LIMIT_EXCEEDED'];
    const allowed = new Set([...S6, ...S9, ...SERVE, ...BOOT_PROMPT_POINTER_CODES]);
    const src = fileURLToPath(new URL('..', import.meta.url));
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== 'generated') walk(path); continue; }
        if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name)) continue;
        for (const m of readFileSync(path, 'utf8').matchAll(/['"`](BOOT_PROMPT_[A-Z_]+)['"`]/g)) found.add(m[1]!);
      }
    };
    walk(src);
    expect([...found].filter((c) => !allowed.has(c))).toEqual([]);
    expect(found.has('BOOT_PROMPT_MISSING')).toBe(false);
    for (const code of BOOT_PROMPT_POINTER_CODES) expect(found.has(code)).toBe(true);
  });

  it('the migration carries prisma/boot-prompt-pointer-invariants.sql verbatim', () => {
    const root = fileURLToPath(new URL('../../prisma/', import.meta.url));
    const guard = readFileSync(join(root, 'boot-prompt-pointer-invariants.sql'), 'utf8');
    const migration = readFileSync(join(root, 'migrations/20261021110000_boot_prompt_pointers/migration.sql'), 'utf8');
    expect(migration.endsWith(guard)).toBe(true);
  });
});
