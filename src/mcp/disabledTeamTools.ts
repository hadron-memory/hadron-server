import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * #3082, V7 R1/R3/R4: agent-team tools are CLI/portal only. Preserve the typed wrapper bodies for reversal,
 * but never register them. The distinct off(...) spelling is also visible to both source manifest scrapers.
 * No environment or test-only re-enable. Session binding follows hrn:node:hadronmemory.com:specs:cor:agt:020:03.
 */
export const offTeamTool = (_server: McpServer): McpServer['tool'] => (() => undefined) as unknown as McpServer['tool'];
