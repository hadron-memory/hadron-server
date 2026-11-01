/**
 * #3030 boundary pin: over real HTTP, a request bound to a worker session (`x-hadron-session`) publishes the worker
 * that the Agent-management guard reads, so the holder's own credential is refused there; the same credential with no
 * session header acts as the person and succeeds.
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
let raw: string;
let agentId: string;
let sessionId: string;

beforeAll(async () => {
  http = httpServer(await createServer());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => http.close(() => r())); });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Ws3030 http', urn: 'ws3030http.example' } });
  const user = await db.user.create({ data: { handle: 'ws3030-holder', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Coordinator role', urn: 'ws3030http.example:agent' } });
  agentId = agent.id;
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: 'ws3030http.example:team' } });
  await db.appAgent.create({ data: { appId: app.id, agentId } });
  const worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Ada', slug: 'ada', heldByUserId: user.id },
  });
  sessionId = (await db.session.create({ data: { id: generateId(), appId: app.id, userId: user.id, workerId: worker.id, agentId } })).id;
  raw = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId: user.id, oauthScopes: [], keyHash: hashUserApiKey(raw), keyPreview: raw.slice(-4) } });
});

async function gql(bound: boolean, query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}`, ...(bound ? { 'x-hadron-session': sessionId } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

const CREATE = 'mutation($a: String!) { createAgentTickerTemplate(agentRef: $a, input: { name: "base", cadenceSeconds: 600 }) { id } }';
const SET_GROUP = 'mutation($a: ID!) { setAgentModelGroup(agentRef: $a, name: "large", patterns: ["claude-opus-*"]) { name } }';
const VIEWER = 'query($a: ID!) { agent(ref: $a) { viewerMayEditTickerTemplates } }';

describe('#3030 over HTTP', () => {
  it('a worker-session-bound request is refused at both kinds of door and writes nothing', async () => {
    const t = await gql(true, CREATE, { a: agentId });
    expect(t.errors?.[0]?.extensions?.code).toBe('AGENT_MANAGEMENT_WORKER_SESSION_REFUSED');
    const g = await gql(true, SET_GROUP, { a: agentId });
    expect(g.errors?.[0]?.extensions?.code).toBe('AGENT_MANAGEMENT_WORKER_SESSION_REFUSED');
    expect(await db.agentTickerTemplate.count()).toBe(0);
    expect(await db.modelGroup.count()).toBe(0);
  });

  it('the capability field answers false when bound and true unbound', async () => {
    expect((await gql(true, VIEWER, { a: agentId })).data?.agent?.viewerMayEditTickerTemplates).toBe(false);
    expect((await gql(false, VIEWER, { a: agentId })).data?.agent?.viewerMayEditTickerTemplates).toBe(true);
  });

  it('the same credential without the session header acts as the person and succeeds', async () => {
    const t = await gql(false, CREATE, { a: agentId });
    expect(t.errors).toBeUndefined();
    const g = await gql(false, SET_GROUP, { a: agentId });
    expect(g.errors).toBeUndefined();
    expect(await db.agentTickerTemplate.count()).toBe(1);
    expect(await db.modelGroup.count()).toBe(1);
  });
});
