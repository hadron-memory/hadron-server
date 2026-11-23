/**
 * #4893 — the remaining direct `resolveAppRef(` callers under src/api. Per door
 * (findings:app-ref-door-classes-4893): a door whose unknown-App answer already
 * collapses missing and unreachable FOLDS the other ref-resolution failures
 * (malformed, ambiguous) into that same answer via the shared list
 * `isAppRefResolutionFailure` — so a malformed or ambiguous ref is byte-identical
 * to an unknown App and never adds parser text beyond the ref itself (no
 * `offendingValue`, no parser message; a door whose miss answer already quotes
 * the ref verbatim keeps that quoting — the same echo a miss produces). A door
 * that deliberately distinguishes missing from unreachable (typed not-found vs
 * FORBIDDEN — cor:api:140:01's default) KEEPS the typed `URN_NOT_QUALIFIED`
 * contract; `requireScheduleAdmin`'s schedule/webhook doors are that class and
 * are pinned below by direct call. A database fault always propagates.
 *
 * Every FOLD row also carries a reaches-resolution control (Elena F4 on #4948):
 * a db whose `app.findFirst`/`memory.findFirst` faults only on the miss ref's
 * URN lookup must make the door REJECT — a row that refuses before resolution
 * (argument validation, a missing credential) never fires the fault and fails
 * the control, so no row can pass vacuously. The ambiguous legacy URN (two live
 * Apps in two orgs, plus an uninstalled third holding it as its current urn) is
 * Elena F3's fixture; the uninstall/reinstall doors are its FOLD pin (F2), and
 * the write-grant memory arm is F5's.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { formatGraphQLError as formatError } from '../formatError.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { withInstallMemory } from './installMemory.js';
import { requireScheduleAdmin } from './resolvers.appRun.js';
import { findCallerInstallMemory } from './resolvers.mutation.node.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });

const CANARY = 'hdr_user_CANARY0123456789abcdef';
// Baylor P2 on #4948: a NUL and a lone UTF-16 surrogate pass the urn grammar but no stored URN can
// contain them — the resolvers pre-reject them as names-nothing (#2975 §10), so they fold like any
// other malformed shape instead of surfacing a Postgres driver fault on the narrowed catches.
const MALFORMED = [CANARY, `  ${CANARY}  `, `hrn:app:${CANARY}`, `a:${CANARY}`, 'hrn:app:', ':', 'mf-org.com:no\u0000pe', 'mf-org.com:pe\uD800'];
const MISSING = 'mf-org.com:nope';
/** The typed miss used only by the reaches-resolution control: guaranteed to route to the App arm. */
const CONTROL_MISS = `hrn:app:${MISSING}`;
/** A legacy URN two live Apps in two orgs both hold (F3), with an uninstalled third holding it as its CURRENT urn. */
const AMBIG = 'amb.example:dup';

type Answer = { ok: true; value: unknown; rawJson: string } | { ok: false; message: string; code: unknown; extra: string[]; rawJson: string };
async function answer(p: Promise<unknown>): Promise<Answer> {
  try { return { ok: true, value: await p, rawJson: '' }; } catch (e) {
    const err = e instanceof GraphQLError ? e : new GraphQLError((e as Error).message, { originalError: e as Error });
    const f = formatError(err.toJSON() as any, err) as any;
    return {
      ok: false, message: f.message, code: f.extensions?.code,
      extra: Object.keys(f.extensions ?? {}).filter((k) => k !== 'code' && k !== 'stacktrace').sort(),
      // Rook P3 on #4948: the FULL formatted error, values included — the `extra` list above
      // carries only extension KEYS, so an extension VALUE echoing the caller's token would
      // otherwise pass unseen.
      rawJson: JSON.stringify({ message: f.message, extensions: f.extensions }),
    };
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
  // F3: two LIVE Apps in two orgs share a legacy URN, and an uninstalled third holds it as its
  // current urn — resolveAppRef refuses it as ambiguous; locate()'s uninstalled fallback (F2) finds
  // exactly the third, whose gate then refuses the caller like any unknown App.
  const orgB = await db.organization.create({ data: { id: generateId(), name: 'mf-org2', urn: 'mf-org2.com' } });
  await db.app.create({ data: { id: generateId(), organizationId: orgB.id, name: 'Other', urn: `${orgB.urn}:team`, legacyUrn: AMBIG } });
  await db.app.update({ where: { id: app.id }, data: { legacyUrn: AMBIG } });
  const orgC = await db.organization.create({ data: { id: generateId(), name: 'mf-org3', urn: 'mf-org3.com' } });
  await db.app.create({ data: { id: generateId(), organizationId: orgC.id, name: 'Uninstalled holder', urn: AMBIG, uninstalledAt: new Date() } });
});
const memberCtx = () => ctx(member.id);
const adminCtx = () => ctx(admin.id);
/** An App-key caller (no user, no session) for the host-key doors, whose person ctx never reaches resolution. */
const keyCtx = () => ctx(undefined, { appId: app.id, appKeyId: 'pin-key' });

