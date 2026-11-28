/**
 * #5412 section 5, condition 5 of the gate ruling (issuecomment-7238581276): a table-driven fail-closed pin over every read door
 * other than the three node surfaces a branch admits (point read, listing, search).
 *
 * Three parts:
 *   1. EVERY GraphQL Query field and EVERY MCP tool is classified, enumerated from the built schema and the live tool registry, so a
 *      door added later fails here until someone decides it. ADMITTED doors honour a branch; every other door is CLOSED: it never
 *      consults the branch map, and a branch-only memory is not in any per-memory reach set (condition 1 of issuecomment-7238580841),
 *      so it answers as for an unreadable memory.
 *   2. Only the admitted surfaces (and the Node field guard, which only EMPTIES fields) call the branch helpers, by file and count.
 *      A new caller fails here until it is classified: it is the only way a closed door could start honouring a branch.
 *   3. Runtime: the named closed doors (the memory record, edges, revisions, comments, export, assets, graph view, loc segments,
 *      batch read, URN resolution, global search; MCP memory list, search, comments, next node, recovery) give a branch-only caller
 *      nothing of the memory, while the same door gives a whole-memory grantee the data, so each probe is a real door.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { buildSchema } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import type { AuthContext } from '../../middleware/auth.js';
import { upsertPlatformActions } from './actions.js';
import { DB_NOW, raw, insertGrantUnguarded, type World } from './grantFixtures3668.js';
import { createMcpServerInstance, createTestableMcpServer } from '../../mcp/server.js';
import { emitNodeUrnV2 } from '../urnEmit.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

// ── 1. Classification ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The doors that honour a branch (gate ruling, section 5). Everything else is CLOSED. */
const ADMITTED_QUERY = ['findNodes', 'node'];
const ADMITTED_TOOLS = ['hadron_find_nodes', 'hadron_get_node', 'hadron_get_nodes', 'hadron_list_nodes'];

/**
 * Every other Query field: CLOSED. None consults the branch map (part 2), and a branch-only memory is in no per-memory reach set,
 * so each answers as for an unreadable memory (or, for a field that reads no memory, is unaffected). Adding a name here is the
 * decision that a new field stays closed; honouring a branch on it means moving it to ADMITTED_QUERY with pins of its own.
 */
const CLOSED_QUERY = `
  accountUsageAccounts accountUsageProjection action actionRegisterIndex actionTickets agent agentAIConfig agentAssets
  agentInstructions agentModelGroups agentProcessList agentRevisions agentSchedules agentServedBootPrompt agentSubscriptions
  agentSubscriptionsPage agentTask agentTaskExternalIdChanges agentTaskList agentTaskStallSchedule agentTaskTree agentTasks
  agentTasksPage agentTeamEvents agentTeamEventsPage agentTeamHost agentTeamHosts agentTickerTemplates agentWebhooks agents
  aiModelPrice aiModelPrices aiProviderEndpoints aiServiceConfig aiServiceConfigs aiSpend app appAIConfig appDeliverySettings
  appGrants appKeyScopeCatalogue appKeys appKeysPage appMemoryScope appMemoryWriteGrants appNodes appNodesPage appRoleLists appRun
  appRuns appTickerSettings apps assetDownloadUrl assets attachableMemories attendeeRegister authContext authenticationStatus
  automationApproval automationApprovals automationReadGrants automationTeamSnapshotGrant automationTeamSnapshotGrants calendarEvent
  calendarEvents calendarSchedule calendars castWorkerPreview channel channelMessageSearch channelMessages channelReadState channels
  chatAiConfigChoices chatEffectiveToolChoice chatHistory chatServedPrompts chatToolChoiceFor comment commentThreads
  compiledPromptProvenance connectionFlow connectionGrant connectionGrants contextReset creditBalance creditLedgerEntries
  dashboardWidgetData dashboardWidgetPresets dashboardWidgetPresetsPage dashboardWidgets dashboardWidgetsPage deleteWorkerPreview
  deliveryBatches driveFile driveFileExport driveFiles dueWakes edge edges effectiveAccess effectiveActionPolicy effectiveModelGroups
  exchangeConnections exchangeConnectionsPage exchangeFolders exchangeMessages externalTasksReport findObjects globalSearch grant
  grantActions grantSigningRequest grantSigningSelection grants heldWorkers homeAssistantInstance homeAssistantInstanceOps
  homeAssistantInstances hostDesiredState hostOperations hostRegistrations hostRegistrationsPage hostSetup hostSweepRuns
  impersonationSession impersonationSessions installMemory invitation latestAppRun marketplaceAgents marketplaceMemories
  marketplaceOrganizations mcpServer mcpServerTools mcpServers me memories memory memoryAssets memoryConfig memoryConfigTemplate
  memoryConfigTemplates memoryEdges memoryLocSegments memoryNodes memoryUsageSummary myAgentSubscriptions myAgentSubscriptionsPage
  myApp myChats myChatsPage myGrants myPasskeys mySecretReadClients myUserApiKeys myUserApiKeysPage nextNode nodeAuthoringCheck
  nodeBatch nodeEdgeRemovals nodeExport nodeRevision nodeRevisions nodeRevisionsPage nodeUsage object orgBootPromptSigning
  orgBootPromptSigningPreview organization organizations ownerLimits previewAgentSchedule previewAutomation principalGrant
  principalGrants publicAgents publicOrganization pullRequestReadiness question questionLog questionLogs questions quotaCounters
  rateLimitPolicies recoveryEdges recoveryNode recoveryNodes registerEntries registerEntry registerRoleCandidates registerRolePick
  renderRunNode resendSender resendSenders resolveAIConfig resolveAiServiceConfigs resolveUrn reviewQualityReport
  saturationAlarmWakeRoles scope scopeExplain scopes secret secretChangeRequest secretEvents secrets selectedSkillFilePlan serverInfo
  session sessions sessionsPage signingRequest skillPlan slackConnection slackConnections specBacklinks specBacklinksPage
  specDocument specUnresolvedReferences specUnresolvedReferencesPage teamAvailability teamChatMessages teamChatSearch
  teamComposition teamHealth teamMetrics teamRoles teamRoster teamSpecSchema teamStopSignals teamUtilization teamWorkItems
  telegramConnection telegramConnections ticker tickers tickersPage usageActivity usageEvents usageEventsPage user users
  validateMemory verifyMemoryNodes verifyNode verifyQuestion webPolls webPollsPage worker workerWakeSettings workers
`.split(/\s+/).filter(Boolean);

