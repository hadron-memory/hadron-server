/**
 * #3082 — the MCP team cut (hrn:node:hadronmemory.com:hadron-dev-team-shared:plans:mcp-team-cut, S1; Holger's V7
 * rulings R1, R2 and R4). The agent team works through the CLI and the portal; MCP carries agents, not workers
 * ("Agents: yes, Workers: no"). The 71 agent-team tools of the plan's "The tool list" are DISABLED: registered through
 * `offTeamTool` they never reach the SDK, so `tools/list` omits them for every principal and a call answers the
 * SDK's unknown-tool error, exactly like a name that never existed.
 *
 * Shape (D1a, the switch must be visible to the two manifest scrapers): hadron-cli's `scripts/gen-tools-manifest.sh`
 * greps `server.tool(` and hadron-portal's `scripts/refresh-hosted-mcp-tools.mjs` matches `tool(` / `registerTool(` /
 * `addTool(` followed by a quoted name. A disabled tool is written `off('<tool name>', …)`, which neither matches, so both
 * generators skip it with no change of their own. Keep that: never write `server.tool(` or `.tool('hadron_…` for a
 * disabled tool, and keep the quoted name on the line AFTER `off(` so the CLI's one-line-after grep cannot catch it.
 *
 * Code, not configuration (D2): there is no environment variable, no option on `createMcpServerInstance` and no test-only
 * path back (R4). Turning a tool back on is a code change in the file that registers it: change `off(` to `server.tool(`.
 * The handlers, shapes and imports stay, so nothing is deleted and reversal is one word per tool. Deleting the wrapper code
 * is out of scope for S1.
 *
 * What does NOT change: GraphQL (every operation behind these tools still works; the CLI and the portal call it), and
 * a worker session the CLI created may still ATTRIBUTE core MCP calls, through the `X-Hadron-Session` header and the
 * `session` argument (#1081). Binding a worker through MCP is refused by `hadron_start_session`
 * (MCP_WORKER_BINDING_UNSUPPORTED, cor:agt:020:03).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Names passed through `off`, in registration order: lets a test or a future generator read the switch. */
export const DISABLED_TEAM_TOOLS: string[] = [];

/** A `server.tool` stand-in that registers nothing. Same type, so every handler and shape stays type-checked. */
export const offTeamTool = (_server: McpServer): McpServer['tool'] =>
  ((name: string) => {
    if (!DISABLED_TEAM_TOOLS.includes(name)) DISABLED_TEAM_TOOLS.push(name);
  }) as never;

/** The typed refusal code of `hadron_start_session` for a worker binding (V7 R2). A cross-repo contract: CLI and docs name it. */
export const MCP_WORKER_BINDING_UNSUPPORTED = 'MCP_WORKER_BINDING_UNSUPPORTED';
