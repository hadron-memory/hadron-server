/**
 * #2044 (S7), cor:agt:040:06 — the LIFECYCLE of an App's install memory: lazy
 * creation by the first customisation, uninstall / reinstall / App deletion
 * retention (Holger's ruling A), and the creation-versus-revocation races.
 * The audience is pinned in lib/auth/installMemory.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'il-org', urn: 'il-org' } })).id;
});

const ctxOf = (userId: string, extra: Record<string, unknown> = {}) =>
  ({ db, userId, roles: [], clientId: `user:${userId}`, ...extra }) as unknown as Context;

async function fixture() {
  const user = async (name: string) => db.user.create({ data: { id: generateId(), name } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'Team Agent', urn: `${orgId}:team-agent`, organizationId: orgId } });
  const { app } = await createDbAppWithKey(db, 'il-app', orgId);
  await createDbAppAgent(db, app.id, agent.id);
  const admin = await user('admin'); await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  const member = await user('member'); await createDbAppMember(db, app.id, member.id, 'member');
  const contributor = await user('contributor'); await db.orgMember.create({ data: { organizationId: orgId, userId: contributor.id, role: 'CONTRIBUTOR' } });
  const stranger = await user('stranger');
  const install = { appRef: app.id, agentRef: agent.id };
  const create = (u: { id: string }, loc = 'prompts:lane', extra: Record<string, unknown> = {}) =>
    M.createNode({}, { input: { install, loc, name: 'Lane', content: 'replacement', ...extra } }, ctxOf(u.id));
  const installRows = () => db.memory.findMany({ where: { appId: app.id, installOfAgentId: agent.id } });
  return { agent, app, admin, member, contributor, stranger, install, create, installRows, user };
}

describe('#2044 install memory — lazy creation', () => {
  it('no customisation, no install memory: reads create nothing', async () => {
    const f = await fixture();
    expect(await Q.installMemory({}, f.install, ctxOf(f.admin.id))).toBeNull();
    expect(await Q.installMemory({}, f.install, ctxOf(f.stranger.id))).toBeNull();
    expect(await f.installRows()).toHaveLength(0);
  });

  it('the first manager write creates exactly one memory, owned by the App, and the next reuses it', async () => {
    const f = await fixture();
    const node = await f.create(f.admin);
    const rows = await f.installRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ class: 'system', organizationId: orgId, ownerUserId: null, appId: f.app.id, installOfAgentId: f.agent.id });
    expect(node.memoryId).toBe(rows[0]!.id);
    expect(rows[0]!.urn).not.toContain('::');
    await f.create(f.admin, 'prompts:other');
    expect(await f.installRows()).toHaveLength(1);
    const read = await Q.installMemory({}, f.install, ctxOf(f.member.id));
    expect(read?.id).toBe(rows[0]!.id);
  });

  it('two concurrent first writes leave one live memory', async () => {
    const f = await fixture();
    await Promise.all([f.create(f.admin, 'a:one'), f.create(f.admin, 'a:two')]);
    expect(await f.installRows()).toHaveLength(1);
    expect(await db.node.count({ where: { memoryId: (await f.installRows())[0]!.id, loc: { in: ['a:one', 'a:two'] } } })).toBe(2);
  });

  it('a non-manager is refused and no memory is created; a stranger cannot tell the App exists', async () => {
    const f = await fixture();
    await expect(f.create(f.member)).rejects.toThrow(/Forbidden/);
    await expect(f.create(f.contributor)).rejects.toThrow(/Forbidden/);
    await expect(f.create(f.stranger)).rejects.toThrow(/APP_NOT_FOUND/);
    expect(await f.installRows()).toHaveLength(0);
  });

  it('an Agent the App does not have installed is refused with nothing created', async () => {
    const f = await fixture();
    await db.appAgent.delete({ where: { appId_agentId: { appId: f.app.id, agentId: f.agent.id } } });
    await expect(f.create(f.admin)).rejects.toMatchObject({ extensions: { code: 'AGENT_NOT_INSTALLED' } });
    expect(await f.installRows()).toHaveLength(0);
  });

  it('a write the core refuses leaves no memory behind', async () => {
    const f = await fixture();
    await expect(f.create(f.admin, 'bad loc with spaces??', { contentType: 'application/x-nope' })).rejects.toThrow();
    expect(await f.installRows()).toHaveLength(0);
  });

  it('createNode needs exactly one of memoryId and install', async () => {
    const f = await fixture();
    await expect(M.createNode({}, { input: { loc: 'x', name: 'x' } }, ctxOf(f.admin.id))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    const mem = await db.memory.create({ data: { id: generateId(), class: 'knowledge', name: 'k', urn: `${orgId}:k`, organizationId: orgId } });
    await expect(M.createNode({}, { input: { memoryId: mem.id, install: f.install, loc: 'x', name: 'x' } }, ctxOf(f.admin.id)))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('updateNode through the install target updates, creates nothing, and hides a missing customisation', async () => {
    const f = await fixture();
    await expect(M.updateNode({}, { input: { install: f.install, loc: 'prompts:lane', content: 'x' } }, ctxOf(f.admin.id)))
      .rejects.toMatchObject({ extensions: { code: 'INSTALL_MEMORY_NOT_FOUND' } });
    expect(await f.installRows()).toHaveLength(0);
    await f.create(f.admin);
    const updated = await M.updateNode({}, { input: { install: f.install, loc: 'prompts:lane', content: 'second' } }, ctxOf(f.admin.id));
    expect(updated.content).toBe('second');
    await expect(M.updateNode({}, { input: { install: f.install, loc: 'prompts:lane', content: 'nope' } }, ctxOf(f.member.id))).rejects.toThrow(/Forbidden/);
    await expect(M.updateNode({}, { input: { install: f.install, loc: 'prompts:lane', content: 'nope' } }, ctxOf(f.stranger.id)))
      .rejects.toMatchObject({ extensions: { code: 'INSTALL_MEMORY_NOT_FOUND' } });
  });
});

describe('#2044 install memory — uninstall, reinstall, App deletion (ruling A)', () => {
  it('uninstall keeps it (readable by participants), reinstall reattaches the same row', async () => {
    const f = await fixture();
    await f.create(f.admin);
    const [row] = await f.installRows();
    await M.uninstallAgentFromApp({}, { appRef: f.app.id, agentRef: f.agent.id }, ctxOf(f.admin.id));
    expect((await Q.installMemory({}, f.install, ctxOf(f.member.id)))?.id).toBe(row!.id);
    await expect(f.create(f.admin, 'prompts:more')).rejects.toMatchObject({ extensions: { code: 'AGENT_NOT_INSTALLED' } });
    await M.installAgentIntoApp({}, { appRef: f.app.id, agentRef: f.agent.id }, ctxOf(f.admin.id));
    expect(await f.installRows()).toHaveLength(1);
    expect((await Q.installMemory({}, f.install, ctxOf(f.member.id)))?.id).toBe(row!.id);
    await f.create(f.admin, 'prompts:more');
    expect(await f.installRows()).toHaveLength(1);
  });

  it('deleteApp keeps it; an org admin finds and deletes it, never reading its content', async () => {
    const f = await fixture();
    await f.create(f.admin);
    const [row] = await f.installRows();
    await M.deleteApp({}, { ref: f.app.id }, ctxOf(f.admin.id));
    expect((await db.memory.findUniqueOrThrow({ where: { id: row!.id } })).deletedAt).toBeNull();
    // Record: the manager sees it. Content: nobody.
    const seen = await resolvers.Query.memory({}, { ref: row!.id }, ctxOf(f.admin.id));
    expect(seen?.id).toBe(row!.id);
    expect(await resolvers.Query.memory({}, { ref: row!.id }, ctxOf(f.member.id))).toBeNull();
    const nodes = await (resolvers.Memory as any).nodes?.(seen, {}, ctxOf(f.admin.id));
    expect(nodes ?? []).toHaveLength(0);
    // New customisation is impossible: the App is gone.
    await expect(f.create(f.admin, 'prompts:late')).rejects.toThrow();
    await expect(M.deleteMemory({}, { id: row!.id }, ctxOf(f.member.id))).rejects.toThrow(/MEMORY_NOT_FOUND/);
    await expect(M.deleteMemory({}, { id: row!.id }, ctxOf(f.admin.id))).resolves.toBe(true);
  });
});

describe('#2044 install memory — URN reclaim (R29) and account erasure', () => {
  it('refuses to hard-delete a soft-deleted App while an install memory remains; allows it once removed by hand', async () => {
    const f = await fixture();
    await db.app.update({ where: { id: f.app.id }, data: { urn: 'il-org:reclaim-me' } });
    await f.create(f.admin);
    const [row] = await f.installRows();
    await M.deleteApp({}, { ref: f.app.id }, ctxOf(f.admin.id));
    const reclaim = () => M.createApp({}, { orgRef: orgId, agentRef: f.agent.id, name: 'Reclaim Me' }, ctxOf(f.admin.id));
    await expect(reclaim()).rejects.toMatchObject({ extensions: { code: 'INSTALL_MEMORIES_REMAIN' } });
    // Nothing was destroyed by the refused attempt.
    expect(await db.app.count({ where: { id: f.app.id } })).toBe(1);
    expect((await db.memory.findUniqueOrThrow({ where: { id: row!.id } })).deletedAt).toBeNull();
    await expect(M.deleteMemory({}, { id: row!.id }, ctxOf(f.admin.id))).resolves.toBe(true);
    await expect(reclaim()).resolves.toBeTruthy();
    expect(await db.app.count({ where: { id: f.app.id } })).toBe(0);
  });

  it('erasing the owner of a user-owned Agent removes its install memories instead of failing on the Agent FK', async () => {
    const f = await fixture();
    const owner = await f.user('uo-owner');
    const agent = await db.agent.create({ data: { id: generateId(), name: 'Mine', urn: 'uo:mine', ownerUserId: owner.id } });
    // An install memory in someone else's (org) App: the App cascade of the erasure does not reach it,
    // so only the explicit sweep keeps the RESTRICT Agent FK from rolling the erasure back.
    const { app } = await createDbAppWithKey(db, 'foreign-app', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await db.memory.create({
      data: { id: generateId(), class: 'system', name: 'uo-install', urn: `${orgId}:uo-install`, organizationId: orgId, appId: app.id, installOfAgentId: agent.id },
    });
    const { deleteUserAccount } = await import('../../../controller/operations/deleteUser.js');
    await deleteUserAccount(db, { targetUserId: owner.id, actorUserId: owner.id });
    expect(await db.memory.count({ where: { installOfAgentId: agent.id } })).toBe(0);
  });
});

// ── Creation versus revocation (the shared authority-anchor protocol) ───────────────────────────
// A third connection holds the contested anchors exclusively and commits the revocation; the
// first write must prove it is WAITING on them (pg_locks barrier) and then be refused with no
// memory created. Pinned at the guarded write itself (the transaction), not the resolver.
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';

async function hold(
  lock: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>,
) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held!: () => void;
  const isHeld = new Promise<void>((r) => { held = r; });
  const done = db.$transaction(async (tx) => { await lock(tx); held(); await gate; }, { timeout: 20_000 });
  await isHeld;
  return { release, done };
}

describe('#2044 install memory — a first write never outlives the authority it needs', () => {
  async function raced(
    revoke: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>,
    anchors: (f: Awaited<ReturnType<typeof fixture>>) => Array<{ kind: 'app' | 'org' | 'agent' | 'user'; id: string }>,
  ) {
    const f = await fixture();
    const holder = await hold(async (tx) => {
      await lockAuthorityAnchors(tx, anchors(f), 'exclusive');
      await revoke(tx, f);
    });
    const write = f.create(f.admin).then(() => 'wrote', (e: Error) => e);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
    } finally {
      holder.release();
      await holder.done;
    }
    return { f, outcome: await write };
  }

  it('concurrent first write vs deleteApp: refused, nothing created', async () => {
    const { f, outcome } = await raced(
      (tx, f) => tx.app.update({ where: { id: f.app.id }, data: { deletedAt: new Date() } }),
      (f) => [{ kind: 'app', id: f.app.id }, { kind: 'org', id: orgId }],
    );
    expect(outcome).not.toBe('wrote');
    expect(await f.installRows()).toHaveLength(0);
  });

  it('concurrent first write vs uninstall: refused, nothing created', async () => {
    const { f, outcome } = await raced(
      (tx, f) => tx.appAgent.deleteMany({ where: { appId: f.app.id, agentId: f.agent.id } }),
      (f) => [{ kind: 'app', id: f.app.id }, { kind: 'agent', id: f.agent.id }],
    );
    expect(outcome).not.toBe('wrote');
    expect(await f.installRows()).toHaveLength(0);
  });

  it('concurrent first write vs the writer\'s own demotion: refused on the CURRENT authority, nothing created', async () => {
    const { f, outcome } = await raced(
      (tx, f) => tx.orgMember.updateMany({ where: { organizationId: orgId, userId: f.admin.id }, data: { role: 'READER' } }),
      (f) => [{ kind: 'org', id: orgId }, { kind: 'user', id: f.admin.id }],
    );
    expect(outcome).toMatchObject({ message: expect.stringMatching(/Forbidden|APP_NOT_FOUND/) });
    expect(await f.installRows()).toHaveLength(0);
  });

  it('CONTROL: with no revocation in flight the same first write lands', async () => {
    const { f, outcome } = await raced(async () => undefined, (f) => [{ kind: 'app', id: f.app.id }]);
    expect(outcome).toBe('wrote');
    expect(await f.installRows()).toHaveLength(1);
  });
});

// ── MCP: `install: { app, agent }` on hadron_create_node / hadron_update_node ──────────────────
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';

describe('#2044 install memory — MCP target', () => {
  const mcpAuth = (userId: string) => ({ userId, organizationId: orgId, roles: [], clientId: `user:${userId}` }) as AuthContext;

  it('hadron_create_node / hadron_update_node write the install memory; a non-manager is refused and nothing is created', async () => {
    const f = await fixture();
    const install = { app: f.app.id, agent: f.agent.id };
    const denied = await createTestableMcpServer(mcpAuth(f.member.id))
      .callToolText('hadron_create_node', { urn: 'prompts:lane', name: 'Lane', content: 'x', install });
    expect(denied).toMatch(/Forbidden|forbidden|denied/i);
    expect(await f.installRows()).toHaveLength(0);

    const created = await createTestableMcpServer(mcpAuth(f.admin.id))
      .callToolText('hadron_create_node', { urn: 'prompts:lane', name: 'Lane', content: 'first', install });
    expect(created).toContain("install memory");
    const [row] = await f.installRows();
    expect(row).toBeTruthy();
    expect((await db.node.findFirstOrThrow({ where: { memoryId: row!.id, loc: 'prompts:lane' } })).content).toBe('first');

    const updated = await createTestableMcpServer(mcpAuth(f.admin.id))
      .callToolText('hadron_update_node', { urn: 'prompts:lane', content: 'second', install });
    expect(updated).toContain('updated');
    expect((await db.node.findFirstOrThrow({ where: { memoryId: row!.id, loc: 'prompts:lane' } })).content).toBe('second');
    // A participant reads it by URN over MCP; a stranger does not.
    const read = await createTestableMcpServer(mcpAuth(f.member.id))
      .callToolText('hadron_get_node', { urn: `hrn:node:${row!.urn}:prompts:lane` });
    expect(read).toContain('second');
    const hidden = await createTestableMcpServer(mcpAuth(f.stranger.id))
      .callToolText('hadron_get_node', { urn: `hrn:node:${row!.urn}:prompts:lane` });
    expect(hidden).not.toContain('second');
  });

  it('edges and isRunnable are refused with install', async () => {
    const f = await fixture();
    const out = await createTestableMcpServer(mcpAuth(f.admin.id)).callToolText('hadron_create_node', {
      urn: 'x', name: 'x', isRunnable: true, install: { app: f.app.id, agent: f.agent.id },
    });
    expect(out).toMatch(/does not support/);
    expect(await f.installRows()).toHaveLength(0);
  });
});

describe('#2044 install memory — list surfaces', () => {
  it('Query.memories(system) lists the record only to its audience', async () => {
    const f = await fixture();
    await f.create(f.admin);
    const reader = await f.user('org-reader');
    await db.orgMember.create({ data: { organizationId: orgId, userId: reader.id, role: 'READER' } });
    const ids = async (u: { id: string }) =>
      ((await Q.memories({}, { filter: { memoryClasses: ['system'] }, orgId, limit: 50 }, ctxOf(u.id))).items as Array<{ id: string }>)
        .map((m) => m.id);
    const [row] = await f.installRows();
    expect(await ids(f.admin)).toContain(row!.id);
    expect(await ids(f.contributor)).toContain(row!.id);
    expect(await ids(reader)).not.toContain(row!.id);
    expect(await ids(f.stranger)).not.toContain(row!.id);
    // By ref and by URN: the same bare null for an org reader as for a missing memory.
    for (const ref of [row!.id, row!.urn]) {
      expect(await Q.memory({}, { ref }, ctxOf(reader.id))).toBeNull();
      expect(await Q.memory({}, { ref }, ctxOf(f.stranger.id))).toBeNull();
      expect((await Q.memory({}, { ref }, ctxOf(f.contributor.id)))?.id).toBe(row!.id);
    }
    // And a node read through the enumeration gate finds nothing for the reader.
    const found = await Q.findNodes({}, { filter: { memoryIds: [row!.id] }, limit: 10 }, ctxOf(reader.id)).catch(() => ({ items: [] }));
    expect(found.items ?? found.nodes ?? []).toHaveLength(0);
  });
});

describe('#2044 install memory — the one-Agent-per-system-memory assumptions', () => {
  it('cannot be transferred, attached as an Agent memory item, or reported/repaired as an Agent\'s own', async () => {
    const f = await fixture();
    await f.create(f.admin);
    const [row] = await f.installRows();
    // Transfer: a system-class memory never transfers independently; the plan names why.
    const preview = await M.transferMemoryOwnership(
      {}, { memoryRef: row!.id, orgRef: orgId, targetClass: 'knowledge', dryRun: true }, ctxOf(f.admin.id),
    );
    expect((preview.blockers as Array<{ code: string }>).map((b) => b.code)).toContain('UNSUPPORTED_MEMORY_CLASS');
    // Attach: refused as an Agent memory item.
    await expect(M.addMemoryToAgent({}, { agentRef: f.agent.id, memoryRef: row!.id, role: 'read' }, ctxOf(f.admin.id))).rejects.toThrow();
    expect(await db.agentMemoryItem.count({ where: { memoryId: row!.id } })).toBe(0);
    // The Agent-system-memory audit starts from Agent.systemMemoryId, which never names it.
    const { findSystemMemoryOwnerMismatches } = await import('../../../lib/agentSystemMemory.js');
    expect(JSON.stringify(await findSystemMemoryOwnerMismatches(db))).not.toContain(row!.id);
    expect((await db.agent.findUniqueOrThrow({ where: { id: f.agent.id } })).systemMemoryId).not.toBe(row!.id);
  });
});
