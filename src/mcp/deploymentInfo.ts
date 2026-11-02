import { signingSurfacePolicy } from '../lib/signing/surface.js';

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
// 0.11.0: the #740-#837 API-surface batch — new queries nextNode (#817),
// renderRunNode (#818) and validateMemory (#819); new MCP tools
// hadron_update_edge / hadron_delete_edge (#835); new AppRun relation and
// spend fields (#831/#832); appRuns sortBy/sortDir + statuses (#833/#836);
// User.googleId/appleId (#837). All caller-detectable additions.
// 0.12.0: #789 — BREAKING. Entity-identifying arguments on the agent/app WRITE
// surface moved onto cor:api:140 (`<entity>Ref`, PK-or-URN via resolve*Ref), a
// hard rename per epic #775's decision (no deprecated aliases):
//   updateAgent/deleteAgent(id -> ref, and now actually accept a URN),
//   addMemoryToAgent/updateAgentMemoryRole/removeMemoryFromAgent(agentId,
//   memoryId -> agentRef, memoryRef), updateApp/deleteApp(id -> ref),
//   regenerateAppKey(id -> appRef), createAppKey(appId -> appRef),
//   createApp(orgId, agentId -> orgRef, agentRef), installAgentIntoApp /
//   uninstallAgentFromApp / addAgentToApp / removeAgentFromApp(appId, agentId
//   -> appRef, agentRef), publishAgentImport / removeAgentImport(parentAgentId,
//   importedAgentId -> parentAgentRef, importedAgentRef).
// 0.13.0: #891 — new query `assets(filter, orgId, limit, offset)`, the uniform
// cross-memory asset list (spec cor:api:120), plus the `AssetFilter` input and
// `AssetsPage` type. A caller-detectable addition: `memoryAssets(memoryId:)`
// remains, but "every asset I can reach" was previously unanswerable.
// 0.14.0: #1009/#1006 — caller-detectable MCP surface additions. New optional
// `session` argument on hadron_list_workers / hadron_cast_worker /
// hadron_team_chat_read (an App-resolution hint, so those tools work after a
// reconnect without a prior hadron_set_active_app), and hadron_server_info's
// response gains `capabilities:` plus a `connection:` line. The capabilities
// line is itself the "how old is this surface?" probe (#1006), so the build
// that introduces it must not share a version with the builds that lack it.
// 0.15.0: #1012 — durable per-client MCP selections. A caller sending the new
// `X-Hadron-Client-Id` header has its active App / active memory restored on the
// next connection instead of losing them to a reconnect; the `client-session-state`
// capability token advertises it. Caller-detectable: the header is new input, and
// the same client now observes different post-reconnect behaviour.
// 0.16.0: #1116 — a BACKWARD cursor on both transcript readers. New optional
// `beforeSeq` on the GraphQL `chatHistory` and `teamChatMessages` queries and
// on the `hadron_team_chat_read` MCP tool, plus the `transcript-backward-cursor`
// capability token. Caller-detectable, and the reason it must be: MCP DROPS
// unknown arguments, so a client sending `beforeSeq` to a build without it does
// not get an error — it gets the OLDEST page instead of the newest, which is a
// silently wrong answer rather than a missing feature.
// 0.17.0: spec 049 Phase 1 (D-2026-09-13-003) — the active ORGANIZATION on
// MCP. New `hadron_set_active_org` tool (persisted per client instance like the
// App and memory selections, re-authorized on restore), an `active organization:`
// line on hadron_server_info showing which rung of the ladder chose it, and the
// `active-org` capability token. Caller-detectable: a client that needs the org
// view on a build without it has no tool to call, and must fall back to naming
// the org per call.
// 0.18.0: spec 049 Phases 2–8 — named search scopes (`hadron_*_scope`,
// `hadron_set_active_scope`), Channels (`hadron_list_channels`,
// `hadron_create_channel`), the chat register (`hadron_register_*`), the
// register block on the briefing / hadron_whoami, and CHANNEL-ADDRESSED chat:
// `hadron_channel_post` / `hadron_channel_read` plus the `channel` selector on
// hadron_team_chat_post / hadron_team_chat_read. The selector is the reason this
// is a capability: MCP drops unknown arguments, so a client sending `channel` to
// an older build silently posts into — or reads — the DEFAULT team chat instead
// (Copilot on PR #1169). Token: `channels`.
// 0.19.0: #1265 — register + ChannelReadState-backed unattended team-chat
// monitoring on hadron_team_chat_read (`monitor`, server-bound checkpoints,
// deliberate acknowledgement). Token: `team-chat-monitor`.
// 0.20.0: #1353 — internal-pilot compact team attention, explicit own-worker
// mark-read, and preview/proof/confirm switchover. Its capability token is
// caller/App-gated by hadron_server_info rather than added to the static list.
// 0.21.0 — `worklog-model` (#1398): the `model` argument on
// `hadron_record_work` and `TeamWorkItem.model`. MCP drops unknown arguments,
// so a lagging build silently records the session fallback — a healthy-looking
// receipt with the wrong attribution. Clients gate on the `worklog-model`
// capability token rather than the version.
export const HADRON_SERVER_VERSION = '0.21.0';