/** A worker-session caller for createGrant's WORKER arm — the arm whose catch moved onto the shared
 *  fold list. A plain member is no worker reader (`resolveGrantReader` returns null), so the FOLD
 *  table's createGrant row drives the MANAGER path and this arm needs its own caller: a live worker
 *  of `app`, driven by its member through an open session (`runAsActor` binds `currentActor()`). */
async function workerArmCtx(): Promise<{ ctx: Context; workerId: string }> {
  const worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: teamAgent.id, name: 'd93-worker', slug: `d93-worker-${generateId().slice(0, 6)}` },
  });
  const session = await db.session.create({
    data: { id: generateId(), appId: app.id, workerId: worker.id, agentId: teamAgent.id, userId: member.id } as never,
  });
  return { ctx: ctx(member.id, { sessionId: session.id }), workerId: worker.id };
}
const createGrantAsWorker = (ref: string, c: Context, holderRef: string, action = 'schedule.create') =>
  M.createGrant({}, { input: { appRef: ref, action, values: {}, holderKind: 'WORKER', holderRef, reason: 'pin' } }, c);

/** FOLD doors: every malformed shape answers exactly like a well-formed ref naming no App. Each row
 *  names its caller ctx; the harness injects a faulty db into the same ctx for the control. */
const FOLD: Array<[string, (ref: string, c: Context) => Promise<unknown>, () => Context, string?]> = [
  ['agentTasks', (r, c) => Q.agentTasks({}, { appRef: r }, c), memberCtx],
  ['agentTasksPage', (r, c) => Q.agentTasksPage({}, { appRef: r, limit: 10 }, c), memberCtx],
  ['agentTeamEvents', (r, c) => Q.agentTeamEvents({}, { appRef: r }, c), memberCtx],
  ['agentTaskExternalIdChanges', (r, c) => Q.agentTaskExternalIdChanges({}, { appRef: r }, c), memberCtx],
  ['createAgentTask(root)', (r, c) => M.createAgentTask({}, { input: { appRef: r, title: 'pin' } }, c), memberCtx],
  ['automationApprovals', (r, c) => Q.automationApprovals({}, { appRef: r }, c), memberCtx],
  ['agentServedBootPrompt', (r, c) => Q.agentServedBootPrompt({}, { agentRef: teamAgent.id, appRef: r }, c), memberCtx],
  ['channels', (r, c) => Q.channels({}, { filter: { appRef: r } }, c), memberCtx],
  ['chatAiConfigChoices', (r, c) => Q.chatAiConfigChoices({}, { appRef: r }, c), memberCtx],
  ['setAppChatbotAiConfig', (r, c) => M.setAppChatbotAiConfig({}, { appRef: r }, c), memberCtx],
  ['appRuns', (r, c) => Q.appRuns({}, { appRef: r, orgRef: org.id }, c), adminCtx],
  ['latestAppRun', (r, c) => Q.latestAppRun({}, { appRef: r }, c), adminCtx],
  ['quotaCounters', (r, c) => Q.quotaCounters({}, { orgRef: org.id, appRef: r }, c), adminCtx],
  ['setQuotaLimit', (r, c) => M.setQuotaLimit({}, { input: { orgRef: org.id, appRef: r, action: 'run.execute', limit: 5 } }, c), adminCtx],
  ['mintActionTickets', (r, c) => M.mintActionTickets({}, { input: { orgRef: org.id, appRef: r, action: 'comm.outbound', count: 1 } }, c), adminCtx],
  ['deliveryBatches', (r, c) => Q.deliveryBatches({}, { appRef: r }, c), keyCtx],
  ['registerHost', (r, c) => M.registerHost({}, { input: { appRef: r, label: 'pin-host', pollIntervalSeconds: 60 } }, c), keyCtx],
  ['createGrant', (r, c) => M.createGrant({}, { input: { appRef: r, action: 'schedule.create', values: {}, holderKind: 'WORKER', holderRef: 'w1', reason: 'pin' } }, c), memberCtx],
  ['appGrants', (r, c) => Q.appGrants({}, { appRef: r }, c), memberCtx],
  ['appMemoryWriteGrants', (r, c) => Q.appMemoryWriteGrants({}, { appRef: r }, c), memberCtx],
  ['secrets(app owner)', (r, c) => Q.secrets({}, { ownerType: 'app', ownerRef: r }, c), memberCtx],
  ['createAppMemory', (r, c) => M.createAppMemory({}, { appRef: r, name: 'pin mem' }, c), memberCtx],
  ['createTelegramConnection', (r, c) => M.createTelegramConnection({}, { appRef: r, botToken: '123:pin' }, c), memberCtx],
  // nodeRef: null — the door refuses a MISSING nodeRef before any App resolution (presence, not
  // truthiness), so without the key the row pinned only that early refusal (Elena F4's control).
  ['setAppAgentBootPrompt', (r, c) => M.setAppAgentBootPrompt({}, { appRef: r, agentRef: teamAgent.id, nodeRef: null }, c), memberCtx],
  ['installMemory', (r, c) => Q.installMemory({}, { appRef: r, agentRef: teamAgent.id }, c), memberCtx],
  ['memoryConfigTemplates(APP owner)', (r, c) => Q.memoryConfigTemplates({}, { filter: { ownerType: 'APP', ownerRef: r } }, c), memberCtx],
  // adminCtx: memberCtx never passes resolveOrgScope (member is only an appMember), so the row
  // would not reach the owner arm at all — Elena F4's control catches exactly that vacuous row.
  ['registerEntries(ownerRef)', (r, c) => Q.registerEntries({}, { filter: { ownerRef: r }, orgId: org.id }, c), adminCtx],
  ['attendeeRegister', (r, c) => Q.attendeeRegister({}, { agentRef: teamAgent.id, appRef: r }, c), memberCtx],
  ['questions', (r, c) => Q.questions({}, { appRef: r }, c), memberCtx],
  ['setAutomationTeamSnapshotGrant', (r, c) => M.setAutomationTeamSnapshotGrant({}, { appRef: r, triggerKind: 'webhook', triggerId: 'w1' }, c), memberCtx],
  ['scopes(owner APP)', (r, c) => Q.scopes({}, { filter: { ownerType: 'APP', ownerRef: r } }, c), memberCtx],
  ['scopes(appRef context)', (r, c) => Q.scopes({}, { filter: { appRef: r } }, c), memberCtx],
  ['scopeExplain', (r, c) => Q.scopeExplain({}, { name: 'x', appRef: r }, c), memberCtx],
  ['app(ref:)', (r, c) => Q.app({}, { ref: r }, c), memberCtx],
  ['worker(ref:, appRef:)', (r, c) => Q.worker({}, { ref: 'zed', appRef: r }, c), memberCtx],
  ['uninstallApp', (r, c) => M.uninstallApp({}, { ref: r }, c), memberCtx],
  ['reinstallApp', (r, c) => M.reinstallApp({}, { ref: r }, c), memberCtx],
  // adminCtx (Elena F5): memberCtx is refused at the door's App gate before the MEMORY arm ever
  // resolves, so the row pinned nothing about the memory ref. The admin passes the gate and the
  // memory arm's fold is what this row exists to pin. The control ref is MEMORY-shaped: an
  // app-shaped URN is refused by resolveMemoryRef's kind boundary before any lookup, so the
  // default control would prove nothing on this row.
  ['setAppMemoryWriteGrant(memory arm)', (r, c) => M.setAppMemoryWriteGrant({}, { appRef: app.urn, memoryRef: r, prefix: 'pin' }, c), adminCtx, `hrn:mem:${MISSING}`],
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
  it('premise: the ambiguous legacy URN is refused as ambiguous by the bare resolver', async () => {
    await expect(resolveAppRef(db, AMBIG)).rejects.toMatchObject({ name: 'AmbiguousLegacyUrnError' });
  });
  for (const [door, call, mkCtx, controlRef] of FOLD) {
    it(`${door}: every malformed or ambiguous shape is byte-identical to the unknown-App answer`, async () => {
      const missRaw = await answer(call(MISSING, mkCtx()));
      const miss = shape(missRaw);
      for (const r of [...MALFORMED, AMBIG]) {
        const gotRaw = await answer(call(r, mkCtx()));
        const got = shape(gotRaw);
        const expected = typeof (miss as any).message === 'string'
          ? { ...(miss as Record<string, unknown>), message: ((miss as any).message as string).split(MISSING).join(r) }
          : miss;
        expect(got).toEqual(expected);
        // Full-form equality (Rook P3 on #4948): the WHOLE formatted error — message, code, every
        // extension KEY and VALUE — equals the miss answer with the ref substituted. A door may
        // echo the ref VERBATIM (in the message or an extension value — several task doors carry
        // `appRef: <ref>`; findings:app-ref-door-classes-4893) because a miss echoes it the same
        // way; anything BEYOND that echo — parser text, `offendingValue`, `URN_NOT_QUALIFIED`, an
        // extension key or value a miss never carries — fails here. The rawJson side substitutes
        // the JSON-ESCAPED ref (a NUL renders as the six characters \u0000 once serialized).
        const jsonEscaped = (s: string) => JSON.stringify(s).slice(1, -1);
        expect(gotRaw.rawJson).toBe(missRaw.rawJson.split(MISSING).join(jsonEscaped(r)));
      }
    });
    it(`${door}: the row reaches ref resolution (the conditional fault fires)`, async () => {
      const c = { ...mkCtx(), db: resolutionFaultDb() } as Context;
      await expect(call(controlRef ?? CONTROL_MISS, c)).rejects.toThrow('resolution-reached fault');
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
    await expect(Q.agentTasks({}, { appRef: MISSING }, c)).rejects.toThrow('connection terminated');
  });
  it('appWriteGrant classifies refusals by type, never by words in a fault (#3275)', async () => {
    const c = { ...memberCtx(), db: faultyDb('URN lookup connection failed') } as Context;
    await expect(Q.appMemoryWriteGrants({}, { appRef: MISSING }, c)).rejects.toThrow('URN lookup connection failed');
  });
});

