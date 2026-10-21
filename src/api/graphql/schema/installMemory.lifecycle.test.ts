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
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';
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

  it('R94 C: erasing the owner of a user-owned Agent keeps another App\'s install memory, detached, and never blocks the erasure', async () => {
    const f = await fixture();
    const owner = await f.user('uo-owner');
    const agent = await db.agent.create({ data: { id: generateId(), name: 'Mine', urn: 'uo:mine', ownerUserId: owner.id } });
    // An install memory in someone else's (org) App: the App cascade of the erasure does not reach it.
    const { app } = await createDbAppWithKey(db, 'foreign-app', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const install = await db.memory.create({
      data: { id: generateId(), class: 'system', name: 'uo-install', urn: `${orgId}:uo-install`, organizationId: orgId, appId: app.id, installOfAgentId: agent.id, isInstallMemory: true },
    });
    const node = await db.node.create({ data: { id: generateId(), memoryId: install.id, loc: 'prompts:lane', name: 'Lane', nodeType: 'page', content: 'secret' } });
    const { deleteUserAccount } = await import('../../../controller/operations/deleteUser.js');
    await deleteUserAccount(db, { targetUserId: owner.id, actorUserId: owner.id });
    // Kept, detached, still an install memory with its content intact.
    const kept = await db.memory.findUniqueOrThrow({ where: { id: install.id } });
    expect(kept).toMatchObject({ deletedAt: null, appId: app.id, installOfAgentId: null, isInstallMemory: true, class: 'system' });
    expect(await db.agent.count({ where: { id: agent.id } })).toBe(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).content).toBe('secret');
    // The App's manager finds it (record) without reading its content, and may delete it (R45).
    expect((await Q.memory({}, { ref: install.id }, ctxOf(f.admin.id)))?.id).toBe(install.id);
    // A stranger finds nothing, and a detached install takes no further write.
    expect(await Q.memory({}, { ref: install.id }, ctxOf(f.stranger.id))).toBeNull();
    await expect(M.updateNode({}, { input: { memoryId: install.id, loc: 'prompts:lane', name: 'x' } }, ctxOf(f.admin.id))).rejects.toThrow();
    await expect(M.deleteMemory({}, { id: install.id }, ctxOf(f.stranger.id))).rejects.toThrow();
    // Once its App is deleted the manager still finds the detached record but reads no content (R45).
    await M.deleteApp({}, { ref: app.id }, ctxOf(f.admin.id));
    expect((await Q.memory({}, { ref: install.id }, ctxOf(f.admin.id)))?.id).toBe(install.id);
    expect(await Q.node({}, { ref: node.id, raw: true }, ctxOf(f.admin.id))).toBeNull();
    await expect(M.deleteMemory({}, { id: install.id }, ctxOf(f.admin.id))).resolves.toBe(true);
  });
});

