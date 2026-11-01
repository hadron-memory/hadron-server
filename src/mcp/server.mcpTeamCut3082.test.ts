/** #3082 / V7 R1-R4: the literal ruled cut, not an implementation-derived oracle. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServerInstance, createTestableMcpServer } from './server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { hashLaunchGrant } from '../lib/hostOperations/launch.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { serveEveryAgent } from '../test/servedBootPrompt.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import type { AuthContext } from '../middleware/auth.js';

export const DISABLED = [
  "hadron_ack_wakes",
  "hadron_agent_ticker_template_create",
  "hadron_agent_ticker_template_delete",
  "hadron_agent_ticker_template_list",
  "hadron_agent_ticker_template_update",
  "hadron_alarm_ack",
  "hadron_cast_worker",
  "hadron_change_worker_agent",
  "hadron_channel_post",
  "hadron_channel_read",
  "hadron_clear_worker_isolation",
  "hadron_create_channel",
  "hadron_create_resume_claim",
  "hadron_delete_worker",
  "hadron_delivery_settings_get",
  "hadron_delivery_settings_set",
  "hadron_due_wakes",
  "hadron_get_worker",
  "hadron_isolate_worker",
  "hadron_list_channels",
  "hadron_list_workers",
  "hadron_model_family_availability_set",
  "hadron_record_work",
  "hadron_register_add",
  "hadron_register_list",
  "hadron_register_remove",
  "hadron_resume_session",
  "hadron_set_team_pause",
  "hadron_set_worker_reports_to",
  "hadron_stall_schedule_get",
  "hadron_stall_schedule_set",
  "hadron_stop_signal_lift",
  "hadron_stop_signal_list",
  "hadron_stop_signal_set",
  "hadron_task_assign",
  "hadron_task_blocker_add",
  "hadron_task_blocker_remove",
  "hadron_task_cancel",
  "hadron_task_create",
  "hadron_task_finish",
  "hadron_task_get",
  "hadron_task_list",
  "hadron_task_make_ready",
  "hadron_task_park",
  "hadron_task_priority_set",
  "hadron_task_progress",
  "hadron_task_reassign",
  "hadron_task_start",
  "hadron_task_update",
  "hadron_team_attention",
  "hadron_team_attention_page",
  "hadron_team_attention_switchover",
  "hadron_team_availability",
  "hadron_team_chat_inbox",
  "hadron_team_chat_inbox_ack",
  "hadron_team_chat_mark_read",
  "hadron_team_chat_post",
  "hadron_team_chat_read",
  "hadron_team_chat_search",
  "hadron_team_events",
  "hadron_team_roster",
  "hadron_team_work_items",
  "hadron_ticker_create",
  "hadron_ticker_delete",
  "hadron_ticker_list",
  "hadron_ticker_subscribe",
  "hadron_ticker_unsubscribe",
  "hadron_ticker_update",
  "hadron_update_worker",
  "hadron_worker_availability_set",
  "hadron_worker_wake_settings"
] as const;
const KEPT = [
  "hadron_agent_processes",
  "hadron_agent_set_base",
  "hadron_agent_set_index_refs",
  "hadron_agent_tasks",
  "hadron_create_app_memory",
  "hadron_create_comment",
  "hadron_create_edge",
  "hadron_create_memory",
  "hadron_create_node",
  "hadron_create_object",
  "hadron_create_parent_node",
  "hadron_create_review",
  "hadron_create_scope",
  "hadron_create_task",
  "hadron_delete_comment",
  "hadron_delete_edge",
  "hadron_delete_node",
  "hadron_delete_object",
  "hadron_delete_scope",
  "hadron_edit_comment",
  "hadron_end_session",
  "hadron_find_nodes",
  "hadron_find_objects",
  "hadron_get_comment",
  "hadron_get_next_node",
  "hadron_get_node",
  "hadron_get_nodes",
  "hadron_get_object",
  "hadron_get_recovery_node",
  "hadron_get_run",
  "hadron_list_apps",
  "hadron_list_comments",
  "hadron_list_memories",
  "hadron_list_nodes",
  "hadron_list_recovery_edges",
  "hadron_list_recovery_nodes",
  "hadron_list_scopes",
  "hadron_lock_memory",
  "hadron_move_node",
  "hadron_preview_automation",
  "hadron_re_adopt_automation",
  "hadron_reopen_comment_thread",
  "hadron_replace_text",
  "hadron_reply_to_comment",
  "hadron_resolve_comment_thread",
  "hadron_restore_node",
  "hadron_run_action",
  "hadron_run_task",
  "hadron_scope_explain",
  "hadron_search",
  "hadron_server_info",
  "hadron_set_active_app",
  "hadron_set_active_memory",
  "hadron_set_active_org",
  "hadron_set_active_scope",
  "hadron_set_asset_public_link",
  "hadron_start_session",
  "hadron_sync_graph",
  "hadron_unlock_memory",
  "hadron_update_edge",
  "hadron_update_node",
  "hadron_update_node_data",
  "hadron_update_object",
  "hadron_update_review",
  "hadron_update_scope",
  "hadron_update_task",
  "hadron_validate",
  "hadron_whoami"
] as const;
const principals = {
  user: { userId: 'u', roles: ['ADMIN'] },
  appKey: { appId: 'a', appKeyId: 'k', roles: [] },
  impersonation: { userId: 'u', roles: ['ADMIN'], impersonation: { sessionId: 's', actorUserId: 'admin', orgId: 'o', expiresAt: new Date('2099-01-01') } },
};
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); });
async function clientFor(auth: AuthContext) {
  const server = createMcpServerInstance(auth, () => undefined, { kind: 'multi-app' });
  const client = new Client({ name: 'cut3082', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote); await client.connect(local);
  close.push(async () => { await client.close(); await server.close(); });
  return client;
}

for (const [kind, auth] of Object.entries(principals)) {
  it(`${kind}: advertises every kept tool and none of the frozen 71`, async () => {
    const client = await clientFor(auth as AuthContext);
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([...KEPT]);
    for (const n of DISABLED) expect(names).not.toContain(n);
  });
}
it.each(['hadron_task_list', 'hadron_ticker_list', 'hadron_stop_signal_list', 'hadron_list_workers'])(
  '%s is exactly an unknown tool at the SDK boundary', async name => {
    const client = await clientFor(principals.user as AuthContext);
    const result = async (n: string) => {
      try { return JSON.stringify(await client.callTool({ name: n, arguments: {} })).replaceAll(n, '<name>'); }
      catch (error) { return String(error).replaceAll(n, '<name>'); }
    };
    expect(await result(name)).toEqual(await result('hadron_nonexistent_3082'));
  });
it('kept descriptions and schemas offer no disabled tool', async () => {
  const client = await clientFor(principals.user as AuthContext);
  const { tools } = await client.listTools();
  for (const tool of tools.filter(t => !DISABLED.includes(t.name as typeof DISABLED[number]))) {
    const text = JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema });
    for (const n of DISABLED) expect(text.split(/[^a-z_]+/), `${tool.name} advertises ${n}`).not.toContain(n);
  }
});

describe('worker binding refuses before looking up a worker or grant', () => {
  let auth: AuthContext; let appAuth: AuthContext; let workerId: string;
  beforeEach(async () => {
    await cleanDb(db);
    const org = await db.organization.create({ data: { name: 'Cut', urn: 'cut3082.test' } });
    const user = await db.user.create({ data: { githubId: 3082001, githubUsername: 'cut3082', roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
    const app = await db.app.create({ data: { name: 'Team', urn: 'cut3082.test:team', organizationId: org.id } });
    await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
    const agent = await db.agent.create({ data: { name: 'Role', urn: 'cut3082.test:role', organizationId: org.id } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Fixture', slug: 'fixture', heldByUserId: user.id, heldAt: new Date() } });
    workerId = worker.id;
    await db.session.create({ data: { id: generateId(), appId: app.id, userId: user.id, workerId, agentId: agent.id } });
    const operationId = generateId();
    await db.hostOperation.create({ data: { id: operationId, appId: app.id, hostId: 'fixture', workerId, status: 'collected', collectedAt: new Date(), type: 'worker.start', args: { workerId, worktree: 'fixture', family: 'claude' }, issuedBy: 'user', issuedByUserId: user.id, holdUserId: user.id, holdAt: worker.heldAt } });
    await db.launchGrant.create({ data: { id: generateId(), appId: app.id, operationId, workerId, hostId: 'fixture', holderUserId: user.id, tokenHash: hashLaunchGrant('hlg_' + 'a'.repeat(64)), expiresAt: new Date(Date.now() + 60000) } });
    await db.resumeClaim.create({ data: { id: generateId(), appId: app.id, sessionId: (await db.session.findFirstOrThrow()).id, workerId, holderUserId: user.id, expiresAt: new Date(Date.now() + 60000) } });
    await serveEveryAgent(db);
    auth = { userId: user.id, appId: app.id, roles: ['READER'] };
    appAuth = { appId: app.id, roles: [] };
  });
  const snapshot = async () => ({ sessions: await db.session.findMany({ orderBy: { id: 'asc' } }), workers: await db.worker.findMany(), claims: await db.resumeClaim.findMany(), grants: await db.launchGrant.findMany(), operations: await db.hostOperation.findMany() });
  for (const principal of ['user', 'app', 'impersonation'] as const) {
    it.each(['worker', 'force', 'grant', 'empty grant'])(`${principal} %s has one typed refusal with no writes`, async arm => {
      const a = principal === 'app' ? appAuth : principal === 'impersonation' ? { ...auth, impersonation: principals.impersonation.impersonation } : auth;
      const server = createTestableMcpServer(a);
      const args = arm === 'grant' ? { launchGrant: 'hlg_' + 'a'.repeat(64) } : arm === 'empty grant' ? { launchGrant: '' } : { workerRef: workerId, ...(arm === 'force' ? { force: true } : {}) };
      const before = await snapshot();
      const result = await server.callTool('hadron_start_session', args);
      expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'MCP_WORKER_BINDING_UNSUPPORTED' } } });
      expect(await snapshot()).toEqual(before);
      expect(await server.callTool('hadron_start_session', { workerRef: 'nonexistent' })).toEqual(result);
    });
  }
  it('server info advertises no retired team capabilities', async () => {
    const server = createTestableMcpServer(auth);
    const info = await server.callToolText('hadron_server_info', {});
    for (const token of ['worker-model', 'worker-boot-briefing', 'team-chat', 'team-worklog', 'session-app-recovery', 'channels', 'team-chat-monitor', 'worklog-model', 'team-attention', 'team-attention-paged']) expect(info).not.toMatch(new RegExp(`(?:^|[ ,])${token}(?:[ ,]|$)`, 'm'));
  });
  it('GraphQL still serves each disabled family', async () => {
    const ctx = { ...auth, db } as Context;
    const Q = resolvers.Query as any; const M = resolvers.Mutation as any;
    const appRef = auth.appId;
    expect((await Q.worker({}, { ref: workerId }, ctx)).id).toBe(workerId);
    expect((await Q.registerEntries({}, { appRef }, ctx)).items).toEqual([]);
    expect((await Q.teamChatMessages({}, { appRef }, ctx)).items).toEqual([]);
    expect(await Q.teamAttentionPage({}, { appRef }, ctx)).toBeTruthy();
    expect(await Q.agentTasks({}, { appRef }, ctx)).toBeDefined();
    expect(await Q.teamRoster({}, { appRef }, ctx)).toBeTruthy();
    expect((await Q.teamStopSignals({}, { appRef }, ctx)).signals).toEqual([]);
    expect(await Q.tickers({}, { appRef }, ctx)).toEqual([]);
    const session = await db.session.findFirstOrThrow();
    expect(await M.createResumeClaim({}, { sessionId: session.id }, ctx)).toMatchObject({ sessionId: session.id, workerId });
    expect(await M.resumeSession({}, { input: {} }, ctx)).toMatchObject({ session: { id: session.id } });
  });
  it('resume is unknown and leaves a live resume claim untouched', async () => {
    const client = await clientFor(auth); const before = await snapshot();
    const out = await client.callTool({ name: 'hadron_resume_session', arguments: {} });
    expect(out).toMatchObject({ isError: true });
    expect(JSON.stringify(out)).toMatch(/not found|Unknown/i);
    expect(await snapshot()).toEqual(before);
  });
});
