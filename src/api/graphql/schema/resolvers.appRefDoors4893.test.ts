/**
 * #4893 — the remaining direct `resolveAppRef(` callers under src/api. Per door
 * (findings:app-ref-door-classes-4893): a door whose unknown-App answer already
 * collapses missing and unreachable FOLDS the other ref-resolution failures
 * (malformed, ambiguous) into that same answer via the shared list
 * `isAppRefResolutionFailure` — so a malformed ref is byte-identical to an
 * unknown App and never quotes the caller's value back (no `offendingValue`, no
 * parser message). A door that deliberately distinguishes missing from
 * unreachable (typed not-found vs FORBIDDEN — cor:api:140:01's default) KEEPS
 * the typed `URN_NOT_QUALIFIED` contract. A database fault always propagates.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError as formatError } from '../formatError.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });

const CANARY = 'hdr_user_CANARY0123456789abcdef';
const MALFORMED = [CANARY, `  ${CANARY}  `, `hrn:app:${CANARY}`, `a:${CANARY}`, 'hrn:app:', ':'];
const MISSING = 'mf-org.com:nope';

type Answer = { ok: true; value: unknown } | { ok: false; message: string; code: unknown; extra: string[] };
async function answer(p: Promise<unknown>): Promise<Answer> {
  try { return { ok: true, value: await p }; } catch (e) {
    const err = e instanceof GraphQLError ? e : new GraphQLError((e as Error).message, { originalError: e as Error });
    const f = formatError(err.toJSON() as any, err) as any;
    return { ok: false, message: f.message, code: f.extensions?.code, extra: Object.keys(f.extensions ?? {}).filter((k) => k !== 'code' && k !== 'stacktrace').sort() };
  }
}
/** Comparable shape: a value deep-compares; an error compares message/code and WHICH extensions exist
 *  (an extension carrying the caller's own ref is allowed to keep it — the door's unknown-App answer
 *  already carries it for a miss), never their parse-error content. */
const shape = (a: Answer): unknown =>
  a.ok ? { ok: true, value: a.value } : { ok: false, message: a.message, code: a.code, extra: a.extra };

let org: any, admin: any, member: any, outsider: any, teamAgent: any, app: any;
beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'mf-org', urn: 'mf-org.com' } });
  const mk = (n: number) => db.user.create({ data: { id: generateId(), githubId: 489_300 + n, githubUsername: `d93-${n}`, roles: ['READER'] }, select: { id: true } });
  admin = await mk(1); outsider = await mk(2); member = await mk(3);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  teamAgent = await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(admin.id));
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
});
const memberCtx = () => ctx(member.id);
const adminCtx = () => ctx(admin.id);

