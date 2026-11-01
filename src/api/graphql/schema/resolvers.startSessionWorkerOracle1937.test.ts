import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #1937 — `startSession`'s id/URN worker ref is not an existence oracle across tenants (the #1742 class).
 *
 * Before #1937, an outsider who guessed `hrn:worker:<org>:<app>:<name>` (or held an id) learned that the worker
 * exists, and in two shapes its ids: WORKER_RETIRED carried `workerId`, SESSION_WORKER_NOT_IN_APP carried
 * `workerId` and `workerAppId`, and a no-App-context caller got FORBIDDEN "not a member of this worker's App",
 * where an absent ref got WORKER_NOT_FOUND. Now the worker read gate on the worker's App runs right after the row
 * loads, and a denial answers exactly like an absent ref.
 *
 * The strict pin is the same ref before and after its worker's deletion: an outsider must not be able to tell the
 * two apart in message, code or extensions. Controls keep every precise code for a reader of the App, the #1037
 * selection-yields order, the soft-deleted-App collapse, and the narrow catch (an outage propagates).
 * The launch-grant exception is pinned twice, on purpose (#1945): here, so a mutant run of this suite alone kills its
 * removal, and in src/lib/hostOperations/launch.test.ts, beside the rest of the launch contract.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { composeWorkerUrn } from '../../../lib/entityRef/workerRef.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { LAUNCH_GRANT_PREFIX } from '../../../lib/hostOperations/launch.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string, appId?: string): Context => ({ db, userId, appId, roles: ['READER'] }) as Context;

/** The whole observable refusal: message, code and every extension. */
async function envelope(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    const g = e as GraphQLError;
    return JSON.stringify({ message: g.message, extensions: g.extensions });
  }
  throw new Error('expected a refusal');
}
const absentEnvelope = (ref: string) => JSON.stringify({ message: `Worker not found: ${ref}`, extensions: { code: 'WORKER_NOT_FOUND' } });
const start = (c: Context, input: Record<string, unknown>) =>
  M.startSession({}, { input: { id: generateId(), tool: 'vitest', ...input } }, c);

let org: { id: string; urn: string };
let app: { id: string; urn: string };
let otherOrgApp: { id: string; urn: string };
let ownedApp: { id: string; urn: string };
let participant: string;
let outsider: string;
let owner: string;
let agentId: string;
let ada: { id: string; urn: string };
let ret: { id: string; urn: string };
let uma: { id: string; urn: string };
let outsiderKey: { id: string };

async function worker(appRow: { id: string; urn: string }, name: string, extra: Record<string, unknown> = {}) {
  const slug = name.toLowerCase();
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: appRow.id, agentId, name, slug, ...extra }, select: { id: true } });
  return { id: w.id, urn: composeWorkerUrn(appRow.urn, slug) };
}

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `o37-${name}-${n}`, roles: ['READER'] }, select: { id: true } }).then((r) => r.id);
  const admin = await u(71, 'admin');
  participant = await u(72, 'participant');
  outsider = await u(73, 'outsider');
  owner = await u(74, 'owner');
  org = await db.organization.create({ data: { name: 'Tenant A', urn: `o37-a-${n}.example` }, select: { id: true, urn: true } });
  const orgB = await db.organization.create({ data: { name: 'Tenant B', urn: `o37-b-${n}.example` }, select: { id: true, urn: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgB.id, userId: outsider, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin))).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  await db.appMember.create({ data: { appId: app.id, userId: participant, role: 'member' } });
  // The outsider's own App, in their own org: the appRef, credential and selection shapes all come from it.
  otherOrgApp = await db.app.create({ data: { organizationId: orgB.id, name: 'Theirs', urn: `${orgB.urn}:theirs` }, select: { id: true, urn: true } });
  await db.appMember.create({ data: { appId: otherOrgApp.id, userId: outsider, role: 'member' } });
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  outsiderKey = await db.appKey.create({
    data: { id: generateId(), appId: otherOrgApp.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label: 'theirs' },
    select: { id: true },
  });
  // A user-owned App: the narrow-catch pin needs a participation lookup that is a plain row read.
  ownedApp = await db.app.create({ data: { ownerUserId: owner, name: 'Solo', urn: `o37-owner-${n}:solo` }, select: { id: true, urn: true } });
  ada = await worker(app, 'Ada');
  ret = await worker(app, 'Ret', { retiredAt: new Date() });
  uma = await worker(ownedApp, 'Uma');
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});