/** Every other MCP tool: CLOSED, for the same reason (the MCP principal access never holds a branch-only memory). */
const CLOSED_TOOLS = `
  hadron_agent_boot_prompt hadron_agent_processes hadron_agent_set_base hadron_agent_set_index_refs hadron_agent_tasks
  hadron_amend_question hadron_answer_question hadron_ask_question hadron_create_app_memory hadron_create_comment hadron_create_edge
  hadron_create_memory hadron_create_node hadron_create_object hadron_create_parent_node hadron_create_review hadron_create_scope
  hadron_create_task hadron_delete_comment hadron_delete_edge hadron_delete_node hadron_delete_object hadron_delete_scope
  hadron_edit_comment hadron_end_session hadron_find_objects hadron_get_automation_team_snapshot_grant hadron_get_comment
  hadron_get_instructions hadron_get_next_node hadron_get_object hadron_get_question hadron_get_recovery_node hadron_get_run
  hadron_get_secret hadron_list_apps hadron_list_automation_read_grants hadron_list_automation_team_snapshot_grants
  hadron_list_comments hadron_list_memories hadron_list_question_logs hadron_list_questions hadron_list_recovery_edges
  hadron_list_recovery_nodes hadron_list_scopes hadron_list_secrets hadron_lock_memory hadron_move_node hadron_preview_automation
  hadron_re_adopt_automation hadron_record_content_validation hadron_reopen_comment_thread hadron_replace_text
  hadron_reply_to_comment hadron_resolve_comment_thread hadron_restore_node hadron_retire_spec hadron_retract_question_answer
  hadron_revoke_automation_read_grant hadron_revoke_automation_team_snapshot_grant hadron_run_action hadron_run_task
  hadron_scope_explain hadron_search hadron_server_info hadron_set_active_app hadron_set_active_memory hadron_set_active_org
  hadron_set_active_scope hadron_set_asset_public_link hadron_set_automation_read_grant hadron_set_automation_team_snapshot_grant
  hadron_start_session hadron_sync_graph hadron_unlock_memory hadron_update_edge hadron_update_node hadron_update_node_data
  hadron_update_object hadron_update_review hadron_update_scope hadron_update_task hadron_validate hadron_web_poll_cancel
  hadron_web_poll_list hadron_whoami hadron_withdraw_question hadron_withdraw_signing_request hadron_request_signature
  hadron_get_signing_request
`.split(/\s+/).filter(Boolean);