describe('#4893 createGrant worker arm: the scoped lookup folds what it can reach (Celine P2 on #4948)', () => {
  // The FOLD table's createGrant row drives the MANAGER path (resolveGrantReader is null for a
  // plain member), so the WORKER arm's appRef branch — the one the branch moved onto the shared
  // fold list — had no row at all. Its lookup is SCOPED to the caller's own App (#3914: foreign
  // alias history must not disclose ambiguity), and a single-id scope can match at most one row
  // per alias source, so AmbiguousLegacyUrnError is UNREACHABLE at this door: the shared-list
  // change is behavior-preserving here and the merge-base mutant survives BY CONSTRUCTION (the
  // only shapes the two catches treat differently cannot occur under the scope). What IS
  // behavioral is pinned instead: malformed folds byte-identically to a miss, the arm reaches
  // ref resolution, and the caller's OWN App's legacy alias RESOLVES under the scope instead of
  // folding — dropping the scope would turn AMBIG into the worker refusal and go red below.
  it('malformed ≡ miss: the same GRANT_REQUESTER_NOT_WORKER bytes', async () => {
    const { ctx: c, workerId } = await workerArmCtx();
    const call = (r: string) => runAsActor({ workerId, agentId: teamAgent.id }, () => createGrantAsWorker(r, c, workerId));
    const missRaw = await answer(call(MISSING));
    expect(missRaw).toMatchObject({ ok: false, code: 'GRANT_REQUESTER_NOT_WORKER' });
    const jsonEscaped = (s: string) => JSON.stringify(s).slice(1, -1);
    for (const r of MALFORMED) {
      const gotRaw = await answer(call(r));
      expect(shape(gotRaw)).toEqual(shape(missRaw));
      expect(gotRaw.rawJson).toBe(missRaw.rawJson.split(MISSING).join(jsonEscaped(r)));
    }
  });
  it('the arm reaches ref resolution (the conditional fault fires)', async () => {
    const { ctx: c, workerId } = await workerArmCtx();
    const faulty = { ...c, db: resolutionFaultDb() } as Context;
    await expect(runAsActor({ workerId, agentId: teamAgent.id }, () => createGrantAsWorker(CONTROL_MISS, faulty, workerId)))
      .rejects.toThrow('resolution-reached fault');
  });
  it('the own-App legacy alias resolves under the scope, past the worker refusal', async () => {
    const { ctx: c, workerId } = await workerArmCtx();
    // The action is incidental to this row and deliberately names nothing registered: the actions
    // registry is world state this suite does not own — cleanDb keeps it, and a shard-mate that
    // registers platform actions turns a 'schedule.create' input into GRANT_VALUES_INVALID for
    // empty values (the CI-only red the first push caught on this exact row). A name nothing
    // registers makes the post-resolution outcome deterministic in every environment.
    const got = await answer(runAsActor({ workerId, agentId: teamAgent.id }, () => createGrantAsWorker(AMBIG, c, workerId, 'pin.4893-no-such-action')));
    // AMBIG is this worker's OWN App's legacyUrn in this world: the scoped lookup resolves it and
    // the door proceeds into grant creation, where it meets the first creation refusal — an
    // outcome the folded answer never reaches, because GRANT_REQUESTER_NOT_WORKER answers
    // before any grant machinery runs.
    expect(got).toMatchObject({ ok: false, code: 'GRANT_ACTION_UNKNOWN' });
  });
});

