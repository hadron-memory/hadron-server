/**
 * Spec 049 Phase 1 — `hadron_set_active_org` on the MCP surface.
 *
 * The ladder itself is pinned in lib/auth/activeOrg.test.ts; these tests cover
 * the SURFACE: the selection is persisted per client instance and restored
 * re-authorized (the #1012 shape), a revoked membership is not restored, an
 * org-owned active App is reported as outranking the selection, App-key
 * callers are refused, and a foreign org reads exactly like a nonexistent one.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import { loadMcpSessionState } from '../lib/mcpSessionState.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let user: { id: string };
let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let foreignOrg: { id: string; urn: string };
let appInA: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  user = await db.user.create({
    data: { id: generateId(), githubId: 97812, githubUsername: `ao-mcp-${suffix}`, roles: ['READER'] },
    select: { id: true },
  });
  const mk = (name: string) =>
    db.organization.create({
      data: { id: generateId(), name, urn: `${name}-${suffix}.com` },
      select: { id: true, urn: true },
    });
  orgA = await mk('ao-mcp-a');
  orgB = await mk('ao-mcp-b');
  foreignOrg = await mk('ao-mcp-foreign');
  for (const o of [orgA, orgB]) {
    await db.orgMember.create({
      data: { id: generateId(), organizationId: o.id, userId: user.id, role: 'CONTRIBUTOR' },
    });
  }
  appInA = await db.app.create({
    data: { id: generateId(), organizationId: orgA.id, name: 'A app', urn: `${orgA.urn}:app` },
    select: { id: true, urn: true },
  });
  await db.appMember.create({ data: { appId: appInA.id, userId: user.id, role: 'owner' } });
});

function auth(extra: Partial<AuthContext> = {}): AuthContext {
  return { userId: user.id, roles: ['READER'], clientId: `user:${user.id}`, ...extra } as AuthContext;
}

const MULTI_APP = { cachedAppResolution: { kind: 'multi-app' as const } };

function server(clientKey: string | null, extra: Partial<AuthContext> = {}, restoredOrgId?: string) {
  return createTestableMcpServer(auth(extra), {
    sessionId: `ao-mcp-${generateId()}`,
    clientKey,
    restoredOrgId,
    ...MULTI_APP,
  });
}

describe('hadron_set_active_org', () => {
  it('selects a member org, persists it, and a NEW connection restores it', async () => {
    const key = 'claude-desktop-1';
    const out = await server(key).callToolText('hadron_set_active_org', { org: orgB.urn });
    expect(out).toContain('Active organization set to');
    expect(out).toContain(orgB.urn);

    const row = await db.mcpSessionState.findUniqueOrThrow({
      where: { userId_clientKey: { userId: user.id, clientKey: key } },
    });
    expect(row.organizationId).toBe(orgB.id);

    const restored = await loadMcpSessionState(db, auth(), key);
    expect(restored.activeOrgId).toBe(orgB.id);

    // And the restored value is what server_info reports on the fresh instance.
    const info = await server(key, {}, restored.activeOrgId).callToolText('hadron_server_info');
    expect(info).toContain(`active organization: hrn:org:${orgB.urn} (via selection)`);
  });

  it('a selection whose membership was REVOKED is not restored', async () => {
    const key = 'cli-1';
    await server(key).callToolText('hadron_set_active_org', { org: orgB.urn });
    await db.orgMember.updateMany({
      where: { organizationId: orgB.id, userId: user.id },
      data: { deletedAt: new Date() },
    });
    const restored = await loadMcpSessionState(db, auth(), key);
    expect(restored.activeOrgId).toBeUndefined();
    // The row still holds it — storage is a cache, and the drop is at read time.
    const row = await db.mcpSessionState.findUniqueOrThrow({
      where: { userId_clientKey: { userId: user.id, clientKey: key } },
    });
    expect(row.organizationId).toBe(orgB.id);
  });

  it('a FOREIGN org and a NONEXISTENT one answer identically, listing memberships', async () => {
    const srv = server('cli-2');
    const foreign = await srv.callTool('hadron_set_active_org', { org: foreignOrg.urn });
    const missing = await srv.callTool('hadron_set_active_org', { org: `hrn:org:nope-${generateId()}.com` });
    for (const r of [foreign, missing]) {
      const text = r.content[0]?.text ?? '';
      expect(text.startsWith('[org_not_found]')).toBe(true);
      expect(text).toContain(`- hrn:org:${orgA.urn}`);
      expect(text).toContain(`- hrn:org:${orgB.urn}`);
      // The caller's own input is echoed; the LIST must never carry the foreign org.
      expect(text).not.toContain(`- hrn:org:${foreignOrg.urn}`);
    }
  });

  it('clear drops the selection and says what the ladder resolves to now', async () => {
    const key = 'cli-3';
    const srv = server(key);
    await srv.callToolText('hadron_set_active_org', { org: orgB.urn });
    const out = await srv.callToolText('hadron_set_active_org', { clear: true });
    expect(out).toContain('cleared');
    // Two memberships, nothing selected: the honest state is "unresolved".
    expect(out).toContain('org_required');
    const row = await db.mcpSessionState.findUniqueOrThrow({
      where: { userId_clientKey: { userId: user.id, clientKey: key } },
    });
    expect(row.organizationId).toBeNull();
  });

  it('an org-owned active App OUTRANKS the selection, and the receipt says so', async () => {
    const srv = server('cli-4');
    await srv.callToolText('hadron_set_active_app', { app: appInA.urn });
    const out = await srv.callToolText('hadron_set_active_org', { org: orgB.urn });
    expect(out).toContain('outranks this selection');
    const info = await srv.callToolText('hadron_server_info');
    expect(info).toContain(`active organization: hrn:org:${orgA.urn} (via app)`);
  });

  it('server_info reports the two ends of the membership count honestly', async () => {
    // Two memberships, nothing chosen → unresolved, not a guess.
    expect(await server('cli-5').callToolText('hadron_server_info')).toContain('active organization: unresolved');
    // Zero memberships → the user-owned view, never a refusal.
    await db.orgMember.updateMany({ where: { userId: user.id }, data: { deletedAt: new Date() } });
    expect(await server('cli-6').callToolText('hadron_server_info')).toContain(
      'active organization: none — no memberships',
    );
  });

  it('an AppKey caller is refused: its organization is the credential', async () => {
    const srv = createTestableMcpServer({ appId: appInA.id, roles: [] } as AuthContext, {
      sessionId: `ao-mcp-${generateId()}`,
      clientKey: 'app-key-1',
    });
    const r = await srv.callTool('hadron_set_active_org', { org: orgA.urn });
    expect(r.content[0]?.text.startsWith('[org_not_found]')).toBe(true);
    expect(await db.mcpSessionState.count()).toBe(0);
  });

  it('a client that sends no clientKey is not persisted', async () => {
    const out = await server(null).callToolText('hadron_set_active_org', { org: orgA.urn });
    expect(out).toContain('Active organization set to');
    expect(await db.mcpSessionState.count()).toBe(0);
  });
});

describe('hadron_server_info membership listing (#1372)', () => {
  it('lists the caller\'s selectable organizations when the active org is unresolved', async () => {
    const info = await server('si-1').callToolText('hadron_server_info');
    expect(info).toContain('active organization: unresolved');
    // URN + display name per line, exactly as the org_not_found refusal lists them.
    expect(info).toContain(`- hrn:org:${orgA.urn} (ao-mcp-a)`);
    expect(info).toContain(`- hrn:org:${orgB.urn} (ao-mcp-b)`);
    // A nonmember organization is absent — the list is the authorized candidate set only.
    expect(info).not.toContain(foreignOrg.urn);
  });

  it('a pure App-key caller gets its credential org, not a user-membership listing', async () => {
    const srv = createTestableMcpServer({ appId: appInA.id, roles: [] } as AuthContext, {
      sessionId: `ao-mcp-${generateId()}`,
      clientKey: 'si-app-key',
    });
    const info = await srv.callToolText('hadron_server_info');
    expect(info).toContain(`active organization: hrn:org:${orgA.urn} (via credential`);
    expect(info).not.toContain('Your memberships:');
  });

  it('an impersonated caller gets no organization line at all', async () => {
    const srv = createTestableMcpServer(
      auth({
        impersonation: {
          sessionId: generateId(),
          actorUserId: generateId(),
          orgId: orgA.id,
          expiresAt: new Date(Date.now() + 60 * 60_000),
        },
      }),
      { sessionId: `ao-mcp-${generateId()}`, clientKey: 'si-imp', ...MULTI_APP },
    );
    const info = await srv.callToolText('hadron_server_info');
    expect(info).not.toContain('active organization:');
    expect(info).not.toContain('Your memberships:');
  });

  it('the zero-membership user-owned line stays clean (no empty listing)', async () => {
    await db.orgMember.updateMany({ where: { userId: user.id }, data: { deletedAt: new Date() } });
    const info = await server('si-2').callToolText('hadron_server_info');
    expect(info).toContain('active organization: none — no memberships');
    expect(info).not.toContain('Your memberships:');
    expect(info).not.toContain('(no organization memberships)');
  });

  it('reading server_info does not select or change anything', async () => {
    // Discovery on the unresolved state writes no selection row…
    await server('si-3').callToolText('hadron_server_info');
    expect(await db.mcpSessionState.count()).toBe(0);
    // …and a read on top of an existing selection leaves it intact.
    const key = 'si-4';
    const srv = server(key);
    await srv.callToolText('hadron_set_active_org', { org: orgA.urn });
    await srv.callToolText('hadron_server_info');
    const row = await db.mcpSessionState.findUniqueOrThrow({
      where: { userId_clientKey: { userId: user.id, clientKey: key } },
    });
    expect(row.organizationId).toBe(orgA.id);
    // A fresh instance still resolves the selection — the read was a read.
    expect(await server(key, {}, orgA.id).callToolText('hadron_server_info')).toContain(
      `active organization: hrn:org:${orgA.urn} (via selection)`,
    );
  });
});
