/**
 * #4838 — the OTHER App-ref doors: concealment pins for the teamRole write
 * doors (createTeamRole / updateTeamRole / deleteTeamRole), the teamRoles read
 * door, and the connectionGrant grantee door.
 *
 * The rule is #4836's (cor:dmo:070:05 Proposed; V58), applied to these doors:
 * REACH FIRST, state after (cor:api:140:02's partition). A caller without
 * standing for the App their appRef names — a non-participant, a pure App key
 * naming another App, or a ref that is missing, deleted, uninstalled or
 * malformed — gets ONE answer, byte-identical across every state:
 * APP_NOT_FOUND · "App not found.", no ref echoed, no appId in extensions.
 * A PARTICIPANT keeps the state answers: APP_UNINSTALLED with the appId on the
 * write doors, and a member who reaches but may not edit keeps FORBIDDEN from
 * the definition-edit gate. The read door keeps its legibility (an uninstalled
 * App's roles still list); only the dead deleted-echo branch after the reach
 * gate goes, pinned here as behaviour-neutral.
 *
 * The connectionGrant grantee door is RULED DIFFERENT (Holger via Vera, team
 * chat #138453, option "No reach needed", recorded as cor:dmo:080:04): a
 * connection owner does NOT need to reach the grantee App — granting to a
 * counterparty is the feature, and the owner learning whether that App exists
 * is accepted. Its slice is only the echo: the grantee refusal keeps
 * BAD_USER_INPUT and drops the ref from the message, so a token pasted into
 * appRef by mistake lands in no terminal, CI log or error tracker. The
 * byte-identical table does NOT apply to that door.
 *
 * Red-first: on main the non-participant table is NOT uniform — the write
 * doors answered APP_UNINSTALLED with the appId for an uninstalled App named
 * by PK (before any reach decision), FORBIDDEN for an existing App and for a
 * pure App key naming another App (an existence oracle), and the URN parser's
 * raw echoing UrnNotQualifiedError for a malformed ref; the connectionGrant
 * door answered "Grantee App not found: '<ref>'." verbatim, and let
 * AmbiguousLegacyUrnError escape raw (AMBIGUOUS_LEGACY_URN: <ref>). The rerun
 * with this file held and the production change reverted: 15 of 44 pins fail
 * (the three non-participant tables, the three pure-App-key pins, the three
 * cross-org subscription-CONTRIBUTOR pins, the foreign-agent org-ADMIN
 * concealment, the hard-vanish race arm, the read door's malformed fold, and
 * the connectionGrant echo + malformed + ambiguous-legacy folds); the 29 that
 * pass are the keeps — participant APP_UNINSTALLED/appId, the by-URN
 * asymmetry, the deleted-App unknown answer, the teamRole doors'
 * ambiguous-legacy fold (main's resolveAppRefConcealed already folded that
 * class), FORBIDDEN for a member who reaches but may not edit, the
 * user-owned-App owner's FORBIDDEN, uninstalled read legibility, the no-reach
 * ruling, resolveAppRefConcealed's kept parse refusal, and the narrow catches
 * (measured 2026-11-22).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { requireMemoryWriteAccess } from './resolvers.helpers.js';
import { resolveAppRefConcealed } from '../../../lib/auth/workerRead.js';
import { UrnNotQualifiedError } from '../../../lib/urn.js';
import { formatGraphQLError } from '../formatError.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

function ctx(userId?: string, appId?: string): Context {
  return { db, userId, appId, roles: userId ? ['READER'] : [] };
}

/**
 * Capture a refusal as a GraphQLError (fail the test if the promise resolves
 * or rejects with anything else), for byte-level comparison.
 */
async function refusal(p: Promise<unknown>): Promise<GraphQLError> {
  return p.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => {
      expect(e).toBeInstanceOf(GraphQLError);
      return e as GraphQLError;
    },
  );
}