/**
 * #1006 — the MCP surface's CAPABILITY tokens: what this build can actually do,
 * stated rather than inferred.
 *
 * The motivating failure was silent. A deployment lagging behind `main` served
 * a `hadron_start_session` schema with no `workerRef`, and MCP drops unknown
 * arguments — so a client following current instructions called it, got a
 * healthy-looking session back, and was never told the worker binding had not
 * happened. Every such session is unattributable, which quietly breaks the
 * `cor:agt:020:03` provenance chain (PR → worklog → session → transcript →
 * human) that the Worker model exists to hold up. A version string alone was
 * not enough: the reporter had to diff the served tool LIST against `main` to
 * work out what was wrong.
 *
 * So capabilities are named per FEATURE, not per release, and a client is meant
 * to test for the token rather than compare versions:
 *
 *   - absence of the whole `capabilities` line ⇒ a build predating this field,
 *     which is itself the "too old, don't trust the surface" signal;
 *   - absence of one token ⇒ that feature is not on this build, so fall back
 *     (e.g. no `worker-model` ⇒ bind with the CLI instead of opening an
 *     unattributed session).
 *
 * Tokens are ADDITIVE and permanent once shipped. Removing one is a breaking
 * change to the same clients that learned to depend on it, so a feature that
 * goes away keeps its token only if the surface still honours it.
 */
/**
 * #3082 (MCP team cut S1, V7 R1/R2): the TEAM capability tokens (`worker-model`, `worker-boot-briefing`, `team-chat`,
 * `team-worklog`, `session-app-recovery`, `transcript-backward-cursor`, `channels`, `team-chat-monitor`,
 * `worklog-model`, and the dynamic `team-attention` / `team-attention-paged`) are no longer advertised: the tools
 * they described are disabled on MCP, so a client that tests for one learns correctly that the surface is not there.
 * The "additive and permanent" rule above is about a feature the surface still honours; this feature was removed on
 * purpose, and the absence of `worker-model` already means "bind with the CLI". The deliberate removal is the one
 * exception, recorded here.
 */
export const MCP_SURFACE_CAPABILITIES = [
  /** Spec 026 — hadron_list_apps / hadron_set_active_app selection regimes. */
  'app-selection',
  /** #1009 — refusals caused by a reconnect say so instead of reading as a client limit. */
  'reconnect-notice',
  /**
   * #1012 — a client sending `X-Hadron-Client-Id` gets its active App and
   * active memory restored after a reconnect. Absent ⇒ selections are
   * per-connection only, and the header is ignored.
   */
  'client-session-state',
  /**
   * Spec 049 Phase 1 — `hadron_set_active_org` and the active-organization
   * ladder (D-2026-09-13-003). Absent ⇒ the org view is portal-only on this
   * build; name the org per call instead.
   */
  'active-org',
] as const;

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
  /** On-only rollout disclosure; missing never means a grant to sign. */
  signing?: true;
  passkeyRegistration?: true;
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
  const policy = signingSurfacePolicy();
  return {
    baseUrl, version: HADRON_SERVER_VERSION,
    ...(policy.signing ? { signing: true as const } : {}),
    ...(policy.registration ? { passkeyRegistration: true as const } : {}),
  };
}
