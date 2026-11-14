/** #3914: real GraphQL worker and manager App-reference parity; all refusals precede any grant write. */
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../../server.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { dropTestActions, seedReadableNodes, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let http: Server;
let base: string;
beforeAll(async () => {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  http = httpServer(await createServer());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => http.close(() => r())); await cleanDb(db); await dropTestActions(); vi.unstubAllEnvs(); });

let w: World;
let pubNode: string; // #4067: a node the requester can read
/** manager: org ADMIN (user2). member: contributor (user1, drives the worker). outsider: no membership. */
let managerId: string; let memberId: string; let outsiderId: string;
let managerKey: string; let memberKey: string; let outsiderKey: string;
let workerSession: string;
let otherWorkerId: string; let otherAppWorkerId: string;

async function keyFor(userId: string): Promise<string> {
  const k = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId, oauthScopes: [], keyHash: hashUserApiKey(k), keyPreview: k.slice(-4) } });
  return k;
}
async function post(key: string, session: string | null, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(session ? { 'x-hadron-session': session } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}
const CREATE = 'mutation($i:CreateGrantInput!){createGrant(input:$i){id appId requestedByWorkerId}}';
beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  [pubNode] = await seedReadableNodes(w.orgId);
  await upsertPlatformActions(db);
  memberId = w.userId; managerId = w.user2Id;
  outsiderId = (await db.user.create({ data: { handle: `out-${generateId().slice(0, 6)}` } })).id;
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: memberId, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: managerId, role: 'ADMIN' } });
  await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } });
  await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: memberId } });
  workerSession = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: memberId, workerId: w.workerId, agentId: w.agentId } })).id;
  [managerKey, memberKey, outsiderKey] = await Promise.all([keyFor(managerId), keyFor(memberId), keyFor(outsiderId)]);
  otherWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'p', slug: `p-${generateId().slice(0, 6)}` } })).id;
  otherAppWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.app2Id, agentId: w.agentId, name: 'o', slug: `o-${generateId().slice(0, 6)}` } })).id;
});

async function refs(appId: string) {
  const app = await db.app.findUniqueOrThrow({ where: { id: appId } });
  const bare = app.urn.replace(/^hrn:app:/, '');
  const legacy = `legacy-${generateId()}.test:old`;
  const renamed = `renamed-${generateId()}.test:old`;
  await db.app.update({ where: { id: appId }, data: { legacyUrn: legacy } });
  await db.urnAlias.create({ data: { urn: renamed, entityType: 'APP', entityId: appId, reason: 'RENAME', replacedByUrn: bare } });
  return { id: appId, canonical: `hrn:app:${bare}`, double: `hrn:app:${bare.replace(/:/g, '::')}`, legacy: `hrn:app:${legacy}`, renamed: `hrn:app:${renamed}` };
}
const input = (appRef: string, holderRef = w.workerId) => ({ appRef, action: 'schedule.create', values: { entryNode: pubNode }, holderKind: 'WORKER', holderRef, reason: 'reference parity' });
const workerCall = (appRef: string) => post(memberKey, workerSession, CREATE, { i: input(appRef) });
const grantCount = () => db.grant.count();

describe('#3914 worker own-App references use the shared resolver', () => {
  for (const form of ['id', 'canonical', 'double', 'legacy', 'renamed'] as const) {
    it(`worker accepts own App ${form} and writes only its own App`, async () => {
      const own = await refs(w.appId);
      const r = await workerCall(own[form]);
      expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
      expect(r.data.createGrant).toMatchObject({ appId: w.appId, requestedByWorkerId: w.workerId });
      expect(await grantCount()).toBe(1);
    });
    it(`manager still accepts the shared ${form} form`, async () => {
      const own = await refs(w.appId);
      const r = await post(managerKey, null, CREATE, { i: input(own[form], otherWorkerId) });
      expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
      expect(r.data.createGrant).toMatchObject({ appId: w.appId, requestedByWorkerId: null });
    });
  }
  it('another App in every form, missing, relative and malformed all conceal identically before holder validation/write', async () => {
    const other = await refs(w.app2Id);
    const responses = [];
    for (const ref of [...Object.values(other), `hrn:app:missing-${generateId()}.test:app`, 'relative', 'hrn:app:']) {
      const r = await post(memberKey, workerSession, CREATE, { i: input(ref, generateId()) });
      expect(r.data?.createGrant ?? null).toBeNull();
      expect(r.errors).toHaveLength(1);
      responses.push({ message: r.errors[0].message, extensions: r.errors[0].extensions });
    }
    expect(responses[0].extensions.code).toBe('GRANT_REQUESTER_NOT_WORKER');
    for (const r of responses) expect(r).toEqual(responses[0]);
    expect(await grantCount()).toBe(0);
  });
  it('foreign ambiguous rename history is the same concealed refusal, not an existence oracle', async () => {
    const other = await refs(w.app2Id);
    const third = await db.app.create({ data: { organizationId: w.orgId, name: 'third', urn: `third-${generateId()}.test:app` } });
    await db.urnAlias.create({ data: { urn: other.renamed.replace(/^hrn:app:/, ''), entityType: 'APP', entityId: third.id, reason: 'RENAME' } });
    const a = await workerCall(other.renamed);
    const b = await workerCall(`hrn:app:missing-${generateId()}.test:app`);
    expect(a.errors[0].extensions.code).toBe('GRANT_REQUESTER_NOT_WORKER');
    expect(a.errors).toEqual(b.errors);
    expect(await grantCount()).toBe(0);
  });
  it('an operational App lookup fault propagates instead of becoming a requester denial', async () => {
    const own = await refs(w.appId);
    const original = db.app.findFirst.bind(db.app);
    let injected = false;
    const spy = vi.spyOn(db.app, 'findFirst').mockImplementation((args) => {
      if (args?.where?.AND) { injected = true; throw new Error('3914 synthetic database fault'); }
      return original(args);
    });
    try {
      const r = await workerCall(own.canonical);
      expect(injected).toBe(true);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');
      expect(await grantCount()).toBe(0);
    } finally { spy.mockRestore(); }
  });

});
