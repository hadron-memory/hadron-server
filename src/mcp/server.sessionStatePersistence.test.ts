/**
 * #1012 — durable per-client MCP selections.
 *
 * `activeAppByMcpSession` and `activeMemoryUrn` live for exactly one MCP
 * transport session, and clients re-initialize transparently after a restart,
 * so both silently evaporated (#1005). #1009 made the loss legible and
 * recoverable for callers holding a Hadron session id; this covers everyone
 * else — above all plain memory work, which has no session to recover from and
 * whose only prior remedy was re-selecting after every restart.
 *
 * Two design decisions are pinned here because getting either wrong is worse
 * than the bug:
 *
 *   - **Per (user, clientKey), never per user.** One person may drive Claude
 *     Desktop, Cursor and the CLI at once. A per-user row would let one switch
 *     the others' active App mid-conversation, turning a LOST selection into a
 *     SILENTLY WRONG one.
 *   - **Storage is not authorization.** A stored selection is a cache of a
 *     choice; it can outlive the membership that justified it, so both pointers
 *     are re-authorized on load through the shared gates.
 *
 * A client that sends no `X-Hadron-Client-Id` is never persisted and keeps the
 * pre-#1012 behaviour exactly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import {
  loadMcpSessionState,
  normalizeClientKey,
  saveActiveApp,
} from '../lib/mcpSessionState.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let user: { id: string };
let app: { id: string; urn: string; name: string };
let otherApp: { id: string; urn: string; name: string };
let memory: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'mcp-ss-org', urn: `mcp-ss-${suffix}.com` },
  });
  user = await db.user.create({
    data: { id: generateId(), githubId: 97810, githubUsername: `mcp-ss-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` },
  });
  otherApp = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Other App', urn: `${org.urn}:other` },
  });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: otherApp.id, userId: user.id, role: 'owner' } });
  memory = await db.memory.create({
    data: {
      id: generateId(),
      class: 'knowledge',
      name: 'docs',
      urn: `${org.urn}:docs`,
      organizationId: org.id,
      visibility: 'ORGANIZATION',
    },
  });
});

const MULTI_APP = { cachedAppResolution: { kind: 'multi-app' as const } };

function auth(): AuthContext {
  return { userId: user.id, roles: ['READER'], clientId: `user:${user.id}` } as AuthContext;
}

/** A cold MCP session for this client instance — the post-reconnect shape. */
function server(clientKey: string | null) {
  return createTestableMcpServer(auth(), {
    sessionId: `mcp-ss-${generateId()}`,
    clientKey,
    ...MULTI_APP,
  });
}

describe('#1012 — clientKey normalization', () => {
  it('accepts a trimmed id and rejects unusable ones', () => {
    expect(normalizeClientKey('  cursor-window-1  ')).toBe('cursor-window-1');
    expect(normalizeClientKey('')).toBeNull();
    expect(normalizeClientKey('   ')).toBeNull();
    expect(normalizeClientKey(undefined)).toBeNull();
    expect(normalizeClientKey(123)).toBeNull();
  });

  it('REJECTS an over-long id rather than truncating it', () => {
    // Truncation would collide two client instances onto one row — exactly the
    // multi-client stomping this design exists to prevent.
    expect(normalizeClientKey('x'.repeat(201))).toBeNull();
    expect(normalizeClientKey('x'.repeat(200))).toHaveLength(200);
  });
});

describe('#1012 — the selection survives a reconnect', () => {
  it('hadron_set_active_app persists, and a NEW connection restores it', async () => {
    const key = 'claude-desktop-1';
    const first = server(key);
    const set = await first.callToolText('hadron_set_active_app', { app: app.urn });
    expect(set).toContain('Active App set to');

    const row = await db.mcpSessionState.findUniqueOrThrow({
      where: { userId_clientKey: { userId: user.id, clientKey: key } },
    });
    expect(row.appId).toBe(app.id);

    // The reconnect: a fresh instance for the same client instance id. The
    // boundary re-authorizes and hands back the App.
    const restored = await loadMcpSessionState(db, auth(), key);
    expect(restored.appId).toBe(app.id);
    expect(restored.organizationId).toBe(org.id);
  });

  it('hadron_set_active_memory persists by PK, so a RENAME cannot strand it', async () => {
    // The surface with no other remedy: active-memory has no Hadron session to
    // recover from, so before this a reconnect meant re-selecting forever.
    const key = 'cli-1';
    await server(key).callToolText('hadron_set_active_memory', { memoryUrn: memory.urn });

    const row = await db.mcpSessionState.findUniqueOrThrow({
      where: { userId_clientKey: { userId: user.id, clientKey: key } },
    });
    expect(row.memoryId).toBe(memory.id);

    // Rename the memory — a URN-keyed store would now dangle.
    const renamed = `${org.urn}:docs-renamed`;
    await db.memory.update({ where: { id: memory.id }, data: { urn: renamed } });

    const restored = await loadMcpSessionState(db, auth(), key);
    expect(restored.memoryUrn).toBe(renamed);
  });

  it('a restored active memory is actually used as run_task default scope', async () => {
    // End-to-end: the restored URN is seeded into the closure, so the tool that
    // reads it behaves as though the caller had just set it.
    const srv = createTestableMcpServer(auth(), {
      sessionId: `mcp-ss-${generateId()}`,
      clientKey: 'cli-1',
      restoredMemoryUrn: memory.urn,
      ...MULTI_APP,
    });
    const out = await srv.callToolText('hadron_run_task', { task: 'no-such-task-anywhere' });
    // It resolved a memory rather than asking for a hint — the selection held.
    expect(out).not.toContain('Pass a `memory` hint');
  });
});

