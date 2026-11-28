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
// 0.36.0 — BREAKING, #1796 step 2: `encryptMemory(memoryRef)` no longer accepts `dataKey` or `passphrase`, no alias.
// A document naming either is refused as an unknown argument before any resolver runs. The secret travels only in
// `x-hadron-memory-keys` (strict owner) or `x-hadron-operation-key` (owning App completion). CLI floor: hadron-cli
// v0.56.0.
//
// 0.37.0 — SEMANTICS BREAK, Billing A1 (#5007): new mutation `adjustCredits(input: AdjustCreditsInput!)` (a signed
// ledger correction, platform admin only). `grantCredits` changes behaviour: a grant without a source pair
// (`sourceType`, `sourceId`) is now refused with BAD_USER_INPUT when the mutation runs, so a lagging client that
// granted without one fails at run time (its document still validates, because the SDL field types are unchanged).
// The server-written source types are refused, and a mismatched replay answers one fixed IDEMPOTENCY_CONFLICT sentence
// instead of naming the stored entry. (0.36.0 is #5066, #1796, merged first.)
//
// 0.38.0 — BREAKING, entity refs S7 (#4148): the agent-task family takes refs, no alias. The eleven own-task mutations
// (`updateAgentTask`, `assignAgentTask`, `reassignAgentTask`, `startAgentTask`, `recordAgentTaskProgress`,
// `finishAgentTask`, `cancelAgentTask`, `releaseAgentTaskExternalId`, `parkAgentTask`, `cloneAgentTask`,
// `makeAgentTaskReady`) take `taskRef: ID!` (was `taskId`); `agentTask(id)` → `agentTask(ref)`; `agentTasks` /
// `agentTasksPage(parentTaskId)` → `parentTaskRef`; `agentTeamEvents` / `agentTeamEventsPage(taskId)` → `taskRef`. A
// lagging client's old name is an UNKNOWN argument and GraphQL refuses the whole operation (ship order per precedent
// 0274: notices, server, companions). Gates and refusals are unchanged; `agentTasks(externalId)` keeps its name (an
// external-system label). (0.36.0 is #5066, #1796, and 0.37.0 is #5064, Billing A1, both merged first.)
//
// 0.39.0 — BREAKING, entity refs S3 (#4139): `nodeExport(id)` → `nodeExport(ref)` (the node's PK or URN), no alias.
// A lagging client's old name is an UNKNOWN argument and GraphQL refuses the whole operation (ship order per precedent
// 0274: notices, server, companions). The export's contents, gating and refusals are unchanged; only the argument that
// names the node changed. (0.38.0 is #4782, entity refs S7, merged first.)
//
// 0.40.0 — SEMANTICS BREAK, Billing A4 (#5011): free credit now expires. `creditBalance` settles the owner's expired
// grants (one `adjustment` entry each, source pair ('grant-expiry', <grant id>)) before it sums, and never answers a
// balance holding credit whose expiry has passed, so a balance drops at an expiry with no write by the client. New
// field `CreditBalance.expiring: [ExpiringCredit!]!` (what is left of each unexpired grant, soonest first) and type
// `ExpiringCredit`. `grantCredits` refuses an `expiresAt` not later than now with BAD_USER_INPUT (it was accepted).
// Additive SDL; a lagging client still validates. (0.39.0 is #4763, #4139 S3, merged first.)
//
// 0.41.0 — REFUSAL WIRE CHANGE, #5168: no refusal quotes or relays the ref the caller typed. Every code is unchanged.
// Messages lose the value (`<CODE>: <ref>` is now `<CODE>: nothing found for the given ref.`; `URN "<v>" is not fully
// qualified. …` is now `The ref is not a fully qualified <type> URN. …`; `No match for <x>Ref "<v>".` and
// `<X> "<v>" not found.` lose the quoted value). Extensions drop the relayed caller value: `offendingValue` (on
// URN_NOT_QUALIFIED, the URN parse BAD_USER_INPUT and AmbiguousLegacyUrnError), `ref` (every entity not-found), and the
// per-door `appRef`, `taskId`, `workerRef`, `nodeRef`, `nodeRevRef`, `channelRef`, `grantRef`, `id` on their not-found
// refusals. `expectedType` and `reason` stay. A client branches on the code, as it should; no first-party client reads a
// dropped key (re-grep on the PR). No SDL change.
//
// 0.42.0 — BREAKING, entity refs gap 3 (#5081): the organization argument on 21 fields is `orgRef`, no alias. The 18 Query
// arguments named `orgId` (findNodes, globalSearch, edges, impersonationSessions, memories, exchangeConnections,
// exchangeConnectionsPage, slackConnections, telegramConnections, mcpServers, homeAssistantInstances, resendSenders, apps,
// agents, scopes, channels, registerEntries, assets) and the 3 named `org` (orgBootPromptSigning,
// orgBootPromptSigningPreview, setOrgBootPromptSigning) are renamed. Scalars and gates are unchanged (impersonationSessions
// keeps `String`); a lagging client's old name is an UNKNOWN argument and GraphQL refuses the whole operation. (0.41.0 is #5168, merged first.)
//
// 0.43.0 — BREAKING, entity refs gap 2 (#5080): 21 input-type fields on 17 input types, plus `createAiServiceConfig(ownerId:)`,
// take refs, no alias (`*Id` -> `*Ref`): `NodeFilter.memoryRefs`, `EdgeFilter.memoryRef` / `sourceRef` / `targetRef`,
// `AppFilter.agentRef`, `AiServiceConfigFilter.ownerRef`, `CreateNodeInput` / `UpdateNodeInput` / `ImportNodeInput` /
// `NodeAuthoringCheckInput` / `BeginAssetUploadV2Input` `.memoryRef`, `UpdateNodeInput.ref`, `NodeEdgeInput.targetRef`,
// `SearchReplaceInNodesInput` `.nodeRefs` / `.memoryRefs`, `SpecSearchReplaceInput.nodeRefs`, `CreateAgentTaskInput` /
// `CloneAgentTaskInput` `.parentTaskRef`, `TickerInput` / `TickerPatch` `.channelRefs`, `BatchThrough.channelRef`, and
// `createAiServiceConfig(ownerRef:)`. A lagging client's old name is an UNKNOWN field or argument and GraphQL refuses the whole
// operation (ship order per precedent 0274: notices, server, companions). Three of them close a gap: ticker channels and
// `BatchThrough` now resolve a URN as well as an id. `NodeInput` (the retired `replaceSubtree` shape) keeps `memoryId` and
// its edges keep `targetId`; `ResumeSessionInput.expectedWorkerId` stays (#5163). MCP tool inputs are unchanged. (0.42.0 is
// #5081, entity refs gap 3, merged first.)
//
// 0.44.0 — NEW REFUSAL, #5184: `updateMemory` with a `urn` (slug) argument on a `personal` or `private` memory that
// belongs to an App answers APP_MEMORY_SLUG_FIXED (extension `memoryClass`) and applies nothing. An organization-owned
// one renamed before; a user-owned one answered BAD_USER_INPUT. `name` still changes. No SDL change. (0.43.0 is #5080, merged first.)
// 0.45.0 — BREAKING (behaviour, no SDL removal), #5183 (A1 of #5182): createMemoryInApp's `name` is optional. For a personal or private memory the server derives
// slug and display name (<app>-<handle>-<class>), the memory is the user's own, one per class per App
// (APP_USER_MEMORY_ALREADY_EXISTS). A client that still sends `name` has it ignored for those classes. Also changed for those
// classes: the memory's tenant moves from the App's organization to the user (organizationId null, URN rooted on their handle),
// and an App key, worker session, run principal or impersonation is refused (authorization denied), before any read of the App.
// 0.46.0 — BREAKING (behaviour, no SDL removal) (#5185, A3 of #5182): attachMemoryToApp LINKS a readable memory
// (any class but system) to an App and no longer binds
// or renames it; `agentRef` is optional and ignored; MEMORY_ALREADY_APP_SCOPED, ORGANIZATION_MISMATCH and AGENT_NOT_INSTALLED
// are no longer answered by it. New: detachMemoryFromApp(memoryRef, appRef): Boolean! and App.attachedMemories. A pure App key and
// a userless run read a linked memory (never write it) while its attacher can read it in their own right. A lagging client that
// relied on the old bind and rename still parses the call but silently gets a link only. (0.45.0 is #5239, merged first.)
// 0.47.0 — ADDITIVE, #5218: `App.viewerAppUserMemoryClasses: [MemoryClass!]!`, the personal/private classes the
// signed-in viewer may still create in the App through `createMemoryInApp`. A lagging client still validates. (0.46.0 is #5258, merged first.)
// 0.48.0 — BREAKING, #5163: `ResumeSessionInput.expectedWorkerId` is renamed `expectedWorkerRef`, no alias (cor:api:140:01),
// and takes a worker reference: the id, as before, or a fully qualified worker URN resolved through `resolveWorkerRef`. A
// lagging client's `expectedWorkerId` is an UNKNOWN input field and GraphQL refuses the whole operation, so the CLI's
// resume (hadron-cli `team.graphql`) ships in the same window. A ref that is neither an id nor a worker URN (a name, a
// relative URN, another type) now refuses URN_NOT_QUALIFIED where it was BAD_USER_INPUT; blank stays BAD_USER_INPUT. A URN
// naming no worker and one naming a worker the caller may not read get one answer (the WORKER_MISMATCH refusal carries
// expectedWorkerId null, or NOTHING_TO_RESUME). The refusal extension `expectedWorkerId` keeps its name (an output id).
// MCP tool inputs are unchanged (hadron_resume_session sends no expected worker). (0.47.0 is #5240, merged first.)
// 0.49.0 — ANSWER CHANGE, #5334 (cor:sec:070:02, Decided, Holger 2026-11-26): `withdrawSecretChangeRequest` on a request that expired while
// open now answers false (nothing was withdrawn); it still ends as expired with its staged value cleared, as before. It answered true.
// A live request still answers true and ends withdrawn; an ended one, and another person's or unknown id, are unchanged. No SDL shape change.
// (0.48.0 is #5314, merged first.)
// 0.50.0 — ADMISSION COST, #5267: `App.viewerAppUserMemoryClasses` (#5218) is priced at 24 per App by GraphQL admission (it was a leaf, 1),
// the statements it issues for a member App with three unlicensed installed Agents (a known under-estimate beyond three, tracked in #5362; see admissionComplexity.ts). A list that selects it for many Apps costs more and can
// now be refused QUERY_TOO_COMPLEX where it was admitted; a single-App selection is unaffected in practice. Answers and the SDL are unchanged.
// (0.48.0 is #5314, merged first; 0.49.0 is #5334, merged first (the order is Peter's, #153292), so 0.50.0 leaves no gap.)
// 0.51.0 — BREAKING (behaviour, no SDL removal) (#5345): the reach of an App's links narrows to the record gate. A user-owned
// memory of a class other than personal/private (`ownerUserId` set) that its owner linked to an App no longer reaches the App's
// pure key or a userless run on ANY surface; the link row stays, inert (`active: false` in App.attachedMemories), until detached.
// What main did differed by class. A knowledge/group memory (for example under a user root) was listed by `hadron_list_memories`
// and its access map, and its NODES were readable through GraphQL `node(ref:)` and returned by `findNodes`, while only
// `memory(ref:)` and the GraphQL `memories` list refused it. Those callers now lose node content reads and search hits, not only
// a listing. An app-class memory (a user-owned App's own, linked into itself included) reached every read on main (the record
// gate's app arm reads the same link judge), so `memory(ref:)` and the `memories` list lose it as well. Both are
// cor:dmo:060:22 (Decided D-2026-11-26: attaching gives no access; the #5258/#5185 interim covers own personal/private only);
// the grant (#5321) is the path to that access. Own personal/private linked by the App's owner and organization-owned links are
// unchanged. (0.50.0 is #5267, merged first.)
// 0.52.0 — ADDITIVE, #5325 (cor:agt:090:01, :02): `StopSignalScope` gains `APP`, a stop signal that covers every live worker of the App,
// one cast after it was set included (worked out at each check, no stored roster) and naming no target; whoever manages the App sets and
// lifts it, a host key never does (STOP_SIGNAL_SCOPE_FORBIDDEN for every shape of the call). The MCP `hadron_stop_signal_set` scope enum
// gains APP. The three older scopes behave as before. A lagging client that still validates against the old enum cannot send APP, and one
// that lists signals may now read a scope it does not know. (0.51.0 is #5345, merged first.)
// 0.53.0 — WIDENING (behaviour, no SDL change) (#5398, cor:api:120:03 App-key line, Decided, Holger 2026-11-27 "Add an own-memory
// read"): every pure App key READS its own App's shared app-class memories (app_id = the App, no per-user marker, no Worker on
// it, the App's own tenant) and lists them, read only. For an organization's App the reads already held through the team-space
// fold, and GraphQL `memories` now lists them too. For a user-owned App every surface is new (memory(ref:), memories, node(ref:),
// findNodes, resolveUrn, hadron_list_memories, the MCP point reads). A user, a session-bound key, an impersonation and a run gain
// nothing; per-user anonymous rows and Worker working memories stay refused. (0.52.0 is #5325, merged first.)
// 0.54.0 — BREAKING (#5394 PR 1, cor:cht:010:02): `startChat` needs an identified App on both scopes: the App credential's App, or the new
// `appRef` argument (SDL addition). A call that identifies neither, or whose `appRef` differs from the credential's App, is refused
// CHAT_APP_NOT_IDENTIFIED before any Agent lookup; the App is never searched for, and SHARED_CHAT_NOT_AVAILABLE_FOR_APP_SESSIONS is
// retired. A previously working signed-in start that names no App is now refused, so a client keys on this version before sending
// `appRef` (hadron-portal#2683, hadron-cli#3310). (0.53.0 is #5416, merged first.)
// 0.55.0 — BREAKING (behaviour, no SDL removal) (#5321, cor:acl:140:02, cor:agt:010:01, cor:dmo:060:22, cor:acl:010:04): an App that acts
// with no person behind it (a pure App key, or a userless run) now reads a memory outside its own App ONLY through a signed `memory.read`
// grant the App holds. Attaching a memory (#5258's `app_memory_links`) no longer gives any read on any surface: the link is the App's scope
// list, and `AppAttachedMemory.active` still shows whether it would count. Upgrade: on deploy every existing attachment stops giving reads,
// with no backfill (only the memory's manager may sign a read grant, cor:acl:140:02); a key or run that read through one gets the
// missing-memory answer until the memory's manager signs a grant. The grant has two forms: (a) the App's own organization, opening its
// ORGANIZATION-visibility unencrypted knowledge memories no App scopes, to userless runs only; (b) named memories, to userless runs and to a
// pure key holding the new App-key scope `grant:read` (ADDITIVE: the closed scope list gains it; a client that validates scopes against the
// old list cannot give it). A person, an impersonation, a session-bound key and a run carrying a user id gain nothing. #5398's own-memory
// read (0.53.0) is neither an attachment nor a grant and is unchanged. (0.53.0 is #5398 and 0.54.0 is #5394, both merged first.)
// 0.56.0 — BREAKING (behaviour) + ADDITIVE, #5027 (cor:acl:030:01, R1-R4, Holger 2026-11-27): a chat lives in a memory the caller
// names. ADDITIVE: `startChat(memoryRef:)` (an id or URN of an app, group, personal or private memory of the Agent's App that the caller
// can read and write as themselves); `Agent.defaultChatHome` (APP_SHARED, PERSONAL or PRIVATE, set through `updateAgent` by whoever
// manages the Agent) decides when memoryRef is omitted; `Chat.homeMemoryClass` and `Chat.homeMemoryUrn` (the `hrn:mem:` form, as
// `Memory.urn`) on every chat read. `Chat.scope` is kept and deprecated, now a label derived from the home's class. BREAKING: a home
// that fails any step, including a caller with no AppMember row in the home's App (a group MemoryMember outside the App), is refused
// with the one `CHAT_HOME_INVALID` and writes nothing; only the person themselves creates a missing personal or private default home
// (an App key, a run or a worker session is refused). A start with neither memoryRef nor a default behaves as before.
// (0.54.0 is #5407 and 0.55.0 is #5411, both merged first.)
// 0.57.0 — BREAKING (output nullability) + ADDITIVE (#5077 F3a-2, cor:dmo:050:12): `AppRun.organizationId` is now `ID` (null for a
// run of an App a person owns) and `AppRun.ownerUserId: ID` is new (exactly one of the two is set). A client that reads
// organizationId as non-null must key on this version. With PERSONAL_APP_RUNS_ENABLED=true the manual door (triggerAppRun,
// runTask(appRef:), importNode(taskRef:)) launches on a person's App for its key or its owner / owner-role member, FORBIDDEN for
// anyone else; the owner and an owner-role member read (appRun, latestAppRun, resolveUrn, hadron_get_run) and cancel that App's
// runs; a platform admin cancels one with its content withheld. MCP `hadron_get_run` and `hadron_run_task` now pass the session's
// impersonation to those gates, as GraphQL always did: an impersonated MCP session is bounded on an organization's run too (its
// one organization, no own-run arm), where MCP used to judge it as the target user. (0.55.0 is #5411 and 0.56.0 is #5391,
// both merged first.)
// 0.58.0 — BREAKING (behaviour; SDL deprecations, no removal) (#5404, cor:acl:140:02, cor:agt:010:01): the two UNSIGNED App grants end.
// (1) Ruling 0083's App write grant (#2484) and #2883's per-automation read grant authorize nothing, and the migration deletes their rows and
// event rows at deploy (no carry, no re-sign): a userless run that wrote or read through one is refused until the memory's owner signs the
// replacement. (2) New grant action `memory.write` (ADDITIVE, through `createGrant` and the signing ceremony): an App's userless runs create
// and edit nodes in the memories it names (`memory`: an id or a list, no wildcard, no organization) under `prefix` (`*`, the whole of
// every named memory, or one loc when `memory` names exactly one); signed by whoever manages every named memory, its targets judged by
// 0083's rule at grant and at every write. (3) The six doors (`setAppMemoryWriteGrant`, `revokeAppMemoryWriteGrant`,
// `appMemoryWriteGrants`, `setAutomationReadGrant`, `revokeAutomationReadGrant`, `automationReadGrants`) and the three MCP
// `hadron_*_automation_read_grant` tools refuse every call with `DOOR_RETIRED` (`extensions.replacement` names `memory.read` or
// `memory.write`); they are deprecated in the SDL and removed once a CLI release carrying hadron-cli#3319 ships.
// `AutomationApproval.readGrants` is always empty (deprecated). (4) A run carrying a user id no longer reads through #2883's grant: a
// user-backed run reads only what its user reads. (0.56.0 is #5391 and 0.57.0 is #5441, both merged first.)
// 0.60.0 — BREAKING (stored values and behaviour, no SDL change) (#5453 PR A, Holger 2026-11-27 and the renames of 2026-11-28, decision record sections 16 and 17; the Proposed lines of cor:dmo:020:04,
// cor:agt:040:05, :06, :12, :18): every node that defines an Agent is node type `system`, and its ROLE names the kind. A compiled boot
// prompt is `system` / `prompt.boot.compiled` (the node type `compiled-boot-prompt` is retired: no row holds it and the database refuses
// it), a source `prompt.boot.source`, an included rule `prompt.boot.rule` (was `boot-prompt-rule`), and a chatbot's conversation, stage
// and prompt-template nodes carry `chatbot.conversation`, `chatbot.stage`, `chatbot.prompt`. One migration retypes the existing rows. A
// client that found a compiled prompt by `nodeType: "compiled-boot-prompt"`, or a rule by the role `boot-prompt-rule`, now finds nothing:
// filter by role (`prompt.boot.compiled`, or the family `prompt.boot`). The retyped nodes are `system`, so an unqualified listing hides
// them; ask for them with #5452's `includeSystemNodes` (0.59.0). A rule is in the boot-prompt family: only whoever manages its Agent or
// App approves it, link lint applies to it, and a direct read shows its platform variables as written. Who may WRITE is unchanged: a
// worker session still writes a rule and is still refused a source (worker sessions writing sources and compiling is PR B). The MCP
// `nodeType` descriptions no longer list `task` or `compiled-boot-prompt`. (0.58.0 is #5404, merged first; 0.59.0 is left for #5452, the opt-in read, built in parallel.)
// 0.61.0 — WIDENING (behaviour; the SDL changes in descriptions only) (#5453 PR B, Ask 5; Holger 2026-11-27, decision record
// hrn:node:hadronmemory.com:hadron-dev-team-shared:decisions:2026-11-27-holger-rulings-to-bo-system-nodes-and-roles, section 4b; this
// reverses cor:agt:040:11 and cor:agt:040:12 in part): a request bound to a WORKER SESSION now writes a boot prompt source
// (`prompt.boot.source`, the bare `boot-prompt`) and a rule (`prompt.boot.rule`) wherever its holder may write the memory, on every door
// (create, update, delete, move, merge, restore, import, clone, replace, Git sync), with no grant. `BOOT_PROMPT_WORKER_SESSION_REFUSED`
// is no longer returned by a WRITE; a session whose holder may not write the memory gets that memory's own refusal, as any caller does.
// The edit grant (`bootprompt.source.edit`) is neither required nor spent; the action stays registered. A worker session also COMPILES
// with no batch grant (`compileAgentBootPrompt`, `compileAppAgentBootPrompt`, `compileWorkerBootPrompt`): a new unapproved revision of a
// compiled node that already exists, in a memory the session may write. As before it never creates the compiled node, sets or moves a
// pointer (`pointerSet` is false) or provisions an organisation grant (`BOOT_PROMPT_GRANT_REQUIRED`, whose text changed), and every other
// refusal is the one `BOOT_PROMPT_COMPILE_NOT_PERMITTED`. Unchanged: only a compile writes a compiled node (`BOOT_PROMPT_COMPILED_WRITE`);
// a worker session approves a source, a rule or a compiled node only under a batch grant (`bootprompt.compile.approve`, where
// `BOOT_PROMPT_WORKER_SESSION_REFUSED` is still the answer); what is served is the last approved revision. A client that treated the
// write refusal as "ask a person to edit" can now let the session edit and compile, and ask the person to approve.
// (0.60.0 is #5453 PR A, which this is stacked on.)
export const HADRON_SERVER_VERSION = '0.61.0';

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