describe('#2064 full-scope §10 (Riana) — response and discovery boundaries', () => {
  it('a nonparticipant platform manager must not recover unreadable content from a metadata-only update', async () => {
    const f = await fixture();
    const node = await f.create(f.admin);
    const platform = await f.user('platform-outsider');
    await db.user.update({ where: { id: platform.id }, data: { roles: ['ADMIN'] } });
    const ctx = ctxOf(platform.id, { roles: ['ADMIN'] });
    expect(await Q.node({}, { ref: node.id, raw: true }, ctx)).toBeNull();
    const { ApolloServer } = await import('@apollo/server');
    const { typeDefs } = await import('./typeDefs.js');
    const server = new ApolloServer({ typeDefs, resolvers });
    await server.start();
    try {
      const result = await server.executeOperation(
        { query: 'mutation($i:UpdateNodeInput!){updateNode(input:$i){id name content}}', variables: { i: { install: f.install, loc: 'prompts:lane', name: 'metadata-only' } } },
        { contextValue: ctx },
      );
      const wire = result.body.kind === 'single' ? result.body.singleResult : null;
      expect((wire?.data as any)?.updateNode?.content ?? null).not.toBe('replacement');
    } finally { await server.stop(); }
  });

  it('the concealment holds at EVERY address of the same write: memoryId+loc and id, not only install+loc (Andi)', async () => {
    const f = await fixture();
    const node = await f.create(f.admin);
    const { emitNodeUrnV2 } = await import('../../../lib/urnEmit.js');
    const nodeUrn = emitNodeUrnV2((await f.installRows())[0]!.urn, 'prompts:lane');
    const platform = await f.user('platform-outsider-2');
    await db.user.update({ where: { id: platform.id }, data: { roles: ['ADMIN'] } });
    const ctx = ctxOf(platform.id, { roles: ['ADMIN'] });
    expect(await Q.node({}, { ref: node.id, raw: true }, ctx)).toBeNull();
    const { ApolloServer } = await import('@apollo/server');
    const { typeDefs } = await import('./typeDefs.js');
    const server = new ApolloServer({ typeDefs, resolvers });
    await server.start();
    try {
      for (const input of [
        { memoryId: node.memoryId, loc: 'prompts:lane', name: 'by-memory-loc' },
        { id: node.id, name: 'by-id' },
        { id: nodeUrn, name: 'by-urn' },
      ]) {
        const result = await server.executeOperation(
          { query: 'mutation($i:UpdateNodeInput!){updateNode(input:$i){id name content description}}', variables: { i: input } },
          { contextValue: ctx },
        );
        const wire = result.body.kind === 'single' ? result.body.singleResult : null;
        const out = (wire?.data as any)?.updateNode;
        // Xan/Andi P3: the write must have SUCCEEDED, or the concealment assertions below prove nothing.
        expect(wire?.errors?.map((e) => e.message)).toBeUndefined();
        expect(out).not.toBeNull();
        expect(out.content ?? null).toBeNull();
        expect(out.description ?? null).toBeNull();
        expect(out.name).toBe('prompts:lane');
      }
    } finally { await server.stop(); }
    // The same addresses return the content to a participant manager.
    const viaMemory = await M.updateNode({}, { input: { memoryId: node.memoryId, loc: 'prompts:lane', name: 'p1' } }, ctxOf(f.admin.id));
    expect(viaMemory.content).toBe('replacement');
    const viaId = await M.updateNode({}, { input: { id: node.id, name: 'p2' } }, ctxOf(f.admin.id));
    expect(viaId.content).toBe('replacement');
    const viaUrn = await M.updateNode({}, { input: { id: nodeUrn, name: 'p3' } }, ctxOf(f.admin.id));
    expect(viaUrn.content).toBe('replacement');
  });

  it('Ruth P2: a partial update by a nonparticipant returns NO preexisting title or content-derived field, and the write succeeds', async () => {
    const f = await fixture();
    const node = await f.create(f.admin);
    const before = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(before.name).not.toBe('prompts:lane');
    const platform = await f.user('platform-outsider-3');
    await db.user.update({ where: { id: platform.id }, data: { roles: ['ADMIN'] } });
    const ctx = ctxOf(platform.id, { roles: ['ADMIN'] });
    const { ApolloServer } = await import('@apollo/server');
    const { typeDefs } = await import('./typeDefs.js');
    const server = new ApolloServer({ typeDefs, resolvers });
    await server.start();
    try {
      const result = await server.executeOperation(
        { query: `mutation($i:UpdateNodeInput!){updateNode(input:$i){id memoryId loc name revision description abstract tags content data
          memory{id} outgoingEdges{id} incomingEdges{id} asset{id} signingRequests{id} commentSummary{comments openThreads}
          approvalStatus{state approval{revision}} mintStatus{minted mintedByInfo} authorship{__typename} createdByWorker{id} updatedByAgent{id}
          contentValidation{state} signatureStatus{state signatures{id}}}}`, variables: { i: { install: f.install, loc: 'prompts:lane', description: 'only-this' } } },
        { contextValue: ctx },
      );
      const wire = result.body.kind === 'single' ? result.body.singleResult : null;
      // The write itself must have SUCCEEDED (a refused write would also leak nothing, and prove nothing).
      expect(wire?.errors?.map((e) => e.message)).toBeUndefined();
      const out = (wire?.data as any)?.updateNode;
      expect(out).not.toBeNull();
      expect(out.id).toBe(node.id);
      expect(out.name).toBe('prompts:lane');
      // Selecting `revision` on a concealed write must not error (Node.revision reads revSeq): Andi, Charles, Bindi.
      expect(out.revision).toBe((await db.node.findUniqueOrThrow({ where: { id: node.id } })).revSeq);
      expect(out).toMatchObject({ description: null, abstract: null, tags: [], content: null, data: null, memory: null,
        outgoingEdges: [], incomingEdges: [], asset: null, signingRequests: [], authorship: null, createdByWorker: null, updatedByAgent: null });
      expect(out.commentSummary).toEqual({ comments: 0, openThreads: 0 });
      expect(out.approvalStatus).toEqual({ state: 'NOT_APPLICABLE', approval: null });
      // And it really was applied.
      expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).description).toBe('only-this');
    } finally { await server.stop(); }
  });

  it('withInstallConcealment never reaches the original resolver for a concealed parent, and passes others through', async () => {
    const { withInstallConcealment, INSTALL_CONCEALED, INSTALL_CONCEALED_FIELDS } = await import('./installMemory.js');
    let calls = 0;
    const map = withInstallConcealment(Object.fromEntries(INSTALL_CONCEALED_FIELDS.map((k) => [k, () => { calls++; return 'ORIGINAL'; }])) as any);
    for (const field of INSTALL_CONCEALED_FIELDS) {
      expect(await map[field]({ [INSTALL_CONCEALED]: true, id: 'x' })).not.toBe('ORIGINAL');
      expect(await map[field]({ id: 'x' })).toBe('ORIGINAL');
    }
    expect(calls).toBe(INSTALL_CONCEALED_FIELDS.length);
  });

  it('a participant manager still gets the content back from an update (positive control)', async () => {
    const f = await fixture();
    await f.create(f.admin);
    const out = await M.updateNode({}, { input: { install: f.install, loc: 'prompts:lane', name: 'renamed' } }, ctxOf(f.admin.id));
    expect(out.content).toBe('replacement');
  });

  it('a manager user session keeps metadata discovery of the retained record after App deletion', async () => {
    const f = await fixture();
    await f.create(f.admin);
    const [memory] = await f.installRows();
    await M.deleteApp({}, { ref: f.app.id }, ctxOf(f.admin.id));
    expect((await Q.memory({}, { ref: memory!.id }, ctxOf(f.admin.id)))?.id).toBe(memory!.id);
    const { app: otherApp } = await createDbAppWithKey(db, 'live-context-app', orgId);
    await createDbAppAgent(db, otherApp.id, f.agent.id);
    const session = await db.session.create({ data: { id: generateId(), appId: otherApp.id, userId: f.admin.id, agentId: f.agent.id } });
    const ctx = ctxOf(f.admin.id, { appId: otherApp.id, sessionId: session.id });
    expect((await Q.memory({}, { ref: memory!.id }, ctx))?.id).toBe(memory!.id);
  });

  it('a manager user session finds the live install memory by address, whichever App the session is bound to', async () => {
    const f = await fixture();
    await f.create(f.admin);
    const [memory] = await f.installRows();
    const { app: otherApp } = await createDbAppWithKey(db, 'live-context-app-2', orgId);
    await createDbAppAgent(db, otherApp.id, f.agent.id);
    const session = await db.session.create({ data: { id: generateId(), appId: otherApp.id, userId: f.admin.id, agentId: f.agent.id } });
    const ctx = ctxOf(f.admin.id, { appId: otherApp.id, sessionId: session.id });
    expect((await Q.installMemory({}, f.install, ctx))?.id).toBe(memory!.id);
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

  it('#2215: an install memory is always summary-indexed (class system), and a search WITHOUT a memory filter still shows its nodes only to the audience', async () => {
    const f = await fixture();
    await f.create(f.admin, 'prompts:lane', { name: 'Install Lane', content: 'zzqx-install-marker body', abstract: 'zzqx-install-marker abstract' });
    const [row] = await f.installRows();
    const reader = await f.user('indexed-reader');
    await db.orgMember.create({ data: { organizationId: orgId, userId: reader.id, role: 'READER' } });
    const search = async (u: { id: string }) => {
      // No .catch: an error on a negative case would read as "found nothing" and hide a broken gate (Ruth, Bindi).
      const out = await Q.findNodes({}, { query: 'zzqx-install-marker', mode: 'keyword', filter: { memoryClasses: ['system'] }, orgId, limit: 20 }, ctxOf(u.id));
      return ((out.hits ?? []) as Array<{ node: { memoryId: string } }>).filter((h) => h.node.memoryId === row!.id);
    };
    const { memoryIsVectorIndexed } = await import('../../../lib/embedding/indexing.js');
    expect(memoryIsVectorIndexed({ class: row!.class, vectorIndexEnabled: row!.vectorIndexEnabled })).toBe(true);
    expect((await search(f.contributor)).length).toBeGreaterThan(0);
    expect(await search(reader)).toHaveLength(0);
    expect(await search(f.stranger)).toHaveLength(0);
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

describe('#2044 install memory — it can never become an Agent\'s brain (Andi P2-1) or sit on an app-class row (P2-2)', () => {
  it('createAgent and updateAgent refuse an install memory as systemMemoryId, and nothing changes', async () => {
    const f = await fixture();
    await f.create(f.admin);
    const [row] = await f.installRows();
    await expect(M.createAgent({}, { orgId, name: 'Promoted Install', systemMemoryId: row!.id }, ctxOf(f.admin.id)))
      .rejects.toThrow(/install memory/i);
    const plain = await db.agent.create({ data: { id: generateId(), name: 'Plain', urn: `${orgId}:plain`, organizationId: orgId } });
    await expect(M.updateAgent({}, { ref: plain.id, systemMemoryId: row!.id }, ctxOf(f.admin.id)))
      .rejects.toThrow(/install memory/i);
    expect(await db.agent.count({ where: { systemMemoryId: row!.id } })).toBe(0);
    const after = await db.memory.findUniqueOrThrow({ where: { id: row!.id } });
    expect(after).toMatchObject({ deletedAt: null, appId: f.app.id, installOfAgentId: f.agent.id });
    // Deleting an Agent therefore cannot tombstone an App's customisation.
    await M.deleteAgent({}, { ref: f.agent.id }, ctxOf(f.admin.id)).catch(() => undefined);
    expect((await db.memory.findUniqueOrThrow({ where: { id: row!.id } })).deletedAt).toBeNull();
  });

  it('R94 C: a DETACHED install memory is still never an Agent\'s system memory', async () => {
    const f = await fixture();
    await f.create(f.admin);
    const [row] = await f.installRows();
    await db.memory.update({ where: { id: row!.id }, data: { installOfAgentId: null } });
    await expect(M.createAgent({}, { orgId, name: 'Promoted Detached', systemMemoryId: row!.id }, ctxOf(f.admin.id)))
      .rejects.toThrow(/install memory/i);
    const plain = await db.agent.create({ data: { id: generateId(), name: 'Plain2', urn: `${orgId}:plain2`, organizationId: orgId } });
    await expect(M.updateAgent({}, { ref: plain.id, systemMemoryId: row!.id }, ctxOf(f.admin.id)))
      .rejects.toThrow(/install memory/i);
    // And it still blocks reclaiming the deleted App's URN until a manager deletes it.
    await M.deleteApp({}, { ref: f.app.id }, ctxOf(f.admin.id));
    await expect(M.deleteMemory({}, { id: row!.id }, ctxOf(f.admin.id))).resolves.toBe(true);
  });

  it('the install discriminator is forbidden on every non-system class, app-class with an App included', async () => {
    const f = await fixture();
    for (const cls of ['app', 'knowledge', 'group', 'personal', 'private'] as const) {
      await expect(db.memory.create({
        data: {
          id: generateId(), class: cls, name: `x-${cls}`, urn: `${orgId}:x-${cls}`, organizationId: orgId,
          appId: f.app.id, installOfAgentId: f.agent.id, isInstallMemory: true,
          ...(cls === 'group' ? { visibility: 'GROUP' as never } : {}),
          ...(cls === 'personal' || cls === 'private' ? { userId: f.admin.id, userMemoryOfAgentId: f.agent.id } : {}),
        },
      }), cls).rejects.toThrow();
    }
  });
});

// ── Every write into an EXISTING install memory carries the same fence (Diego P2 on #2064) ──────
describe('#2044 install memory — existing-node writes versus revocation', () => {
  async function racedWrite(
    write: (f: Awaited<ReturnType<typeof fixture>>, memoryId: string) => Promise<unknown>,
    revoke: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>,
    anchors: (f: Awaited<ReturnType<typeof fixture>>) => Array<{ kind: 'app' | 'org' | 'agent' | 'user'; id: string }>,
  ) {
    const f = await fixture();
    await f.create(f.admin, 'prompts:lane');
    const [row] = await f.installRows();
    const holder = await hold(async (tx) => {
      await lockAuthorityAnchors(tx, anchors(f), 'exclusive');
      await revoke(tx, f);
    });
    const outcome = write(f, row!.id).then(() => 'wrote', (e: Error) => e);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
    } finally {
      holder.release();
      await holder.done;
    }
    return { f, row: row!, result: await outcome };
  }
  const update = (f: Awaited<ReturnType<typeof fixture>>) =>
    M.updateNode({}, { input: { install: f.install, loc: 'prompts:lane', content: 'late' } }, ctxOf(f.admin.id));
  const createByMemoryId = (f: Awaited<ReturnType<typeof fixture>>, memoryId: string) =>
    M.createNode({}, { input: { memoryId, loc: 'prompts:other', name: 'o', content: 'late' } }, ctxOf(f.admin.id));

  for (const [label, write] of [['updateNode(install)', (f: any) => update(f)], ['createNode(memoryId)', (f: any, id: string) => createByMemoryId(f, id)]] as const) {
    it(`${label} vs deleteApp: refused, nothing committed`, async () => {
      const { f, row, result } = await racedWrite(write as never,
        (tx, f) => tx.app.update({ where: { id: f.app.id }, data: { deletedAt: new Date() } }),
        (f) => [{ kind: 'app', id: f.app.id }, { kind: 'org', id: orgId }]);
      expect(result).not.toBe('wrote');
      expect(await db.node.count({ where: { memoryId: row.id, content: 'late' } })).toBe(0);
      expect(await f.installRows()).toHaveLength(1);
    });
    it(`${label} vs uninstall: refused, nothing committed`, async () => {
      const { row, result } = await racedWrite(write as never,
        (tx, f) => tx.appAgent.deleteMany({ where: { appId: f.app.id, agentId: f.agent.id } }),
        (f) => [{ kind: 'app', id: f.app.id }, { kind: 'agent', id: f.agent.id }]);
      expect(result).not.toBe('wrote');
      expect(await db.node.count({ where: { memoryId: row.id, content: 'late' } })).toBe(0);
    });
    it(`${label} vs the writer's demotion: refused on the CURRENT authority`, async () => {
      const { row, result } = await racedWrite(write as never,
        (tx, f) => tx.orgMember.updateMany({ where: { organizationId: orgId, userId: f.admin.id }, data: { role: 'READER' } }),
        (f) => [{ kind: 'org', id: orgId }, { kind: 'user', id: f.admin.id }]);
      expect(result).not.toBe('wrote');
      expect(await db.node.count({ where: { memoryId: row.id, content: 'late' } })).toBe(0);
    });
  }

  it('CONTROL: with no revocation in flight the same writes land', async () => {
    const { f, row, result } = await racedWrite((f) => update(f), async () => undefined, (f) => [{ kind: 'app', id: f.app.id }]);
    expect(result).toBe('wrote');
    expect(await createByMemoryId(f, row.id)).toBeTruthy();
  });

  it('the other ordering: a revoker waits behind an in-flight write holding the fence, then proceeds', async () => {
    const f = await fixture();
    await f.create(f.admin);
    const writer = await hold((tx) => lockAuthorityAnchors(tx, [{ kind: 'app', id: f.app.id }, { kind: 'org', id: orgId }], 'shared'));
    const deleting = M.deleteApp({}, { ref: f.app.id }, ctxOf(f.admin.id)).then(() => 'deleted', (e: Error) => e);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
      expect((await db.app.findUniqueOrThrow({ where: { id: f.app.id } })).deletedAt).toBeNull();
    } finally {
      writer.release();
      await writer.done;
    }
    expect(await deleting).toBe('deleted');
  });
});

describe('#2044 install memory — the cleanup delete carries the fence too (Xan on #2064)', () => {
  it('a manager demoted while the delete waits is refused on the CURRENT role, and the memory stays', async () => {
    const f = await fixture();
    await f.create(f.admin);
    const [row] = await f.installRows();
    const holder = await hold(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'org', id: orgId }, { kind: 'user', id: f.admin.id }], 'exclusive');
      await tx.orgMember.updateMany({ where: { organizationId: orgId, userId: f.admin.id }, data: { role: 'READER' } });
    });
    const deleting = M.deleteMemory({}, { id: row!.id }, ctxOf(f.admin.id)).then(() => 'deleted', (e: Error) => e);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
    } finally {
      holder.release();
      await holder.done;
    }
    expect(await deleting).not.toBe('deleted');
    expect((await db.memory.findUniqueOrThrow({ where: { id: row!.id } })).deletedAt).toBeNull();
  });

  it('CONTROL: with nothing in flight the same manager deletes', async () => {
    const f = await fixture();
    await f.create(f.admin);
    const [row] = await f.installRows();
    await expect(M.deleteMemory({}, { id: row!.id }, ctxOf(f.admin.id))).resolves.toBe(true);
  });
});

