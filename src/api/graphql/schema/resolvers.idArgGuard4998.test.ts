/**
 * #4998 (entity refs S7): no NEW Query or Mutation argument names an entity by `id` / `<entity>Id` / `<entity>Ids`.
 *
 * `resolvers.refArgSchema.test.ts` checks only the fields its tables list, so a new mutation taking `fooId` passed every
 * check. This walk covers EVERY argument of every Query and Mutation field: one named `id`, `*Id` or `*Ids` fails unless
 * `ALLOWED_ID_ARGS` lists it with a one-line reason. hrn:node:hadronmemory.com:specs:cor:api:140:01: the name is the
 * contract; an argument that names an addressable entity is `<entity>Ref` (PK or URN), and `<entity>Id` is reserved for a
 * genuine primary key.
 *
 * The allow-list started as exactly what was on main after S0-S6 (main 6267f067b) and only shrinks: an entry with no
 * reason fails, and an entry whose argument no longer exists fails, so a rename removes its entry. Each reason is one of:
 *   - the entity has no ref resolver (#775's N/A list), so its primary key is the only address;
 *   - an external-system label or a token, not a Hadron entity;
 *   - a compare-and-set or legacy shape that takes only a PK on purpose;
 *   - a DEFERRAL: the entity has a resolver and the argument is a known gap, with its issue number.
 * Input-type fields are #5080's walk (`refArgSchema.test.ts`); `String`-typed ref arguments that exist today are accepted
 * (Holger R5, 2026-11-23), so this guard fixes the shape for new arguments only.
 */
import { describe, expect, it } from 'vitest';
import { buildSchema, GraphQLObjectType } from 'graphql';
import { typeDefs } from './typeDefs.js';

