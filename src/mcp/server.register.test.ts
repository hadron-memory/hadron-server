/**
 * Spec 049 Phase 5 — the register tools on the MCP surface.
 *
 * The rules are pinned in lib/register.test.ts; this covers the SURFACE: the
 * tools go through the same resolvers (the install default lists under the
 * active App; add → list → remove round-trip), a refusal comes back as a
 * `[code] message` text envelope rather than a thrown error, and a Channel
 * whose host memory the caller cannot read is named by id only — the same
 * gate `RegisterEntry.channel` applies (Codex P1 on PR #1166).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { ensureChannelWithRoot } from '../lib/channels.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let app: { id: string; urn: string };
let app2: { id: string; urn: string };
let agent: { id: string; urn: string };
let worker: { id: string };
let channel: { id: string };
let channel2: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'rgm', urn: `rgm-${t}.com` } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 49301, githubUsername: `rgm-admin-${t}` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 49302, githubUsername: `rgm-member-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` } });
  app2 = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  // The admin participates in BOTH Apps (app-class memories admit participants, not org rank); the member only in the first.
  await db.appMember.create({ data: { appId: app2.id, userId: admin.id, role: 'owner' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'ag', urn: `${org.urn}:ag`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appAgent.create({ data: { appId: app2.id, agentId: agent.id } });
  const mem = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app-shared`, name: 's', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  const mem2 = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:other-shared`, name: 's2', class: 'app', appId: app2.id, sharedMemoryOfAgentId: agent.id } });
  worker = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
  channel = (await ensureChannelWithRoot(db, { memoryId: mem.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app.id })).channel;
  channel2 = (await ensureChannelWithRoot(db, { memoryId: mem2.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app2.id })).channel;
});

function server(userId: string, activeAppId: string = app.id) {
  const auth = { userId, roles: ['READER'], clientId: `user:${userId}`, appId: activeAppId, organizationId: org.id } as AuthContext;
  return createTestableMcpServer(auth, { sessionId: `rgm-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
}

describe('register tools', () => {
  it('lists the install default under the active App; add → list → remove round-trip', async () => {
    const asAdmin = server(admin.id);
    const listed = await asAdmin.callToolText('hadron_register_list', {});
    expect(listed).toContain('1 register entry');
    expect(listed).toContain(`team (chats:team) ← ${agent.urn} — BOTH, install default`);
    const added = await asAdmin.callToolText('hadron_register_add', { channel: channel.id, attendee: worker.id, role: 'WATCH', description: 'Iris watches' });
    expect(added).toContain('Added.');
    expect(added).toContain(`hrn:worker:${org.urn}:app:iris — WATCH`);
    expect(added).toContain('Iris watches');
    const id = added.match(/id ([0-9a-f]{32})/)![1];
    expect(await asAdmin.callToolText('hadron_register_list', { attendee: worker.id })).toContain('1 register entry');
    expect(await asAdmin.callToolText('hadron_register_remove', { entry: id })).toBe('Removed.');
    expect(await asAdmin.callToolText('hadron_register_list', { attendee: worker.id })).toContain('No register entries');
  });

  it('a refusal is a [code] text envelope, not a thrown error', async () => {
    const asMember = server(member.id);
    expect(await asMember.callToolText('hadron_register_add', { channel: channel.id })).toMatch(/^\[forbidden\]/);
    const dup = await server(admin.id).callToolText('hadron_register_add', { channel: channel.id, attendee: agent.urn });
    expect(dup).toMatch(/^\[register_entry_exists\]/);
    const foreign = await server(admin.id).callToolText('hadron_register_add', { channel: 'nope' });
    expect(foreign).toMatch(/^\[bad_user_input\] No match for channelRef "nope"/);
    const install = await db.registerEntry.findFirstOrThrow({ where: { appId: app.id } });
    expect(await asMember.callToolText('hadron_register_remove', { entry: install.id })).toMatch(/^\[forbidden\]/);
  });

  it('an owner-side reader sees the row but not a Channel whose host memory they cannot read', async () => {
    // An org row (admin is org ADMIN) naming the OTHER App's Channel; the
    // member is on the org side but not a participant of that App.
    const asAdmin = server(admin.id);
    await asAdmin.callToolText('hadron_register_add', { owner: org.urn, channel: channel2.id });
    const seen = await server(member.id).callToolText('hadron_register_list', { owner: org.urn });
    expect(seen).toContain('1 register entry');
    expect(seen).toContain(`channel ${channel2.id} (host memory not readable to you)`);
    expect(seen).not.toContain('team (chats:team)');
    // The admin, driving the OTHER App (an active App bounds MCP reads to its memories), sees the name and address.
    expect(await server(admin.id, app2.id).callToolText('hadron_register_list', { owner: org.urn })).toContain('team (chats:team) ← every attendee');
  });
});

describe('the register on the identity surfaces (Phase 6)', () => {
  it('hadron_start_session, hadron_get_worker and hadron_whoami all carry the bound worker\'s register block', async () => {
    const asAdmin = server(admin.id);
    const started = await asAdmin.callToolText('hadron_start_session', { description: 'stint', workerRef: 'Iris' });
    expect(started).toContain('## Channels (register)');
    expect(started).toContain('- team — hrn:mem:');
    expect(await asAdmin.callToolText('hadron_get_worker', { workerRef: 'Iris' })).toContain('## Channels (register)');
    const who = await asAdmin.callToolText('hadron_whoami', {});
    expect(who).toContain('working as: Iris');
    expect(who).toContain('    ## Channels (register)');
  });
});
