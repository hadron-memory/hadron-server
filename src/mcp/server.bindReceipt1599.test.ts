import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/** #1599: real MCP receipts identify the session argument separately from the worker. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import * as workerResolvers from '../api/graphql/schema/resolvers.worker.js';
import { createTestableMcpServer } from './server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

let userId: string;
let appId: string;
let workerId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Receipt', urn: `receipt-${generateId()}.example` } });
  const user = await db.user.create({ data: { githubId: 159901, githubUsername: 'receipt-user' } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Engineer', urn: `${org.urn}:engineer`, systemPrompt: 'You are {{name}}.' } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.appMember.create({ data: { appId, userId, role: 'owner' } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: 'Iris', slug: 'iris' } })).id;
});

afterEach(() => vi.restoreAllMocks());

const server = () => createTestableMcpServer({ userId, appId, roles: ['READER'], clientId: `user:${userId}` }, { sessionId: generateId() });

/** Read the committed identity independently of the receipt being checked. */
async function boundSessionId() {
  return (await db.session.findFirstOrThrow({ where: { workerId, endedAt: null }, orderBy: { startedAt: 'desc' } })).id;
}

function expectBindLabels(text: string, sessionId: string) {
  expect(sessionId).not.toBe(workerId);
  expect(text).toContain(`Worker session id: ${sessionId} (pass as \`session\``);
  expect(text).toContain(`worker id: ${workerId}`);
  expect(text).not.toContain(`Worker session id: ${workerId}`);
  expect(text).not.toContain(`worker id: ${sessionId}`);
}

describe('#1599 bound identity labels', () => {
  it('start keeps its success marker and labels the committed session and worker ids', async () => {
    const text = await server().callToolText('hadron_start_session', { description: 'work', workerRef: workerId });
    const sessionId = await boundSessionId();
    expect(text).toContain(`Session started: ${sessionId}`);
    expectBindLabels(text, sessionId);
    expect(text).toContain('You are Iris.');
  });

  it('a briefing failure still returns both correct labels after the session committed', async () => {
    vi.spyOn(workerResolvers, 'composeWorkerPrompt').mockRejectedValueOnce(new Error('briefing unavailable'));
    const text = await server().callToolText('hadron_start_session', { description: 'work', workerRef: workerId });
    const sessionId = await boundSessionId();
    expect(text).toContain('The boot briefing could not be rendered');
    expect(text).toContain(`Session started: ${sessionId}`);
    expectBindLabels(text, sessionId);
    expect(text).not.toContain('Error:');
  });

  it('resume preserves the same session and gives the same labeled identities', async () => {
    const first = server();
    await first.callToolText('hadron_start_session', { description: 'work', workerRef: workerId });
    const sessionId = await boundSessionId();
    await first.callToolText('hadron_create_resume_claim', { session: sessionId });
    const text = await server().callToolText('hadron_resume_session', {});
    expect(text).toContain(`Session resumed: ${sessionId}`);
    expectBindLabels(text, sessionId);
    expect(await db.session.count({ where: { workerId, endedAt: null } })).toBe(1);
  });

  it('get-worker explicitly identifies which displayed id is the active worker session', async () => {
    const srv = server();
    await srv.callToolText('hadron_start_session', { description: 'work', workerRef: workerId });
    const sessionId = await boundSessionId();
    const text = await srv.callToolText('hadron_get_worker', { workerRef: workerId });
    expect(text).toContain(`Worker id: ${workerId}`);
    expect(text).toContain(`Your active session: ${sessionId} (worker session id; pass as \`session\``);
    expect(text).not.toContain(`Your active session: ${workerId}`);
  });

  it('whoami labels each id on its own bound row', async () => {
    const srv = server();
    await srv.callToolText('hadron_start_session', { description: 'work', workerRef: workerId });
    const sessionId = await boundSessionId();
    const text = await srv.callToolText('hadron_whoami', {});
    expect(text).toContain(`- session ${sessionId} (worker session id; pass as \`session\``);
    expect(text).toContain(`worker id: ${workerId}`);
    expect(text).not.toContain(`worker id: ${sessionId}`);
  });

  it('a plain session labels its session id without inventing a worker identity', async () => {
    const srv = server();
    const text = await srv.callToolText('hadron_start_session', { description: 'plain work' });
    const session = await db.session.findFirstOrThrow({ where: { userId, workerId: null } });
    expect(text).toContain(`Session started: ${session.id}`);
    expect(text).toContain(`Session id: ${session.id} (pass as \`session\``);
    expect(text).not.toContain('Worker session id:');
    expect(text).not.toContain('worker id:');
    expect((await srv.callToolText('hadron_whoami', {}))).toContain('working as: nobody');
  });

  it('the receipt composes the briefing under the session being returned, so its immutable record (not the current approval) is read', async () => {
    const spy = vi.spyOn(workerResolvers, 'composeWorkerPrompt');
    await server().callToolText('hadron_start_session', { description: 'work', workerRef: workerId });
    const sessionId = await boundSessionId();
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]![0].sessionId).toBe(sessionId);
  });
});
