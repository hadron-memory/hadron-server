/**
 * #3986 — `globalSearch` agent-task arm, driven by a LIVE worker session built through real context construction
 * (`X-Hadron-Session` over HTTP), never a supplied `runAsActor` actor (cf. resolvers.globalSearchAgentTask3945.test.ts).
 * cor:api:050:02 / :03: search equals the per-kind task read gate, in hits AND `total`; cor:agt:050:21: a worker counts
 * as a participant through its worker session; cor:agt:020:03: the session runs on the holder's user and token.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../lib/workerSignature.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../middleware/auth.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let http: Server;
let base: string;
const keys: Record<string, string> = {};
let taskX: string;
let taskY: string;
let workerX: string;
let sessionAdmin: string; // org-admin holder, worker of App X
let sessionMember: string; // X-only AppMember holder, worker of App X
let memberId: string;
let appXId: string;

beforeAll(async () => {
  http = httpServer(await createServer());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => http.close(() => r())); });

async function mkKey(userId: string): Promise<string> {
  const raw = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId, oauthScopes: [], keyHash: hashUserApiKey(raw), keyPreview: raw.slice(-4) } });
  return raw;
}

async function gql(key: string, session: string | null, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(session ? { 'x-hadron-session': session } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

const SEARCH = 'query($q: String!) { globalSearch(query: $q, entityTypes: [agentTask]) { total hits { id entityType } } }';
const search = async (key: string, session: string | null) => {
  const r = await gql(key, session, SEARCH, { q: 'zebra' });
  expect(r.errors).toBeUndefined();
  return r.data.globalSearch as { total: number; hits: Array<{ id: string; entityType: string }> };
};
const ids = (r: { hits: Array<{ id: string }> }) => r.hits.map((h) => h.id).sort();

beforeEach(async () => {
  await cleanDb(db);
  const sfx = generateId().slice(-8);
  const org = await db.organization.create({ data: { name: 'Ws3986', urn: `ws3986-${sfx}.example` } });
  const admin = await db.user.create({ data: { handle: `ws3986-admin-${sfx}`, roles: ['READER'] } });
  const member = await db.user.create({ data: { handle: `ws3986-member-${sfx}`, roles: ['READER'] } });
  memberId = member.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Role', urn: `${org.urn}:agent` } });
  const appX = await db.app.create({ data: { organizationId: org.id, name: 'X', urn: `${org.urn}:x` } });
  const appY = await db.app.create({ data: { organizationId: org.id, name: 'Y', urn: `${org.urn}:y` } });
  appXId = appX.id;
  for (const a of [appX, appY]) await db.appAgent.create({ data: { appId: a.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: appX.id, userId: member.id, role: 'member' } });
  const mkWorker = (slug: string, holder: string) => db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: appX.id, agentId: agent.id, name: slug, slug, heldByUserId: holder },
  });
  const wAdmin = await mkWorker('wadmin', admin.id);
  const wMember = await mkWorker('wmember', member.id);
  workerX = wAdmin.id;
  const mkSession = async (userId: string, workerId: string) =>
    (await db.session.create({ data: { id: generateId(), appId: appX.id, userId, workerId, agentId: agent.id } })).id;
  sessionAdmin = await mkSession(admin.id, wAdmin.id);
  sessionMember = await mkSession(member.id, wMember.id);
  keys.admin = await mkKey(admin.id);
  keys.member = await mkKey(member.id);
  const CREATE = 'mutation($a: ID!, $t: String!) { createAgentTask(input: { appRef: $a, title: $t }) { id } }';
  const x = await gql(keys.admin, null, CREATE, { a: appX.id, t: 'Rotate the zebra keys' });
  const y = await gql(keys.admin, null, CREATE, { a: appY.id, t: 'Zebra audit on Y' });
  expect(x.errors).toBeUndefined();
  expect(y.errors).toBeUndefined();
  taskX = x.data.createAgentTask.id;
  taskY = y.data.createAgentTask.id;
});

describe('#3986 agentTask search through a live worker session over HTTP', () => {
  it('control: the org-admin holder acting as themselves (no session) sees BOTH Apps\' tasks', async () => {
    const r = await search(keys.admin, null);
    expect(ids(r)).toEqual([taskX, taskY].sort());
    expect(r.total).toBe(2);
  });

  it('the same holder through its worker session gets its own App only, hits and total (no cross-App reach)', async () => {
    const r = await search(keys.admin, sessionAdmin);
    expect(ids(r)).toEqual([taskX]);
    expect(r.total).toBe(1);
  });

  it('a retired worker\'s session finds nothing, and total is 0', async () => {
    expect(ids(await search(keys.admin, sessionAdmin))).toEqual([taskX]);
    await db.worker.update({ where: { id: workerX }, data: { retiredAt: new Date() } });
    const r = await search(keys.admin, sessionAdmin);
    expect(r.hits).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('removing the holder\'s live participation revokes the session\'s hits (a stale session userId does not admit)', async () => {
    const before = await search(keys.member, sessionMember);
    expect(ids(before)).toEqual([taskX]);
    expect(before.total).toBe(1);
    await db.appMember.delete({ where: { appId_userId: { appId: appXId, userId: memberId } } });
    const r = await search(keys.member, sessionMember);
    expect(r.hits).toEqual([]);
    expect(r.total).toBe(0);
  });
});