describe('#2044 install memory — lock order and the pooled-only writers (Diego/Xan deltas on #2064)', () => {
  it('a writer takes the authority BEFORE any memory/node lock: while a revoker holds the anchor, the memory row is free', async () => {
    const f = await fixture();
    await f.create(f.admin);
    const [row] = await f.installRows();
    // What account erasure (or any revoker) holds: the tenant anchor, exclusively.
    const revoker = await hold((tx) => lockAuthorityAnchors(tx, [{ kind: 'org', id: orgId }], 'exclusive'));
    const writing = M.updateNode({}, { input: { install: f.install, loc: 'prompts:lane', content: 'queued' } }, ctxOf(f.admin.id))
      .then(() => 'wrote', (e: Error) => e);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
      // The waiting writer holds NO lock on the memory or node rows, so the revoker's later
      // delete of them cannot cycle with it.
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${row!.id} FOR UPDATE NOWAIT`;
        await tx.$queryRaw`SELECT id FROM nodes WHERE memory_id = ${row!.id} FOR UPDATE NOWAIT`;
      });
    } finally {
      revoker.release();
      await revoker.done;
    }
    expect(await writing).toBe('wrote');
  });

  it('deleteMemory takes the authority first too', async () => {
    const f = await fixture();
    await f.create(f.admin);
    const [row] = await f.installRows();
    const revoker = await hold((tx) => lockAuthorityAnchors(tx, [{ kind: 'org', id: orgId }], 'exclusive'));
    const deleting = M.deleteMemory({}, { id: row!.id }, ctxOf(f.admin.id)).then(() => 'deleted', (e: Error) => e);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${row!.id} FOR UPDATE NOWAIT`;
      });
    } finally {
      revoker.release();
      await revoker.done;
    }
    expect(await deleting).toBe('deleted');
  });

  it('writers that cannot recheck inside their own fenced transaction fail closed on an install memory (restore, move, delete node)', async () => {
    const f = await fixture();
    const node = await f.create(f.admin, 'prompts:lane');
    await M.updateNode({}, { input: { install: f.install, loc: 'prompts:lane', content: 'v2' } }, ctxOf(f.admin.id));
    const [row] = await f.installRows();
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: node.id }, orderBy: { revNo: 'asc' } });
    const before = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    await expect(M.restoreNodeRevision({}, { revisionId: rev.id }, ctxOf(f.admin.id))).rejects.toThrow();
    await expect(M.deleteNode({}, { nodeRef: node.id }, ctxOf(f.admin.id))).rejects.toThrow();
    // The title promised "move" and the body never called it (Andi, Xan, Clark): relocate within the install memory.
    await expect(M.moveNode({}, { sourceRef: node.id, targetUrn: emitNodeUrnV2(row!.urn, 'prompts:moved') }, ctxOf(f.admin.id)))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect({ content: after.content, deletedAt: after.deletedAt, revSeq: after.revSeq, loc: after.loc, memoryId: after.memoryId })
      .toEqual({ content: before.content, deletedAt: before.deletedAt, revSeq: before.revSeq, loc: before.loc, memoryId: before.memoryId });
    expect(row).toBeTruthy();
    // The supported doors still write.
    await expect(M.updateNode({}, { input: { install: f.install, loc: 'prompts:lane', content: 'v3' } }, ctxOf(f.admin.id))).resolves.toBeTruthy();
  });
});
