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
import { buildSchema, GraphQLObjectType } from 'graphql';
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
  // #4138 (S2): the node-revision mutations take a revision ref (URN or PK). Query.nodeRevision joins once #4136 (S0)
  // extends this guard to Query fields.
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
]);

/** The legacy-`Id` check, one (field, arg) at a time, against a per-field allow-list. */
const isStrayLegacyIdArg = (field: string, arg: string, allowed: ReadonlySet<string> = ALLOWED_ID_ARGS): boolean =>
  /^(id|.*Id)$/.test(arg) && !allowed.has(`${field}.${arg}`);

const mutationFields = () => {
  const schema = buildSchema(typeDefs);
  const mutation = schema.getType('Mutation') as GraphQLObjectType;
  return mutation.getFields();
};

describe('#789 — SDL ref-argument names match the resolvers', () => {
  const fields = mutationFields();

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
    const offenders: string[] = [];
    for (const name of Object.keys(EXPECTED_REF_ARGS)) {
      for (const arg of fields[name]?.args ?? []) {
        if (isStrayLegacyIdArg(name, arg.name)) offenders.push(`${name}.${arg.name}`);
      }
    }
    // `createApp.agentId` was exactly this — SDL saying Id while the resolver
    // read agentRef, so the mutation was unusable through the real API.
    expect(offenders).toEqual([]);
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

