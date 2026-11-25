/**
 * #3707 S1b — who may issue a grant for each seeded action (cor:acl:140:02, cor:acl:140:04): whoever may create a schedule
 * (or a webhook) in that App themselves, i.e. requireScheduleAdmin's gate (owner or org ADMIN). Pinned directly on the helper.
 *
 * #3730 (the carry PR over S1b): the issuer registry is CLOSED (item 1), the issuer follows the create gate for the Apps that
 * gate refuses — user-owned, deleted (item 2, cor:acl:140:02 as confirmed under AT0.5588) — the person-only legs are split one
 * arm per case with production-shaped fixtures (item 3), and every refusal asserts its code and message, never a bare throw
 * (item 4).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { PLATFORM_ACTIONS, type ActionDefinition } from './actions.js';
import { runAsActor } from '../requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { requireActionIssuer, ISSUER_RULES } from './issuers.js';

let app: { id: string; urn: string };
let org: { id: string; urn: string };
const u: Record<'admin' | 'owner' | 'contributor' | 'reader' | 'outsider' | 'otherAdmin', string> = {} as never;
const ctx = (userId: string, roles: string[] = []): Context => ({ db, userId, roles }) as Context;
const ACTIONS = ['schedule.create', 'webhook.create'];
/** #3730 item 4: a refusal is its code and message, never "some throw" (conventions:the-error-code-is-the-contract). */
const refused = (p: Promise<unknown>, code: string, message: string) =>
  expect(p, `${code} ${message}`).rejects.toMatchObject({ extensions: { code }, message });

beforeEach(async () => {
  await cleanDb(db);
  const t = generateId().slice(0, 8);
  org = await db.organization.create({ data: { id: generateId(), name: 'iss', urn: `iss-${t}` } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'iss-o', urn: `iss-o-${t}` } });
  for (const k of ['admin', 'owner', 'contributor', 'reader', 'outsider', 'otherAdmin'] as const) {
    u[k] = (await db.user.create({ data: { id: generateId(), handle: `${k}-${t}` } })).id;
  }
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: u.admin, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: u.owner, role: 'OWNER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: u.contributor, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: u.reader, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: other.id, userId: u.otherAdmin, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Iss', urn: `${org.urn}:iss` } });
});

describe('#3707: who may issue schedule.create and webhook.create', () => {
  for (const action of ACTIONS) {
    it(`${action}: an org ADMIN and an org OWNER may issue`, async () => {
      await expect(requireActionIssuer(ctx(u.admin), action, app.id)).resolves.toBeUndefined();
      await expect(requireActionIssuer(ctx(u.owner), action, app.id)).resolves.toBeUndefined();
    });

    it(`${action}: a person who cannot create one in the App is not an issuer (contributor, reader, outsider, another org's admin)`, async () => {
      // #3730 item 4: the shared gates' typed denial, not a bare throw.
      for (const who of ['contributor', 'reader', 'outsider', 'otherAdmin'] as const) {
        await refused(requireActionIssuer(ctx(u[who]), action, app.id), 'FORBIDDEN', 'Forbidden');
      }
    });

    it(`${action}: a revoked org membership does not authorize`, async () => {
      await db.orgMember.updateMany({ where: { userId: u.admin }, data: { deletedAt: new Date() } });
      await refused(requireActionIssuer(ctx(u.admin), action, app.id), 'FORBIDDEN', 'Forbidden');
    });

    it(`${action}: no caller identity is not an issuer`, async () => {
      await refused(requireActionIssuer({ db, roles: [] } as unknown as Context, action, app.id), 'FORBIDDEN', 'Forbidden');
    });
  }

  it('an app ref by URN resolves the same as by id', async () => {
    await expect(requireActionIssuer(ctx(u.admin), 'schedule.create', app.urn)).resolves.toBeUndefined();
    await refused(requireActionIssuer(ctx(u.reader), 'schedule.create', app.urn), 'FORBIDDEN', 'Forbidden');
  });

  it('an unknown action has no issuer: nobody, not even an admin, may issue it', async () => {
    await refused(requireActionIssuer(ctx(u.admin), 'schedule.creat', app.id), 'BAD_USER_INPUT', 'Unknown action.');
    await refused(requireActionIssuer(ctx(u.admin), '', app.id), 'BAD_USER_INPUT', 'Unknown action.');
  });

  it('every shipped action names a rule the server can map (the key set is closed)', () => {
    for (const a of PLATFORM_ACTIONS) expect(Object.keys(ISSUER_RULES), a.name).toContain(a.issuerRule);
  });
});

