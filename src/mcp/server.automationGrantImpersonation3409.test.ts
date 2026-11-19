/**
 * #3409: defence-in-depth pins on the six registered MCP automation-grant handlers.
 * MCP initialization rejects impersonation with HTTP 401 (cor:acl:100:02). These
 * deliberately in-process contexts do not claim an impersonating wire session.
 * The manager's otherwise identical ordinary context must still succeed, so
 * deleting impersonation in ctxOf/ctx cannot hide behind another refusal.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import { registerAutomationReadGrantTools } from './automationReadGrantTools.js';
import { registerAutomationTeamSnapshotGrantTools } from './automationTeamSnapshotGrantTools.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let appId: string, orgId: string, managerId: string, adminId: string, memoryId: string;
let newTriggerId: string, readGrantId: string, teamGrantId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Grant pins', urn: 'grant3409.example' } });
  orgId = org.id;
  const manager = await db.user.create({ data: { handle: 'grant-manager', roles: ['READER'] } });
  managerId = manager.id;
  adminId = (await db.user.create({ data: { handle: 'support-admin', roles: ['ADMIN'] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: managerId, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { organizationId: orgId, name: 'Team', urn: 'grant3409.example:team' } })).id;
  memoryId = (await db.memory.create({ data: { name: 'Reports', urn: 'grant3409.example:reports', class: 'knowledge',
    organizationId: orgId, visibility: 'ORGANIZATION' } })).id;
  const schedule = () => db.agentSchedule.create({ data: { id: generateId(), appId, organizationId: orgId,
    name: 'Report', cron: '* * * * *', entryNodeUrn: 'hrn:node:grant3409.example:reports:entry' } });
  const existing = await schedule();
  newTriggerId = (await schedule()).id;
  // Nonempty, live rows make revoke/list observable. Set targets another trigger,
  // so dropping forwarding must create a new row/event, not an idempotent no-op.
  readGrantId = (await db.appAutomationReadGrant.create({ data: { appId, triggerKind: 'SCHEDULE', triggerId: existing.id,
    memoryId, grantedBy: managerId } })).id;
  teamGrantId = (await db.appAutomationTeamSnapshotGrant.create({ data: { appId, triggerKind: 'SCHEDULE', triggerId: existing.id,
    grantedBy: managerId } })).id;
});

const snapshot = async () => ({
  readGrants: await db.appAutomationReadGrant.findMany({ where: { appId }, orderBy: { id: 'asc' } }),
  teamGrants: await db.appAutomationTeamSnapshotGrant.findMany({ where: { appId }, orderBy: { id: 'asc' } }),
  readEvents: await db.appAutomationReadGrantEvent.findMany({ where: { appId }, orderBy: { id: 'asc' } }),
  teamEvents: await db.appAutomationTeamSnapshotGrantEvent.findMany({ where: { appId }, orderBy: { id: 'asc' } }),
  instructionEvents: await db.agentTeamEvent.findMany({ where: { appId }, orderBy: { id: 'asc' } }),
});
const auth = (impersonating: boolean): AuthContext => ({
  userId: managerId, roles: [], organizationId: orgId,
  ...(impersonating ? { impersonation: { sessionId: generateId(), actorUserId: adminId, orgId,
    expiresAt: new Date(Date.now() + 60_000) } } : {}),
});
async function call(name: string, args: Record<string, unknown>, impersonating: boolean) {
  const server = new McpServer({ name: 'grant3409', version: '1' });
  const client = new Client({ name: 'grant3409', version: '1' });
  registerAutomationReadGrantTools(server, { db, auth: auth(impersonating) });
  registerAutomationTeamSnapshotGrantTools(server, { db, auth: auth(impersonating) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    return await client.callTool({ name, arguments: args });
  } finally { await client.close(); await server.close(); }
}

const tools = [
  ['hadron_set_automation_read_grant', 'read', 'set'],
  ['hadron_revoke_automation_read_grant', 'read', 'revoke'],
  ['hadron_list_automation_read_grants', 'read', 'list'],
  ['hadron_set_automation_team_snapshot_grant', 'team', 'set'],
  ['hadron_revoke_automation_team_snapshot_grant', 'team', 'revoke'],
  ['hadron_list_automation_team_snapshot_grants', 'team', 'list'],
] as const;
for (const [tool, kind, action] of tools) {
  const args = () => action === 'revoke' ? { id: kind === 'read' ? readGrantId : teamGrantId }
    : action === 'list' ? { app: appId }
    : { app: appId, triggerKind: 'SCHEDULE', triggerId: newTriggerId, ...(kind === 'read' ? { memory: memoryId } : {}) };

  it(`${tool}: impersonation is [forbidden] Forbidden with no grant/event effects`, async () => {
    const before = await snapshot();
    const result = await call(tool, args(), true);
    // All six source-derived FORBIDDEN doors use this exact MCP rendering.
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: '[forbidden] Forbidden' }] });
    expect(await snapshot()).toEqual(before);
  });

  it(`${tool}: managing-person CONTROL reaches the success branch`, async () => {
    const before = await snapshot();
    const result = await call(tool, args(), false);
    expect(result.isError).not.toBe(true);
    const after = await snapshot();
    const rows = kind === 'read' ? after.readGrants : after.teamGrants;
    const events = kind === 'read' ? after.readEvents : after.teamEvents;
    if (action === 'set') {
      expect(rows).toHaveLength(2);
      expect(rows.find(r => r.triggerId === newTriggerId)).toMatchObject({ grantedBy: managerId, revokedAt: null });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: 'GRANT', actorUserId: managerId, triggerId: newTriggerId });
    } else if (action === 'revoke') {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ revokedBy: managerId, revokedAt: expect.any(Date) });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: 'REVOKE', actorUserId: managerId });
    } else {
      expect(JSON.stringify(result.content)).toContain(kind === 'read' ? readGrantId : teamGrantId);
      expect(after).toEqual(before);
    }
    expect(after.instructionEvents).toEqual(before.instructionEvents);
  });
}
