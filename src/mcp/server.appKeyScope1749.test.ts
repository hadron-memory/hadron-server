import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1749 (Riana, #1781 cycle 1) — the App-key wake tools across the REAL returning-request boundary of the MCP HTTP
 * transport (`handleMcpRequest`), which `createTestableMcpServer.callTool` bypasses. A transport belongs to the exact
 * key that initialized it, and each request's own session header decides N5, not the initialization's.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { ensureChannelWithRoot } from '../lib/channels.js';
import { appendChatMessage } from '../lib/chatRoot.js';
import { getMemoryEncryptionInfo } from '../lib/nodeCrypto.js';
import { APP_KEY_PREFIX, hashAppKey } from '../middleware/auth.js';

vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let server: Server;
let baseUrl: string;
beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

let appId: string;
let keyA: { id: string; raw: string };
let keyB: { id: string; raw: string };
let sessionId: string;

async function mkKey(label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  const row = await db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label } });
  return { id: row.id, raw };
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  const org = await db.organization.create({ data: { id: generateId(), name: 'mcp-ak', urn: `mcp-ak-${suffix}` } });
  const holder = await db.user.create({ data: { id: generateId(), githubId: 99_100, githubUsername: `mk-${suffix}`, roles: ['READER'] }, select: { id: true } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.id}:team`, visibility: 'ORGANIZATION' } });
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.id}:team` } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.appMember.create({ data: { appId, userId: holder.id, role: 'member' } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.id}:team-shared`, name: 'shared', class: 'app', appId, sharedMemoryOfAgentId: agent.id } });
  const made = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'team', createdBy: holder.id });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name: 'Liam', slug: 'liam', heldByUserId: holder.id, heldAt: new Date() }, select: { id: true } });
  await db.registerEntry.create({ data: { id: generateId(), appId, channelId: made.channel.id, attendeeWorkerId: worker.id, role: 'BOTH' } });
  const enc = await getMemoryEncryptionInfo(db, memory.id);
  await appendChatMessage(db, { id: made.rootId, memoryId: memory.id, loc: 'chats:team' }, enc, async ({ tx, seq, msgNum }) =>
    tx.node.create({ data: { id: generateId(), memoryId: memory.id, loc: `chats:team:messages:${msgNum}`, name: msgNum, nodeType: 'chat-message', seq, messageChannelId: made.channel.id, content: 'for liam', data: { mentions: ['liam'] } } }),
    { asChannel: true });
  keyA = await mkKey('A');
  keyB = await mkKey('B');
  await db.appKeyScope.create({ data: { id: generateId(), appKeyId: keyA.id, scope: 'attention:deliver', grantedByUserId: holder.id } });
  sessionId = (await db.session.create({ data: { id: generateId(), appId }, select: { id: true } })).id;
});

const initializeBody = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'router', version: '1.0.0' } },
};
async function post(body: unknown, opts: { key: string; mcpSession?: string; hadronSession?: string }) {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${opts.key}`,
  };
  if (opts.mcpSession) headers['mcp-session-id'] = opts.mcpSession;
  if (opts.hadronSession) headers['x-hadron-session'] = opts.hadronSession;
  return fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function open(key: string, hadronSession?: string): Promise<string> {
  const res = await post(initializeBody, { key, hadronSession });
  expect(res.status).toBe(200);
  const id = res.headers.get('mcp-session-id')!;
  await res.text();
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { key, mcpSession: id, hadronSession });
  return id;
}
let rpc = 10;
/** A tool call on an open transport: the tool's text, or the HTTP status when the transport itself refuses. */
async function call(mcpSession: string, key: string, name: string, args: Record<string, unknown>, hadronSession?: string) {
  const res = await post({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name, arguments: args } }, { key, mcpSession, hadronSession });
  if (res.status !== 200) return { status: res.status, text: '' };
  const raw = await res.text();
  const data = raw.split('\n').find((l) => l.startsWith('data:'))?.slice(5) ?? raw;
  return { status: 200, text: (JSON.parse(data).result?.content?.[0]?.text ?? '') as string };
}
const due = (m: string, key: string, hs?: string) => call(m, key, 'hadron_due_wakes', { appRef: appId }, hs);

