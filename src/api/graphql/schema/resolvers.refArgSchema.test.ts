/**
 * #789 — the SDL must declare the SAME argument names the resolvers
 * destructure, for every entity-reference argument on the agent/app write
 * surface (cor:api:140).
 *
 * This guard exists because that invariant is genuinely unguarded otherwise:
 * every other test in this repo calls `resolvers.Mutation.*` DIRECTLY, which
 * bypasses GraphQL argument validation entirely. So during #789 the resolver
 * for `createApp` was renamed to `agentRef` while its SDL still said
 * `agentId` — the whole suite stayed green, `tsc` was clean, and
 * `check-graphql-sdl` passed (it only parses). The mismatch surfaced only when
 * hadron-cli's genqlient codegen validated a real operation against the
 * exported schema. Any caller going through the actual GraphQL layer would
 * have hit "Unknown argument".
 *
 * Cheap to keep, and it fails loudly on exactly that drift.
 */

import { describe, it, expect } from 'vitest';
import { buildSchema, GraphQLObjectType, GraphQLInputObjectType } from 'graphql';
import { typeDefs } from './typeDefs.js';

/** The expected reference-argument names, per cor:api:140. */
const EXPECTED_REF_ARGS: Record<string, string[]> = {
  updateAgent: ['ref', 'systemMemoryRef'],
  // #4140 (S4): memory, org and agent writes take refs; a foreign ref is `<entity>Ref`.
  updateMemory: ['ref', 'orgRef'],
  updateOrganization: ['ref'],
  createAgent: ['orgRef', 'systemMemoryRef'],
  deleteAgent: ['ref'],
  repairAgentSystemMemory: ['agentRef'],
  addMemoryToAgent: ['agentRef', 'memoryRef'],
  updateAgentMemoryRole: ['agentRef', 'memoryRef'],
  removeMemoryFromAgent: ['agentRef', 'memoryRef'],
  // #4138 (S2): the node-revision mutations take a revision ref (URN or PK); Query.nodeRevision is in EXPECTED_QUERY_REF_ARGS.
  restoreNodeRevision: ['nodeRevRef'],
  deleteNodeRevision: ['nodeRevRef'],
  updateNodeRevision: ['nodeRevRef'],
  updateApp: ['ref'],
  deleteApp: ['ref'],
  regenerateAppKey: ['appRef'],
  createAppKey: ['appRef'],
  createApp: ['orgRef', 'agentRef'],
  installAgentIntoApp: ['appRef', 'agentRef'],
  // #1050: teamAgentRef removed — casting reads no system memory, so the
  // argument had become accepted-and-ignored.
  castWorker: ['appRef', 'agentRef'],
  retireWorker: ['workerRef'],
  deleteWorker: ['workerRef'],
  createTeamChatMessage: ['appRef', 'sessionRef'],
  recordTeamWork: ['appRef', 'sessionRef'],
  updateTeamCollections: ['appRef'],
  uninstallAgentFromApp: ['appRef', 'agentRef'],
  addAgentToApp: ['appRef', 'agentRef'],
  removeAgentFromApp: ['appRef', 'agentRef'],
  publishAgentImport: ['parentAgentRef', 'importedAgentRef'],
  removeAgentImport: ['parentAgentRef', 'importedAgentRef'],
  startImpersonation: ['orgRef', 'userRef'],
  retryFailedEmbeddings: ['memoryRef'],
  // Spec 049 Channels. Added with #1171, which widened every one of these from
  // the ULID to the Channel's address — the moment the argument NAMES an
  // addressable entity rather than carrying a PK is the moment this table
  // should have covered it.
  updateChannel: ['ref'],
  deleteChannel: ['ref'],
  createChannelMessage: ['channelRef', 'sessionRef'],
  advanceChannelReadState: ['attendeeRef', 'appRef', 'channelRef'],
  markOwnTeamChatRead: ['appRef', 'sessionRef', 'channelRef'],
  // #4142 (S6) — the hard-rename slices B–F. Chunk A (memory reads) waits on
  // #4136 and is NOT here. Every entry is a Mutation whose entity argument
  // renamed with no alias; the stray check below holds each one to that.
  createMemory: ['orgRef'],
  deleteMemory: ['ref'],
  setMemorySourceToken: ['ref'],
  syncMemory: ['ref'],
  pushMemoryToGit: ['ref'],
  // replaceSubtree is deliberately NOT here (#4219 blind P2-A): its arg keeps
  // the LEGACY `memoryId` shape so legacy callers reach REPLACE_SUBTREE_RETIRED
  // instead of an unknown-argument error. It is not a renamed field.
  linkMemoryToUser: ['memoryRef'],
  encryptMemory: ['memoryRef'],
  deleteOrganization: ['ref'],
  linkGithubApp: ['orgRef'],
  updateOrgGithubApp: ['orgRef'],
  unlinkGithubApp: ['orgRef'],
  createUserInvitation: ['orgRef'],
  startChat: ['agentRef'],
  updateAgentAIConfig: ['agentRef'],
  clearAgentAIConfig: ['agentRef'],
  createRevision: ['agentRef'],
  publishRevision: ['agentRef'],
  restoreRevision: ['agentRef'],
  acquireEditorLock: ['agentRef'],
  releaseEditorLock: ['agentRef'],
  joinApp: ['appRef'],
  leaveApp: ['appRef'],
  // The nine alias-drops of chunk F: the survivor `<entity>Ref` args are now
  // REQUIRED (ID!) — the deprecated `…Id` alias is gone from the SDL.
  createMemorySubscription: ['memoryRef', 'orgRef'],
  updateMemorySubscription: ['memoryRef', 'orgRef'],
  deleteMemorySubscription: ['memoryRef', 'orgRef'],
  ensureAppMember: ['appRef', 'userRef'],
  removeAppMember: ['appRef', 'userRef'],
  revokeAgentSubscription: ['userRef', 'agentRef'],
  addOrgMember: ['orgRef', 'userRef'],
  updateOrgMember: ['orgRef', 'userRef'],
  removeOrgMember: ['orgRef', 'userRef'],
  // #4137 (S1): the memory share/member mutations — memoryId, granteeId and
  // userId gone with no alias.
  createMemoryShare: ['memoryRef', 'granteeRef'],
  updateMemoryShareRole: ['memoryRef', 'granteeRef'],
  deleteMemoryShare: ['memoryRef', 'granteeRef'],
  addMemoryMember: ['memoryRef', 'userRef'],
  updateMemoryMemberRole: ['memoryRef', 'userRef'],
  removeMemoryMember: ['memoryRef', 'userRef'],
  // #4148 (S7): the agent-task family's own-task argument is `taskRef` (gate pin 1; the family precedent).
  updateAgentTask: ['taskRef'],
  assignAgentTask: ['taskRef'],
  reassignAgentTask: ['taskRef'],
  startAgentTask: ['taskRef'],
  recordAgentTaskProgress: ['taskRef'],
  finishAgentTask: ['taskRef'],
  cancelAgentTask: ['taskRef'],
  releaseAgentTaskExternalId: ['taskRef'],
  parkAgentTask: ['taskRef'],
  cloneAgentTask: ['taskRef'],
  makeAgentTaskReady: ['taskRef'],
  // #5081 (gap 3): the signing switch's organization argument is `orgRef`, not `org`.
  setOrgBootPromptSigning: ['orgRef'],
};

