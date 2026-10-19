import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1967 — hadron_team_chat_post never silently records the HUMAN as the author (cor:agt:020:03 rev 55,
 * cor:agt:020:04 rev 22; Holger's ruling #12681: parity with hadron_channel_post, #1697).
 *
 * Before: an omitted `session` posted as the authenticated human with a success receipt, the #8403 class. Now the
 * tool has the channel tool's contract on BOTH its paths (the App's default team chat and `channel:`): a named
 * session posts as its Worker; with none named, a connection bound to one worker session posts as that Worker;
 * otherwise `asMe: true` posts as the human, or the post is refused [authorship_required]. The cross-App arm is the
 * shared resolveSessionAuthor's (the session driver's write right on the host memory), pinned here both ways.
 *
 * Over the real Streamable HTTP transport, because the connection binding lives in the per-connection registry the
 * transport layer maintains.
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
let strangerToken: string;
let teamChannelId: string;
let opsChannelId: string;
let headerSessionId: string;
let appUrn: string;
const WORKER_REF = 'hrn:worker:authorship1967.example:team:iris';
const DARA_REF = 'hrn:worker:authorship1967.example:team:dara';
const OLA_REF = 'hrn:worker:authorship1967.example:other:ola';

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Authorship', urn: 'authorship1967.example' } });
  const user = await db.user.create({ data: { githubId: 196701, githubUsername: 'team-human', handle: 'team-human', roles: ['READER'] } });
  const stranger = await db.user.create({ data: { githubId: 196702, githubUsername: 'other-human', handle: 'other-human', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { id: generateId(), urn: 'authorship1967.example:server-engineer', name: 'server-engineer', organizationId: org.id } });
  const app = await db.app.create({ data: { id: generateId(), name: 'Team', urn: 'authorship1967.example:team', organizationId: org.id } });
  appUrn = app.urn;
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const shared = await db.memory.create({ data: {
    id: generateId(), urn: 'authorship1967.example:team-shared', name: 'team-shared', class: 'app',
    appId: app.id, organizationId: org.id, sharedMemoryOfAgentId: agent.id,
  } });
  teamChannelId = (await ensureChannelWithRoot(db, { memoryId: shared.id, loc: 'chats:team', name: 'team', createdBy: user.id, asDefaultOfAppId: app.id })).channel.id;
  opsChannelId = (await ensureChannelWithRoot(db, { memoryId: shared.id, loc: 'chats:ops', name: 'ops', createdBy: user.id })).channel.id;
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Dara', slug: 'dara' } });
  // Another App of the same org, with a worker: the cross-App arm. Its driver is either the org admin (who may
  // write Team's host memory) or a stranger who belongs to Other only (who may not).
  const other = await db.app.create({ data: { id: generateId(), name: 'Other', urn: 'authorship1967.example:other', organizationId: org.id } });
  await db.appAgent.create({ data: { appId: other.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: other.id, userId: user.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: other.id, userId: stranger.id, role: 'member' } });
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: other.id, agentId: agent.id, name: 'Ola', slug: 'ola' } });
  headerSessionId = generateId();
  await db.session.create({
    data: { id: headerSessionId, appId: app.id, userId: user.id, workerId: worker.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() },
  });
  ({ rawKey: token } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' }));
  ({ rawKey: strangerToken } = await mintUserApiKey(db, { userId: stranger.id, label: null, createdBy: stranger.id, issuedVia: 'test' }));
});

/** One MCP connection; `header` sends X-Hadron-Session on every request. */
async function connection(header?: string, bearer = token) {
  const h = {
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(header ? { 'x-hadron-session': header } : {}),
  };
  const init = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: '1967', version: '1' } } }),
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

const seqOf = async (channelId: string) => (await db.channel.findUniqueOrThrow({ where: { id: channelId } })).lastSeq;
const posted = async () => (await seqOf(teamChannelId)) + (await seqOf(opsChannelId));
const sessionIdOf = (receipt: string) => /Session started: ([0-9a-f]{32})/.exec(receipt)![1];

/** Both of the tool's paths: the App's default team chat, and an explicit Channel. */
const PATHS: Array<[string, () => Record<string, unknown>]> = [
  ['the default team chat', () => ({ app: appUrn })],
  ['an explicit channel', () => ({ channel: opsChannelId })],
];