describe('#1012 — per CLIENT, not per user', () => {
  it("one client's selection does not move another client's", async () => {
    // The failure this keying exists to prevent: a per-user row would make
    // switching App in Cursor silently switch it in Claude Desktop.
    await server('claude-desktop-1').callToolText('hadron_set_active_app', { app: app.urn });
    await server('cursor-1').callToolText('hadron_set_active_app', { app: otherApp.urn });

    expect((await loadMcpSessionState(db, auth(), 'claude-desktop-1')).appId).toBe(app.id);
    expect((await loadMcpSessionState(db, auth(), 'cursor-1')).appId).toBe(otherApp.id);
    expect(await db.mcpSessionState.count({ where: { userId: user.id } })).toBe(2);
  });

  it('re-selecting on the same client updates its row rather than adding one', async () => {
    await server('cli-1').callToolText('hadron_set_active_app', { app: app.urn });
    await server('cli-1').callToolText('hadron_set_active_app', { app: otherApp.urn });

    expect(await db.mcpSessionState.count({ where: { userId: user.id } })).toBe(1);
    expect((await loadMcpSessionState(db, auth(), 'cli-1')).appId).toBe(otherApp.id);
  });
});

describe('#1012 — opting out costs nothing', () => {
  it('a client sending no id is never persisted, and still selects normally', async () => {
    const out = await server(null).callToolText('hadron_set_active_app', { app: app.urn });
    expect(out).toContain('Active App set to');
    expect(await db.mcpSessionState.count()).toBe(0);
  });

  it('loading without a client id restores nothing', async () => {
    await saveActiveApp(db, auth(), 'cli-1', app.id);
    expect(await loadMcpSessionState(db, auth(), null)).toEqual({});
  });
});

describe('#1012 — storage is not authorization', () => {
  it('drops an App the caller no longer participates in (#475 / #1007)', async () => {
    await saveActiveApp(db, auth(), 'cli-1', app.id);
    expect((await loadMcpSessionState(db, auth(), 'cli-1')).appId).toBe(app.id);

    // Revoke BOTH grants: isAppParticipant admits an AppMember OR an org
    // CONTRIBUTOR+, so dropping one leaves the other standing.
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: user.id } } });
    await db.orgMember.deleteMany({ where: { organizationId: org.id, userId: user.id } });

    expect((await loadMcpSessionState(db, auth(), 'cli-1')).appId).toBeUndefined();
  });

  it('keeps the App for a participant who is not an AppMember (the SHARED gate)', async () => {
    // The complement: re-authorization must use isAppParticipant, not a
    // bespoke member-row lookup, or an org CONTRIBUTOR loses a valid selection.
    await saveActiveApp(db, auth(), 'cli-1', app.id);
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: user.id } } });

    expect((await loadMcpSessionState(db, auth(), 'cli-1')).appId).toBe(app.id);
  });

  it('drops a soft-deleted or uninstalled App', async () => {
    await saveActiveApp(db, auth(), 'cli-1', app.id);
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    expect((await loadMcpSessionState(db, auth(), 'cli-1')).appId).toBeUndefined();
  });

  it('drops a memory the caller can no longer read', async () => {
    await server('cli-1').callToolText('hadron_set_active_memory', { memoryUrn: memory.urn });
    expect((await loadMcpSessionState(db, auth(), 'cli-1')).memoryUrn).toBe(memory.urn);

    // Losing org membership removes the org-read that admitted this memory.
    await db.orgMember.deleteMany({ where: { organizationId: org.id, userId: user.id } });
    await db.appMember.deleteMany({ where: { userId: user.id } });

    expect((await loadMcpSessionState(db, auth(), 'cli-1')).memoryUrn).toBeUndefined();
  });

  it("never restores another user's row", async () => {
    await saveActiveApp(db, auth(), 'shared-key-name', app.id);
    const stranger = await db.user.create({
      data: { id: generateId(), githubId: 97811, githubUsername: `mcp-ss-x-${generateId().slice(-6)}`, roles: ['READER'] },
    });
    const strangerAuth = {
      userId: stranger.id, roles: ['READER'], clientId: `user:${stranger.id}`,
    } as AuthContext;

    // Same clientKey string, different user — the unique is (userId, clientKey).
    expect(await loadMcpSessionState(db, strangerAuth, 'shared-key-name')).toEqual({});
  });
});

describe('#1012 — deleted targets degrade, never dangle', () => {
  it('a deleted App nulls the pointer and leaves the memory selection intact', async () => {
    const key = 'cli-1';
    await server(key).callToolText('hadron_set_active_app', { app: app.urn });
    await server(key).callToolText('hadron_set_active_memory', { memoryUrn: memory.urn });

    await db.app.delete({ where: { id: app.id } });

    const row = await db.mcpSessionState.findUniqueOrThrow({
      where: { userId_clientKey: { userId: user.id, clientKey: key } },
    });
    expect(row.appId).toBeNull();
    expect(row.memoryId).toBe(memory.id);
  });

  it('a deleted user takes their rows with them', async () => {
    await saveActiveApp(db, auth(), 'cli-1', app.id);
    await db.appMember.deleteMany({ where: { userId: user.id } });
    await db.orgMember.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
    expect(await db.mcpSessionState.count()).toBe(0);
  });
});