/**
 * #4136 (S0): the Query fields that already take refs, so the extension is exercised before any rename lands. Keyed by the
 * bare field name and checked against `schema.getQueryType()`; the Mutation table above is checked against the Mutation
 * type. A Query field a later slice renames (#4141's `appRuns(parentRunRef)`, S2/S3's reads) adds or changes its entry here.
 */
const EXPECTED_QUERY_REF_ARGS: Record<string, string[]> = {
  node: ['ref', 'memoryRef'],
  memory: ['ref'],
  app: ['ref'],
  agent: ['ref'],
  appRun: ['ref'],
  nodeRevisions: ['nodeRef'],
  nodeRevision: ['nodeRevRef'], // #4138 (S2)
  appRuns: ['appRef', 'orgRef', 'parentRunRef'],
  // #4139 (S3): nodeExport takes the node's ref (PK or URN).
  nodeExport: ['ref'],
  // #4142 (S6 chunk A): the memory reads.
  usageEvents: ['memoryRef', 'nodeRef'],
  usageEventsPage: ['memoryRef', 'nodeRef'],
  memoryAssets: ['memoryRef'],
  memoryLocSegments: ['memoryRefs'],
  // #4148 (S7): the agent-task family (gate pin 1: `ref` for the field's own subject, `parentTaskRef` / `taskRef`).
  agentTask: ['ref'],
  agentTasks: ['appRef', 'parentTaskRef'],
  agentTasksPage: ['appRef', 'parentTaskRef'], // shares agentTasks' ListArgs (Bridget's LOCAL P2-1)
  agentTeamEvents: ['appRef', 'taskRef'],
  agentTeamEventsPage: ['appRef', 'taskRef'],
  // #5081 (gap 3): the 20 Query fields whose organization argument was `orgId` (18) or `org` (2) are `orgRef`.
  findNodes: ['orgRef'],
  globalSearch: ['orgRef'],
  edges: ['orgRef'],
  impersonationSessions: ['orgRef'],
  memories: ['orgRef'],
  exchangeConnections: ['orgRef'],
  exchangeConnectionsPage: ['orgRef'],
  slackConnections: ['orgRef'],
  telegramConnections: ['orgRef'],
  mcpServers: ['orgRef'],
  homeAssistantInstances: ['orgRef'],
  resendSenders: ['orgRef'],
  apps: ['orgRef'],
  agents: ['orgRef'],
  scopes: ['orgRef'],
  channels: ['orgRef'],
  registerEntries: ['orgRef'],
  assets: ['orgRef'],
  orgBootPromptSigning: ['orgRef'],
  orgBootPromptSigningPreview: ['orgRef'],
};