/** `Query.<field>.<arg>` or `Mutation.<field>.<arg>` -> why it stays `id`/`*Id`/`*Ids`. */
export const ALLOWED_ID_ARGS: Record<string, string> = {
  'Query.recoveryEdges.edgeIds': 'deferred: hadron-server#5280 (Edge has resolveEdgeRef, with deleted edges); a known gap against cor:api:140:01',
  'Query.automationTeamSnapshotGrants.triggerId': 'a schedule or webhook id (by triggerKind); neither has a ref resolver',
  'Query.automationTeamSnapshotGrant.id': 'an automation team-snapshot grant row; no URN or resolver (not the grants table resolveGrantRef reads)',
  'Query.hostDesiredState.hostId': "a host's token within its App (what a key's host:operate scope names); no resolver",
  'Query.hostSweepRuns.hostId': "a host's token within its App (what a key's host:operate scope names); no resolver",
  'Query.hostSetup.hostId': "a host's token within its App (what a key's host:operate scope names); no resolver",
  'Query.agentTeamHost.hostId': "#5259: a host's token within its App (what a key's host:operate scope names); no resolver",
  'Query.contextReset.resetId': 'a context reset has no URN or resolver',
  'Query.hostOperations.hostId': "a host's token within its App (what a key's host:operate scope names); no resolver",
  'Query.agentTasks.externalId': 'an external-system label, not a Hadron entity',
  'Query.agentTasks.externalIds': 'an external-system label, not a Hadron entity',
  'Query.agentTasksPage.externalId': 'an external-system label, not a Hadron entity',
  'Query.agentTasksPage.externalIds': 'an external-system label, not a Hadron entity',
  'Query.signingRequest.id': 'a signing request; no URN or resolver',
  'Query.grantSigningRequest.id': 'a grant signing request; no URN or resolver',
  'Query.grantSigningSelection.id': 'a grant signing selection; no URN or resolver',
  'Query.questions.assigneeId': 'deferred: hadron-server#5280 (a User, resolveUserRef); a known gap against cor:api:140:01',
  'Query.questions.askedByWorkerId': 'deferred: hadron-server#5280 (a Worker, resolveWorkerRef); a known gap against cor:api:140:01',
  'Query.questions.askedByAppId': 'deferred: hadron-server#5280 (an App, resolveAppRef); a known gap against cor:api:140:01',
  'Query.sessions.customerId': 'an external-system label, not a Hadron entity',
  'Query.sessionsPage.customerId': 'an external-system label, not a Hadron entity',
  'Query.session.id': 'Session: no ref resolver (#775 N/A)',
  'Query.connectionFlow.flowId': "an OAuth connection flow's id; no URN or resolver",
  'Query.secretChangeRequest.id': 'a staged secret change request; no URN or resolver',
  'Query.exchangeMessages.connectionId': 'ExchangeConnection: no ref resolver (#775 N/A)',
  'Query.exchangeFolders.connectionId': 'ExchangeConnection: no ref resolver (#775 N/A)',
  'Query.calendarEvents.calendarId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Query.calendarEvent.eventId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Query.calendarEvent.calendarId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Query.driveFiles.folderId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Query.driveFile.fileId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Query.driveFileExport.fileId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Query.resolveAIConfig.chatId': 'a chat id; chats have no ref resolver (#775 N/A)',
  'Query.chatEffectiveToolChoice.chatId': 'a chat id; chats have no ref resolver (#775 N/A)',
  'Query.chatServedPrompts.chatId': 'a chat id; chats have no ref resolver (#775 N/A)',
  'Query.chatHistory.chatId': 'a chat id; chats have no ref resolver (#775 N/A)',
  'Query.assetDownloadUrl.assetId': 'Asset: no ref resolver (#775 N/A)',
  'Mutation.revokeAppMemoryWriteGrant.id': 'an App memory write grant row; no URN or resolver (not the grants table resolveGrantRef reads)',
  'Mutation.setAutomationTeamSnapshotGrant.triggerId': 'a schedule or webhook id (by triggerKind); neither has a ref resolver',
  'Mutation.revokeAutomationTeamSnapshotGrant.id': 'an automation team-snapshot grant row; no URN or resolver (not the grants table resolveGrantRef reads)',
  'Mutation.setAutomationReadGrant.triggerId': 'a schedule or webhook id (by triggerKind); neither has a ref resolver',
  'Mutation.revokeAutomationReadGrant.id': 'an automation read grant row; no URN or resolver (not the grants table resolveGrantRef reads)',
  'Mutation.updateAgentTickerTemplate.id': 'a ticker template; no URN or resolver (resolveTickerRef addresses tickers, not templates)',
  'Mutation.deleteAgentTickerTemplate.id': 'a ticker template; no URN or resolver (resolveTickerRef addresses tickers, not templates)',
  'Mutation.setAppChatbotAiConfig.configId': 'deferred: hadron-server#5280 (an AiServiceConfig, URN-addressable since #3857); a known gap against cor:api:140:01',
  'Mutation.liftTeamStopSignal.id': 'a team stop signal; no URN or resolver',
  'Mutation.acknowledgeDeliveryBatches.batchIds': 'delivery batch tokens the server handed the caller; no URN or resolver',
  'Mutation.disposeAgentTaskFinding.findingId': "a finding's id within the task named by taskRef (F1, F2, ...), not an entity",
  'Mutation.acknowledgeAlarm.eventId': 'an agent-team event (the alarm); no URN or resolver',
  'Mutation.stopImpersonation.id': 'an impersonation session; no URN or resolver',
  'Mutation.recordNodeContentValidationReport.runId': "the reporter's own idempotency key, not a Hadron entity",
  'Mutation.withdrawSigningRequest.id': 'a signing request; no URN or resolver',
  'Mutation.withdrawGrantSigningSelection.id': 'a grant signing selection; no URN or resolver',
  'Mutation.withdrawGrantSigningRequest.id': 'a grant signing request; no URN or resolver',
  'Mutation.replaceSubtree.memoryId': 'the legacy shape of the retired replaceSubtree, kept so legacy callers reach REPLACE_SUBTREE_RETIRED (#4219)',
  'Mutation.updateAgentSchedule.id': 'AgentSchedule: no ref resolver',
  'Mutation.deleteAgentSchedule.id': 'AgentSchedule: no ref resolver',
  'Mutation.rotateAgentWebhook.id': 'AgentWebhook: no ref resolver',
  'Mutation.deleteAgentWebhook.id': 'AgentWebhook: no ref resolver',
  'Mutation.softDeleteAsset.assetId': 'Asset: no ref resolver (#775 N/A)',
  'Mutation.restoreAsset.assetId': 'Asset: no ref resolver (#775 N/A)',
  'Mutation.updateSession.id': 'Session: no ref resolver (#775 N/A)',
  'Mutation.recordSessionOutcome.sessionId': 'Session: no ref resolver (#775 N/A)',
  'Mutation.endSession.id': 'Session: no ref resolver (#775 N/A)',
  'Mutation.createResumeClaim.sessionId': 'Session: no ref resolver (#775 N/A)',
  'Mutation.updateUserRoles.userId': 'org-role writes are keyed by raw user id only, documented in the SDL (#775 N/A)',
  'Mutation.linkGithubApp.installationId': 'a GitHub App installation id (external)',
  'Mutation.updateOrgGithubApp.appId': "the GitHub App's own numeric id (external)",
  'Mutation.deleteExchangeConnection.id': 'ExchangeConnection: no ref resolver (#775 N/A)',
  'Mutation.testExchangeConnection.id': 'ExchangeConnection: no ref resolver (#775 N/A)',
  'Mutation.cancelWebPoll.jobId': "the web-fetch tool's poll job id (external to core)",
  'Mutation.withdrawSecretChangeRequest.id': 'a staged secret change request; no URN or resolver',
  'Mutation.revealSecret.clientId': 'a secret read client id; no URN or resolver',
  'Mutation.exchangeReply.connectionId': 'ExchangeConnection: no ref resolver (#775 N/A)',
  'Mutation.exchangeReply.messageId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.exchangeMoveMessage.connectionId': 'ExchangeConnection: no ref resolver (#775 N/A)',
  'Mutation.exchangeMoveMessage.messageId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.exchangeMoveMessage.folderId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.emailSaveDraft.replyToMessageId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.emailUpdateDraft.draftId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.emailSendDraft.draftId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.emailDeleteMessage.messageId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.emailMarkRead.messageId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.emailFlagMessage.messageId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.emailCategorizeMessage.messageId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.calendarCreateEvent.calendarId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.calendarUpdateEvent.eventId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.calendarUpdateEvent.calendarId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.calendarDeleteEvent.eventId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.calendarDeleteEvent.calendarId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.calendarRespondToEvent.eventId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.calendarRespondToEvent.calendarId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.exportNodeToGoogleDoc.folderId': "the mail, calendar or drive provider's own id, passed through to the capability tool",
  'Mutation.startChat.userId': "a PK compare-and-set against the session's user, not a lookup",
  'Mutation.sendChatMessage.chatId': 'a chat id; chats have no ref resolver (#775 N/A)',
  'Mutation.processChatResponse.chatId': 'a chat id; chats have no ref resolver (#775 N/A)',
  'Mutation.saveChatSummary.chatId': 'a chat id; chats have no ref resolver (#775 N/A)',
  'Mutation.updateChatTitle.chatId': 'a chat id; chats have no ref resolver (#775 N/A)',
  'Mutation.deleteChat.chatId': 'a chat id; chats have no ref resolver (#775 N/A)',
  'Mutation.updateAiServiceConfig.id': 'deferred: hadron-server#5280 (an AiServiceConfig, URN-addressable since #3857); a known gap against cor:api:140:01',
  'Mutation.testAiServiceConfig.id': 'deferred: hadron-server#5280 (an AiServiceConfig, URN-addressable since #3857); a known gap against cor:api:140:01',
  'Mutation.deleteAiServiceConfig.id': 'deferred: hadron-server#5280 (an AiServiceConfig, URN-addressable since #3857); a known gap against cor:api:140:01',
  'Mutation.releaseWorker.expectedHolderUserId': 'a PK compare-and-set against the current holder, not a lookup',
  'Mutation.revokeAppKey.id': 'an AppKey credential id; no ref resolver (#775 N/A)',
  'Mutation.grantAppKeyScope.id': 'an AppKey credential id; no ref resolver (#775 N/A)',
  'Mutation.grantAppKeyScope.hostId': "a host's token within its App (what a key's host:operate scope names); no resolver",
  'Mutation.revokeAppKeyScope.id': 'an AppKey credential id; no ref resolver (#775 N/A)',
  'Mutation.revokeUserApiKey.id': 'a UserApiKey credential id; no ref resolver (#775 N/A)',
  'Mutation.setUserApiKeyHidden.id': 'a UserApiKey credential id; no ref resolver (#775 N/A)',
  'Mutation.deleteUserApiKey.id': 'a UserApiKey credential id; no ref resolver (#775 N/A)',
  'Mutation.createAppUser.externalId': 'an external-system label, not a Hadron entity',
  'Mutation.startAgentSession.externalUserId': 'an external-system label, not a Hadron entity',
  'Mutation.endAgentSession.sessionId': 'Session: no ref resolver (#775 N/A)',
  'Mutation.linkMemoryToUser.externalUserId': 'an external-system label, not a Hadron entity',
};

