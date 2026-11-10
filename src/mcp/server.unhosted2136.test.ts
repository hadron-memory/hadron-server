/** #2136: legacy App-key scope across real GraphQL and MCP, isolated synthetic fixtures only. */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { APP_KEY_PREFIX, hashAppKey, hashUserApiKey } from '../middleware/auth.js';
import { ensureChannelWithRoot } from '../lib/channels.js';
import { appendChatMessage } from '../lib/chatRoot.js';
import { getMemoryEncryptionInfo } from '../lib/nodeCrypto.js';
import { authorizeLegacyWakeWorkers } from '../lib/tickers/wakeKeyScope.js';
import { lockAuthorityAnchors } from '../lib/auth/authorityAnchors.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
let server: Server, base: string, appId: string, orgId: string, managerId: string;
let hosted: string, unhosted: string, rawKey: string, bareId: string, hostKeyId: string;
let hostRawKey: string;
beforeAll(async () => {
  server = httpServer(await createServer());
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
async function key(label: string) {
  const raw = APP_KEY_PREFIX + randomBytes(32).toString('hex');
  const row = await db.appKey.create({ data: { appId, label, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4) } });
  return { id: row.id, raw };
}
const ctx = (keyId: string): Context => ({ db, appId, appKeyId: keyId, organizationId: orgId, roles: [] });
async function hostWorker(workerId: string) {
  await resolvers.Mutation.registerHost({}, { input: { appRef: appId, label: 'Synthetic host', pollIntervalSeconds: 60,
    workers: [{ worker: workerId, family: 'codex', worktrees: [] }] } }, ctx(hostKeyId));
}
beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().toLowerCase();
  const org = await db.organization.create({ data: { name: 'R64', urn: `r64-${n}.example` } }); orgId = org.id;
  const manager = await db.user.create({ data: { githubId: 2136001, githubUsername: `r64-${n}`, roles: ['READER'] } }); managerId = manager.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: managerId, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { organizationId: orgId, name: 'Team', urn: `${org.urn}:role`, visibility: 'ORGANIZATION' } });
  const app = await db.app.create({ data: { organizationId: orgId, name: 'Team', urn: `${org.urn}:team` } }); appId = app.id;
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.appMember.create({ data: { appId, userId: managerId, role: 'member' } });
  const memory = await db.memory.create({ data: { organizationId: orgId, class: 'app', appId, sharedMemoryOfAgentId: agent.id,
    urn: `${org.urn}:shared`, name: 'Shared' } });
  const ch = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'Team', createdBy: managerId });
  const workers = [];
  for (const name of ['Hosted', 'Unhosted']) {
    const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId: managerId } });
    workers.push(w.id);
    await db.registerEntry.create({ data: { appId, channelId: ch.channel.id, attendeeWorkerId: w.id, role: 'BOTH' } });
  }
  [hosted, unhosted] = workers;
  const bare = await key('Bare'); rawKey = bare.raw; bareId = bare.id;
  const host = await key('Host'); hostKeyId = host.id; hostRawKey = host.raw;
  for (const k of [bareId, hostKeyId]) await db.appKeyScope.create({ data: { id: generateId(), appKeyId: k, scope: 'attention:deliver', grantedByUserId: managerId } });
  await db.appKeyScope.create({ data: { id: generateId(), appKeyId: hostKeyId, scope: 'host:operate', hostId: 'synthetic', grantedByUserId: managerId } });
  await hostWorker(hosted);
  const enc = await getMemoryEncryptionInfo(db, memory.id);
  await appendChatMessage(db, { id: ch.rootId, memoryId: memory.id, loc: 'chats:team' }, enc, async ({ tx, seq, msgNum }) =>
    tx.node.create({ data: { memoryId: memory.id, loc: `chats:team:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq,
      messageChannelId: ch.channel.id, content: 'synthetic mention for both', data: { mentions: ['hosted', 'unhosted'] } } }), { asChannel: true });
  await db.node.updateMany({ where: { messageChannelId: ch.channel.id }, data: { createdAt: new Date(Date.now() - 3600_000) } });
});
async function gql(query: string, variables: Record<string, unknown>) {
  const response = await fetch(`${base}/graphql`, { method: 'POST', headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ data: any; errors?: { extensions?: { code?: string } }[] }>;
}
const dueQuery = 'query($app:String!,$workers:[String!]) { dueWakes(appRef:$app,workerRefs:$workers) { wakes { worker { id name } proof } } }';
describe('R64 legacy wake scope', () => {
  it('GraphQL unhosted read and acknowledgement succeed as the positive control', async () => {
    const page = await gql(dueQuery, { app: appId, workers: [unhosted] });
    expect(page.errors).toBeUndefined();
    expect(page.data.dueWakes.wakes.map((w: { worker: { id: string } }) => w.worker.id)).toEqual([unhosted]);
    const result = await gql('mutation($p:[String!]!){ acknowledgeWakes(proofs:$p){ acknowledged unchanged } }', { p: [page.data.dueWakes.wakes[0].proof] });
    expect(result.errors).toBeUndefined(); expect(result.data.acknowledgeWakes.acknowledged).toBe(1);
  });
  it('GraphQL batches already refuse the bare attention key', async () => {
    const result = await gql('query($app:String!){ deliveryBatches(appRef:$app){ batches { id text } } }', { app: appId });
    expect(result.errors?.[0]?.extensions?.code).toBe('APP_KEY_SCOPE_REQUIRED');
  });
  it('GraphQL due-wake read must return only the unhosted worker', async () => {
    const result = await gql(dueQuery, { app: appId });
    expect(result.errors).toBeUndefined();
    expect(result.data.dueWakes.wakes.map((w: { worker: { id: string } }) => w.worker.id)).toEqual([unhosted]);
  });
  it('GraphQL ack must refuse an issued proof once its worker becomes hosted', async () => {
    const page = await gql(dueQuery, { app: appId, workers: [unhosted] });
    const proof = page.data.dueWakes.wakes[0].proof;
    await hostWorker(unhosted);
    const result = await gql('mutation($p:[String!]!){ acknowledgeWakes(proofs:$p){ acknowledged unchanged } }', { p: [proof] });
    expect(await db.workerWakeAck.count()).toBe(0);
    expect(result.errors?.length).toBeGreaterThan(0);
  });
  it('GraphQL host key reads and acknowledges only its registered workers', async () => {
    rawKey = hostRawKey;
    const page = await gql(dueQuery, { app: appId });
    expect(page.errors).toBeUndefined();
    expect(page.data.dueWakes.wakes.map((w: { worker: { id: string } }) => w.worker.id)).toEqual([hosted]);
    expect(JSON.stringify(page)).not.toContain('Unhosted');
    const out = await gql('mutation($p:[String!]!){acknowledgeWakes(proofs:$p){acknowledged}}', { p: [page.data.dueWakes.wakes[0].proof] });
    expect(out.errors).toBeUndefined(); expect(out.data.acknowledgeWakes.acknowledged).toBe(1);
  });

  it('GraphQL formerly-host key fails closed after scope revocation', async () => {
    rawKey = hostRawKey;
    await resolvers.Mutation.revokeAppKeyScope({}, { id: hostKeyId, scope: 'host:operate' }, { db, userId: managerId, roles: ['READER'] });
    const out = await gql(dueQuery, { app: appId });
    expect(out.errors?.[0]?.extensions?.code).toBe('APP_KEY_SCOPE_REQUIRED');
    expect(out.data).toBeNull();
    expect(await db.appKeyWakeRead.count()).toBe(0);
  });

  it.each(['registration', 'host-scope', 'attention-scope'])('host ack refuses %s loss with no acknowledgement writes', async loss => {
    rawKey = hostRawKey;
    const page = await gql(dueQuery, { app: appId });
    const proof = page.data.dueWakes.wakes[0].proof;
    if (loss === 'registration') {
      await resolvers.Mutation.registerHost({}, { input: { appRef: appId, label: 'Synthetic host', pollIntervalSeconds: 60, workers: [] } }, ctx(hostKeyId));
    } else {
      await resolvers.Mutation.revokeAppKeyScope({}, { id: hostKeyId, scope: loss === 'host-scope' ? 'host:operate' : 'attention:deliver' }, { db, userId: managerId, roles: ['READER'] });
    }
    const out = await gql('mutation($p:[String!]!){acknowledgeWakes(proofs:$p){acknowledged}}', { p: [proof] });
    expect(out.errors?.length).toBeGreaterThan(0);
    expect(await db.workerWakeAck.count()).toBe(0);
    expect(await db.workerDeliveryTick.count()).toBe(0);
    expect(await db.workerDeliveryTaskEvent.count()).toBe(0);
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });

  it('a lost host does not transfer its listed workers to a non-host key', async () => {
    await db.hostRegistration.updateMany({ where: { appId }, data: { lostAt: new Date() } });
    const out = await gql(dueQuery, { app: appId });
    expect(out.errors).toBeUndefined();
    expect(out.data.dueWakes.wakes.map((w: { worker: { id: string } }) => w.worker.id)).toEqual([unhosted]);
  });

  it('personal user key retains its holder/manager read and acknowledgement arm', async () => {
    rawKey = 'hdr_user_' + randomBytes(32).toString('hex');
    await db.userApiKey.create({ data: { userId: managerId, keyHash: hashUserApiKey(rawKey), keyPreview: rawKey.slice(-4), oauthScopes: [] } });
    const out = await gql(dueQuery, { app: appId });
    expect(out.errors).toBeUndefined();
    expect(new Set(out.data.dueWakes.wakes.map((w: { worker: { id: string } }) => w.worker.id))).toEqual(new Set([hosted, unhosted]));
    const ack = await gql('mutation($p:[String!]!){acknowledgeWakes(proofs:$p){acknowledged}}', { p: out.data.dueWakes.wakes.map((w: { proof: string }) => w.proof) });
    expect(ack.errors).toBeUndefined(); expect(ack.data.acknowledgeWakes.acknowledged).toBe(2);
  });

  it.each(['registration', 'scope'])('read revalidates %s change after selecting its page', async change => {
    let selected!: () => void;
    let resume!: () => void;
    const selectedPage = new Promise<void>(r => { selected = r; });
    const releasePage = new Promise<void>(r => { resume = r; });
    const original = db.worker.findMany.bind(db.worker);
    let pinned = false;
    const spy = vi.spyOn(db.worker, 'findMany').mockImplementation((async (args: any) => {
      const rows = await original(args);
      if (!pinned && args?.select?.heldByUserId && args?.take) {
        pinned = true;
        expect(rows.map(r => r.id)).toContain(unhosted);
        selected(); await releasePage;
      }
      return rows;
    }) as typeof db.worker.findMany);
    const pending = gql(dueQuery, { app: appId, workers: [unhosted] });
    try {
      await selectedPage;
      if (change === 'registration') {
        await hostWorker(unhosted);
        expect(await db.hostRegistrationWorker.count({ where: { workerId: unhosted } })).toBe(1);
      } else {
        await resolvers.Mutation.revokeAppKeyScope({}, { id: bareId, scope: 'attention:deliver' }, { db, userId: managerId, roles: ['READER'] });
        expect(await db.appKeyScope.count({ where: { appKeyId: bareId, revokedAt: { not: null } } })).toBe(1);
      }
      resume();
      const result = await pending;
      expect(result.errors?.length).toBeGreaterThan(0);
      expect(result.data).toBeNull();
      expect(await db.appKeyWakeRead.count()).toBe(0);
      expect(await db.appWakeReservation.count()).toBe(0);
    } finally { resume(); spy.mockRestore(); await pending; }
  });

  it('a deciding non-host scope fences the first registration until commit', async () => {
    let held!: () => void;
    let release!: () => void;
    const holding = new Promise<void>(r => { held = r; });
    const finish = new Promise<void>(r => { release = r; });
    let readerPid = 0;
    const reader = db.$transaction(async tx => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: appId }, { kind: 'org', id: orgId }], 'shared');
      expect(await authorizeLegacyWakeWorkers(tx, { appKeyId: bareId, appId }, null, [unhosted])).toBe(true);
      readerPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
      held(); await finish;
    });
    await holding;
    let registered = false;
    const writer = hostWorker(unhosted).then(() => { registered = true; });
    try {
      let blocked = false;
      for (let n = 0; n < 100; n++) {
        const rows = await db.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE ${readerPid} = ANY(pg_blocking_pids(a.pid))) AS blocked`;
        if (rows[0].blocked) { blocked = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      expect(blocked).toBe(true);
      expect(registered).toBe(false);
      expect(await db.hostRegistrationWorker.count({ where: { workerId: unhosted } })).toBe(0);
    } finally { release(); await reader; await writer; }
    expect(registered).toBe(true);
    expect(await db.hostRegistrationWorker.count({ where: { workerId: unhosted } })).toBe(1);
  });

  it('host keys exclude workers registered only to a different host', async () => {
    const other = await key('Other host');
    await db.appKeyScope.create({ data: { id: generateId(), appKeyId: other.id, scope: 'host:operate', hostId: 'other', grantedByUserId: managerId } });
    await resolvers.Mutation.registerHost({}, { input: { appRef: appId, label: 'Other', pollIntervalSeconds: 60,
      workers: [{ worker: unhosted, family: 'codex', worktrees: [] }] } }, ctx(other.id));
    rawKey = hostRawKey;
    const out = await gql(dueQuery, { app: appId });
    expect(out.errors).toBeUndefined();
    expect(out.data.dueWakes.wakes.map((w: { worker: { id: string } }) => w.worker.id)).toEqual([hosted]);
    expect(JSON.stringify(out)).not.toContain('Unhosted');
  });

  it('host scope with a lost registration is refused even on an empty page', async () => {
    rawKey = hostRawKey;
    await db.hostRegistration.updateMany({ where: { appId }, data: { lostAt: new Date() } });
    const out = await gql(dueQuery, { app: appId });
    expect(out.errors?.[0]?.extensions?.code).toBe('APP_KEY_SCOPE_REQUIRED');
    expect(out.data).toBeNull();
    expect(await db.appKeyWakeRead.count()).toBe(0);
  });

  it('registration filtering precedes pagination and audit count', async () => {
    const out = await gql('query($a:String!){dueWakes(appRef:$a,first:1){wakes{worker{id name}} pageInfo{hasNextPage endCursor}}}', { a: appId });
    expect(out.errors).toBeUndefined();
    expect(out.data.dueWakes.wakes.map((w: { worker: { id: string } }) => w.worker.id)).toEqual([unhosted]);
    expect(out.data.dueWakes.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
    expect((await db.appKeyWakeRead.findMany()).map(r => r.workerCount)).toEqual([1]);
  });

  it('final audit revalidates a registration change after issuance', async () => {
    const original = db.$transaction.bind(db);
    let transactions = 0;
    let changed = false;
    const spy = vi.spyOn(db, '$transaction').mockImplementation((async (...args: any[]) => {
      transactions++;
      if (transactions === 2) {
        spy.mockRestore();
        expect(await db.appWakeReservation.count({ where: { workerId: unhosted } })).toBe(1);
        await hostWorker(unhosted); changed = true;
      }
      return (original as any)(...args);
    }) as typeof db.$transaction);
    try {
      const out = await gql(dueQuery, { app: appId, workers: [unhosted] });
      expect(changed).toBe(true);
      expect(out.errors?.length).toBeGreaterThan(0);
      expect(out.data).toBeNull();
      expect(await db.appKeyWakeRead.count()).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it('dormant-only answers filter hosted names before counting or audit', async () => {
    const old = new Date(Date.now() - 100 * 86400000);
    for (const workerId of [hosted, unhosted]) await db.session.create({ data: { id: generateId(), appId, workerId, userId: managerId,
      startedAt: old, updatedAt: old, type: 'DEVELOPER' } });
    const out = await gql('query($a:String!){dueWakes(appRef:$a){wakes{worker{id}} dormant{worker{id name}}}}', { a: appId });
    expect(out.errors).toBeUndefined();
    expect(out.data.dueWakes.wakes).toEqual([]);
    expect(out.data.dueWakes.dormant.map((d: { worker: { id: string } }) => d.worker.id)).toEqual([unhosted]);
    expect(JSON.stringify(out)).not.toMatch(/"Hosted"/);
    expect((await db.appKeyWakeRead.findMany()).map(r => r.workerCount)).toEqual([1]);
  });

});