/** Tools registered only in some deployments (feature-gated); classified, but absent from the default registry. */
const OPTIONAL_TOOLS = new Set(['hadron_request_signature', 'hadron_get_signing_request', 'hadron_withdraw_signing_request']);
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

describe('#5412 condition 5, part 1: every Query field and MCP tool is classified', () => {
  it('Query fields: the built schema is exactly ADMITTED_QUERY plus CLOSED_QUERY', () => {
    const fields = Object.keys(buildSchema(typeDefs.replace('#graphql', '')).getQueryType()!.getFields());
    expect(sorted(fields)).toEqual(sorted([...ADMITTED_QUERY, ...CLOSED_QUERY]));
    expect(ADMITTED_QUERY.filter((f) => CLOSED_QUERY.includes(f))).toEqual([]);
  });

  it('MCP tools: the registry is exactly ADMITTED_TOOLS plus CLOSED_TOOLS', () => {
    const server = createMcpServerInstance({ userId: 'u-guard' } as never, () => undefined, { kind: 'multi-app' });
    const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(tools.length).toBeGreaterThan(50);
    const classified = [...ADMITTED_TOOLS, ...CLOSED_TOOLS].filter((t) => !OPTIONAL_TOOLS.has(t) || tools.includes(t));
    expect(sorted(tools)).toEqual(sorted(classified));
    expect(ADMITTED_TOOLS.filter((t) => CLOSED_TOOLS.includes(t))).toEqual([]);
  });
});

// ── 2. Callers of the branch helpers ─────────────────────────────────────────────────────────────────────────────────────

const HELPER_CALL = /\b(nodeBranchScopes|isBranchOnlyMemory|mcpNodeBranchScopes|mcpBranchPrefixesFor|grantReadReachDetailFor|appReadGrantReachDetail|branchNodeWhereArms|branchRestrictionWhere|branchAwareScopeWhere|branchSqlRows|branchSqlClause|branchAdmitsLoc)\s*\(/g;
/** File → calls (definitions excluded by place: the defining modules are listed with their own internal uses). */
const HELPER_CALLERS: Record<string, { n: number; because: string }> = {
  'src/lib/grants/readGrant.ts': { n: 6, because: 'defines the detail judge; grantReadReachFor (every per-memory gate) reads `.whole` only' },
  'src/lib/grants/branchRead.ts': { n: 7, because: 'defines the shared arm (JS, Prisma, SQL)' },
  'src/lib/retrieval/postgres.ts': { n: 1, because: 'every retrieval leg carries NodeSqlFilter.branches (search, browse, totals, vector)' },
  'src/api/graphql/schema/resolvers.helpers.ts': { n: 4, because: 'defines nodeBranchScopes / isBranchOnlyMemory' },
  'src/api/graphql/schema/resolvers.query.node.ts': { n: 8, because: 'ADMITTED: node(ref) and findNodes' },
  'src/api/graphql/schema/branchNodeFields.ts': { n: 1, because: 'NARROWS only: empties the derived Node fields of a branch-only node' },
  'src/mcp/branchRead.ts': { n: 4, because: 'defines the MCP branch map' },
  'src/mcp/server.ts': { n: 14, because: 'ADMITTED: hadron_get_node, hadron_get_nodes, hadron_list_nodes, hadron_find_nodes' },
};
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? (f === 'generated' ? [] : walk(p)) : [p];
});
const withoutComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('#5412 condition 5, part 2: only the admitted surfaces call the branch helpers', () => {
  it('callers by file and count', () => {
    const found: Record<string, number> = {};
    for (const p of walk('src')) {
      if (!p.endsWith('.ts') || p.endsWith('.test.ts') || p.startsWith('src/test/')) continue;
      const n = (withoutComments(readFileSync(p, 'utf8')).match(HELPER_CALL) ?? []).length;
      if (n) found[p] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(HELPER_CALLERS).map(([p, v]) => [p, v.n])));
  });
});

// ── 3. Runtime probes ────────────────────────────────────────────────────────────────────────────────────────────────────

const server = new ApolloServer<Context>({ typeDefs, resolvers });
let alice: string;
let app: { id: string; urn: string };
let keyId: string;

const keyAuth = (): AuthContext => ({ appId: app.id, appKeyId: keyId, roles: [], clientId: `app:${app.id}` } as AuthContext);
async function gql(query: string, variables: Record<string, unknown>) {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, ...keyAuth() } as unknown as Context });
  if (res.body.kind !== 'single') throw new Error('incremental');
  return res.body.singleResult as { data?: Record<string, any> | null; errors?: unknown[] };
}
const call = (tool: string, args: Record<string, unknown>) => createTestableMcpServer(keyAuth()).callToolText(tool, args);

