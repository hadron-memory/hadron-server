/**
 * #3511 (ruling 0177; hrn:node:hadronmemory.com:specs:cor:dmo:050:12 r40): rotating a webhook's credentials is a
 * PERSON-ONLY act (`agent-webhook.rotate` on the closed list). `rotateAgentWebhook` returns the new secret path and a
 * platform token, which would land in a model transcript, so a worker session in any shape is refused even when its
 * holder is an org ADMIN and the stored run owner. Each refusal is the door's existing non-admin answer, byte for
 * byte, and mints nothing: the secret is unchanged and no token is returned.
 *
 * Unchanged: createAgentWebhook, deleteAgentWebhook, and a person rotating as themselves.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { RUN_CLIENT_PREFIX } from '../../../lib/auth/runPrincipal.js';
import { requestActorStorage, runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { appRunMutations as M } from './resolvers.appRun.js';
import type { Context } from './resolvers.helpers.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const ENTRY = 'hrn:node:webhook-rotate-3511:knowledge:tasks:entry';

type F = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const admin = await db.user.create({ data: { id: generateId(), handle: 'wr-admin', name: 'Admin', roles: ['READER'] as never } });
  const plain = await db.user.create({ data: { id: generateId(), handle: 'wr-plain', name: 'Plain', roles: ['READER'] as never } });
  const org = await db.organization.create({ data: { id: generateId(), name: 'WR Org', urn: 'wr3511.test' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: plain.id, role: 'READER' } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'WR App', urn: 'wr3511.test:app' } });
  await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'owner' } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'WR Agent', urn: 'wr3511.test:agent' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  // The org ADMIN holds the worker: a worker whose holder manages the org is still refused.
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'WR Worker', slug: 'wr-worker', heldByUserId: admin.id } });
  const workerSession = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: admin.id, tool: 'vitest' } });
  const personSession = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, userId: admin.id, tool: 'vitest' } });
  const key = await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'hdr_app_x...0000', label: 'existing' } });
  // Stored run owner = the admin, so the owner check admits them and the person gate is what decides.
  const hook = await db.agentWebhook.create({ data: {
    id: generateId(), organizationId: org.id, appId: app.id, userId: admin.id, name: 'wr-hook', secret: 'original-secret', entryNodeUrn: ENTRY,
  } });
  return { admin, plain, org, app, agent, worker, workerSession, personSession, key, hook };
}

let f: F;
beforeEach(async () => { await cleanDb(db); f = await fixture(); });

const person = (extra: Record<string, unknown> = {}) => ({ db, userId: f.admin.id, roles: ['READER'], ...extra }) as unknown as Context;

/** The non-person shapes; each runs the door call inside its own actor scope. */
const CLASSES: Record<string, (call: (c: Context) => Promise<unknown>) => Promise<unknown>> = {
  boundWorker: (call) => runAsActor({ workerId: f.worker.id, agentId: f.agent.id }, () => call(person())),
  sessionRowWorker: (call) => call(person({ sessionId: f.workerSession.id })),
  ambiguousActor: (call) => requestActorStorage.run({ workerId: null, agentId: null, ambiguousSessionIds: ['s1', 's2'] }, () => call(person())),
  refusedBinding: (call) => call(person({ sessionBindingRefused: true })),
  impersonation: (call) => call(person({ impersonation: { sessionId: generateId(), actorUserId: f.admin.id, orgId: f.org.id, expiresAt: new Date('2099-01-01') } })),
  runPrincipal: (call) => call(person({ clientId: `${RUN_CLIENT_PREFIX}${generateId()}`, appId: f.app.id, organizationId: f.org.id })),
  appKey: (call) => call({ db, appId: f.app.id, appKeyId: f.key.id, organizationId: f.org.id, roles: [] } as unknown as Context),
};

const rotate = (c: Context) => M.rotateAgentWebhook({}, { id: f.hook.id }, c);
const answer = (p: Promise<unknown>) => p.then(
  (v) => ({ admitted: JSON.stringify(v ?? null) }),
  (e: any) => ({ code: e?.extensions?.code ?? null, message: String(e?.message) }),
);
const FORBIDDEN = { code: 'FORBIDDEN', message: 'Forbidden' };
const stored = () => db.agentWebhook.findUniqueOrThrow({ where: { id: f.hook.id } });

describe('#3511 rotateAgentWebhook is person-only', () => {
  it('the non-admin answer at this door is the byte-identical reference', async () => {
    expect(await answer(rotate(person({ userId: f.plain.id })))).toEqual(FORBIDDEN);
  });

  for (const cls of Object.keys(CLASSES)) {
    it(`${cls}: refused with the non-admin answer, secret unchanged, no token`, async () => {
      const before = await stored();
      const got = await answer(CLASSES[cls](rotate));
      expect(got).toEqual(FORBIDDEN);
      expect(JSON.stringify(got)).not.toContain('/hooks/');
      expect(await stored()).toEqual(before);
    });
  }

  it('the same admin signed in as themselves rotates (control)', async () => {
    const result = await rotate(person());
    expect(result.webhook.secret).not.toBe('original-secret');
    expect(result.path).toBe(`/hooks/${result.webhook.secret}/wr-hook`);
    expect(result.token).toBeTruthy();
    expect((await stored()).secret).toBe(result.webhook.secret);
  });

  it('the same admin with a non-worker session rotates (control)', async () => {
    const result = await rotate(person({ sessionId: f.personSession.id }));
    expect(result.webhook.secret).not.toBe('original-secret');
    expect(result.token).toBeTruthy();
  });

  it('a session bound after the pre-check is still refused inside the transaction', async () => {
    const c = person();
    let release!: () => void; let locked!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { locked = r; });
    const holder = db.$transaction(async tx => {
      await tx.agentWebhook.update({ where: { id: f.hook.id }, data: { updatedBy: 'holder' } });
      locked(); await gate;
    }, { timeout: 20000 });
    await ready;
    const call = rotate(c).then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await waitForLockWaitersOfType(db, 'transactionid');
      // The pre-check passed as a person; now the request becomes a worker session.
      c.sessionId = f.workerSession.id;
      release(); await holder;
      const out = await call;
      expect(out.error).toMatchObject({ extensions: { code: 'FORBIDDEN' }, message: 'Forbidden' });
      expect((await stored()).secret).toBe('original-secret');
    } finally { release(); await Promise.allSettled([holder, call]); }
  });
});

describe('#3511 unchanged neighbours', () => {
  it('deleteAgentWebhook still admits an org admin worker session (not on the list)', async () => {
    expect(await CLASSES.sessionRowWorker((c) => M.deleteAgentWebhook({}, { id: f.hook.id }, c))).toBe(true);
    expect((await stored()).deletedAt).not.toBeNull();
  });
});