describe('the exact key: a transport belongs to the key that initialized it', () => {
  it('a same-App scopeless key B cannot borrow the scope, proof identity or audit of key A on A\'s transport', async () => {
    const m = await open(keyA.raw);
    const mine = await due(m, keyA.raw);
    expect(mine.text).toContain('1 due');
    const audited = await db.appKeyWakeRead.findMany();
    expect(audited.map((r) => r.appKeyId)).toEqual([keyA.id]);
    // B, live and of the same App, on A's transport: the transport does not exist for it.
    const borrowed = await due(m, keyB.raw);
    expect(borrowed.status).toBe(404);
    const proof = /proof: (\S+)/.exec(mine.text)![1]!;
    expect((await call(m, keyB.raw, 'hadron_ack_wakes', { proofs: [proof] })).status).toBe(404);
    expect(await db.appKeyWakeRead.count()).toBe(1);
    expect(await db.workerWakeAck.count()).toBe(0);
    // A itself still can, and the wake's receipt names A (#2072, R53: it moves no message mark).
    expect((await call(m, keyA.raw, 'hadron_ack_wakes', { proofs: [proof] })).text).toBe('Acknowledged 1.');
    expect((await db.workerWakeAck.findFirstOrThrow()).ackedByAppKeyId).toBe(keyA.id);
    expect(await db.workerDeliveryChannel.count()).toBe(0);
  });

  it('B on its own transport is the scopeless key it is; proofs stay separate per key', async () => {
    const mb = await open(keyB.raw);
    expect((await due(mb, keyB.raw)).text).toMatch(/^\[app_key_scope_required\]/);
    expect(await db.appKeyWakeRead.count()).toBe(0);
    await db.appKeyScope.create({ data: { id: generateId(), appKeyId: keyB.id, scope: 'attention:deliver', grantedByUserId: (await db.user.findFirstOrThrow()).id } });
    const ma = await open(keyA.raw);
    const proofA = /proof: (\S+)/.exec((await due(ma, keyA.raw)).text)![1]!;
    expect((await call(mb, keyB.raw, 'hadron_ack_wakes', { proofs: [proofA] })).text).toMatch(/^\[wake_proof_requester_mismatch\]/);
    expect(await db.workerWakeAck.count()).toBe(0);
  });
});

describe('N5 on the returning request: this request\'s session header decides', () => {
  it('unbound succeeds; a valid header refuses; an invalid header refuses; omitting it succeeds again — on due and ack', async () => {
    const m = await open(keyA.raw);
    const first = await due(m, keyA.raw);
    expect(first.text).toContain('1 due');
    const proof = /proof: (\S+)/.exec(first.text)![1]!;
    const reads = await db.appKeyWakeRead.count();
    for (const hs of [sessionId, generateId()]) {
      expect((await due(m, keyA.raw, hs)).text).toMatch(/^\[app_key_session_bound\]/);
      expect((await call(m, keyA.raw, 'hadron_ack_wakes', { proofs: [proof] }, hs)).text).toMatch(/^\[app_key_session_bound\]/);
    }
    // Refusals leave nothing behind.
    expect(await db.appKeyWakeRead.count()).toBe(reads);
    expect(await db.workerWakeAck.count()).toBe(0);
    // The header omitted again: the same transport works.
    expect((await due(m, keyA.raw)).text).toContain('1 due');
    expect((await call(m, keyA.raw, 'hadron_ack_wakes', { proofs: [proof] })).text).toBe('Acknowledged 1.');
  });

  it('a transport initialized with a session header is not stuck refused when later requests carry none', async () => {
    const m = await open(keyA.raw, sessionId);
    expect((await due(m, keyA.raw, sessionId)).text).toMatch(/^\[app_key_session_bound\]/);
    expect((await due(m, keyA.raw)).text).toContain('1 due');
  });
});
