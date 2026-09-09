/**
 * #1141 — the `hadron_chatbot_*` MCP tools are gone, and stay gone.
 *
 * Holger's ruling on #754: the eleven chatbot tools are REMOVED rather than
 * fixed. #407 had found every one of them gated only by `requireAppScope()`
 * with global loc / raw-id lookups — cross-tenant read and write with no memory
 * gate — and removing the surface retires that finding-class with it.
 *
 * This file is the thing that makes it a removal rather than a deletion. A
 * deleted block comes back the moment someone needs "just the start tool"; an
 * asserted absence has to be argued with. So it pins two different properties,
 * because they fail differently:
 *
 *   1. The eleven names are not registered — the literal regression.
 *   2. NO tool is named `hadron_chatbot_*` — which also refuses a twelfth. A
 *      removal you can undo by picking a new name is not a removal.
 *
 * What this does NOT assert, deliberately: that agent chat is unreachable. It
 * is very much reachable — through GraphQL `startChat` / `sendChatMessage` /
 * `processChatResponse`, `chat-scope.ts`, the goal stack and routing on the
 * chat-root node, and the portal, all of which stay. The MCP surface was the
 * part with no memory gate, and the portal was already the chat lifecycle's
 * surface (hadron-cli's README says so). Scope note on #1141: #921 (chat
 * storage decoupled from the engine) is separate and is not this.
 */

import { describe, it, expect } from 'vitest';
import { createTestableMcpServer, type TestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

/** The eleven, named in full so the diff that re-adds one is visibly wrong. */
const REMOVED = [
  'hadron_chatbot_start',
  'hadron_chatbot_send',
  'hadron_chatbot_process',
  'hadron_chatbot_get_routing_map',
  'hadron_chatbot_get_route_history',
  'hadron_chatbot_push_goal',
  'hadron_chatbot_pop_goal',
  'hadron_chatbot_add_training_entry',
  'hadron_chatbot_define_persona',
  'hadron_chatbot_list_personas',
  'hadron_chatbot_run_persona',
] as const;

function srv(): TestableMcpServer {
  // An App-key principal: `requireAppScope()` was the ONLY gate these tools
  // had, so this is exactly the caller for whom they used to work.
  return createTestableMcpServer({
    clientId: 'test-client',
    appId: 'test-app',
    roles: [],
  } as unknown as AuthContext);
}

describe('#1141 — the chatbot MCP tools are not registered', () => {
  it.each(REMOVED)('%s is gone', (name) => {
    // toolDescription throws on an unregistered name — the same signal a
    // renamed tool gives, which is what makes this assertion non-vacuous.
    expect(() => srv().toolDescription(name)).toThrow(/not registered/i);
  });

  it('no tool is named hadron_chatbot_* at all, including one added later', () => {
    expect(srv().toolNames().filter((n) => n.startsWith('hadron_chatbot'))).toEqual([]);
  });

  it('the manifest is otherwise intact — this removed tools, it did not break registration', () => {
    // Guards the failure mode where a bad deletion truncates the registration
    // block and every assertion above passes for the wrong reason: an empty
    // manifest satisfies "no chatbot tools" perfectly.
    // 43 registered for this principal after the removal, 54 before — a
    // difference of exactly the eleven above, checked as a set rather than a
    // count. The floor here is deliberately loose: it exists to catch a
    // TRUNCATED registration block (which would drop dozens), not to pin a
    // number that every new tool would have to come back and edit.
    const names = srv().toolNames();
    expect(names.length).toBeGreaterThan(30);
    for (const kept of ['hadron_find_nodes', 'hadron_get_node', 'hadron_create_node']) {
      expect(names).toContain(kept);
    }
  });
});