async function grantMemory(values: (memoryId: string) => Record<string, unknown>) {
  const own = await db.organization.create({ data: { id: generateId(), name: `alice-${generateId().slice(-8)}`, urn: `alice-${generateId().slice(-8)}` } });
  await db.orgMember.create({ data: { organizationId: own.id, userId: alice, role: 'OWNER' } });
  const m = await db.memory.create({
    data: { id: generateId(), name: `m-${generateId().slice(-6)}`, urn: `${own.urn}:kb`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: own.id } as never,
  });
  const mk = (loc: string) => db.node.create({ data: { id: generateId(), memoryId: m.id, loc, name: `n-${loc}`, content: `zebrafish ${loc}` } as never });
  const inside = await mk('docs:api');
  const child = await mk('docs:api:v1');
  const outside = await mk('other');
  const edge = await db.edge.create({ data: { id: generateId(), memoryId: m.id, sourceId: inside.id, targetId: outside.id, name: 'relates_to', loc: 'e1' } as never });
  await insertGrantUnguarded({ appId: app.id, userId: alice } as World, {
    user_id: null, grantee_app_id: app.id, issuer_user_id: alice, action: 'memory.read', action_values: values(m.id),
    activated_at: raw(DB_NOW), verification_kind: 'PASSKEY', verified_by: alice,
  } as never);
  return { m, inside, child, outside, edge, nodeUrn: emitNodeUrnV2(m.urn, inside.loc), memUrn: `hrn:mem:${m.urn}` };
}
type W = Awaited<ReturnType<typeof grantMemory>>;

/** What a door gives away about the memory: its id or URN, any of its node or edge ids, or its content marker. */
const revealsAny = (text: string, w: W) => [w.m.id, w.m.urn, w.inside.id, w.child.id, w.outside.id, w.edge.id, 'zebrafish'].some((s) => text.includes(s));
const answered = (text: string) => !text.includes('"errors"');

/**
 * A closed door. `echoes`: what it repeats from its own arguments (masked before the leak check). `reveals`: what giving the memory
 * away looks like on this door (default {@link revealsAny}); it must be false for the branch-only caller and, as the control that
 * proves the probe reaches a real door, true for a whole-memory grantee, unless `noControl` says why that door gives a pure App
 * key nothing on any memory.
 */