/** The one unknown-App answer, exactly: code, message, and NOTHING else riding. */
const CONCEALED = { code: 'APP_NOT_FOUND', message: 'App not found.', extensions: { code: 'APP_NOT_FOUND' } };
const shape = (e: GraphQLError) => ({
  code: String(e.extensions?.code),
  message: e.message,
  extensions: e.extensions ?? {},
});
/** A canary value must appear in NO serialized part of a refusal. */
const assertNoCanary = (e: unknown, canary: string) =>
  expect(JSON.stringify({ message: (e as GraphQLError).message, extensions: (e as GraphQLError).extensions })).not.toContain(canary);

// F7 (#4871 blind seat): the narrow-catch pins mock `db.app.findFirst` with
// `rejectedValueOnce`; a test that fails BEFORE the once is consumed would
// leak the spy into later tests. Restoring every spy after each test closes
// that hole (the module mocks above are untouched by it).
afterEach(() => vi.restoreAllMocks());

// ── fixture ────────────────────────────────────────────────────────────────
let suffix: string;
let orgT: { id: string; urn: string };
let admin: { id: string };
let contrib: { id: string };
let appMember: { id: string };
let outsider: { id: string };
let teamAgent: { id: string; systemMemoryId: string };
let app: { id: string; urn: string };
// The connectionGrant side: an owner with a connection in orgA, grantee Apps
// in a DIFFERENT org (cross-org counterparty delegation is the feature).
let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let connOwner: { id: string };
let connId: string;
let granteeApp: { id: string; urn: string };
// F4 (#4871 blind seat): two live Apps claiming the SAME legacyUrn. When the
// primary URN lookup misses, resolveAppRef's alias fallback finds both and
// throws AmbiguousLegacyUrnError — whose message ECHOES the ref
// (`AMBIGUOUS_LEGACY_URN: <ref>`), a real fourth class for every fold, and no
// earlier test produced it.
let ambiguousUrn: string;
// F3 (#4871 blind delta seat, the actor its verdict asked for): a CROSS-ORG
// subscription CONTRIBUTOR — a CONTRIBUTOR of a second org holding a
// CONTRIBUTOR MemorySubscription to orgT's free-standing knowledge memory.
// They are a REAL generic-memory writer of orgT's shared knowledge (the
// subscription arm of requireMemoryWriteAccess admits them) with no arm that
// reaches the Team Agent's system memory and no participation in the App.
let subOrg: { id: string };
let subContrib: { id: string };
let sharedKnowledge: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgT = await db.organization.create({
    data: { id: generateId(), name: 'ar-org', urn: `ar-org-${suffix}.com` },
  });
  const mkUser = async (n: number, name: string) =>
    db.user.create({
      data: { id: generateId(), githubId: 98300 + n, githubUsername: `${name}-${suffix}`, roles: ['READER'] },
    });
  admin = await mkUser(1, 'admin');
  contrib = await mkUser(2, 'contrib');
  appMember = await mkUser(3, 'appmember');
  outsider = await mkUser(4, 'outsider');
  await db.orgMember.createMany({
    data: [
      { id: generateId(), organizationId: orgT.id, userId: admin.id, role: 'ADMIN' },
      { id: generateId(), organizationId: orgT.id, userId: contrib.id, role: 'CONTRIBUTOR' },
    ],
  });

  const created = await M.createAgent({}, { orgRef: orgT.id, name: 'AR Team Agent' }, ctx(admin.id));
  teamAgent = { id: created.id, systemMemoryId: created.systemMemoryId };
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      description: 'Server-side work',
    },
  });
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:frontend-engineer',
      name: 'frontend-engineer',
    },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: orgT.id, name: 'AR Team App', urn: `${orgT.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: appMember.id, role: 'reader' } });

  orgA = await db.organization.create({
    data: { id: generateId(), name: 'ar-conn-org', urn: `ar-conn-${suffix}.com` },
  });
  orgB = await db.organization.create({
    data: { id: generateId(), name: 'ar-grantee-org', urn: `ar-grantee-${suffix}.com` },
  });
  connOwner = await db.user.create({
    data: { id: generateId(), githubId: 98390, githubUsername: `ar-connowner-${suffix}`, roles: ['READER'] },
  });
  const conn = await db.exchangeConnection.create({
    data: {
      id: generateId(),
      organizationId: orgA.id,
      userId: connOwner.id,
      mailboxEmail: 'owner@ar-conn.com',
      toolConnectionId: `ar-tool-${suffix}`,
      createdBy: connOwner.id,
    },
  });
  connId = conn.id;
  const ga = await db.app.create({
    data: { id: generateId(), organizationId: orgB.id, name: 'ar-grantee', urn: `${orgB.urn}:grantee` },
  });
  granteeApp = { id: ga.id, urn: ga.urn };

  ambiguousUrn = `${orgT.urn}:legacy-dup-${suffix}`;
  subOrg = await db.organization.create({
    data: { id: generateId(), name: 'ar-sub-org', urn: `ar-sub-${suffix}.com` },
  });
  subContrib = await mkUser(5, 'subcontrib');
  await db.orgMember.create({
    data: { id: generateId(), organizationId: subOrg.id, userId: subContrib.id, role: 'CONTRIBUTOR' },
  });
  // Free-standing (appId NULL): an App-scoped knowledge memory is barred from
  // the subscription write arm (#653), so the grant must name the org's shared
  // knowledge — exactly the memory class a cross-org subscriber can write.
  sharedKnowledge = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: orgT.id,
      urn: `${orgT.urn}:shared-km`,
      name: 'shared-km',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });
  await db.memorySubscription.create({
    data: { memoryId: sharedKnowledge.id, organizationId: subOrg.id, role: 'CONTRIBUTOR' },
  });
  for (const n of ['a', 'b']) {
    await db.app.create({
      data: {
        id: generateId(),
        organizationId: orgT.id,
        name: `ar-legacy-dup-${n}`,
        urn: `${orgT.urn}:dup-${n}-${suffix}`,
        legacyUrn: ambiguousUrn,
      },
    });
  }
});

// ── the teamRole write doors ───────────────────────────────────────────────
const writeDoors: Record<string, (appRef: string, c: Context) => Promise<unknown>> = {
  createTeamRole: (appRef, c) => M.createTeamRole({}, { appRef, role: 'oncall', description: 'paged first' }, c),
  updateTeamRole: (appRef, c) => M.updateTeamRole({}, { appRef, role: 'backend-engineer', description: 'edited' }, c),
  deleteTeamRole: (appRef, c) => M.deleteTeamRole({}, { appRef, role: 'frontend-engineer' }, c),
};

/** Built per test: `suffix` is assigned by beforeEach, so a module-level
 * constant would interpolate `undefined` at import time. */
const canary = () => `canary-${suffix} not a urn`;

for (const [doorName, door] of Object.entries(writeDoors)) {
  describe(`#4838 — ${doorName}`, () => {
    it('a non-participant gets ONE byte-identical unknown-App answer across every App state', async () => {
      // Walk the states a ref can name, collecting the refusal each earns:
      // missing by id, missing by URN, malformed (canary), an existing App the
      // caller cannot reach, uninstalled named by PK, uninstalled named by URN,
      // and soft-deleted. The app row mutates forward (live → uninstalled →
      // deleted); every refusal must be the SAME bytes.
      const missingUrn = `${orgT.urn}:ghost-${suffix}`;
      const answers: ReturnType<typeof shape>[] = [];
      for (const ref of [generateId(), missingUrn, canary(), app.id]) {
        answers.push(shape(await refusal(door(ref, ctx(outsider.id)))));
      }
      await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
      answers.push(shape(await refusal(door(app.id, ctx(outsider.id)))));
      answers.push(shape(await refusal(door(app.urn, ctx(outsider.id)))));
      await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
      answers.push(shape(await refusal(door(app.id, ctx(outsider.id)))));
      for (const a of answers) expect(a).toEqual(CONCEALED);
      // The canary (in the malformed ref and the missing URN) is in no answer.
      for (const a of answers) expect(JSON.stringify(a)).not.toContain(suffix);
    });

    it('a pure App key naming ANOTHER App gets the same unknown-App answer', async () => {
      const e = await refusal(door(app.id, ctx(undefined, granteeApp.id)));
      expect(shape(e)).toEqual(CONCEALED);
    });

    it('a cross-org subscription CONTRIBUTOR — a generic-memory writer, not a participant — gets the same unknown-App answer', async () => {
      // F3 (#4871 blind delta): the actor is a real writer in orgT's ecosystem
      // (the subscription arm of the write gate admits them to the org's
      // free-standing knowledge memory — asserted, so the actor is not a
      // dressed-up outsider) yet holds no arm that reaches the Team Agent's
      // system memory and no App participation. On main the edit gate answered
      // them FORBIDDEN — an existence oracle; the reach rule gives them the one
      // unknown-App answer, byte-identical to every other non-participant's.
      await requireMemoryWriteAccess(ctx(subContrib.id), sharedKnowledge.id);
      expect(shape(await refusal(door(app.id, ctx(subContrib.id))))).toEqual(CONCEALED);
    });

    it('a PARTICIPANT naming an uninstalled App by PK keeps APP_UNINSTALLED with the appId', async () => {
      await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
      const e = await refusal(door(app.id, ctx(admin.id)));
      expect(e.extensions?.code).toBe('APP_UNINSTALLED');
      expect(e.extensions?.appId).toBe(app.id);
    });

    it('a participant naming an uninstalled App by URN gets the unknown-App answer (resolution refuses it — unchanged)', async () => {
      await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
      const e = await refusal(door(app.urn, ctx(admin.id)));
      expect(shape(e)).toEqual(CONCEALED);
    });

    it('a soft-deleted App is the unknown-App answer for a participant too', async () => {
      await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
      const e = await refusal(door(app.id, ctx(admin.id)));
      expect(shape(e)).toEqual(CONCEALED);
    });

    it('a member who REACHES but may not edit keeps FORBIDDEN (the definition-edit gate)', async () => {
      const e = await refusal(door(app.id, ctx(appMember.id)));
      expect(e.extensions?.code).toBe('FORBIDDEN');
      // and the member still reaches the READ door (not concealed from it)
      expect((await Q.teamRoles({}, { appRef: app.id }, ctx(appMember.id))).total).toBe(2);
    });

    it('the happy path still works for a participant with authority', async () => {
      await expect(door(app.id, ctx(admin.id))).resolves.toBeTruthy();
    });

    it('a fault INSIDE the ref lookup is not folded into the unknown-App answer (narrow catch)', async () => {
      // A WELL-FORMED (but missing) URN, so the fault is thrown by the lookup
      // itself — a malformed ref never reaches the database to fail there.
      const fault = new Error('synthetic db fault');
      const spy = vi.spyOn(db.app, 'findFirst').mockRejectedValueOnce(fault);
      const e = await door(`${orgT.urn}:ghost-narrow-${suffix}`, ctx(outsider.id)).then(
        () => {
          throw new Error('expected a rejection');
        },
        (x: unknown) => x,
      );
      spy.mockRestore();
      expect(e).toBe(fault);
      expect(formatGraphQLError({ message: String((e as Error)?.message) }, e).extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it('an AMBIGUOUS legacy URN (two live Apps claim it) is the same unknown-App answer (a KEEP: main folded this class already)', async () => {
      // F4: AmbiguousLegacyUrnError's message echoes the ref raw, so it must
      // fold — and the throw is caller-INDEPENDENT, so even a participant
      // (admin) gets the one answer; the reach gate is not what conceals it.
      const e = await refusal(door(ambiguousUrn, ctx(admin.id)));
      expect(shape(e)).toEqual(CONCEALED);
      assertNoCanary(e, suffix);
    });
  });
}