/** The argument names this guard holds to the convention: a bare `id`, and any `…Id` or `…Ids`. */
export const ID_ARG = /^(id|.*Ids?)$/;

const CONVENTION = 'an argument naming an entity takes <entity>Ref (hrn:node:hadronmemory.com:specs:cor:api:140:01)';

/** Every unlisted id argument, every allow-list entry with no reason, and every stale entry. Empty = the schema conforms. */
export function idArgProblems(sdl: string = typeDefs, allowed: Record<string, string> = ALLOWED_ID_ARGS): string[] {
  const schema = buildSchema(sdl);
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const root of [schema.getQueryType(), schema.getMutationType()]) {
    if (!root) continue;
    for (const [field, def] of Object.entries((root as GraphQLObjectType).getFields())) {
      for (const arg of def.args) {
        const key = `${root.name}.${field}.${arg.name}`;
        seen.add(key);
        if (ID_ARG.test(arg.name) && !(key in allowed)) {
          problems.push(`${key}: ${CONVENTION}; list it in ALLOWED_ID_ARGS with a one-line reason if it is a genuine primary key`);
        }
      }
    }
  }
  for (const [key, reason] of Object.entries(allowed)) {
    if (reason.trim() === '') problems.push(`${key}: allow-list entry has no reason (cor:api:140:01)`);
    if (!seen.has(key)) problems.push(`${key}: stale allow-list entry, no such argument (cor:api:140:01)`);
  }
  return problems;
}

