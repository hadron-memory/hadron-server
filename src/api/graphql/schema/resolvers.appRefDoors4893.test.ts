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
 * Every FOLD row also carries a reaches-resolution control (#4948):
 * a db whose `app.findFirst`/`memory.findFirst` faults only on the miss ref's
 * URN lookup must make the door REJECT — a row that refuses before resolution
 * (argument validation, a missing credential) never fires the fault and fails
 * the control, so no row can pass vacuously. The ambiguous legacy URN (two live
 * Apps in two orgs, plus an uninstalled third holding it as its current urn) is
 * the ambiguity fixture; the uninstall/reinstall doors pin its FOLD, and
 * the write-grant memory arm is pinned the same way.
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
// #4948: a NUL and a lone UTF-16 surrogate pass the urn grammar but no stored URN can
// contain them — the resolvers pre-reject them as names-nothing (#2975 §10), so they fold like any
// other malformed shape instead of surfacing a Postgres driver fault on the narrowed catches.
const MALFORMED = [CANARY, `  ${CANARY}  `, `hrn:app:${CANARY}`, `a:${CANARY}`, 'hrn:app:', ':', 'mf-org.com:no\u0000pe', 'mf-org.com:pe\uD800', 'mf-org.com:pe\uDC00'];
const MISSING = 'mf-org.com:nope';
/** The typed miss used only by the reaches-resolution control: guaranteed to route to the App arm. */
const CONTROL_MISS = `hrn:app:${MISSING}`;
/** A legacy URN two live Apps in two orgs both hold, with an uninstalled third holding it as its CURRENT urn. */
const AMBIG = 'amb.example:dup';

type Answer = { ok: true; value: unknown; rawJson: string } | { ok: false; message: string; code: unknown; extra: string[]; rawJson: string };
async function answer(p: Promise<unknown>): Promise<Answer> {
  try { return { ok: true, value: await p, rawJson: '' }; } catch (e) {
    const err = e instanceof GraphQLError ? e : new GraphQLError((e as Error).message, { originalError: e as Error });
    const f = formatError(err.toJSON() as any, err) as any;
    return {
      ok: false, message: f.message, code: f.extensions?.code,
      extra: Object.keys(f.extensions ?? {}).filter((k) => k !== 'code' && k !== 'stacktrace').sort(),
      // #4948: the FULL formatted error, values included — the `extra` list above
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

let org: any, admin: any, member: any, outsider: any, teamAgent: any, app: any, orgBAdmin: any, orgCAdmin: any, uninstalledApp: any;
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
  // Two LIVE Apps in two orgs share a legacy URN, and an uninstalled third holds it as its
  // current urn — resolveAppRef refuses it as ambiguous; locate()'s uninstalled fallback finds
  // exactly the third, whose gate then refuses the caller like any unknown App. Each claimant org
  // has an ADMIN, so the fallthrough rows can pin every caller class (#4948).
  const orgB = await db.organization.create({ data: { id: generateId(), name: 'mf-org2', urn: 'mf-org2.com' } });
  orgBAdmin = await mk(4);
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgB.id, userId: orgBAdmin.id, role: 'ADMIN' } });
  await db.app.create({ data: { id: generateId(), organizationId: orgB.id, name: 'Other', urn: `${orgB.urn}:team`, legacyUrn: AMBIG } });
  // Load-bearing fixture: every ambiguous FOLD row and the locate fallthrough suite below key on
  // THIS App's legacyUrn being AMBIG — changing it here re-baselines all of them.
  await db.app.update({ where: { id: app.id }, data: { legacyUrn: AMBIG } });
  const orgC = await db.organization.create({ data: { id: generateId(), name: 'mf-org3', urn: 'mf-org3.com' } });
  orgCAdmin = await mk(5);
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgC.id, userId: orgCAdmin.id, role: 'ADMIN' } });
  uninstalledApp = await db.app.create({ data: { id: generateId(), organizationId: orgC.id, name: 'Uninstalled holder', urn: AMBIG, uninstalledAt: new Date() } });
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
  // truthiness), so without the key the row pinned only that early refusal (the control catches it).
  ['setAppAgentBootPrompt', (r, c) => M.setAppAgentBootPrompt({}, { appRef: r, agentRef: teamAgent.id, nodeRef: null }, c), memberCtx],
  ['installMemory', (r, c) => Q.installMemory({}, { appRef: r, agentRef: teamAgent.id }, c), memberCtx],
  ['memoryConfigTemplates(APP owner)', (r, c) => Q.memoryConfigTemplates({}, { filter: { ownerType: 'APP', ownerRef: r } }, c), memberCtx],
  // adminCtx: memberCtx never passes resolveOrgScope (member is only an appMember), so the row
  // would not reach the owner arm at all — the control catches exactly that vacuous row.
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
  // adminCtx (#4948): memberCtx is refused at the door's App gate before the MEMORY arm ever
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
        // Full-form equality (#4948): the WHOLE formatted error — message, code, every
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
    it(`${door}: the row reaches ref resolution on both lookup paths (the conditional fault fires)`, async () => {
      // #4948: the control used to prove only the fully-qualified
      // URN path (CONTROL_MISS → app.findFirst); the FOLD rows' MISSING baseline takes the LEGACY
      // alias path (app.findMany + urnAlias.findMany), which a control on the urn path alone says
      // nothing about — a door that refused the legacy form before resolution would have passed
      // vacuously. Both paths now fault through the same wrapped db. A row with an explicit
      // controlRef runs only that ref: its arm's URN boundary refuses the bare MISSING shape
      // BEFORE any lookup (resolveMemoryRef requires a fully-qualified URN, so a bare root:slug
      // never reaches a query), and the controlRef IS that arm's fully-qualified miss — the one
      // ref that does reach the memory lookup.
      const c = { ...mkCtx(), db: resolutionFaultDb() } as Context;
      for (const ref of controlRef ? [controlRef] : [CONTROL_MISS, MISSING]) {
        await expect(call(ref, c)).rejects.toThrow('resolution-reached fault');
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
    await expect(Q.agentTasks({}, { appRef: MISSING }, c)).rejects.toThrow('connection terminated');
  });
  it('appWriteGrant classifies refusals by type, never by words in a fault (#3275)', async () => {
    const c = { ...memberCtx(), db: faultyDb('URN lookup connection failed') } as Context;
    await expect(Q.appMemoryWriteGrants({}, { appRef: MISSING }, c)).rejects.toThrow('URN lookup connection failed');
  });
});