// ── a foreign PUBLIC Team Agent in a user-owned App ────────────────────────
describe('#4838 — a foreign org\'s PUBLIC Team Agent in a user-owned App (the edit-gate org arm vs the reach rule)', () => {
  // The one edit-gate arm the reach rule does not admit, in its one reachable
  // shape. A user-owned agent is PERSONAL-visibility only (createAgentCore),
  // and createAgentOrgGrant licenses only PUBLIC agents — so a user-owned
  // agent can NEVER sit in an org App, and its owner arm only ever coincides
  // with a user-owned App's owner, whom isAppParticipant admits. But a
  // personal App may install a FOREIGN org's PUBLIC agent outright
  // (requirePersonalAppAgentInstall's PUBLIC arm; an org App reaches the same
  // shape through createAgentOrgGrant). That agent's org ADMIN/OWNER write its
  // system memory (the org arm of canManageAgentSystemMemory), so on MAIN this
  // door served them on an App they hold no participation in; the reach rule
  // (V58 keys reach on App participation) conceals them HERE while the generic
  // node surface — updateNode / hadron_update_node_data, gated on memory write
  // access alone — stays open to them: the register keeps its writers, this
  // door is what the concealment takes.
  let soloOwner: { id: string };
  let fOrg: { id: string; urn: string };
  let fAdmin: { id: string };
  let pubAgent: { id: string; systemMemoryId: string };
  let soloApp: { id: string };

  beforeEach(async () => {
    soloOwner = await db.user.create({
      data: {
        id: generateId(),
        githubId: 98311,
        githubUsername: `ar-solo-${suffix}`,
        handle: 'ar-solo',
        roles: ['READER'],
      },
    });
    fOrg = await db.organization.create({
      data: { id: generateId(), name: 'ar-foreign-org', urn: `ar-foreign-${suffix}.com` },
    });
    fAdmin = await db.user.create({
      data: { id: generateId(), githubId: 98312, githubUsername: `ar-fadmin-${suffix}`, roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: fOrg.id, userId: fAdmin.id, role: 'ADMIN' },
    });
    const created = await M.createAgent(
      {},
      { orgRef: fOrg.id, name: 'AR Public Team Agent', visibility: 'PUBLIC' },
      ctx(fAdmin.id),
    );
    pubAgent = { id: created.id, systemMemoryId: created.systemMemoryId };
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: pubAgent.systemMemoryId,
        loc: 'roles:pub-role',
        name: 'pub-role',
        description: 'A role the agent\'s org edits',
      },
    });
    soloApp = await db.app.create({
      data: { id: generateId(), ownerUserId: soloOwner.id, name: 'AR Solo App', urn: `solo-${generateId().slice(-8)}:app` },
    });
    await db.appAgent.create({ data: { appId: soloApp.id, agentId: pubAgent.id } });
  });

  it('the agent\'s org ADMIN — an edit-gate writer, not a participant — is concealed on the door and keeps the generic node surface', async () => {
    // The other door first, as the capability claim: fAdmin writes the
    // register through the generic surface (the org arm of the memory write
    // gate), at this head exactly as on main.
    const updated = await M.updateNode(
      {},
      { input: { memoryId: pubAgent.systemMemoryId, loc: 'roles:pub-role', description: 'edited through the generic surface' } },
      ctx(fAdmin.id),
    );
    expect(updated).toBeTruthy();
    // This door on main SERVED them (the write succeeded); the reach rule
    // gives them the one unknown-App answer, byte-identical.
    expect(shape(await refusal(M.createTeamRole({}, { appRef: soloApp.id, role: 'oncall', description: 'x' }, ctx(fAdmin.id))))).toEqual(CONCEALED);
  });

  it('the user-owned App\'s OWNER reaches (the owner arm) and keeps FORBIDDEN from the edit gate — the register is the foreign org\'s', async () => {
    const e = await refusal(M.createTeamRole({}, { appRef: soloApp.id, role: 'oncall', description: 'x' }, ctx(soloOwner.id)));
    expect(e.extensions?.code).toBe('FORBIDDEN');
  });
});