/**
 * Args that legitimately stay `<entity>Id` because they are genuine PKs or external-system labels, per
 * the convention ("output fields, DB columns, resolved locals" → `<entity>Id`). Each entry names ONE field
 * (`field.arg`), so `appId` is allowed on `updateOrgGithubApp` and still flagged anywhere else (#4357 P3-8:
 * `appId` is also a Hadron entity name; a global allowance would have waved a stray `joinApp.appId` through).
 */
const ALLOWED_ID_ARGS = new Set([
  // startChat.userId: a PK compare-and-set against the session's user, not an
  // entity the caller names (#4142 S6 ruling A). S4 (#4140) already renamed
  // systemMemoryId away, so it no longer appears here.
  'startChat.userId',
  // #4142 (S6): external-system / label args the stray regex catches by
  // spelling, not Hadron entity PK refs.
  // linkGithubApp.installationId: a GitHub App INSTALLATION id (external
  // system, an Int) — pairs with orgRef, which names the Hadron org.
  'linkGithubApp.installationId',
  // updateOrgGithubApp.appId: the GitHub App's own numeric id (external
  // system), not a Hadron App ref — the Hadron org is named by orgRef.
  'updateOrgGithubApp.appId',
  // linkMemoryToUser.externalUserId: the external identity's label at the
  // App's IdP; the Hadron memory is named by memoryRef.
  'linkMemoryToUser.externalUserId',
  // #4136 (S0): Query fields are keyed `Query.<field>.<arg>` so a Query field can never share a Mutation field's allowance.
  // #4148 (S7): agentTasks.externalId is an external-system label (an outside item's id, e.g. an issue URL; cor:agt:120:02),
  // not a Hadron entity reference, so it keeps its name per the convention ("external-system labels" stay `<x>Id`).
  'Query.agentTasks.externalId',
  'Query.agentTasksPage.externalId',
]);

/** The legacy-`Id` check, one (field, arg) at a time, against a per-field allow-list. */
const isStrayLegacyIdArg = (field: string, arg: string, allowed: ReadonlySet<string> = ALLOWED_ID_ARGS): boolean =>
  /^(id|org|.*Id)$/.test(arg) && !allowed.has(`${field}.${arg}`);

type Root = 'Query' | 'Mutation';

/** The fields of one root type of `schema` (the real SDL unless a fixture is passed). */
const fieldsOf = (root: Root, sdl: string = typeDefs) => {
  const schema = buildSchema(sdl);
  const type = (root === 'Query' ? schema.getQueryType() : schema.getMutationType()) as GraphQLObjectType;
  return type.getFields();
};

/** Every way `table` disagrees with the fields: a missing field, or a missing declared ref argument. Empty = agrees. */
const refArgProblems = (root: Root, table: Record<string, string[]>, sdl: string = typeDefs): string[] => {
  const fields = fieldsOf(root, sdl);
  const problems: string[] = [];
  for (const [name, expected] of Object.entries(table)) {
    const field = fields[name];
    if (!field) { problems.push(`${root}.${name} is missing from the SDL`); continue; }
    const argNames = field.args.map((a) => a.name);
    for (const want of expected) if (!argNames.includes(want)) problems.push(`${root}.${name} should declare "${want}"`);
  }
  return problems;
};

