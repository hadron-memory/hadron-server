import { serverInfoFieldPresence } from '../lib/signing/surface.js';

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
// `AssetsPage` type. A caller-detectable addition: `memoryAssets(memoryRef:)`
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
// 0.22.0: #4140 — BREAKING (GraphQL): six argument renames on four mutations, no aliases. updateMemory(id →
// ref, organizationId → orgRef), updateOrganization(id → ref), createAgent(orgId → orgRef, systemMemoryId →
// systemMemoryRef), updateAgent(systemMemoryId → systemMemoryRef); the system-memory refs retype String → ID
// and accept a URN. A client sending the old names gets "Unknown argument" until it upgrades.
// 0.23.0 — BREAKING, entity refs S6 (#4142, slices B–F): the GraphQL mutation
// args that name entities renamed to `<entity>Ref` and (where the deprecated
// `…Id` alias dropped) became REQUIRED — `createMemory.orgRef`,
// `deleteMemory.ref`, `setMemorySourceToken.ref`, `syncMemory.ref`,
// `pushMemoryToGit.ref`, `linkMemoryToUser.memoryRef`,
// `encryptMemory.memoryRef`, `deleteOrganization.ref`, `linkGithubApp.orgRef`,
// `updateOrgGithubApp.orgRef`, `unlinkGithubApp.orgRef`,
// `createUserInvitation.orgRef`, `startChat.agentRef`,
// `updateAgentAIConfig.agentRef`, `clearAgentAIConfig.agentRef`,
// `createRevision.agentRef`, `publishRevision.agentRef`,
// `restoreRevision.agentRef`, `acquireEditorLock.agentRef`,
// `releaseEditorLock.agentRef`, `joinApp.appRef`, `leaveApp.appRef`, and the
// nine alias-drop mutations (`*MemorySubscription`,
// `ensureAppMember`/`removeAppMember`, `revokeAgentSubscription`,
// `add`/`update`/`removeOrgMember`). TWO breaks, not one:
//  (a) a lagging build's `…Id` argument is now an UNKNOWN argument — GraphQL
//      refuses the whole operation, unlike MCP's silent drop;
//  (b) the nine alias-drop survivors' ref args changed BOTH type and
//      nullability — optional `String` → required `ID!` (`memoryRef`/`orgRef`/
//      `appRef`/`userRef`/`agentRef` on the mutations above). An
//      already-migrated client whose variables declare `$o: String` or
//      `String!` now fails VARIABLE VALIDATION on those nine — retyping the
//      variables to `ID!` is part of the migration, not optional.
//  Naming rule (#4357 P3-B, in the words of cor:api:140:01 and the ref-param-naming
//  convention): `ref` when the field names one entity and it is obvious which,
//  `<entity>Ref` otherwise, so `deleteMemory(ref)` beside `encryptMemory(memoryRef)`
//  is within the rule. For codegen users (P3-D): `userRef: ID!` takes an id, an
//  email, a handle or an hrn:user URN.
// `replaceSubtree.memoryId` is DELIBERATELY unchanged (legacy `String!`): the
// field exists only so legacy callers reach REPLACE_SUBTREE_RETIRED instead
// of an unknown-argument error (#4219 blind P2-A).
// (Chunk A, the memory reads, is 0.32.0, below.)
//
// 0.24.0 — BREAKING (#2027 S11): the attention API is RETIRED. The GraphQL fields
// `teamAttention` / `teamAttentionPage` / `teamAttentionPreviewPage` /
// `teamAttentionSwitchoverPreview` and the `confirmTeamAttentionSwitchover`
// mutation are gone, and with them the `hadron_team_attention*` MCP tools
// (already wire-disabled by #3082). A router still polling must move to the
// wake path (`dueWakes` / the CLI's `hadron team wakes`); the explicit
// `markOwnTeamChatRead` mark and every wake/mark/resume rule it shared a module
// with are unchanged.
//
// 0.25.0 — #4836 (cor:dmo:070:05 Proposed; V58): startSession's `appRef` refusals are
//      concealed and re-typed. A caller without standing for the named App — a non-member,
//      an anonymous caller, a malformed/ambiguous ref, or a pure App key naming any other
//      App — gets ONE answer: APP_NOT_FOUND · "App not found.", byte-identical for a
//      missing, deleted, uninstalled and existing-but-inaccessible App, echoing no ref and
//      carrying no appId. Was: BAD_USER_INPUT · "App not found: <ref>" (missing/deleted,
//      echoing the value), FORBIDDEN (existing, non-member — an existence oracle), the
//      URN parser's echoing typed errors (malformed), and SESSION_APP_MISMATCH (an App key
//      naming another App — that code is GONE from this door). A caller with standing
//      keeps APP_UNINSTALLED by PK, with the appId. `hadron_start_session` (MCP) never
//      took an appRef, so the MCP tool surface is unchanged.
//
// 0.29.0 — #4838 (the other App-ref doors; same rule as 0.25.0): the teamRole write doors
//      (`createTeamRole` / `updateTeamRole` / `deleteTeamRole`) and the `teamRoles` read
//      conceal their `appRef` refusals the same way — reach first, state after. A caller
//      without standing gets the one APP_NOT_FOUND · "App not found." answer for a missing,
//      deleted, uninstalled (by PK) or existing-but-inaccessible App and for a malformed or
//      ambiguous ref, echoing no ref and carrying no appId; a participant keeps
//      APP_UNINSTALLED with the appId, and a member who reaches but may not edit keeps
//      FORBIDDEN. Was: BAD_USER_INPUT · "App not found: <ref>" for a deleted App (echoing;
//      reachable only in the resolve-then-read race), APP_UNINSTALLED with the appId
//      BEFORE any reach decision for an uninstalled App named by PK (an existence and
//      state oracle), FORBIDDEN for an existing App, and the URN parser's echoing typed
//      errors for a malformed ref. `createConnectionGrant`'s grantee refusal keeps its
//      code (BAD_USER_INPUT) and its deliberate existence oracle (a connection owner need
//      not reach the grantee App) but no longer echoes the ref: "Grantee App not found."
//      (was "Grantee App not found: '<ref>'."). The three local appNotFound copies
//      (`agentTask` / `hostOperation` / `hostAssignment`) are untouched.
//
//      Why 0.29.0 and not 0.26.0: 0.26.0–0.28.0 are reserved numbers, taken by the
//      concurrent surface renumbering recorded in team chat #138407 — this entry takes
//      the next FREE number past them (blind review on #4871 asked).
//
// 0.30.0 — BREAKING, entity refs S5 (#4141, partial: `appRuns(parentRunId)` follows): two GraphQL
// arguments renamed, no aliases. `cancelAppRun(id)` -> `cancelAppRun(ref)` and
// `startAgentSession(agentId)` -> `startAgentSession(agentRef)`; each takes an id OR a URN (hrn:apprun /
// hrn:agent). A client still sending the old name gets "Unknown argument" and the whole operation is
// refused until it upgrades; `startAgentSession` is an App-key operation, so external integrators and SDK
// callers are affected, not only the first-party clients. Refusals are unchanged: `cancelAppRun` keeps
// NOT_FOUND "Run not found." and FORBIDDEN for a non-admin, with a ref that cannot name a run now
// BAD_USER_INPUT; `startAgentSession` answers an unknown, deleted or uninstalled Agent with the one existing
// FORBIDDEN, and a relative URN as URN_NOT_QUALIFIED.
//
// 0.31.0 — BREAKING, entity refs S5 (#4141, the third field; completes 0.30.0, which renamed `cancelAppRun` and
// `startAgentSession`): the GraphQL argument `appRuns(parentRunId)` is renamed `appRuns(parentRunRef)`, no alias, and
// takes a run id OR an hrn:apprun URN. A client still sending `parentRunId` gets "Unknown argument" and the whole
// query is refused until it upgrades. The filter keeps its tri-state (omitted = no filter, null = top-level runs,
// a ref = that run's children). A ref naming no run in scope (unknown, outside the org, ambiguous legacy) is the
// exactly empty page, not an error; a ref that cannot name a run is BAD_USER_INPUT. The org READER gate still runs
// first, so a non-member sees the App NOT_FOUND whatever the ref.
//
// 0.32.0 — BREAKING, entity refs S6 chunk A (#4142): the GraphQL memory READS take `<entity>Ref`, no alias.
// `usageEvents` / `usageEventsPage` (`memoryId` → `memoryRef`, `nodeId` → `nodeRef`; both stay optional `ID`),
// `memoryAssets` (`memoryId` → `memoryRef: ID!`) and `memoryLocSegments` (`memoryIds` → `memoryRefs: [ID!]!`).
// A lagging client's old name is an UNKNOWN argument and GraphQL refuses the whole operation. Nothing else
// changes: every field already resolved an ID or URN and keeps its gate and its refusals byte-identical; the
// usage "provide either nodeId or loc" refusal now names `nodeRef`.
//
// 0.33.0 — BREAKING, entity refs S2 (#4138): the node-revision operations take `nodeRevRef`, no alias.
// `nodeRevision(revisionId)`, `restoreNodeRevision(revisionId)`, `updateNodeRevision(revisionId)` and the
// delete-revision mutation (`revisionId` → `nodeRevRef: String!`, a revision URN or id). A lagging client's old name is an UNKNOWN
// argument and GraphQL refuses the whole operation.
//
// 0.34.0 — BREAKING, entity refs (#4368): `setAgentAssetUploadEnabled(input.agentUrn)` → `input.agentRef`, no alias.
// A lagging client's old name is an UNKNOWN input field and GraphQL refuses the whole operation. The gate, the
// refusals and what the field accepts (an id or a URN) are unchanged. `beginAssetUpload` and `agentAssets`, the
// deprecated v1 calls, keep `agentUrn` until they are retired.
//
// 0.35.0 — BREAKING, entity refs S1 (#4137): the six memory share/member mutations take refs and nothing else, no alias.
// `createMemoryShare` / `updateMemoryShareRole` (`memoryId` -> `memoryRef: ID!`, `granteeRef: ID!`), `deleteMemoryShare`
// (`granteeRef: String`, omitted = the caller's own share) and `addMemoryMember` / `updateMemoryMemberRole` /
// `removeMemoryMember` (`memoryRef: ID!`, `userRef: ID!`). The deprecated `granteeId`, `memoryId` and `userId` arguments are
// removed, and the surviving refs are now required `ID!` (were optional `String`). A lagging client's old name is an UNKNOWN
// argument and GraphQL refuses the whole operation. The existence-hiding order is unchanged: memory resolved, principal gate,
// counterparty resolved. (0.34.0 is #5046, #4368, merged first.)
//
// 0.36.0 — BREAKING, entity refs S7 (#4148): the agent-task family takes refs, no alias. The eleven own-task mutations
// (`updateAgentTask`, `assignAgentTask`, `reassignAgentTask`, `startAgentTask`, `recordAgentTaskProgress`,
// `finishAgentTask`, `cancelAgentTask`, `releaseAgentTaskExternalId`, `parkAgentTask`, `cloneAgentTask`,
// `makeAgentTaskReady`) take `taskRef: ID!` (was `taskId`); `agentTask(id)` → `agentTask(ref)`; `agentTasks` /
// `agentTasksPage(parentTaskId)` → `parentTaskRef`; `agentTeamEvents` / `agentTeamEventsPage(taskId)` → `taskRef`. A
// lagging client's old name is an UNKNOWN argument and GraphQL refuses the whole operation (ship order per precedent
// 0274: notices, server, companions). Gates and refusals are unchanged; `agentTasks(externalId)` keeps its name (an
// external-system label).
export const HADRON_SERVER_VERSION = '0.36.0';

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
  const present = serverInfoFieldPresence();
  return {
    baseUrl, version: HADRON_SERVER_VERSION,
    ...(present.signing ? { signing: true as const } : {}),
    ...(present.passkeyRegistration ? { passkeyRegistration: true as const } : {}),
  };
}
