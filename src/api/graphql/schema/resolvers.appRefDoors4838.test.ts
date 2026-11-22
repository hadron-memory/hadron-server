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
 * chat #138453, option "No reach needed"): a connection owner does NOT need to
 * reach the grantee App — granting to a counterparty is the feature, and the
 * owner learning whether that App exists is accepted. Its slice is only the
 * echo: the grantee refusal keeps BAD_USER_INPUT and drops the ref from the
 * message, so a token pasted into appRef by mistake lands in no terminal, CI
 * log or error tracker. The byte-identical table does NOT apply to that door.
 *
 * Red-first: on main the non-participant table is NOT uniform — the write
 * doors answered APP_UNINSTALLED with the appId for an uninstalled App named
 * by PK (before any reach decision), FORBIDDEN for an existing App and for a
 * pure App key naming another App (an existence oracle), and the URN parser's
 * raw echoing UrnNotQualifiedError for a malformed ref; the connectionGrant
 * door answered "Grantee App not found: '<ref>'." verbatim. The rerun with
 * this file held and the production change reverted: 9 of 32 pins fail (the
 * three non-participant tables, the three pure-App-key pins, the read door's
 * malformed fold, and the connectionGrant echo + malformed fold); the 23 that
 * pass are the keeps — participant APP_UNINSTALLED/appId, the by-URN
 * asymmetry, the deleted-App unknown answer, FORBIDDEN for a member who
 * reaches but may not edit, uninstalled read legibility, the no-reach ruling,
 * and the narrow catches (measured 2026-11-22).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
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
const noCanary = (e: unknown, canary: string) =>
  expect(JSON.stringify({ message: (e as GraphQLError).message, extensions: (e as GraphQLError).extensions })).not.toContain(canary);

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
let orgA: { id: string };
let orgB: { id: string };
let connOwner: { id: string };
let connId: string;
let granteeApp: { id: string; urn: string };

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
});

// ── the teamRole write doors ───────────────────────────────────────────────
const writeDoors: Record<string, (appRef: string, c: Context) => Promise<unknown>> = {
  createTeamRole: (appRef, c) => M.createTeamRole({}, { appRef, role: 'oncall', description: 'paged first' }, c),
  updateTeamRole: (appRef, c) => M.updateTeamRole({}, { appRef, role: 'backend-engineer', description: 'edited' }, c),
  deleteTeamRole: (appRef, c) => M.deleteTeamRole({}, { appRef, role: 'frontend-engineer' }, c),
};

const CANARY = `canary-${suffix} not a urn`;

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
      for (const ref of [generateId(), missingUrn, CANARY, app.id]) {
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
      expect(formatGraphQLError(e as Error).extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    });
  });
}

// ── the teamRoles read door ────────────────────────────────────────────────
describe('#4838 — teamRoles (read)', () => {
  it('a malformed ref folds into the unknown-App answer (canary in no refusal)', async () => {
    const e = await refusal(Q.teamRoles({}, { appRef: CANARY }, ctx(contrib.id)));
    expect(shape(e)).toEqual(CONCEALED);
    noCanary(e, suffix);
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
      noCanary(e, suffix);
      expect(JSON.stringify(e.extensions)).not.toContain('appRef');
    }
  });

  it('a MALFORMED grantee ref folds into the same no-echo BAD_USER_INPUT answer (canary in no refusal)', async () => {
    const e = await refusal(create(CANARY, ctx(connOwner.id)));
    expect(e).toBeInstanceOf(GraphQLError);
    expect(e.extensions?.code).toBe('BAD_USER_INPUT');
    expect(e.message).toBe('Grantee App not found.');
    noCanary(e, suffix);
  });

  it('a grantee App the owner cannot REACH still receives the grant (the ruling: no reach needed)', async () => {
    const g = (await create(granteeApp.id, ctx(connOwner.id))) as { id: string; granteeAppId?: string };
    expect(g.granteeAppId ?? (await db.connectionGrant.findUniqueOrThrow({ where: { id: g.id } })).granteeAppId).toBe(granteeApp.id);
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
    expect(formatGraphQLError(e as Error).extensions?.code).toBe('INTERNAL_SERVER_ERROR');
  });
});
