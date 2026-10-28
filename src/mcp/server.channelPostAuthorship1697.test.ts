import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1697 — hadron_channel_post never silently records the HUMAN as the author.
 *
 * The resolver treats sessionRef as optional and an omitted one meant "the
 * calling user", so an agent that forgot its worker session id posted under
 * its human's name with a success receipt. The tool now matches the CLI's
 * `channel post --session | --as-me` gate: a named session posts as its
 * Worker; with none named, a connection bound to one worker session (DAC,
 * #1610, or the X-Hadron-Session header) posts as that Worker; otherwise the
 * caller must say `asMe: true`, or the post is refused.
 *
 * Over the real Streamable HTTP transport, because the connection binding
 * lives in the per-connection registry the transport layer maintains.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { mintUserApiKey } from '../middleware/auth.js';
import { ensureChannelWithRoot } from '../lib/channels.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let server: Server;
let baseUrl: string;
let token: string;
let channelId: string;
let headerSessionId: string;
const WORKER_REF = 'hrn:worker:authorship1697.example:team:iris';
const DARA_REF = 'hrn:worker:authorship1697.example:team:dara';

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Authorship', urn: 'authorship1697.example' } });
  const user = await db.user.create({ data: { githubId: 169701, githubUsername: 'chan-human', handle: 'chan-human', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { id: generateId(), urn: 'authorship1697.example:server-engineer', name: 'server-engineer', organizationId: org.id } });
  const app = await db.app.create({ data: { id: generateId(), name: 'Team', urn: 'authorship1697.example:team', organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const shared = await db.memory.create({ data: {
    id: generateId(), urn: 'authorship1697.example:team-shared', name: 'team-shared', class: 'app',
    appId: app.id, organizationId: org.id, sharedMemoryOfAgentId: agent.id,
  } });
  await ensureChannelWithRoot(db, { memoryId: shared.id, loc: 'chats:team', name: 'team', createdBy: user.id, asDefaultOfAppId: app.id });
  channelId = (await ensureChannelWithRoot(db, { memoryId: shared.id, loc: 'chats:ops', name: 'ops', createdBy: user.id })).channel.id;
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Dara', slug: 'dara' } });
  headerSessionId = generateId();
  await db.session.create({
    data: { id: headerSessionId, appId: app.id, userId: user.id, workerId: worker.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() },
  });
  ({ rawKey: token } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' }));
});

/** One MCP connection; `header` sends X-Hadron-Session on every request. */
async function connection(header?: string) {
  const h = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(header ? { 'x-hadron-session': header } : {}),
  };
  const init = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: '1697', version: '1' } } }),
  });
  expect(init.status).toBe(200);
  const sid = init.headers.get('mcp-session-id')!;
  let id = 10;
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers: { ...h, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return res.text();
  };
}

const lastSeq = async () => (await db.channel.findUniqueOrThrow({ where: { id: channelId } })).lastSeq;