// #3730 item 1: the registry lookup must be an OWN-property hit on a closed set. A plain Record lookup answers an inherited
// property name ('toString' resolves to a function that never refuses; '__proto__' to a non-callable object), so an action
// definition whose issuerRule only LOOKS like a key would get a gate that either never refuses or crashes. Red first: on the
// pre-#3730 lookup both poisoned rules resolve for an org ADMIN (the toString "gate" returns a string and refuses nobody).
describe('#3730 item 1: a rule key that only looks like one has no issuer — the registry is closed', () => {
  /** A full definition with a poisoned rule key, pushed into the shipped list only for the call inside `run`. */
  const poisoned = (issuerRule: string): ActionDefinition => ({
    name: 'test.3730.poison', source: 'PLATFORM', parameters: [{ name: 'entryNode', type: 'node-ref', refusesWildcard: true }],
    tool: null, enforcement: 'SERVER', issuerRule: issuerRule as never, summaryTemplate: 'Poison {app} at {entryNode}',
  });
  /** Run `fn` with `entry` visible to the helper, then put the shipped list back exactly as it was, whatever happened. */
  async function withAction<T>(entry: ActionDefinition, fn: () => Promise<T>): Promise<T> {
    const shared = PLATFORM_ACTIONS as unknown as ActionDefinition[];
    const shipped = [...shared];
    shared.push(entry);
    try { return await fn(); } finally {
      shared.splice(0, shared.length, ...shipped);
    }
  }

  for (const key of ['toString', '__proto__', 'constructor', 'APP_SCHEDULE_ADMIX']) {
    it(`an action whose issuerRule is ${JSON.stringify(key)} refuses an org ADMIN: unknown action`, async () => {
      await withAction(poisoned(key), () =>
        refused(requireActionIssuer(ctx(u.admin), 'test.3730.poison', app.id), 'BAD_USER_INPUT', 'Unknown action.'));
    });
  }
});

// #3730 item 2 (cor:acl:140:02, reading confirmed under AT0.5588): the issuer follows the CREATE gate exactly. While nobody
// may create a schedule or webhook in a user-owned App, nobody may issue those actions there — its OWNER included, who passes
// the owner check and is refused by the user-owned arm; if schedules reach user-owned Apps, issuing follows the shared gate.
describe('#3730 item 2: the issuer follows the schedule gates for the Apps they refuse', () => {
  it('a user-owned App: its owner passes the owner check and is still not an issuer (nobody may issue what nobody may create)', async () => {
    const owned = await db.app.create({ data: { id: generateId(), ownerUserId: u.admin, name: 'IssUser', urn: `iss-u-${generateId().slice(0, 8)}` } });
    for (const action of ACTIONS) {
      await refused(requireActionIssuer(ctx(u.admin), action, owned.id), 'BAD_USER_INPUT', 'This operation is not supported for user-owned Apps yet.');
    }
  });

  it('a deleted App has no issuer: the ref resolves to nothing (APP_NOT_FOUND, the stable wire code)', async () => {
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    for (const action of ACTIONS) {
      // #3730 item 4: the code is the contract. resolveAppRef refuses the deleted App before requireScheduleAdmin's own
      // NOT_FOUND branch, with EntityNotFoundError's wire code — at the ceremony door the route's uniform catch turns it
      // into the one refusal, so this shape never reaches a client as anything but "no" (pinned over real HTTP below).
      await expect(requireActionIssuer(ctx(u.admin), action, app.id), action).rejects.toMatchObject({ code: 'APP_NOT_FOUND', message: 'APP_NOT_FOUND: no match for the given ref.' });
    }
  });
});

