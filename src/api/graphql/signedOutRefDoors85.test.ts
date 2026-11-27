/** #85 (cor:api:140:02 r7): signed-out callers get UNAUTHENTICATED before any App or organization ref resolves. */
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildASTSchema, parse } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { signJwt } from '../../auth/jwt.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../../test/startServerFixture.js';
import { typeDefs } from './schema/typeDefs.js';
import { signedOutRefDoors } from './signedOutRefDoorsPlugin.js';

const PINNED_DOORS = [
  'addAgentToApp',
  'addOrgMember',
  'adjustCredits',
  'advanceChannelReadState',
  'assignHostWorker',
  'attachMemoryToApp',
  'authorizeContextResetStop',
  'cancelWebPoll',
  'castWorker',
  'claimContextReset',
  'clearOwnerLimits',
  'cloneMemory',
  'collectHostOperations',
  'compileAppAgentBootPrompt',
  'createAgent',
  'createAgentOrgGrant',
  'createAgentSchedule',
  'createAgentTask',
  'createAgentTasks',
  'createAgentWebhook',
  'createApp',
  'createAppKey',
  'createAppMemory',
  'createConnectionGrant',
  'createGrant',
  'createHomeAssistantInstance',
  'createMcpServer',
  'createMemory',
  'createMemoryInApp',
  'createMemorySubscription',
  'createNode',
  'createPrincipalGrant',
  'createResendSender',
  'createReviewNode',
  'createScope',
  'createSlackConnection',
  'createSpecNode',
  'createTaskNode',
  'createTeamChatMessage',
  'createTeamRole',
  'createTelegramConnection',
  'createTicker',
  'createUserInvitation',
  'deleteApp',
  'deleteAppModelGroup',
  'deleteMemorySubscription',
  'deleteOrganization',
  'deleteTeamRole',
  'detachMemoryFromApp',
  'endAgentlessSession',
  'ensureAppMember',
  'extractParentNodeToMemory',
  'grantApp',
  'grantCredits',
  'importNode',
  'installAgentIntoApp',
  'issueHostOperation',
  'joinAgentTeamHost',
  'joinApp',
  'leaveApp',
  'liftTeamStopSignal',
  'linkGithubApp',
  'markOwnTeamChatRead',
  'mintActionTickets',
  'recordAppAction',
  'recordHostSweepRun',
  'recordTeamWork',
  'regenerateAppKey',
  'registerContextResetRecovery',
  'registerHost',
  'reinstallApp',
  'removeAgentFromApp',
  'removeAgentTeamHost',
  'removeAppMember',
  'removeOrgMember',
  'reportContextResetAgentStopped',
  'reportContextResetRelaunchFailed',
  'reportContextResetRelaunched',
  'reportExternalTasks',
  'reportHostOperation',
  'restartWorkerSession',
  'revokeAgentOrgGrant',
  'revokeAppGrant',
  'runTask',
  'setAgentTaskStallSchedule',
  'setAppAgentBootPrompt',
  'setAppChatbotAiConfig',
  'setAppDeliverySettings',
  'setAppMemoryWriteGrant',
  'setAppModelGroup',
  'setAppProperties',
  'setAppRoleList',
  'setAppSweepMode',
  'setAppTickerSettings',
  'setAutomationReadGrant',
  'setAutomationTeamSnapshotGrant',
  'setHostSetupSource',
  'setHostWorkerAvailability',
  'setHostWorkerTerminals',
  'setModelFamilyAvailability',
  'setOrgBootPromptSigning',
  'setOwnerLimits',
  'setQuotaLimit',
  'setSaturationAlarmWakeRoles',
  'setTeamPause',
  'setTeamStopSignal',
  'setWorkerAvailability',
  'setWorkerLeaveAlone',
  // #5394: startChat's appRef makes it a ref door; a signed-out start was already refused (requireRole READER).
  'startChat',
  'startConnection',
  'startImpersonation',
  'startSession',
  'transferMemoryOwnership',
  'triggerAppRun',
  'unassignHostWorker',
  'uninstallAgentFromApp',
  'uninstallApp',
  'unlinkGithubApp',
  'updateAgentTeamHost',
  'updateApp',
  'updateMemory',
  'updateMemorySubscription',
  'updateNode',
  'updateOrgGithubApp',
  'updateOrgMember',
  'updateOrganization',
  'updateReviewNode',
  'updateSpecNode',
  'updateTaskNode',
  'updateTeamCollections',
  'updateTeamRole',
];

vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let server: Server;
let base: string;
let orgId: string;
let orgUrn: string;
let appId: string;
let strangerToken: string;
let deletedOrgId: string;
let deletedAppId: string;
let appKeyRaw: string;

async function ask(query: string, bearer?: string) {
  const response = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ query }),
  });
  return { status: response.status, text: await response.text() };
}

const doors = (ref: string) => [
  `mutation { createAppKey(appRef: "${ref}") { rawKey } }`,
  `mutation { regenerateAppKey(appRef: "${ref}") { rawKey } }`,
  `mutation { updateOrganization(ref: "${ref}", name: "x") { id } }`,
  `mutation { deleteOrganization(ref: "${ref}") }`,
  `mutation { linkGithubApp(orgRef: "${ref}", installationId: 1) { id } }`,
  `mutation { unlinkGithubApp(orgRef: "${ref}") { id } }`,
];

beforeAll(async () => {
  server = createHttpServer(await createServerOnCleanDb());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await closeServerIfStarted(server); });

beforeEach(async () => {
  await cleanDb(db);
  orgUrn = `so85-${generateId().slice(0, 8)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'so85', urn: orgUrn } });
  orgId = org.id;
  const app = await db.app.create({ data: { id: generateId(), name: 'so85app', urn: `so85app-${generateId().slice(0, 8)}`, organizationId: orgId } });
  appId = app.id;
  const gone = await db.organization.create({ data: { id: generateId(), name: 'so85gone', urn: `so85gone-${generateId().slice(0, 8)}`, deletedAt: new Date() } });
  deletedOrgId = gone.id;
  const goneApp = await db.app.create({ data: { id: generateId(), name: 'so85goneapp', urn: `so85goneapp-${generateId().slice(0, 8)}`, organizationId: orgId, deletedAt: new Date() } });
  deletedAppId = goneApp.id;
  appKeyRaw = `hdr_app_${generateId().replace(/[^0-9a-f]/g, '').padEnd(64, '0').slice(0, 64)}`;
  await db.appKey.create({ data: { appId, keyHash: createHash('sha256').update(appKeyRaw).digest('hex'), keyPreview: appKeyRaw.slice(0, 12) } });
  const stranger = await db.user.create({ data: { handle: `so85-stranger-${generateId().slice(0, 6)}`, roles: ['READER'] } });
  strangerToken = await signJwt({ sub: stranger.id, roles: ['READER'] });
});

describe('#85 signed-out ref doors', () => {
  it('the derived door list is pinned exactly, so a door added or lost fails here', () => {
    expect(signedOutRefDoors(buildASTSchema(parse(typeDefs), { assumeValidSDL: true }))).toEqual(PINNED_DOORS);
  });

  it('every mutation whose resolver resolves an App or organization reference directly is a door', async () => {
    const { resolvers } = await import('./schema/resolvers.js');
    const doors = new Set(PINNED_DOORS);
    const direct = Object.entries(resolvers.Mutation as Record<string, unknown>)
      .filter(([, fn]) => typeof fn === 'function' && /resolve(App|Org)Ref\(/.test(String(fn)))
      .map(([name]) => name);
    expect(direct.filter((name) => !doors.has(name))).toEqual([]);
  });

  it('every mutation taking an argument named exactly `ref` whose name mentions an App or an organization is a door', () => {
    const schema = buildASTSchema(parse(typeDefs), { assumeValidSDL: true });
    const doors = new Set(PINNED_DOORS);
    const strays = Object.values(schema.getMutationType()!.getFields())
      .filter((f) => /app(?![a-z])|App(?![a-z])|org/i.test(f.name) && f.args.some((a) => a.name === 'ref' || a.name === 'id') && !doors.has(f.name))
      .map((f) => f.name);
    expect(strays).toEqual([]);
  });

  it('a signed-out caller gets one byte-identical UNAUTHENTICATED for a real, a missing and a malformed ref', async () => {
    for (let i = 0; i < doors('x').length; i += 1) {
      const answers = await Promise.all([appId, orgId, orgUrn, deletedOrgId, deletedAppId, generateId(), 'hrn:org:no-such', '@@ not a ref @@']
        .map(async (ref) => ask(doors(ref)[i]!)));
      const first = answers[0]!;
      expect(first.status, `door ${i}`).toBe(200);
      expect(JSON.parse(first.text).errors[0].extensions.code, `door ${i}`).toBe('UNAUTHENTICATED');
      for (const a of answers) expect(a, `door ${i}`).toEqual(first);
    }
  });

  it('85: detachMemoryFromApp signed out answers one raw-identical UNAUTHENTICATED whether the App and memory are real, missing or malformed, and writes nothing (#5185)', async () => {
    // A real memory linked into the real App, so a refusal that leaked "found" vs "missing" would show, and a detach that ran would be visible.
    const memory = await db.memory.create({ data: { id: generateId(), name: 'so85mem', urn: `${orgUrn}:m-${generateId().slice(-8)}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: orgId } as never });
    const attacher = await db.user.create({ data: { handle: `so85-attacher-${generateId().slice(0, 6)}`, roles: ['READER'] } });
    await db.appMemoryLink.create({ data: { appId, memoryId: memory.id, attachedBy: attacher.id } });
    const linksBefore = await db.appMemoryLink.count();
    const query = (memoryRef: string, appRef: string) => `mutation { detachMemoryFromApp(memoryRef: "${memoryRef}", appRef: "${appRef}") }`;
    const apps = [appId, orgId, orgUrn, deletedAppId, generateId(), 'hrn:app:no-such', '@@ not a ref @@'];
    const memories = [memory.id, memory.urn, generateId(), 'hrn:mem:no-such:memory', '@@ not a ref @@'];
    // ask() returns the raw HTTP status and body text, so toEqual below is byte identity of both.
    const answers = await Promise.all(apps.flatMap((appRef) => memories.map((memoryRef) => ask(query(memoryRef, appRef)))));
    const first = answers[0]!;
    expect(first.status).toBe(200);
    const body = JSON.parse(first.text) as { data?: unknown; errors?: Array<{ extensions?: { code?: string } }> };
    expect(body.errors).toHaveLength(1);
    expect(body.errors![0]!.extensions?.code).toBe('UNAUTHENTICATED');
    expect(body.data == null).toBe(true);
    for (const answer of answers) expect(answer).toEqual(first);
    expect(await db.appMemoryLink.count()).toBe(linksBefore);
  });

  it('writes nothing for a signed-out caller', async () => {
    const before = await db.appKey.count();
    for (const q of doors(appId)) await ask(q);
    for (const q of doors(orgId)) await ask(q);
    expect(await db.appKey.count()).toBe(before);
    expect((await db.organization.findUniqueOrThrow({ where: { id: orgId } })).name).toBe('so85');
  });

  it('a signed-in caller keeps the answers it had: a real and a missing ref are not UNAUTHENTICATED', async () => {
    for (const ref of [orgId, generateId()]) {
      for (const q of doors(ref)) {
        const a = await ask(q, strangerToken);
        expect(['FORBIDDEN', 'NOT_FOUND', 'ORGANIZATION_NOT_FOUND', 'APP_NOT_FOUND']).toContain(JSON.parse(a.text).errors[0].extensions.code);
      }
    }
  });

  it('an aliased door and a fragment-wrapped door are refused the same way signed out', async () => {
    const aliased = await ask(`mutation { x: createAppKey(appRef: "${appId}") { rawKey } }`);
    const fragmented = await ask(`mutation { ...F } fragment F on Mutation { ... on Mutation { createAppKey(appRef: "${appId}") { rawKey } } }`);
    for (const a of [aliased, fragmented]) expect(JSON.parse(a.text).errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('an App-key caller is not refused by the gate (its answer is the door\'s own)', async () => {
    for (const q of doors(appId)) {
      const a = await ask(q, appKeyRaw);
      const code = JSON.parse(a.text).errors?.[0]?.extensions?.code;
      expect(code).not.toBe('UNAUTHENTICATED');
    }
  });

  it('a mutation with no ref argument is not affected for a signed-out caller', async () => {
    const a = await ask('mutation { __typename }');
    expect(a.status).toBe(200);
    expect(a.text).toContain('Mutation');
  });
});