describe('#1697 hadron_channel_post: authorship is explicit', () => {
  it('no session, nothing bound, no asMe: refused, and nothing is posted (it used to post as the human)', async () => {
    const call = await connection();
    const text = await call('hadron_channel_post', { channel: channelId, body: 'who am I?' });
    expect(text).toContain('[authorship_required]');
    expect(text).toContain('"isError":true');
    expect(text).not.toContain('as chan-human');
    expect(await lastSeq()).toBe(0);
  });

  it('asMe: true posts as the human, deliberately', async () => {
    const call = await connection();
    expect(await call('hadron_channel_post', { channel: channelId, body: 'me', asMe: true })).toContain('as chan-human');
  });

  it('a connection bound to one worker session posts as that Worker with no session argument', async () => {
    const call = await connection();
    await call('hadron_start_session', { description: '1697', workerRef: WORKER_REF, force: true });
    const text = await call('hadron_channel_post', { channel: channelId, body: 'derived' });
    expect(text).toContain('as Iris');
    expect(text).not.toContain('as chan-human');
  });

  it('the X-Hadron-Session header names the Worker the same way', async () => {
    const call = await connection(headerSessionId);
    expect(await call('hadron_channel_post', { channel: channelId, body: 'header' })).toContain('as Iris');
  });

  it('asMe: true still posts as the human on a worker-bound connection', async () => {
    const call = await connection();
    await call('hadron_start_session', { description: '1697', workerRef: WORKER_REF, force: true });
    expect(await call('hadron_channel_post', { channel: channelId, body: 'me', asMe: true })).toContain('as chan-human');
    // The node stamp agrees with the envelope: the bound worker is not
    // credited for a post its human chose to make as themself.
    const msg = await db.node.findFirstOrThrow({ where: { content: 'me', nodeType: { not: 'chat' } }, select: { createdByWorkerId: true, createdByAgentId: true } });
    expect(msg).toEqual({ createdByWorkerId: null, createdByAgentId: null });
  });

  it('once the bound session ends, an unnamed post is refused again rather than falling back to the human', async () => {
    const call = await connection();
    const started = await call('hadron_start_session', { description: '1697', workerRef: WORKER_REF, force: true });
    const hadronSession = /Session started: ([0-9a-f]{32})/.exec(started)![1];
    await call('hadron_end_session', { id: hadronSession });
    expect(await call('hadron_channel_post', { channel: channelId, body: 'after' })).toContain('[authorship_required]');
    expect(await lastSeq()).toBe(0);
  });

  it('session and asMe together are refused', async () => {
    const call = await connection();
    const text = await call('hadron_channel_post', { channel: channelId, body: 'both', session: headerSessionId, asMe: true });
    expect(text).toContain('[bad_user_input]');
    expect(await lastSeq()).toBe(0);
  });

  describe('on a SHARED connection (#1711 review, Diego P2)', () => {
    /** One connection carrying two chat sessions' worker bindings, Iris then Dara. */
    async function shared() {
      const call = await connection();
      const iris = /Session started: ([0-9a-f]{32})/.exec(await call('hadron_start_session', { description: 'chat A', workerRef: WORKER_REF, force: true }))![1];
      const dara = /Session started: ([0-9a-f]{32})/.exec(await call('hadron_start_session', { description: 'chat B', workerRef: DARA_REF }))![1];
      return { call, iris, dara };
    }
    const authorsOfLatest = async () => {
      const msg = await db.node.findFirstOrThrow({
        where: { memoryId: (await db.channel.findUniqueOrThrow({ where: { id: channelId } })).memoryId, nodeType: { not: 'chat' } },
        orderBy: { createdAt: 'desc' },
        select: { data: true, content: true, createdByWorkerId: true, createdByAgentId: true },
      });
      return msg;
    };

    it('asMe: true posts as the human without choosing either worker, and settles nothing for later calls', async () => {
      const { call } = await shared();
      const text = await call('hadron_channel_post', { channel: channelId, body: 'me, on a shared host', asMe: true });
      expect(text).not.toContain('"isError":true');
      expect(text).toContain('as chan-human');
      expect(text).not.toMatch(/as (Iris|Dara)/);
      // No worker behind the write: neither the envelope nor the node stamp names one.
      const msg = await authorsOfLatest();
      expect(JSON.stringify(msg.data)).toContain('authorUserId');
      expect(msg.content).toBe('me, on a shared host');
      expect(JSON.stringify(msg.data)).not.toContain('authorWorkerId');
      expect({ createdByWorkerId: msg.createdByWorkerId, createdByAgentId: msg.createdByAgentId }).toEqual({ createdByWorkerId: null, createdByAgentId: null });
      // No scope change: the connection is exactly as ambiguous as before.
      expect(await call('hadron_channel_post', { channel: channelId, body: 'unsaid' })).toContain('[session_ambiguous]');
      expect(await call('hadron_create_node', { urn: 'hrn:node:authorship1697.example:team-shared:unsaid', name: 'unsaid' }))
        .toContain('[session_ambiguous]');
    });

    it('naming a session still posts as that worker on the shared connection', async () => {
      const { call, dara } = await shared();
      expect(await call('hadron_channel_post', { channel: channelId, body: 'b', session: dara })).toContain('as Dara');
    });

    it('sticky shared status: after one binding ends, an unnamed post is still refused (never derived), and asMe: true still posts as the human', async () => {
      const { call, dara } = await shared();
      await call('hadron_end_session', { id: dara });
      expect(await call('hadron_channel_post', { channel: channelId, body: 'unsaid' })).toContain('[session_ambiguous]');
      const text = await call('hadron_channel_post', { channel: channelId, body: 'me', asMe: true });
      expect(text).toContain('as chan-human');
      expect(text).not.toContain('as Iris');
    });
  });
});