describe('#4998 — no Query or Mutation argument names an entity by id unless allow-listed with a reason', () => {
  it('the real schema conforms', () => {
    expect(idArgProblems()).toEqual([]);
  });
  it('every allow-list entry carries a reason', () => {
    for (const [key, reason] of Object.entries(ALLOWED_ID_ARGS)) expect(reason.trim(), key).not.toBe('');
  });
});

/** A fixture schema (never the real SDL), so the negative cases pin the CHECKER and not today's drift. */
const FIXTURE_SDL = `
  type Query { thing(ref: ID!, filterId: ID): String  list(memberIds: [ID!], limit: Int): String  byId(id: ID!): String }
  type Mutation { change(ref: ID!, fooId: ID): String  plain(name: String, fooRef: ID): String }
`;

describe('#4998 — the walk fails where it must (fixture schema)', () => {
  it('a new fooId mutation argument fails, naming the field, the argument and the convention', () => {
    const problems = idArgProblems(FIXTURE_SDL, {
      'Query.thing.filterId': 'a pk', 'Query.list.memberIds': 'a pk', 'Query.byId.id': 'a pk',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^Mutation\.change\.fooId: /);
    expect(problems[0]).toContain('cor:api:140:01');
  });
  it('adding it with a reason passes', () => {
    expect(idArgProblems(FIXTURE_SDL, {
      'Query.thing.filterId': 'a pk', 'Query.list.memberIds': 'a pk', 'Query.byId.id': 'a pk', 'Mutation.change.fooId': 'a pk',
    })).toEqual([]);
  });
  it('Query fields are walked, and id, *Id and *Ids all match; Ref and plain arguments do not', () => {
    expect(idArgProblems(FIXTURE_SDL, {}).map((p) => p.split(':')[0])).toEqual([
      'Query.thing.filterId', 'Query.list.memberIds', 'Query.byId.id', 'Mutation.change.fooId',
    ]);
  });
  it('an allow-list entry with an empty reason fails', () => {
    expect(idArgProblems(FIXTURE_SDL, {
      'Query.thing.filterId': ' ', 'Query.list.memberIds': 'a pk', 'Query.byId.id': 'a pk', 'Mutation.change.fooId': 'a pk',
    })).toEqual(['Query.thing.filterId: allow-list entry has no reason (cor:api:140:01)']);
  });
  it('an entry for an argument that does not exist fails (the list only shrinks)', () => {
    expect(idArgProblems(FIXTURE_SDL, {
      'Query.thing.filterId': 'a pk', 'Query.list.memberIds': 'a pk', 'Query.byId.id': 'a pk', 'Mutation.change.fooId': 'a pk',
      'Mutation.gone.oldId': 'renamed',
    })).toEqual(['Mutation.gone.oldId: stale allow-list entry, no such argument (cor:api:140:01)']);
  });
  it('an allowance is per root, field and argument: it covers neither another field nor the other root', () => {
    const sdl = 'type Query { a(xId: ID): String  b(xId: ID): String } type Mutation { a(xId: ID): String }';
    expect(idArgProblems(sdl, { 'Query.a.xId': 'a pk' }).map((p) => p.split(':')[0])).toEqual(['Query.b.xId', 'Mutation.a.xId']);
  });
});