// ── the teamRoles read door ────────────────────────────────────────────────
describe('#4838 — teamRoles (read)', () => {
  it('a malformed ref folds into the unknown-App answer (canary in no refusal)', async () => {
    const e = await refusal(Q.teamRoles({}, { appRef: canary() }, ctx(contrib.id)));
    expect(shape(e)).toEqual(CONCEALED);
    assertNoCanary(e, suffix);
  });

  it('an ambiguous legacy URN folds into the unknown-App answer too (same resolveApp)', async () => {
    const e = await refusal(Q.teamRoles({}, { appRef: ambiguousUrn }, ctx(contrib.id)));
    expect(shape(e)).toEqual(CONCEALED);
    assertNoCanary(e, suffix);
  });

  it('a soft-deleted App is the unknown-App answer — the deleted-echo branch after the reach gate is gone, behaviour-neutral', async () => {
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    const e = await refusal(Q.teamRoles({}, { appRef: app.id }, ctx(admin.id)));
    expect(shape(e)).toEqual(CONCEALED);
  });

  it('an uninstalled App\'s roles still list for a participant (roster stays legible)', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    expect((await Q.teamRoles({}, { appRef: app.id }, ctx(admin.id))).total).toBe(2);
  });

  it('an outsider and a foreign App key keep the unknown-App answer on a live App', async () => {
    expect(shape(await refusal(Q.teamRoles({}, { appRef: app.id }, ctx(outsider.id))))).toEqual(CONCEALED);
    expect(shape(await refusal(Q.teamRoles({}, { appRef: app.id }, ctx(undefined, granteeApp.id))))).toEqual(CONCEALED);
  });
});