/** The outsider shapes: who asks, and with what App context. */
const SHAPES: Array<[string, () => { c: Context; input: Record<string, unknown> }]> = [
  ['no App context (a user of another org)', () => ({ c: ctx(outsider), input: {} })],
  ['an explicit appRef to their own App', () => ({ c: ctx(outsider), input: { appRef: otherOrgApp.urn } })],
  ['their own App key (a credential)', () => ({ c: { db, appId: otherOrgApp.id, appKeyId: outsiderKey.id, roles: [] } as unknown as Context, input: {} })],
  ['an active-App selection on their own App', () => ({ c: ctx(outsider, otherOrgApp.id), input: {} })],
];
const WORKERS: Array<[string, () => { id: string; urn: string }]> = [['a live worker', () => ada], ['a retired worker', () => ret]];
const FORMS: Array<['id' | 'urn']> = [['id'], ['urn']];

describe('an outsider cannot tell a foreign worker from an absent one', () => {
  for (const [shape, who] of SHAPES) {
    for (const [kind, pick] of WORKERS) {
      for (const [form] of FORMS) {
        it(`${shape}, ${kind}, by ${form}: the same ref answers identically before and after the worker is deleted`, async () => {
          const { c, input } = who();
          const w = pick();
          const ref = w[form];
          const before = await envelope(start(c, { ...input, workerRef: ref }));
          expect(before).toBe(absentEnvelope(ref));
          await db.worker.delete({ where: { id: w.id } });
          expect(await envelope(start(c, { ...input, workerRef: ref }))).toBe(before);
          expect(await db.session.count()).toBe(0);
        });
      }
    }
  }

  it('no refusal carries an id the caller did not send: a URN never comes back with the worker\'s id, nor any ref with its App\'s', async () => {
    for (const [, who] of SHAPES) {
      const { c, input } = who();
      for (const w of [ada, ret]) {
        const byUrn = await envelope(start(c, { ...input, workerRef: w.urn }));
        expect(byUrn).not.toContain(w.id);
        expect(byUrn).not.toContain(app.id);
        // An id-form ref is echoed as given, exactly as an absent id is; the App's id still never appears.
        expect(await envelope(start(c, { ...input, workerRef: w.id }))).not.toContain(app.id);
      }
    }
  });


});

describe('a reader of the App keeps every precise answer', () => {
  it('binds by id and by URN', async () => {
    expect((await start(ctx(participant), { workerRef: ada.id })).workerId).toBe(ada.id);
    expect((await start(ctx(participant), { workerRef: ada.urn, force: true })).workerId).toBe(ada.id);
  });

  it('a retired worker is WORKER_RETIRED, with its id', async () => {
    const got = JSON.parse(await envelope(start(ctx(participant), { workerRef: ret.urn })));
    expect(got.extensions).toEqual({ code: 'WORKER_RETIRED', workerId: ret.id });
  });

  it('an appRef naming another App the reader is in is SESSION_WORKER_NOT_IN_APP, with the ids', async () => {
    await db.appMember.create({ data: { appId: otherOrgApp.id, userId: participant, role: 'member' } });
    const got = JSON.parse(await envelope(start(ctx(participant), { appRef: otherOrgApp.urn, workerRef: ada.id })));
    expect(got.extensions).toMatchObject({ code: 'SESSION_WORKER_NOT_IN_APP', workerId: ada.id, workerAppId: app.id, appId: otherOrgApp.id });
  });

  it('#1037: a selection on another App yields to the ref, and the session lands in the worker\'s App', async () => {
    await db.appMember.create({ data: { appId: otherOrgApp.id, userId: participant, role: 'member' } });
    const s = await start(ctx(participant, otherOrgApp.id), { workerRef: ada.urn });
    expect(s.appId).toBe(app.id);
    expect(s.workerId).toBe(ada.id);
  });

  it('the App\'s own key binds its worker', async () => {
    const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
    const own = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label: 'own' }, select: { id: true } });
    const s = await start({ db, appId: app.id, appKeyId: own.id, roles: [] } as unknown as Context, { workerRef: ada.id });
    expect(s.workerId).toBe(ada.id);
  });

  it('a soft-deleted App still collapses, for its own participant too', async () => {
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    expect(await envelope(start(ctx(participant), { workerRef: ada.id }))).toBe(absentEnvelope(ada.id));
  });
});

