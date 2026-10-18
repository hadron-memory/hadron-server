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