// ── the connectionGrant grantee door ───────────────────────────────────────
describe('#4838 — createConnectionGrant (grantee ref)', () => {
  const create = (appRef: string, c: Context) =>
    M.createConnectionGrant({}, { connectionRef: connId, appRef, scopes: ['mail.read'] }, c);

  it('a missing grantee App answers BAD_USER_INPUT with NO ref echoed (id, URN and deleted alike)', async () => {
    await db.app.update({ where: { id: granteeApp.id }, data: { deletedAt: new Date() } });
    for (const ref of [generateId(), `${orgB.urn}:ghost-${suffix}`, granteeApp.id]) {
      const e = await refusal(create(ref, ctx(connOwner.id)));
      expect(e.extensions?.code).toBe('BAD_USER_INPUT');
      expect(e.message).toBe('Grantee App not found.');
      assertNoCanary(e, suffix);
      expect(JSON.stringify(e.extensions)).not.toContain('appRef');
    }
  });

  it('a MALFORMED grantee ref folds into the same no-echo BAD_USER_INPUT answer (canary in no refusal)', async () => {
    const e = await refusal(create(canary(), ctx(connOwner.id)));
    expect(e).toBeInstanceOf(GraphQLError);
    expect(e.extensions?.code).toBe('BAD_USER_INPUT');
    expect(e.message).toBe('Grantee App not found.');
    assertNoCanary(e, suffix);
  });

  it('an AMBIGUOUS legacy grantee URN folds into the no-echo answer too (main let it escape raw)', async () => {
    // F4, and RED on main: the old grantee catch folded only AppNotFoundError,
    // so AmbiguousLegacyUrnError escaped verbatim — AMBIGUOUS_LEGACY_URN: <ref>
    // — echoing the ref into terminals and logs. The shared fold conceals it.
    const e = await refusal(create(ambiguousUrn, ctx(connOwner.id)));
    expect(e.extensions?.code).toBe('BAD_USER_INPUT');
    expect(e.message).toBe('Grantee App not found.');
    assertNoCanary(e, suffix);
  });

  it('a grantee App the owner cannot REACH still receives the grant (the ruling: no reach needed)', async () => {
    const g = (await create(granteeApp.id, ctx(connOwner.id))) as { id: string };
    expect((await db.connectionGrant.findUniqueOrThrow({ where: { id: g.id } })).granteeAppId).toBe(granteeApp.id);
  });

  it('a fault INSIDE the grantee lookup is not folded (narrow catch)', async () => {
    const fault = new Error('synthetic db fault');
    const spy = vi.spyOn(db.app, 'findFirst').mockRejectedValueOnce(fault);
    const e = await create(granteeApp.urn, ctx(connOwner.id)).then(
      () => {
        throw new Error('expected a rejection');
      },
      (x: unknown) => x,
    );
    spy.mockRestore();
    expect(e).toBe(fault);
    expect(formatGraphQLError({ message: String((e as Error)?.message) }, e).extensions?.code).toBe('INTERNAL_SERVER_ERROR');
  });
});

