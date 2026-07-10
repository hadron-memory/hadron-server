/**
 * Server-identity / deployment-info surface — answers "which hadron-server
 * am I talking to?".
 *
 * Extracted into its own dependency-free module so both the MCP server
 * (src/mcp/server.ts) and the GraphQL resolvers (which mcp/server.ts itself
 * imports) can read it without a circular import. Both import these symbols
 * directly from here — this module is the single source of truth.
 */

/**
 * Hadron MCP server version — single source of truth for the MCP-
 * protocol-level server identity. Used both as the `version` field in
 * the McpServer constructor (the MCP initialize response's server
 * identity) and in the deployment-info diagnostics surface
 * (hadron_server_info / hadron_set_active_memory success message); also
 * surfaced over GraphQL via Query.serverInfo.
 *
 * Bump when the MCP/API surface changes in a way callers should be
 * able to detect: new tool/query added, tool removed or renamed, response-
 * shape break, semantics change that would surprise a previously-
 * working caller.
 *
 * Intentionally NOT tied to `package.json`'s version — that tracks the
 * repo's release identity (deploy / npm-publish cadence), and the two
 * may legitimately diverge. The MCP-protocol-level identity is its
 * own contract: callers care about "what tools and shapes does this
 * server expose?", not "what release of the hadron-server repo am I
 * talking to?"
 */
// 0.8.0: headless multi-node runs surface complete — AppRun.data/hops/spawn
// on GraphQL, appRuns(parentRunId:), AppRunTriggerKind.SPAWN, run tools
// (hadron_spawn / hadron_child_runs / node tools).
// 0.9.0: #542 — GraphQL surface unified on the <object>Ref convention
// (runTask nodeRef; updateNodeData/createEdge/deleteNode/moveNode/node ref args).
// 0.10.0: #598 — read surface finished on the <object>Ref convention
// (agentAIConfig/memoryNodes/memoryEdges/memoryUsageSummary/agentSubscriptions/
// appNodes/appAIConfig/appKeys/myChats/resolveAIConfig/resolveAiServiceConfigs
// <entity>Id args renamed to <entity>Ref — a caller-visible rename).
export const HADRON_SERVER_VERSION = '0.10.0';

/**
 * Diagnostics surface — answers "which hadron-server am I talking to?"
 * from the agent side. Agents can call hadron_server_info (this exact object,
 * formatted) to see the bound deployment URL + version;
 * hadron_set_active_memory's success message also includes it inline.
 *
 * Motivated by #187 / #190 (dual-MCP-namespace divergence): when
 * `mcp__hadron__*` and `mcp__claude_ai_Hadron__*` are bound to different
 * hadron-server instances backed by different databases, agents had no
 * server-side way to notice they'd reached the wrong one. Exposing the
 * BASE_URL lets a transcript reader (or the agent itself, on the next
 * call) see the mismatch directly.
 *
 * Intentionally does NOT expose the DATABASE_URL — the connection
 * string may carry credentials. If a future need arises to disambiguate
 * two deployments that share a BASE_URL but point at different DBs, add
 * a separate `dbName` field that parses the path segment only.
 */
export interface DeploymentInfo {
  baseUrl: string;
  version: string;
}

export function getDeploymentInfo(): DeploymentInfo {
  // Treat empty string and `"/"` as effectively-unset, matching the
  // pattern in src/auth/oauth.ts which special-cases `BASE_URL === '/'`
  // (a known sentinel left by Vitest's globalSetup when no explicit
  // value is configured). Without this guard a single empty/`"/"`
  // value silently propagates into `server: ` lines and hadron_server_info
  // output — exactly the wrong-server-but-no-way-to-tell symptom this
  // surface exists to fix. Gemini review caught this on PR-191.
  const raw = process.env.BASE_URL;
  // PORT uses `||` (not `??`) so an empty-string PORT — e.g. shell `PORT= node ...`
  // or `vi.stubEnv('PORT', '')` — falls back to 4000. Symmetric with the
  // empty-string handling on BASE_URL above; `??` would only catch null/undefined
  // and let `""` slip through, producing `http://localhost:`. PR-194 review.
  const baseUrl =
    raw && raw !== '/'
      ? raw
      : `http://localhost:${process.env.PORT || 4000}`;
  return { baseUrl, version: HADRON_SERVER_VERSION };
}
