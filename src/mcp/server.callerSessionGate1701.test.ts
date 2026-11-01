/**
 * #1701 — the caller-session gate covers the whole tool manifest.
 *
 * The gate is fail-closed: every tool is gated, and so offers `session`, unless
 * it is listed as writing nothing on the caller's behalf. This pins that list
 * from both sides, so adding a tool, or moving one onto the list, is a visible
 * decision in review rather than a silent hole in attribution.
 */
import { describe, expect, it } from 'vitest';
import { createTestableMcpServer } from './server.js';

/** Mirror of ACTOR_NEUTRAL_TOOLS in createMcpServerInstance — keep in step on purpose. */
const ACTOR_NEUTRAL = new Set([
  // Recovery reads select existing data; restore remains an attributed write.
  'hadron_list_recovery_nodes', 'hadron_list_recovery_edges', 'hadron_get_recovery_node',
  'hadron_search', 'hadron_list_memories', 'hadron_server_info', 'hadron_list_apps', 'hadron_list_scopes',
  'hadron_scope_explain', 'hadron_list_channels', 'hadron_register_list', 'hadron_find_nodes', 'hadron_get_node',
  'hadron_get_nodes', 'hadron_get_next_node', 'hadron_list_nodes', 'hadron_get_object', 'hadron_find_objects',
  'hadron_get_run', 'hadron_whoami', 'hadron_channel_read', 'hadron_team_chat_read', 'hadron_team_chat_search', 'hadron_team_attention',
  'hadron_team_attention_page', 'hadron_list_workers', 'hadron_get_worker', 'hadron_team_work_items',
  'hadron_list_comments', 'hadron_get_comment', 'hadron_team_chat_mark_read',
  'hadron_task_get', 'hadron_task_list', 'hadron_team_events', 'hadron_team_availability', 'hadron_team_roster',
  'hadron_set_active_memory', 'hadron_set_active_app', 'hadron_set_active_org', 'hadron_set_active_scope',
  'hadron_unlock_memory', 'hadron_lock_memory',
  'hadron_start_session',
]);

/** Neutral tools that define their own `session` parameter (it is not the gate's). */
const NEUTRAL_WITH_OWN_SESSION = new Set([
  'hadron_channel_read', 'hadron_team_chat_read', 'hadron_list_workers', 'hadron_get_worker',
  'hadron_team_work_items', 'hadron_team_chat_mark_read',
  'hadron_task_get', 'hadron_task_list', 'hadron_team_events', 'hadron_team_availability', 'hadron_team_roster',
]);

const hasParam = (server: ReturnType<typeof createTestableMcpServer>, tool: string, param: string): boolean => {
  try {
    server.toolParamSchema(tool, param);
    return true;
  } catch {
    return false;
  }
};

describe('#1701 caller-session gate: manifest coverage', () => {
  const server = createTestableMcpServer({ userId: 'gate-coverage', roles: [] });

  it('every tool that can write offers a way to name the caller\'s session', () => {
    const missing = server
      .toolNames()
      .filter((t) => !ACTOR_NEUTRAL.has(t))
      .filter((t) => !hasParam(server, t, t === 'hadron_end_session' ? 'id' : 'session'));
    expect(missing).toEqual([]);
  });

  it('the neutral list is exactly what the gate skips: none of them gains a session parameter', () => {
    const injected = [...ACTOR_NEUTRAL]
      .filter((t) => !NEUTRAL_WITH_OWN_SESSION.has(t))
      .filter((t) => hasParam(server, t, 'session'));
    expect(injected).toEqual([]);
  });

  it('the neutral list names registered tools or the exact ruled retired set (#3082)', () => {
    const retired = new Set(["hadron_ack_wakes", "hadron_agent_ticker_template_create", "hadron_agent_ticker_template_delete", "hadron_agent_ticker_template_list", "hadron_agent_ticker_template_update", "hadron_alarm_ack", "hadron_cast_worker", "hadron_change_worker_agent", "hadron_channel_post", "hadron_channel_read", "hadron_clear_worker_isolation", "hadron_create_channel", "hadron_create_resume_claim", "hadron_delete_worker", "hadron_delivery_settings_get", "hadron_delivery_settings_set", "hadron_due_wakes", "hadron_get_worker", "hadron_isolate_worker", "hadron_list_channels", "hadron_list_workers", "hadron_model_family_availability_set", "hadron_record_work", "hadron_register_add", "hadron_register_list", "hadron_register_remove", "hadron_resume_session", "hadron_set_team_pause", "hadron_set_worker_reports_to", "hadron_stall_schedule_get", "hadron_stall_schedule_set", "hadron_stop_signal_lift", "hadron_stop_signal_list", "hadron_stop_signal_set", "hadron_task_assign", "hadron_task_blocker_add", "hadron_task_blocker_remove", "hadron_task_cancel", "hadron_task_create", "hadron_task_finish", "hadron_task_get", "hadron_task_list", "hadron_task_make_ready", "hadron_task_park", "hadron_task_priority_set", "hadron_task_progress", "hadron_task_reassign", "hadron_task_start", "hadron_task_update", "hadron_team_attention", "hadron_team_attention_page", "hadron_team_attention_switchover", "hadron_team_availability", "hadron_team_chat_inbox", "hadron_team_chat_inbox_ack", "hadron_team_chat_mark_read", "hadron_team_chat_post", "hadron_team_chat_read", "hadron_team_chat_search", "hadron_team_events", "hadron_team_roster", "hadron_team_work_items", "hadron_ticker_create", "hadron_ticker_delete", "hadron_ticker_list", "hadron_ticker_subscribe", "hadron_ticker_unsubscribe", "hadron_ticker_update", "hadron_update_worker", "hadron_worker_availability_set", "hadron_worker_wake_settings"]);
    const registered = new Set([...server.toolNames(), ...retired]);
    expect([...ACTOR_NEUTRAL].filter((t) => !registered.has(t))).toEqual([]);
  });

  it('the injected parameter tells the caller when it is required', () => {
    expect(server.toolParamDescription('hadron_create_node', 'session')).toMatch(/SESSION_AMBIGUOUS/);
  });
});
