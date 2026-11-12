/**
 * #4067 (V86, ruling 0265; hrn:node:hadronmemory.com:specs:cor:acl:140:07): `createGrant` stores a grant only if every node-typed value
 * names a live node the REQUESTER can read. A missing node, a deleted one, one in a memory the requester cannot read and a malformed
 * id are ONE refusal (GRANT_VALUES_INVALID, the same message), so the call is no existence oracle, and nothing is stored. All three
 * arms: the worker session, the managing person over GraphQL, and `hadron_create_grant` over MCP.
 */
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../../server.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { USER_API_KEY_PREFIX, hashUserApiKey, type AuthContext } from '../../../middleware/auth.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { dropTestActions, seedReadableNodes, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

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
let readable: string; let readableB: string;
let hidden: string; // exists, in a memory neither requester can read
let deleted: string;
let managerId: string; let memberId: string;
let managerKey: string; let memberKey: string; let workerSession: string; let holderWorkerId: string;

async function keyFor(userId: string): Promise<string> {
  const k = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId, oauthScopes: [], keyHash: hashUserApiKey(k), keyPreview: k.slice(-4) } });
  return k;
}
async function post(key: string, session: string | null, query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(session ? { 'x-hadron-session': session } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}
const CREATE = 'mutation($i:CreateGrantInput!){createGrant(input:$i){id action values}}';
const rows = () => db.$queryRawUnsafe<any[]>('SELECT * FROM grants');
const base_ = (values: unknown, over: Record<string, unknown> = {}) => ({
  action: 'schedule.create', values: { entryNode: values }, holderKind: 'WORKER', holderRef: holderWorkerId, reason: 'nightly digest', ...over,
});
const asWorker = (v: unknown) => post(memberKey, workerSession, CREATE, { i: { ...base_(v), holderRef: w.workerId } });
const asManager = (v: unknown) => post(managerKey, null, CREATE, { i: { ...base_(v), appRef: w.appId } });
const asMcp = async (v: unknown) => {
  const auth = { userId: managerId, roles: ['READER'], clientId: `user:${managerId}`, appId: w.appId, organizationId: w.orgId } as AuthContext;
  const s = createTestableMcpServer(auth, { sessionId: `g-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
  return s.callToolText('hadron_create_grant', { app: w.appId, ...base_(v) });
};

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  [readable, readableB] = await seedReadableNodes(w.orgId, 2);
  // A memory in another org, private, with no member: neither the worker's person nor the manager can read it.
  const org2 = await db.organization.create({ data: { name: 'x-org', urn: `x-${generateId().slice(0, 6)}.test` } });
  const priv = await db.memory.create({ data: { id: generateId(), organizationId: org2.id, urn: `${org2.urn}:kb`, name: 'priv', class: 'knowledge', visibility: 'ORGANIZATION' } as never });
  hidden = (await db.node.create({ data: { id: generateId(), memoryId: priv.id, loc: 'h', name: 'h', nodeType: 'info', content: 'x' } as never })).id;
  const pub = await db.node.findFirstOrThrow({ where: { id: readableB } });
  deleted = (await db.node.create({ data: { id: generateId(), memoryId: pub.memoryId, loc: 'gone', name: 'gone', nodeType: 'info', content: 'x', deletedAt: new Date() } as never })).id;
  await upsertPlatformActions(db);
  memberId = w.userId; managerId = w.user2Id;
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: memberId, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: managerId, role: 'ADMIN' } });
  await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } });
  await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: memberId } });
  workerSession = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: memberId, workerId: w.workerId, agentId: w.agentId } })).id;
  [managerKey, memberKey] = await Promise.all([keyFor(managerId), keyFor(memberId)]);
  holderWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'p', slug: `p-${generateId().slice(0, 6)}` } })).id;
});

const ARMS: Array<[string, (v: unknown) => Promise<any>]> = [['worker', asWorker], ['manager', asManager]];

describe.each(ARMS)('%s arm', (_name, ask) => {
  it('a node the requester can read is stored exactly as before', async () => {
    const r = await ask(readable);
    expect(r.errors).toBeUndefined();
    expect(r.data.createGrant.values).toEqual({ entryNode: readable });
    expect(await rows()).toHaveLength(1);
  });

  it('a nonexistent, a deleted, an unreadable and a malformed id are the byte-identical refusal, and nothing is stored', async () => {
    const answers = [];
    for (const v of [generateId(), deleted, hidden, 'not an id!', [readable, generateId()], [readable, hidden]]) {
      const r = await ask(v);
      expect(r.data).toBeNull();
      answers.push(JSON.stringify(r.errors.map((e: any) => ({ message: e.message, code: e.extensions?.code, path: e.path }))));
    }
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0])[0].code).toBe('GRANT_VALUES_INVALID');
    expect(answers[0]).not.toContain(hidden);
    expect(await rows()).toHaveLength(0);
  });

  it('a list of readable nodes is accepted', async () => {
    const r = await ask([readable, readableB]);
    expect(r.errors).toBeUndefined();
    expect(await rows()).toHaveLength(1);
  });
});

describe('requester-read, not world-read', () => {
  it('a node only SOMEONE ELSE can read is refused: the manager\'s own private memory is theirs to name, not the worker\'s person\'s', async () => {
    // A private memory owned by the manager's person: only that person reads it.
    const mem = await db.memory.create({ data: { id: generateId(), userId: managerId, urn: `mgr-${generateId().slice(0, 6)}.test:mine`, name: 'mine', class: 'private', ownerUserId: managerId } as never });
    const onlyManager = (await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'a', name: 'a', nodeType: 'info', content: 'x' } as never })).id;
    const viaWorker = await asWorker(onlyManager);
    const viaManager = await asManager(onlyManager);
    // Whatever each requester's own read gate says decides: a refusal for one never depends on what the other can read.
    expect(viaManager.errors).toBeUndefined();
    expect(viaWorker.errors?.[0]?.extensions?.code).toBe('GRANT_VALUES_INVALID');
  });
});

describe('MCP arm (hadron_create_grant, person only)', () => {
  it('stores a readable node and refuses missing, deleted and unreadable with one answer, storing nothing', async () => {
    const ok = JSON.parse(await asMcp(readable));
    expect(ok.values).toEqual({ entryNode: readable });
    const before = (await rows()).length;
    const answers = [];
    for (const v of [generateId(), deleted, hidden, 'not an id!']) answers.push(await asMcp(v));
    expect(new Set(answers).size).toBe(1);
    expect(answers[0].toLowerCase()).toContain('grant_values_invalid');
    expect(answers[0]).not.toContain(hidden);
    expect((await rows()).length).toBe(before);
  });
});