/** Every listed field that still declares a legacy `<entity>Id` argument not on the per-field allow-list. */
const strayIdProblems = (root: Root, table: Record<string, string[]>, sdl: string = typeDefs, allowed: ReadonlySet<string> = ALLOWED_ID_ARGS): string[] => {
  const fields = fieldsOf(root, sdl);
  const offenders: string[] = [];
  for (const name of Object.keys(table)) {
    // A Query field's allowance key is `Query.<field>`, a Mutation's the bare field name (the table's existing keys).
    const key = root === 'Query' ? `Query.${name}` : name;
    for (const arg of fields[name]?.args ?? []) if (isStrayLegacyIdArg(key, arg.name, allowed)) offenders.push(`${name}.${arg.name}`);
  }
  return offenders;
};

describe('#789 — SDL ref-argument names match the resolvers', () => {
  const fields = fieldsOf('Mutation');

  it.each(Object.entries(EXPECTED_REF_ARGS))(
    '%s declares %s',
    (name, expected) => {
      const field = fields[name];
      expect(field, `Mutation.${name} is missing from the SDL`).toBeDefined();
      const argNames = field.args.map((a) => a.name);
      for (const want of expected) {
        expect(argNames, `Mutation.${name} should declare "${want}"`).toContain(want);
      }
    },
  );

  it('none of them still declares a legacy <entity>Id reference arg', () => {
    // `createApp.agentId` was exactly this — SDL saying Id while the resolver
    // read agentRef, so the mutation was unusable through the real API.
    expect(strayIdProblems('Mutation', EXPECTED_REF_ARGS)).toEqual([]);
  });
});

describe('#4136 (S0) — the same guard over Query fields', () => {
  const fields = fieldsOf('Query');

  it.each(Object.entries(EXPECTED_QUERY_REF_ARGS))(
    'Query.%s declares %s',
    (name, expected) => {
      const field = fields[name];
      expect(field, `Query.${name} is missing from the SDL`).toBeDefined();
      const argNames = field.args.map((a) => a.name);
      for (const want of expected) {
        expect(argNames, `Query.${name} should declare "${want}"`).toContain(want);
      }
    },
  );

  it('none of the listed Query fields still declares a legacy <entity>Id reference arg', () => {
    expect(strayIdProblems('Query', EXPECTED_QUERY_REF_ARGS)).toEqual([]);
  });
});

/**
 * #4368: an input-object field that names an entity takes `<entity>Ref` too. `setAgentAssetUploadEnabled` carries its ref in
 * `input`, which the argument tables above never see. The two deprecated v1 asset calls (beginAssetUpload, agentAssets) keep
 * `agentUrn` until their deprecation window ends (gate decision, #4368).
 */
describe('#4368 — setAgentAssetUploadEnabled names its Agent with agentRef', () => {
  const input = buildSchema(typeDefs).getType('SetAgentAssetUploadEnabledInput') as GraphQLInputObjectType;
  it('declares agentRef (required) and no agentUrn alias', () => {
    const f = input.getFields();
    expect(f.agentRef?.type.toString()).toBe('String!');
    expect(f.agentUrn).toBeUndefined();
  });
});

/** A fixture schema (never the real SDL), so the negative cases pin the CHECKER and not today's drift. */
const FIXTURE_SDL = `
  type Query { thing(ref: ID!, thingId: ID): String  other(otherRef: ID, filterId: ID): String  plain(limit: Int): String }
  type Mutation { change(ref: ID!, thingId: ID): String }
`;