/**
 * F4's control: a db whose `app.findFirst`/`memory.findFirst` throws ONLY on the miss ref's
 * URN-path lookup. A door that reaches ref resolution with the caller's ref sees the fault and
 * (per the narrow-fold contract) propagates it; a door that refuses earlier never fires it, so a
 * vacuous row fails here instead of passing on nothing.
 */
function resolutionFaultDb() {
  const hits = (args: unknown) => JSON.stringify((args as { where?: unknown } | undefined)?.where ?? {}).includes(MISSING);
  const wrap = (model: object) => new Proxy(model, {
    get: (t, k) => (k === 'findFirst'
      ? (args: unknown) => { if (hits(args)) throw new Error('resolution-reached fault'); return (t as any).findFirst(args); }
      : (t as any)[k]),
  });
  return new Proxy(db, {
    get: (t, k) => (k === 'app' || k === 'memory' ? wrap((t as any)[k]) : (t as any)[k]),
  }) as any;
}

describe('#4893 withInstallMemory folds the App arm alone (the Agent arm keeps its typed contract)', () => {
  it('a malformed APP ref folds to the door AppNotFoundError', async () => {
    await expect(withInstallMemory(memberCtx(), { appRef: CANARY, agentRef: teamAgent.id }, async () => 1))
      .rejects.toMatchObject({ name: 'AppNotFoundError' });
  });
  it('a malformed AGENT ref keeps the boundary typed answer, not an App miss (Elena F1 on #4948)', async () => {
    await expect(withInstallMemory(memberCtx(), { appRef: app.urn, agentRef: CANARY }, async () => 1))
      .rejects.toMatchObject({ name: 'UrnNotQualifiedError' });
  });
});