/** FOLD doors: every malformed shape answers exactly like a well-formed ref naming no App. */
const FOLD: Array<[string, (ref: string) => Promise<unknown>]> = [
  ['agentTasks', (r) => Q.agentTasks({}, { appRef: r }, memberCtx())],
  ['agentTasksPage', (r) => Q.agentTasksPage({}, { appRef: r, limit: 10 }, memberCtx())],
  ['agentTeamEvents', (r) => Q.agentTeamEvents({}, { appRef: r }, memberCtx())],
  ['agentTaskExternalIdChanges', (r) => Q.agentTaskExternalIdChanges({}, { appRef: r }, memberCtx())],
  ['createAgentTask(root)', (r) => M.createAgentTask({}, { input: { appRef: r, title: 'pin' } }, memberCtx())],
  ['automationApprovals', (r) => Q.automationApprovals({}, { appRef: r }, memberCtx())],
  ['agentServedBootPrompt', (r) => Q.agentServedBootPrompt({}, { agentRef: teamAgent.id, appRef: r }, memberCtx())],
  ['channels', (r) => Q.channels({}, { filter: { appRef: r } }, memberCtx())],
  ['chatAiConfigChoices', (r) => Q.chatAiConfigChoices({}, { appRef: r }, memberCtx())],
  ['setAppChatbotAiConfig', (r) => M.setAppChatbotAiConfig({}, { appRef: r }, memberCtx())],
  ['appRuns', (r) => Q.appRuns({}, { appRef: r, orgRef: org.id }, adminCtx())],
  ['latestAppRun', (r) => Q.latestAppRun({}, { appRef: r }, adminCtx())],
  ['quotaCounters', (r) => Q.quotaCounters({}, { orgRef: org.id, appRef: r }, adminCtx())],
  ['setQuotaLimit', (r) => M.setQuotaLimit({}, { input: { orgRef: org.id, appRef: r, action: 'run.execute', limit: 5 } }, adminCtx())],
  ['mintActionTickets', (r) => M.mintActionTickets({}, { input: { orgRef: org.id, appRef: r, action: 'comm.outbound', count: 1 } }, adminCtx())],
  ['deliveryBatches', (r) => Q.deliveryBatches({}, { appRef: r }, memberCtx())],
  ['registerHost', (r) => M.registerHost({}, { input: { appRef: r, label: 'pin-host', pollIntervalSeconds: 60 } }, memberCtx())],
  ['createGrant', (r) => M.createGrant({}, { input: { appRef: r, action: 'schedule.create', values: {}, holderKind: 'WORKER', holderRef: 'w1', reason: 'pin' } }, memberCtx())],
  ['appGrants', (r) => Q.appGrants({}, { appRef: r }, memberCtx())],
  ['appMemoryWriteGrants', (r) => Q.appMemoryWriteGrants({}, { appRef: r }, memberCtx())],
  ['secrets(app owner)', (r) => Q.secrets({}, { ownerType: 'app', ownerRef: r }, memberCtx())],
  ['createAppMemory', (r) => M.createAppMemory({}, { appRef: r, name: 'pin mem' }, memberCtx())],
  ['createTelegramConnection', (r) => M.createTelegramConnection({}, { appRef: r, botToken: '123:pin' }, memberCtx())],
  ['setAppAgentBootPrompt', (r) => M.setAppAgentBootPrompt({}, { appRef: r, agentRef: teamAgent.id }, memberCtx())],
  ['installMemory', (r) => Q.installMemory({}, { appRef: r, agentRef: teamAgent.id }, memberCtx())],
  ['memoryConfigTemplates(APP owner)', (r) => Q.memoryConfigTemplates({}, { filter: { ownerType: 'APP', ownerRef: r } }, memberCtx())],
  ['registerEntries(ownerRef)', (r) => Q.registerEntries({}, { filter: { ownerRef: r }, orgId: org.id }, memberCtx())],
  ['attendeeRegister', (r) => Q.attendeeRegister({}, { agentRef: teamAgent.id, appRef: r }, memberCtx())],
  ['questions', (r) => Q.questions({}, { appRef: r }, memberCtx())],
  ['setAutomationTeamSnapshotGrant', (r) => M.setAutomationTeamSnapshotGrant({}, { appRef: r, triggerKind: 'webhook', triggerId: 'w1' }, memberCtx())],
  ['scopes(owner APP)', (r) => Q.scopes({}, { filter: { ownerType: 'APP', ownerRef: r } }, memberCtx())],
  ['scopes(appRef context)', (r) => Q.scopes({}, { filter: { appRef: r } }, memberCtx())],
  ['scopeExplain', (r) => Q.scopeExplain({}, { name: 'x', appRef: r }, memberCtx())],
  ['app(ref:)', (r) => Q.app({}, { ref: r }, memberCtx())],
  ['worker(ref:, appRef:)', (r) => Q.worker({}, { ref: 'zed', appRef: r }, memberCtx())],
];

/** KEEP doors: the typed contract is deliberate (missing ≠ unreachable on the door) — a malformed
 *  ref keeps the boundary's typed `URN_NOT_QUALIFIED` (spec 022 / cor:api:140:01), a miss keeps
 *  the door's typed not-found. Pinned so a later sweep cannot silently over-fold them. */
const KEEP: Array<[string, (ref: string) => Promise<unknown>, unknown]> = [
  ['joinApp', (r) => M.joinApp({}, { appRef: r }, memberCtx()), 'AppNotFoundError'],
  ['appAIConfig', (r) => Q.appAIConfig({}, { appRef: r }, memberCtx()), 'APP_NOT_FOUND'],
  ['appKeys', (r) => Q.appKeys({}, { appRef: r }, memberCtx()), 'APP_NOT_FOUND'],
  ['regenerateAppKey', (r) => M.regenerateAppKey({}, { appRef: r }, memberCtx()), 'APP_NOT_FOUND'],
  ['createAppKey', (r) => M.createAppKey({}, { appRef: r }, memberCtx()), 'APP_NOT_FOUND'],
  ['leaveApp', (r) => M.leaveApp({}, { appRef: r }, memberCtx()), 'APP_NOT_FOUND'],
  ['appNodes', (r) => Q.appNodes({}, { appRef: r }, memberCtx()), 'APP_NOT_FOUND'],
  ['teamWorkItems', (r) => Q.teamWorkItems({}, { appRef: r }, memberCtx()), 'APP_NOT_FOUND'],
  ['createSlackConnection', (r) => M.createSlackConnection({}, { orgRef: org.id, appRef: r, botToken: 'x', appToken: 'y' }, adminCtx()), 'APP_NOT_FOUND'],
  ['createMemoryConfigTemplate(APP owner)', (r) => M.createMemoryConfigTemplate({}, { ownerType: 'APP', ownerRef: r, input: { name: 'pin-tpl' } }, adminCtx()), 'APP_NOT_FOUND'],
];