// ── resolveAppRefConcealed vs the shared fold predicate ────────────────────
describe('#4838 — resolveAppRefConcealed vs isAppRefResolutionFailure (the intentional difference)', () => {
  // P3 (#4871 blind delta): two fold lists live in workerRead.ts — the shared
  // four-class predicate these doors use, and the older two-class
  // resolveAppRefConcealed (#4836's doors). The difference is INTENTIONAL and
  // tracked as hadron-server#4876 (the parse-error fold on those doors). This
  // pin documents the difference so the two lists cannot drift SILENTLY: when
  // the tracked fold lands, this pin goes red and is updated with it. (The
  // predicate's own four-class contract is unit-pinned in workerRead.test.ts.)
  it('a MALFORMED ref KEEPS its typed parse refusal from resolveAppRefConcealed (not the unknown-App answer)', async () => {
    const e = await resolveAppRefConcealed(db, canary()).then(
      () => {
        throw new Error('expected a refusal');
      },
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(UrnNotQualifiedError);
  });
});

// ── the resolveApp hard-vanish race arm ────────────────────────────────────
describe('#4838 — the teamRole doors\' shared resolveApp (the hard-vanish race arm)', () => {
  // Anita + Rook on the #4871 delta (surviving mutant / unpinned arm): a row
  // that HARD-vanishes between resolution and resolveApp's read (the
  // rename-collision cleanup deletes App rows outright) must fold into the one
  // unknown-App answer, not surface as a distinguishable INTERNAL_SERVER_ERROR.
  // Mocked rather than raced: the window is between two awaits, so the once-
  // mock IS the interleaving. resolveApp is shared by all three write doors;
  // one door pins it.
  it('a row that vanishes between resolution and the read is the unknown-App answer', async () => {
    const spy = vi.spyOn(db.app, 'findUnique').mockResolvedValueOnce(null as never);
    let e: unknown;
    try {
      e = await refusal(M.createTeamRole({}, { appRef: app.id, role: 'oncall', description: 'x' }, ctx(admin.id)));
      // #4884: the once-mock must have been CONSUMED by resolveApp's read of this App. Without this, a refactor that stops calling
      // findUnique on this path leaves the mock unused and the pin green for the wrong reason (the answer would then be the real
      // row's, not the vanished one's). Asserted before mockRestore, which clears the recorded calls.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ where: { id: app.id } })); // the read of THIS App, not another lookup
    } finally {
      spy.mockRestore();
    }
    expect(shape(e)).toEqual(CONCEALED);
  });
});