describe('#4136 (S0) — the checker fails where it must (fixture schema)', () => {
  it('a Query entry naming an arg the SDL does not declare fails', () => {
    expect(refArgProblems('Query', { thing: ['ref'] }, FIXTURE_SDL)).toEqual([]);
    expect(refArgProblems('Query', { thing: ['ref', 'memoryRef'] }, FIXTURE_SDL)).toEqual(['Query.thing should declare "memoryRef"']);
  });
  it('a Query entry naming a field the SDL does not have fails', () => {
    expect(refArgProblems('Query', { gone: ['ref'] }, FIXTURE_SDL)).toEqual(['Query.gone is missing from the SDL']);
  });
  it('a Query field is judged against the Query type and a Mutation field against the Mutation type, never crossed', () => {
    expect(refArgProblems('Query', { change: ['ref'] }, FIXTURE_SDL)).toEqual(['Query.change is missing from the SDL']);
    expect(refArgProblems('Mutation', { thing: ['ref'] }, FIXTURE_SDL)).toEqual(['Mutation.thing is missing from the SDL']);
    expect(refArgProblems('Mutation', { change: ['ref'] }, FIXTURE_SDL)).toEqual([]);
  });
  it('a stray <entity>Id arg on a listed Query field is flagged, an unlisted field is not looked at', () => {
    expect(strayIdProblems('Query', { thing: ['ref'], other: ['otherRef'] }, FIXTURE_SDL, new Set())).toEqual(['thing.thingId', 'other.filterId']);
    expect(strayIdProblems('Query', { plain: [] }, FIXTURE_SDL, new Set())).toEqual([]);
  });
  it('a Query allowance is per field and keyed Query.<field>.<arg>: it neither covers another field nor a Mutation of the same name', () => {
    expect(strayIdProblems('Query', { thing: ['ref'], other: ['otherRef'] }, FIXTURE_SDL, new Set(['Query.thing.thingId']))).toEqual(['other.filterId']);
    // the bare Mutation-style key does not wave a Query arg through, and a Query key does not wave a Mutation arg through
    expect(strayIdProblems('Query', { thing: ['ref'] }, FIXTURE_SDL, new Set(['thing.thingId']))).toEqual(['thing.thingId']);
    expect(strayIdProblems('Mutation', { change: ['ref'] }, FIXTURE_SDL, new Set(['Query.change.thingId']))).toEqual(['change.thingId']);
  });
  it('the Mutation behavior is unchanged: a Mutation entry still fails on a missing arg and a stray Id', () => {
    expect(refArgProblems('Mutation', { change: ['ref', 'orgRef'] }, FIXTURE_SDL)).toEqual(['Mutation.change should declare "orgRef"']);
    expect(strayIdProblems('Mutation', { change: ['ref'] }, FIXTURE_SDL, new Set())).toEqual(['change.thingId']);
    expect(strayIdProblems('Mutation', { change: ['ref'] }, FIXTURE_SDL, new Set(['change.thingId']))).toEqual([]);
  });
  it('the appRuns.parentRunId allowance is gone (#4141 renamed it parentRunRef), so the old name is a stray Id arg', () => {
    expect(isStrayLegacyIdArg('Query.appRuns', 'parentRunId')).toBe(true);
    expect(isStrayLegacyIdArg('Query.appRuns', 'orgId')).toBe(true);
    expect(isStrayLegacyIdArg('Query.agentTasks', 'parentRunId')).toBe(true);
  });
});

describe('#4357 P3-8 — the legacy-Id allowance is per field', () => {
  it('allows each documented arg on its own field only', () => {
    expect(isStrayLegacyIdArg('updateOrgGithubApp', 'appId')).toBe(false);
    expect(isStrayLegacyIdArg('startChat', 'userId')).toBe(false);
  });
  it('still flags the same spelling on any other field (appId is a Hadron entity name too)', () => {
    expect(isStrayLegacyIdArg('joinApp', 'appId')).toBe(true);
    expect(isStrayLegacyIdArg('leaveApp', 'appId')).toBe(true);
    expect(isStrayLegacyIdArg('createMemory', 'userId')).toBe(true);
    expect(isStrayLegacyIdArg('syncMemory', 'id')).toBe(true);
  });
});


describe('#5081 (gap 3) — the 21 organization-scope arguments stay named in the guard tables', () => {
  const QUERY = ['findNodes', 'globalSearch', 'edges', 'impersonationSessions', 'memories', 'exchangeConnections', 'exchangeConnectionsPage', 'slackConnections', 'telegramConnections', 'mcpServers', 'homeAssistantInstances', 'resendSenders', 'apps', 'agents', 'scopes', 'channels', 'registerEntries', 'assets', 'orgBootPromptSigning', 'orgBootPromptSigningPreview'];
  it.each(QUERY)('Query.%s is in EXPECTED_QUERY_REF_ARGS with orgRef', (name) => {
    expect(EXPECTED_QUERY_REF_ARGS[name]).toContain('orgRef');
  });
  it('Mutation.setOrgBootPromptSigning is in EXPECTED_REF_ARGS with orgRef', () => {
    expect(EXPECTED_REF_ARGS.setOrgBootPromptSigning).toContain('orgRef');
  });
  it('a bare `org` argument is a stray legacy arg, as is orgId', () => {
    expect(isStrayLegacyIdArg('Query.orgBootPromptSigning', 'org')).toBe(true);
    expect(isStrayLegacyIdArg('Query.apps', 'orgId')).toBe(true);
    expect(isStrayLegacyIdArg('Query.apps', 'orgRef')).toBe(false);
  });
});
