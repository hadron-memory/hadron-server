/**
 * #3707 S1b — who may issue a grant for each seeded action (cor:acl:140:02, cor:acl:140:04): whoever may create a schedule
 * (or a webhook) in that App themselves, i.e. requireScheduleAdmin's gate (owner or org ADMIN). Pinned directly on the helper.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { PLATFORM_ACTIONS } from './actions.js';
import { runAsActor } from '../requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { requireActionIssuer, ISSUER_RULES } from './issuers.js';

let app: { id: string; urn: string };
const u: Record<'admin' | 'owner' | 'contributor' | 'reader' | 'outsider' | 'otherAdmin', string> = {} as never;
const ctx = (userId: string, roles: string[] = []): Context => ({ db, userId, roles }) as Context;
const ACTIONS = ['schedule.create', 'webhook.create'];

beforeEach(async () => {
  await cleanDb(db);
  const t = generateId().slice(0, 8);
  const org = await db.organization.create({ data: { id: generateId(), name: 'iss', urn: `iss-${t}` } });
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
      for (const who of ['contributor', 'reader', 'outsider', 'otherAdmin'] as const) {
        await expect(requireActionIssuer(ctx(u[who]), action, app.id), who).rejects.toThrow();
      }
    });

    it(`${action}: a revoked org membership does not authorize`, async () => {
      await db.orgMember.updateMany({ where: { userId: u.admin }, data: { deletedAt: new Date() } });
      await expect(requireActionIssuer(ctx(u.admin), action, app.id)).rejects.toThrow();
    });

    it(`${action}: no caller identity is not an issuer`, async () => {
      await expect(requireActionIssuer({ db, roles: [] } as unknown as Context, action, app.id)).rejects.toThrow();
    });
  }

  it('an app ref by URN resolves the same as by id', async () => {
    await expect(requireActionIssuer(ctx(u.admin), 'schedule.create', app.urn)).resolves.toBeUndefined();
    await expect(requireActionIssuer(ctx(u.reader), 'schedule.create', app.urn)).rejects.toThrow();
  });

  it('an unknown action has no issuer: nobody, not even an admin, may issue it', async () => {
    await expect(requireActionIssuer(ctx(u.admin), 'schedule.creat', app.id)).rejects.toThrow(/unknown action/i);
    await expect(requireActionIssuer(ctx(u.admin), '', app.id)).rejects.toThrow(/unknown action/i);
  });

  it('every shipped action names a rule the server can map (the key set is closed)', () => {
    for (const a of PLATFORM_ACTIONS) expect(Object.keys(ISSUER_RULES), a.name).toContain(a.issuerRule);
  });
});

// cor:acl:140:04 / cor:dmo:050:12 (ruling 0099): giving a grant is PERSON-ONLY. Authority over the App is necessary, not sufficient:
// a worker acting with its ADMIN holder's identity is refused, as every other grant door refuses it (requirePersonOnlyAct).
describe('#3707 (LOCAL P2-1): the issuer is a person acting as themselves, never a worker carrying a person\'s authority', () => {
  async function workerFor(appId: string) {
    const agent = await db.agent.create({ data: { organizationId: (await db.app.findUniqueOrThrow({ where: { id: appId } })).organizationId!, name: 'iss-agent', urn: `iss-agent-${generateId().slice(0, 6)}` } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: 'iss-worker', slug: `iss-w-${generateId().slice(0, 6)}` } });
    return { agent, worker };
  }

  for (const action of ACTIONS) {
    it(`${action}: a worker-bound request carrying an ADMIN's user id is refused (the request actor)`, async () => {
      const { agent, worker } = await workerFor(app.id);
      await expect(runAsActor({ workerId: worker.id, agentId: agent.id }, () => requireActionIssuer(ctx(u.admin), action, app.id))).rejects.toThrow();
    });

    it(`${action}: a session row that names a worker is refused even with no request actor`, async () => {
      const { agent, worker } = await workerFor(app.id);
      const session = await db.session.create({ data: { id: generateId(), appId: app.id, workerId: worker.id, agentId: agent.id } as never });
      await expect(requireActionIssuer({ ...ctx(u.admin), sessionId: session.id } as Context, action, app.id)).rejects.toThrow();
    });

    it(`${action}: a headless run principal, an impersonation and an App key are refused`, async () => {
      await expect(requireActionIssuer({ ...ctx(u.admin), clientId: 'run:abc' } as Context, action, app.id)).rejects.toThrow();
      await expect(requireActionIssuer({ ...ctx(u.admin), impersonation: { actorUserId: u.owner } } as unknown as Context, action, app.id)).rejects.toThrow();
      await expect(requireActionIssuer({ ...ctx(u.admin), appKeyId: generateId() } as Context, action, app.id)).rejects.toThrow();
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