type Probe = {
  name: string;
  run: (w: W) => Promise<unknown>;
  echoes?: (w: W) => string[];
  reveals?: (text: string, w: W) => boolean;
  noControl?: string;
};
const GQL_PROBES: Probe[] = [
  { name: 'memory(ref): the memory record', run: (w) => gql('query($m: ID!) { memory(ref: $m) { id name } }', { m: w.m.id }), reveals: (t) => !t.includes('"memory":null') },
  { name: 'memories: the memory list', run: () => gql('query { memories(limit: 200) { total items { id } } }', {}) },
  { name: 'edges(memoryRef)', run: (w) => gql('query($m: ID) { edges(filter: { memoryRef: $m }) { total items { id } } }', { m: w.m.id }), echoes: (w) => [w.m.id] },
  { name: 'edge(ref)', run: (w) => gql('query($e: ID!) { edge(ref: $e) { id } }', { e: w.edge.id }), echoes: (w) => [w.edge.id], reveals: (t) => !t.includes('"edge":null') },
  { name: 'nodeRevisions (a node inside the branch)', run: (w) => gql('query($n: ID!) { nodeRevisions(nodeRef: $n) { revNo } }', { n: w.inside.id }), echoes: (w) => [w.inside.id], reveals: answered, noControl: 'a pure App key reads no revisions (FORBIDDEN on any memory)' },
  { name: 'commentThreads (a node inside the branch)', run: (w) => gql('query($n: ID!) { commentThreads(targetRef: $n) { total } }', { n: w.inside.id }), echoes: (w) => [w.inside.id], reveals: answered },
  { name: 'nodeExport (a node inside the branch)', run: (w) => gql('query($n: ID!) { nodeExport(ref: $n) { filename } }', { n: w.inside.id }), echoes: (w) => [w.inside.id], reveals: answered },
  { name: 'memoryAssets', run: (w) => gql('query($m: ID!) { memoryAssets(memoryRef: $m) { total } }', { m: w.m.id }), echoes: (w) => [w.m.id], reveals: answered, noControl: 'asset reads need a signed-in user (UNAUTHENTICATED for any key)' },
  { name: 'memoryNodes (graph view)', run: (w) => gql('query($m: ID!) { memoryNodes(memoryRef: $m) { total nodes { id } } }', { m: w.m.id }), echoes: (w) => [w.m.id] },
  { name: 'memoryEdges (graph view)', run: (w) => gql('query($m: ID!) { memoryEdges(memoryRef: $m) { total edges { id } } }', { m: w.m.id }), echoes: (w) => [w.m.id] },
  { name: 'memoryLocSegments', run: (w) => gql('query($m: ID!) { memoryLocSegments(memoryRefs: [$m], parentLoc: "") { items { segment } } }', { m: w.m.id }), echoes: (w) => [w.m.id], reveals: (t) => t.includes('"segment"') },
  { name: 'nodeBatch (a node inside the branch)', run: (w) => gql('query($n: ID!) { nodeBatch(refs: [$n]) { nodes { id } unavailable } }', { n: w.inside.id }), echoes: (w) => [w.inside.id], reveals: (t) => !t.includes('"nodes":[]') },
  { name: 'resolveUrn (a node inside the branch)', run: (w) => gql('query($u: String!) { resolveUrn(urn: $u) { id memoryId } }', { u: w.nodeUrn }) },
  { name: 'globalSearch', run: () => gql('query { globalSearch(query: "zebrafish") { total } }', {}), echoes: () => ['"zebrafish"'], reveals: (t) => !t.includes('"total":0'), noControl: 'global search returns no node of a grant-read memory to a pure App key' },
];
const MCP_PROBES: Probe[] = [
  { name: 'hadron_list_memories', run: () => call('hadron_list_memories', {}), noControl: 'an App key lists its own and linked memories only, never a grant-read one' },
  { name: 'hadron_search (exact id, global scope)', run: (w) => call('hadron_search', { query: w.inside.id, scope: 'global' }), echoes: (w) => [w.inside.id], noControl: 'cross-entity search returns no node of a grant-read memory to a pure App key' },
  { name: 'hadron_list_comments (a node inside the branch)', run: (w) => call('hadron_list_comments', { targetRef: w.nodeUrn }), echoes: (w) => [w.nodeUrn], noControl: 'MCP comment reads refuse a pure App key on a grant-read memory (target not found)' },
  { name: 'hadron_get_next_node (a parent inside the branch)', run: (w) => call('hadron_get_next_node', { parent: w.nodeUrn }), echoes: (w) => [w.nodeUrn] },
  { name: 'hadron_list_recovery_nodes', run: (w) => call('hadron_list_recovery_nodes', { memoryRef: w.memUrn }), echoes: (w) => [w.memUrn], noControl: 'recovery needs read AND write on the memory; a read grant gives no write' },
];

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  const org = (await createDbOrgAndGraph(db, { orgName: 'brg5412', graphName: 'base' })).org;
  alice = (await db.user.create({ data: { id: generateId(), handle: `alice-${generateId().slice(-6)}` } as never })).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` } as never });
  keyId = (await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'k1' } })).id;
  await db.$executeRawUnsafe(`INSERT INTO app_key_scopes (id, app_key_id, scope, granted_by_user_id) VALUES ($1, $2, 'grant:read', $3)`, generateId(), keyId, alice);
});

const textOf = (r: unknown, w: W, p: Probe) => {
  let text = typeof r === 'string' ? r : JSON.stringify(r);
  for (const e of p.echoes?.(w) ?? []) text = text.split(e).join('<asked>');
  return text;
};

describe('#5412 condition 5, part 3: the named closed doors give a branch-only caller nothing of the memory', () => {
  for (const p of [...GQL_PROBES, ...MCP_PROBES]) {
    it(p.name, async () => {
      const reveals = p.reveals ?? revealsAny;
      const branch = await grantMemory((id) => ({ memory: id, branch: 'docs' }));
      const b = textOf(await p.run(branch), branch, p);
      expect(reveals(b, branch), b.slice(0, 600)).toBe(false);
      expect(revealsAny(b, branch), b.slice(0, 600)).toBe(false);
      // The control: the same door gives a whole-memory grantee the data, so the probe reaches a real door.
      if (p.noControl) return;
      const whole = await grantMemory((id) => ({ memory: id }));
      const w = textOf(await p.run(whole), whole, p);
      expect(reveals(w, whole), w.slice(0, 600)).toBe(true);
    });
  }
});