describe('#1967 hadron_team_chat_post: authorship is explicit', () => {
  for (const [path, where] of PATHS) {
    describe(`on ${path}`, () => {
      it('no session, nothing bound, no asMe: refused, and nothing is posted (it used to post as the human)', async () => {
        const call = await connection();
        const text = await call('hadron_team_chat_post', { ...where(), body: 'who am I?' });
        expect(text).toContain('[authorship_required]');
        expect(text).toContain('"isError":true');
        expect(text).not.toContain('as team-human');
        expect(await posted()).toBe(0);
      });

      it('asMe: true posts as the human, deliberately', async () => {
        const call = await connection();
        expect(await call('hadron_team_chat_post', { ...where(), body: 'me', asMe: true })).toContain('as team-human');
      });

      it('a connection bound to one worker session posts as that Worker with no session argument', async () => {
        const call = await connection();
        await call('hadron_start_session', { description: '1967', workerRef: WORKER_REF, force: true });
        const text = await call('hadron_team_chat_post', { ...where(), body: 'derived' });
        expect(text).toContain('as Iris');
        expect(text).not.toContain('as team-human');
      });

      it('the X-Hadron-Session header names the Worker the same way', async () => {
        const call = await connection(headerSessionId);
        expect(await call('hadron_team_chat_post', { ...where(), body: 'header' })).toContain('as Iris');
      });

      it('asMe: true still posts as the human on a worker-bound connection, and no worker is credited', async () => {
        const call = await connection();
        await call('hadron_start_session', { description: '1967', workerRef: WORKER_REF, force: true });
        expect(await call('hadron_team_chat_post', { ...where(), body: 'me', asMe: true })).toContain('as team-human');
        const msg = await db.node.findFirstOrThrow({ where: { content: 'me', nodeType: { not: 'chat' } }, select: { createdByWorkerId: true, createdByAgentId: true } });
        expect(msg).toEqual({ createdByWorkerId: null, createdByAgentId: null });
      });

      it('once the bound session ends, an unnamed post is refused again rather than falling back to the human', async () => {
        const call = await connection();
        const hadronSession = sessionIdOf(await call('hadron_start_session', { description: '1967', workerRef: WORKER_REF, force: true }));
        await call('hadron_end_session', { id: hadronSession });
        expect(await call('hadron_team_chat_post', { ...where(), body: 'after' })).toContain('[authorship_required]');
        expect(await posted()).toBe(0);
      });

      it('session and asMe together are refused', async () => {
        const call = await connection();
        const text = await call('hadron_team_chat_post', { ...where(), body: 'both', session: headerSessionId, asMe: true });
        expect(text).toContain('[bad_user_input]');
        expect(await posted()).toBe(0);
      });

      it('a named session posts as its Worker', async () => {
        const call = await connection();
        expect(await call('hadron_team_chat_post', { ...where(), body: 'named', session: headerSessionId })).toContain('as Iris');
      });
    });
  }

  describe('on a SHARED connection', () => {
    async function shared() {
      const call = await connection();
      const iris = sessionIdOf(await call('hadron_start_session', { description: 'chat A', workerRef: WORKER_REF, force: true }));
      const dara = sessionIdOf(await call('hadron_start_session', { description: 'chat B', workerRef: DARA_REF }));
      return { call, iris, dara };
    }

    it('an unnamed post is refused [session_ambiguous]; asMe: true posts as the human without choosing a worker', async () => {
      const { call } = await shared();
      expect(await call('hadron_team_chat_post', { app: appUrn, body: 'unsaid' })).toContain('[session_ambiguous]');
      const text = await call('hadron_team_chat_post', { app: appUrn, body: 'me, shared', asMe: true });
      expect(text).not.toContain('"isError":true');
      expect(text).toContain('as team-human');
      expect(text).not.toMatch(/as (Iris|Dara)/);
      expect(await call('hadron_team_chat_post', { app: appUrn, body: 'still unsaid' })).toContain('[session_ambiguous]');
    });

    it('naming a session still posts as that worker', async () => {
      const { call, dara } = await shared();
      expect(await call('hadron_team_chat_post', { app: appUrn, body: 'b', session: dara })).toContain('as Dara');
    });
  });

  describe('cross-App (Holger #12681; the shared resolveSessionAuthor)', () => {
    it('a worker of another App posts into this team chat when its driver may write the host memory, marked cross-App', async () => {
      const call = await connection();
      await call('hadron_start_session', { description: '1967 x', workerRef: OLA_REF });
      const text = await call('hadron_team_chat_post', { app: appUrn, body: 'from Other' });
      expect(text).toContain('as Ola');
      expect(text).toContain('cross-App post');
    });

    it('it is refused when its driver may not write the host memory, and nothing is posted', async () => {
      const call = await connection(undefined, strangerToken);
      await call('hadron_start_session', { description: '1967 x', workerRef: OLA_REF });
      const text = await call('hadron_team_chat_post', { app: appUrn, body: 'from Other' });
      expect(text).not.toContain('as Ola');
      expect(text).not.toContain('as other-human');
      expect(await posted()).toBe(0);
    });
  });
});