describe('#4893 the schedule doors stay KEEP: requireScheduleAdmin keeps the typed contract', () => {
  it('malformed keeps URN_NOT_QUALIFIED; a miss keeps the resolver’s typed AppNotFoundError', async () => {
    await expect(requireScheduleAdmin(adminCtx(), CANARY)).rejects.toMatchObject({ name: 'UrnNotQualifiedError' });
    // The door lets resolveAppRef's typed miss propagate raw (the GraphQL NOT_FOUND wrap fires
    // only for an App that resolved but is gone) — that is the KEEP contract being pinned.
    await expect(requireScheduleAdmin(adminCtx(), MISSING)).rejects.toMatchObject({ name: 'AppNotFoundError' });
  });
});

describe('#4893 findCallerInstallMemory folds both arms into its one not-customised answer', () => {
  it('a malformed or ambiguous ref on either arm answers INSTALL_MEMORY_NOT_FOUND', async () => {
    const refused = { extensions: { code: 'INSTALL_MEMORY_NOT_FOUND' } };
    await expect(findCallerInstallMemory(memberCtx(), { appRef: app.urn, agentRef: CANARY })).rejects.toMatchObject(refused);
    await expect(findCallerInstallMemory(memberCtx(), { appRef: CANARY, agentRef: teamAgent.id })).rejects.toMatchObject(refused);
    await expect(findCallerInstallMemory(memberCtx(), { appRef: AMBIG, agentRef: teamAgent.id })).rejects.toMatchObject(refused);
  });
});