describe('#4893 fold doors: a malformed App ref answers exactly like an unknown App', () => {
  it('premise: the bare resolver throws the typed parse error, and it quotes the value', async () => {
    const caught: unknown[] = [];
    for (const r of MALFORMED) { try { await resolveAppRef(db, r); } catch (e) { caught.push(e); } }
    expect(caught.map((e) => (e as Error)?.constructor?.name)).toContain('UrnNotQualifiedError');
    expect(caught.map((e) => (e as Error).message).join('\n')).toContain('CANARY');
  });
  for (const [door, call] of FOLD) {
    it(`${door}: every malformed shape is byte-identical to the unknown-App answer`, async () => {
      const missRaw = await answer(call(MISSING));
      const miss = shape(missRaw);
      expect((miss as any).ok === false || (miss as any).ok === true).toBe(true); // baseline captured
      // A door whose message QUOTES the ref verbatim (chatbotAiConfig's AppNotFoundError, per
      // findings:app-ref-door-classes-4893) keeps that form: the malformed answer must equal
      // the miss message with MISSING replaced by the called ref — so text derived BEYOND the
      // verbatim ref (a parser message quoting a fragment) still fails.
      const quotes = missRaw.ok === false && missRaw.message.includes(MISSING);
      for (const r of MALFORMED) {
        const got = shape(await answer(call(r)));
        const expected = typeof (miss as any).message === 'string'
          ? { ...(miss as Record<string, unknown>), message: ((miss as any).message as string).split(MISSING).join(r) }
          : miss;
        expect(got).toEqual(expected);
        const json = JSON.stringify(got);
        expect(json).not.toContain('URN_NOT_QUALIFIED');
        expect(json).not.toContain('offendingValue');
        // On a door that does not quote the ref, any CANARY is an echo of the caller's token.
        if (!quotes) expect(json).not.toContain('CANARY');
      }
    });
  }
});

describe('#4893 keep doors: the typed URN_NOT_QUALIFIED contract stays', () => {
  for (const [door, call, missCode] of KEEP) {
    it(`${door}: malformed keeps URN_NOT_QUALIFIED, a miss keeps its typed answer`, async () => {
      const miss = await answer(call(MISSING));
      expect(miss).toMatchObject({ ok: false, code: missCode });
      const got = await answer(call(CANARY));
      expect(got).toMatchObject({ ok: false, code: 'URN_NOT_QUALIFIED' });
      expect((got as any).message).toContain('CANARY'); // the boundary quotes the caller's value (spec 022) — unchanged
    });
  }
});

describe('#4893 the fold stays narrow (a database fault is never the unknown-App answer)', () => {
  const faultyDb = (message = 'connection terminated') => {
    // Only app.findFirst faults (resolveAppRef's URN-path lookup); every other
    // model method delegates to the real client so the door under test runs.
    const appModel = new Proxy((db as any).app, {
      get: (t, k) => (k === 'findFirst' ? () => { throw new Error(message); } : (t as any)[k]),
    });
    return new Proxy(db, { get: (t, k) => (k === 'app' ? appModel : (t as any)[k]) }) as any;
  };
  it('a value door propagates the fault instead of answering null', async () => {
    const c = { ...memberCtx(), db: faultyDb() } as Context;
    await expect(Q.app({}, { ref: MISSING }, c)).rejects.toThrow('connection terminated');
  });
  it('a page door propagates the fault instead of an empty page', async () => {
    const c = { ...memberCtx(), db: faultyDb() } as Context;
    await expect(Q.channels({}, { filter: { appRef: MISSING } }, c)).rejects.toThrow('connection terminated');
  });
  it('a registration door propagates the fault instead of an empty list', async () => {
    const c = { ...memberCtx(), db: faultyDb() } as Context;
    await expect(Q.attendeeRegister({}, { agentRef: teamAgent.id, appRef: MISSING }, c)).rejects.toThrow('connection terminated');
  });
  it('a task door keeps the fault distinct from APP_NOT_FOUND', async () => {
    const c = { ...memberCtx(), db: faultyDb() } as Context;
    const got = await answer(Q.agentTasks({}, { appRef: MISSING }, c));
    expect(got).not.toMatchObject({ ok: false, code: 'APP_NOT_FOUND' });
  });
  it('appWriteGrant classifies refusals by type, never by words in a fault (#3275)', async () => {
    const c = { ...memberCtx(), db: faultyDb('URN lookup connection failed') } as Context;
    const got = await answer(Q.appMemoryWriteGrants({}, { appRef: MISSING }, c));
    expect(got).not.toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });
});