// cor:acl:140:04 / cor:dmo:050:12 (ruling 0099): giving a grant is PERSON-ONLY. Authority over the App is necessary, not sufficient:
// a worker acting with its ADMIN holder's identity is refused, as every other grant door refuses it (requirePersonOnlyAct).
// #3730 item 3: one REFUSAL ARM per case, each fixture production-shaped, so deleting an arm from requirePersonAsThemselves (or
// the app-key arm from requireActionIssuer) goes red in exactly its own case. The impersonation fixture is a real
// ImpersonationContext — sessionId names a live ImpersonationSession row, orgId the org it scopes, userId the TARGET (an org
// OWNER, so only the impersonation arm refuses them: the gate would pass the target were they acting as themselves).
describe("#3707 (LOCAL P2-1) / #3730 item 3: the issuer is a person acting as themselves, never a worker carrying a person's authority", () => {
  async function workerFor(appId: string) {
    const agent = await db.agent.create({ data: { organizationId: (await db.app.findUniqueOrThrow({ where: { id: appId } })).organizationId!, name: 'iss-agent', urn: `iss-agent-${generateId().slice(0, 6)}` } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: 'iss-worker', slug: `iss-w-${generateId().slice(0, 6)}` } });
    return { agent, worker };
  }

  for (const action of ACTIONS) {
    it(`${action}: a worker-bound request carrying an ADMIN's user id is refused (the request actor)`, async () => {
      const { agent, worker } = await workerFor(app.id);
      await refused(runAsActor({ workerId: worker.id, agentId: agent.id }, () => requireActionIssuer(ctx(u.admin), action, app.id)), 'FORBIDDEN', 'Forbidden');
    });

    it(`${action}: a session row that names a worker is refused even with no request actor`, async () => {
      const { agent, worker } = await workerFor(app.id);
      const session = await db.session.create({ data: { id: generateId(), appId: app.id, workerId: worker.id, agentId: agent.id } as never });
      await refused(requireActionIssuer({ ...ctx(u.admin), sessionId: session.id } as Context, action, app.id), 'FORBIDDEN', 'Forbidden');
    });

    // The three split legs of the old one-case triple (issuers3707 :95-98 pre-#3730). One arm each, exact refusal.
    it(`${action}: a headless run principal is refused (clientId 'run:…', the isRunPrincipal arm)`, async () => {
      await refused(requireActionIssuer({ ...ctx(u.admin), clientId: 'run:abc' } as Context, action, app.id), 'FORBIDDEN', 'Forbidden');
    });

    it(`${action}: an impersonation context is refused, whoever it carries (the ctx.impersonation arm)`, async () => {
      const impSession = await db.impersonationSession.create({
        data: { adminUserId: u.admin, targetUserId: u.owner, organizationId: org.id, reason: 'issuer pin', expiresAt: new Date(Date.now() + 3600_000) },
      });
      const impersonated: Context = {
        ...ctx(u.owner),
        impersonation: { sessionId: impSession.id, actorUserId: u.admin, orgId: org.id, expiresAt: impSession.expiresAt },
      };
      await refused(requireActionIssuer(impersonated, action, app.id), 'FORBIDDEN', 'Forbidden');
    });

    it(`${action}: an App key is refused (the issuer door's own appKeyId arm, before the person gate)`, async () => {
      await refused(requireActionIssuer({ ...ctx(u.admin), appKeyId: generateId() } as Context, action, app.id), 'FORBIDDEN', 'Forbidden');
    });
  }

  it('control: the same ADMIN as themselves, with a session row that names no worker, still issues', async () => {
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, userId: u.admin } as never });
    await expect(requireActionIssuer({ ...ctx(u.admin), sessionId: session.id } as Context, 'schedule.create', app.id)).resolves.toBeUndefined();
  });

  it('a refusal for a worker is byte-identical to a refusal for a non-admin person (no oracle on who holds authority)', async () => {
    const { agent, worker } = await workerFor(app.id);
    const asWorker = await runAsActor({ workerId: worker.id, agentId: agent.id }, () => requireActionIssuer(ctx(u.admin), 'schedule.create', app.id)).catch((e) => e);
    const asReader = await requireActionIssuer(ctx(u.reader), 'schedule.create', app.id).catch((e) => e);
    expect([asWorker.message, asWorker.extensions?.code]).toEqual([asReader.message, asReader.extensions?.code]);
  });
});