describe('#4893 createGrant worker arm: the scoped lookup folds what it can reach (#4948)', () => {
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
 * The reaches-resolution control: a db whose resolution lookups throw ONLY when the caller's miss ref is in the
 * where — `app.findFirst`/`memory.findFirst` (the primary URN path), `app.findMany`/`urnAlias.findMany`
 * (the legacy alias path) and `worker.findFirst` (the workerRef arm). A door that reaches ref
 * resolution with the caller's ref sees the fault and (per the narrow-fold contract) propagates it; a
 * door that refuses earlier never fires it, so a vacuous row fails here instead of passing on nothing.
 * Extra markers extend the fault key past the miss ref, so a row can fault a LATER lookup (the
 * worker-row read) without firing the App resolution on the way in.
 */
function resolutionFaultDb(...extraMarkers: string[]) {
  // #4971 (NEW-13): the extra markers belong to the WORKER-row read alone. Applied to every model they could
  // also fire on the App lookup, and a row meant to fault the later worker read would fault on the way in.
  const hits = (markers: string[], args: unknown) => {
    const where = JSON.stringify((args as { where?: unknown } | undefined)?.where ?? {});
    return markers.some((m) => where.includes(m));
  };
  const wrap = (model: object, methods: string[], markers: string[] = [MISSING]) => new Proxy(model, {
    get: (t, k) => (methods.includes(k as string)
      ? (args: unknown) => { if (hits(markers, args)) throw new Error('resolution-reached fault'); return (t as any)[k](args); }
      : (t as any)[k]),
  });
  return new Proxy(db, {
    get: (t, k) => {
      if (k === 'app') return wrap((t as any).app, ['findFirst', 'findMany']);
      if (k === 'memory') return wrap((t as any).memory, ['findFirst']);
      if (k === 'urnAlias') return wrap((t as any).urnAlias, ['findMany']);
      if (k === 'worker') return wrap((t as any).worker, ['findFirst'], [MISSING, ...extraMarkers]);
      return (t as any)[k];
    },
  }) as any;
}

describe('#4893 withInstallMemory folds the App arm alone (the Agent arm keeps its typed contract)', () => {
  it('a malformed APP ref folds to the door AppNotFoundError', async () => {
    await expect(withInstallMemory(memberCtx(), { appRef: CANARY, agentRef: teamAgent.id }, async () => 1))
      .rejects.toMatchObject({ name: 'AppNotFoundError' });
  });
  it('a malformed AGENT ref keeps the boundary typed answer, not an App miss (#4948)', async () => {
    await expect(withInstallMemory(memberCtx(), { appRef: app.urn, agentRef: CANARY }, async () => 1))
      .rejects.toMatchObject({ name: 'UrnNotQualifiedError' });
  });
  // The participant gates judge BEFORE the Agent resolves, so a caller the gates refuse gets the one
  // unknown-App answer whatever their agentRef says — the typed Agent errors are reachable only for a
  // caller the gates already admitted. Before the reorder this was an App-existence oracle: a
  // non-participant could tell an existing App (typed Agent error) from a missing one (AppNotFoundError).
  it('a non-participant cannot tell an existing App from a missing one through the Agent arm', async () => {
    const jsonEscaped = (s: string) => JSON.stringify(s).slice(1, -1);
    for (const agentRef of [...MALFORMED, 'hrn:agent:mf-org.com:ghost']) {
      const existing = await answer(withInstallMemory(ctx(outsider.id), { appRef: app.urn, agentRef }, async () => 1));
      const missing = await answer(withInstallMemory(ctx(outsider.id), { appRef: MISSING, agentRef }, async () => 1));
      // Same shape, and the same bytes once the caller's own App ref is substituted — no Agent-arm
      // text, no parse contract, nothing that differs between an App that exists and one that does not.
      const missShape = shape(missing) as Record<string, unknown>;
      expect(shape(existing)).toEqual(
        typeof missShape.message === 'string'
          ? { ...missShape, message: (missShape.message as string).split(MISSING).join(app.urn) }
          : missShape,
      );
      expect(existing.rawJson).toBe(missing.rawJson.split(MISSING).join(jsonEscaped(app.urn)));
    }
  });
  it('the gates-admitted caller keeps the typed Agent contract (the typed row after the reorder)', async () => {
    await expect(withInstallMemory(memberCtx(), { appRef: app.urn, agentRef: 'hrn:agent:mf-org.com:ghost' }, async () => 1))
      .rejects.toMatchObject({ name: 'AgentNotFoundError' });
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
  // #4948 (test gap): the two-arm fold must not swallow an operational fault.
  it('a resolution fault propagates instead of answering not-customised', async () => {
    const c = { ...memberCtx(), db: resolutionFaultDb() } as Context;
    await expect(findCallerInstallMemory(c, { appRef: CONTROL_MISS, agentRef: teamAgent.id }))
      .rejects.toThrow('resolution-reached fault');
  });
});

describe('#4893 deliveryBatches task arm: the own-session caller folds like the host arm (#4948)', () => {
  // The FOLD table's deliveryBatches row drives the HOST arm (keyCtx carries no session), so the
  // task arm's narrowed catch — selfBatches' appRef lookup — had no row. Its caller is a live
  // worker session of the App driven by its member.
  const call = (r: string, c: Context) => Q.deliveryBatches({}, { appRef: r }, c);
  it('malformed ≡ miss: the same APP_NOT_FOUND bytes through the own-session arm', async () => {
    const { ctx: c, workerId } = await workerArmCtx();
    const run = (r: string) => runAsActor({ workerId, agentId: teamAgent.id }, () => call(r, c));
    const missRaw = await answer(run(MISSING));
    expect(missRaw).toMatchObject({ ok: false, code: 'APP_NOT_FOUND' });
    const jsonEscaped = (s: string) => JSON.stringify(s).slice(1, -1);
    for (const r of [...MALFORMED, AMBIG]) {
      const gotRaw = await answer(run(r));
      expect(shape(gotRaw)).toEqual(shape(missRaw));
      expect(gotRaw.rawJson).toBe(missRaw.rawJson.split(MISSING).join(jsonEscaped(r)));
    }
  });
  it('the task arm reaches ref resolution (the conditional fault fires, not APP_NOT_FOUND)', async () => {
    const { ctx: c, workerId } = await workerArmCtx();
    const faulty = { ...c, db: resolutionFaultDb() } as Context;
    await expect(runAsActor({ workerId, agentId: teamAgent.id }, () => call(CONTROL_MISS, faulty)))
      .rejects.toThrow('resolution-reached fault');
  });
});

describe('#4893 a fault wins the two-arm folds (#4948)', () => {
  // readableAttendee's settled pair (register's read-state doors): an app-arm fault must win even
  // while the agent arm fails to resolve — the `if (fault) throw` line had no pin.
  it('channelReadState propagates an app-arm fault beside a names-nothing agent arm', async () => {
    const c = { ...memberCtx(), db: resolutionFaultDb() } as Context;
    await expect(Q.channelReadState({}, { attendeeRef: CANARY, appRef: CONTROL_MISS, channelRef: 'ch:pin' }, c))
      .rejects.toThrow('resolution-reached fault');
  });
  // The register worker arm's try holds resolution AND the worker-row read. This row faults the
  // APP resolution inside the worker arm: the v2 worker URN resolves its App first
  // (composeUrnV2 → hrn:app:mf-org.com:nope), so the miss marker fires there.
  it('attendeeRegister propagates a workerRef-arm resolution fault instead of the empty list', async () => {
    const c = { ...memberCtx(), db: resolutionFaultDb() } as Context;
    await expect(Q.attendeeRegister({}, { workerRef: 'hrn:worker:mf-org.com:nope:zed' }, c))
      .rejects.toThrow('resolution-reached fault');
  });
  // …and this one faults the WORKER-ROW read itself: the ref's App segment names the REAL App
  // (hrn:app:mf-org.com:team, no marker), so the App resolution completes and only the worker
  // lookup — keyed on the marker slug — faults. That lookup runs inside the same narrowed catch,
  // and a fault there must propagate instead of the empty list.
  it('attendeeRegister propagates a worker-row fault (after the App resolves) instead of the empty list', async () => {
    const c = { ...memberCtx(), db: resolutionFaultDb('d93-faultpin') } as Context;
    await expect(Q.attendeeRegister({}, { workerRef: 'hrn:worker:mf-org.com:team:d93-faultpin' }, c))
      .rejects.toThrow('resolution-reached fault');
  });
});

describe("#4893 locate's ambiguous fallthrough is caller-neutral (#4948)", () => {
  // locate(AMBIG) reaches the uninstalled current-urn holder for EVERY caller; the gate decides.
  // A claimant org's admin must be refused exactly like the member row — their OWN App being one
  // of the live legacy claimants tells them nothing.
  it("orgA's and orgB's admins are refused the one denial on the ambiguous ref", async () => {
    await expect(M.uninstallApp({}, { ref: AMBIG }, adminCtx())).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(M.reinstallApp({}, { ref: AMBIG }, ctx(orgBAdmin.id))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
  it("the uninstalled holder's own admin reinstalls THROUGH the ambiguity (the fallthrough is the reach)", async () => {
    await expect(M.reinstallApp({}, { ref: AMBIG }, ctx(orgCAdmin.id))).resolves.toBe(true);
  });
  it('after that reinstall the current-urn holder wins the primary lookup: AMBIG resolves, no longer ambiguous', async () => {
    await M.reinstallApp({}, { ref: AMBIG }, ctx(orgCAdmin.id));
    await expect(resolveAppRef(db, AMBIG)).resolves.toMatchObject({ id: uninstalledApp.id });
    // The repeat is the no-op branch (already installed), still through the resolved ref.
    await expect(M.reinstallApp({}, { ref: AMBIG }, ctx(orgCAdmin.id))).resolves.toBe(true);
  });
});

describe("#4893 the secrets fold carries only the arm's own denial (#4948)", () => {
  it('an argument-validation refusal propagates instead of reading as an empty owner', async () => {
    await expect(Q.secrets({}, { ownerType: 'org' }, memberCtx()))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
  it("the App arm's folded denial still answers the empty page (missing ≡ not-yours)", async () => {
    await expect(Q.secrets({}, { ownerType: 'app', ownerRef: MISSING }, memberCtx()))
      .resolves.toEqual({ items: [], total: 0 });
  });
  it('an existing App the caller cannot reach is the same empty page as a missing one', async () => {
    // Two paths to the one empty page: a ref that fails to resolve dies in the App arm's
    // authorizationDenied() — the FORBIDDEN code the resolver's catch matches — while an App that
    // resolves but is not the caller's dies later, at canSeeSecretOwner. Pin both halves against
    // the same answer: either path diverging is an App-existence oracle on this door.
    const outsiderCtx = ctx(outsider.id);
    await expect(Q.secrets({}, { ownerType: 'app', ownerRef: MISSING }, outsiderCtx))
      .resolves.toEqual({ items: [], total: 0 });
    await expect(Q.secrets({}, { ownerType: 'app', ownerRef: app.urn }, outsiderCtx))
      .resolves.toEqual({ items: [], total: 0 });
  });
});
