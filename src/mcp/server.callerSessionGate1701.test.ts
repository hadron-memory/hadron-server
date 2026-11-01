/**
 * #1701 — the caller-session gate covers the whole tool manifest.
 *
 * The gate is fail-closed: every tool is gated, and so offers `session`, unless
 * it is listed as writing nothing on the caller's behalf. This pins that list
 * from both sides, so adding a tool, or moving one onto the list, is a visible
 * decision in review rather than a silent hole in attribution.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestableMcpServer } from './server.js';

/** Mirror of ACTOR_NEUTRAL_TOOLS in createMcpServerInstance — keep in step on purpose. */
const ACTOR_NEUTRAL = new Set([
  'hadron_search', 'hadron_list_memories', 'hadron_server_info',
  'hadron_list_apps', 'hadron_list_scopes', 'hadron_scope_explain',
  'hadron_find_nodes', 'hadron_get_node', 'hadron_get_nodes',
  'hadron_get_next_node', 'hadron_list_nodes', 'hadron_get_object',
  'hadron_find_objects', 'hadron_get_run', 'hadron_whoami',
  'hadron_list_comments', 'hadron_get_comment', 'hadron_list_recovery_nodes',
  'hadron_list_recovery_edges', 'hadron_get_recovery_node', 'hadron_set_active_memory',
  'hadron_set_active_app', 'hadron_set_active_org', 'hadron_set_active_scope',
  'hadron_unlock_memory', 'hadron_lock_memory', 'hadron_start_session',
]);

/** Neutral tools that define their own `session` parameter (it is not the gate's). */
const NEUTRAL_WITH_OWN_SESSION = new Set<string>(); // All former own-session reads are retired.

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

  it('the neutral list names only registered tools', () => {
    const registered = new Set(server.toolNames());
    expect([...ACTOR_NEUTRAL].filter(t => !registered.has(t))).toEqual([]);
  });

  it('the actual production neutral policy matches the retained manifest mirror', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    const marker = 'const ACTOR_NEUTRAL_TOOLS = new Set([';
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(']);', start);
    expect(end).toBeGreaterThan(start);
    const actual = [...source.slice(start + marker.length, end).matchAll(/['"](hadron_[a-z_]+)['"]/g)].map(m => m[1]);
    expect(actual.sort()).toEqual([...ACTOR_NEUTRAL].sort());
  });

  it('the injected parameter tells the caller when it is required', () => {
    expect(server.toolParamDescription('hadron_create_node', 'session')).toMatch(/SESSION_AMBIGUOUS/);
  });
});