describe('the narrow catch', () => {
  it('a failure inside the read gate propagates; it is never reported as a missing worker', async () => {
    const spy = vi.spyOn(db.appMember, 'findUnique').mockRejectedValueOnce(new Error('connection reset'));
    try {
      await expect(start(ctx(outsider), { workerRef: uma.id })).rejects.toThrow(/connection reset/);
    } finally {
      spy.mockRestore();
    }
  });

  it('control: without the failure the same call is the absent envelope', async () => {
    expect(await envelope(start(ctx(outsider), { workerRef: uma.id }))).toBe(absentEnvelope(uma.id));
    expect((await start(ctx(owner), { workerRef: uma.id })).workerId).toBe(uma.id);
  });
});

describe('#1945: the one exception, the worker the caller\'s own launch grant names', () => {
  // The grant already told its holder that this worker exists, so the read gate is skipped for it alone. A holder who
  // has since lost the App must reach the FORBIDDEN that fails the start (#10775), not a not-found that leaves the
  // start hanging. Removing the exception turns both answers below into the absent envelope.
  let holder: string;
  let kit: { id: string; urn: string };
  let hostKey: { id: string };
  const hostCtx = () => ({ db, appId: app.id, appKeyId: hostKey.id, organizationId: org.id, roles: [] }) as unknown as Context;

  beforeEach(async () => {
    const n = Math.floor(Math.random() * 1_000_000);
    const manager = (await db.user.create({ data: { githubId: 75 * 1_000_000 + n, githubUsername: `o37-mgr-${n}`, roles: ['READER'] }, select: { id: true } })).id;
    holder = (await db.user.create({ data: { githubId: 76 * 1_000_000 + n, githubUsername: `o37-holder-${n}`, roles: ['READER'] }, select: { id: true } })).id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: manager, role: 'ADMIN' } });
    await db.appMember.create({ data: { appId: app.id, userId: holder, role: 'member' } });
    kit = await worker(app, 'Kit', { heldByUserId: holder, heldAt: new Date() });
    const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
    hostKey = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label: 'host' }, select: { id: true } });
    await M.grantAppKeyScope({}, { id: hostKey.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager));
    await M.registerHost({}, {
      input: { appRef: app.id, label: 'Orca', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] }] },
    }, hostCtx());
    await M.issueHostOperation({}, {
      input: { appRef: app.id, hostId: 'orca1', worker: kit.id, type: 'worker.start', args: { worktree: 'hadron-server/kit', family: 'claude' } },
    }, ctx(manager));
  });

  const grantFor = async (): Promise<string> => {
    const [op] = await M.collectHostOperations({}, { appRef: app.id }, hostCtx());
    expect(op.launchGrant.startsWith(LAUNCH_GRANT_PREFIX)).toBe(true);
    return op.launchGrant as string;
  };
  const refusal = async (p: Promise<unknown>) => JSON.parse(await envelope(p)) as { extensions: Record<string, unknown> };

  for (const [form, ref] of [['the grant alone', () => undefined], ['the worker\'s URN', () => kit.urn], ['the worker\'s id', () => kit.id]] as const) {
    it(`by ${form}: a holder who lost the App reaches the FORBIDDEN that fails the start, never the absent envelope`, async () => {
      const grant = await grantFor();
      await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: holder } } });
      const workerRef = ref();
      const got = await refusal(start(ctx(holder), { launchGrant: grant, ...(workerRef ? { workerRef } : {}) }));
      expect(got.extensions).toMatchObject({ code: 'LAUNCH_REFUSED', reason: 'FORBIDDEN' });
      expect(got.extensions.code).not.toBe('WORKER_NOT_FOUND');
      expect(await db.session.count()).toBe(0);
    });
  }

  it('the disclosed marginal: that holder also learns their own grant\'s worker was retired, and nothing about any other', async () => {
    const grant = await grantFor();
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: holder } } });
    await db.worker.update({ where: { id: kit.id }, data: { retiredAt: new Date() } });
    expect((await refusal(start(ctx(holder), { launchGrant: grant }))).extensions).toMatchObject({ code: 'LAUNCH_REFUSED', reason: 'WORKER_RETIRED' });
  });

  it('control: any other ref the holder sends is gated first, so a retired worker of the App reads as absent', async () => {
    const grant = await grantFor();
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: holder } } });
    expect(await envelope(start(ctx(holder), { launchGrant: grant, workerRef: ret.urn }))).toBe(absentEnvelope(ret.urn));
  });
});
