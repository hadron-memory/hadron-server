/**
 * #1054 — WorkerContinuity.handoffAuthor: who held the worker when the session
 * that wrote the newest handoff ran. The handle is identity
 * (hrn:node:hadronmemory.com:specs:cor:acl:070:01), so any signed-in caller who
 * can read the worker sees it; null only for an unknown or erased author.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mintUserApiKey } from '../../../middleware/auth.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../../../test/startServerFixture.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

type Gql = { data?: any; errors?: Array<{ message: string }> };
let n: number;
let org: { id: string; urn: string };
let appId: string;
let workerId: string;
let workMemoryId: string;
const user: Record<string, string> = {};

let server: Server;
let baseUrl: string;
beforeAll(async () => {
  server = createHttpServer(await createServerOnCleanDb());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await closeServerIfStarted(server); });

const keyFor = async (who: string) =>
  (await mintUserApiKey(db, { userId: user[who]!, label: null, createdBy: user[who]!, issuedVia: 'test' })).rawKey;
async function post(bearer: string, query: string, variables: Record<string, unknown> = {}): Promise<Gql> {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Gql>;
}
const Q = `query($w: ID!, $a: ID) { worker(ref: $w, appRef: $a) { continuity {
  status handoff { id } previousSession { id } handoffAuthor { userHandle sessionId } } } }`;

async function endedSession(id: string, userId: string | null, extra: Record<string, unknown> = {}) {
  await db.session.create({
    data: { id, appId, workerId, userId, endedAt: new Date(Date.now() - 1000), ...extra } as any,
  });
}
async function handoff(loc: string, data: unknown) {
  await db.node.create({ data: { memoryId: workMemoryId, loc, name: loc, content: 'where I got to', data: data as any } });
}

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Author', urn: `ha1054-${n}.example` }, select: { id: true, urn: true } });
  for (const who of ['holderA', 'holderB', 'stranger']) {
    user[who] = (await db.user.create({ data: { handle: `ha1054-${who}-${n}`, roles: ['READER'] } })).id;
  }
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.holderA!, role: 'READER' } });
  appId = (await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } })).id;
  await db.appMember.create({ data: { appId, userId: user.holderB!, role: 'member' } });
  const sys = (await db.memory.create({ data: { class: 'system', organizationId: org.id, name: 'Iris system', urn: `${org.urn}:iris-system` } })).id;
  const agentId = (await db.agent.create({
    data: { organizationId: org.id, name: 'Iris', urn: `${org.urn}:iris`, visibility: 'ORGANIZATION', systemMemoryId: sys },
  })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  workMemoryId = (await db.memory.create({
    data: { class: 'app', organizationId: org.id, appId, name: 'Iris working', urn: `${org.urn}:iris-working` },
  })).id;
  workerId = (await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'Iris', slug: 'iris', memoryId: workMemoryId },
  })).id;
});

describe('#1054 — WorkerContinuity.handoffAuthor', () => {
  it('a handoff written under holder A and read by holder B names A', async () => {
    const sid = `s-a-${n}`;
    await endedSession(sid, user.holderA!);
    await handoff('handoffs:0001', { sessionId: sid });
    const r = await post(await keyFor('holderB'), Q, { w: workerId, a: appId });
    expect(r.errors).toBeUndefined();
    expect(r.data.worker.continuity.status).toBe('CURRENT');
    expect(r.data.worker.continuity.handoffAuthor).toEqual({ userHandle: `ha1054-holderA-${n}`, sessionId: sid });
    expect(r.data.worker.continuity.previousSession.id).toBe(sid);
  });

  it('names the author of an OLDER handoff (status MISSING), not the previous session\'s driver', async () => {
    const old = `s-old-${n}`;
    await endedSession(old, user.holderA!);
    await endedSession(`s-new-${n}`, user.holderB!);
    await handoff('handoffs:0001', { sessionId: old });
    const r = await post(await keyFor('holderB'), Q, { w: workerId, a: appId });
    expect(r.errors).toBeUndefined();
    expect(r.data.worker.continuity.status).toBe('MISSING');
    expect(r.data.worker.continuity.handoffAuthor).toEqual({ userHandle: `ha1054-holderA-${n}`, sessionId: old });
  });

  it('an unknown author (no user on the session) gives a null handle and no error', async () => {
    const sid = `s-nouser-${n}`;
    await endedSession(sid, null);
    await handoff('handoffs:0001', { sessionId: sid });
    const r = await post(await keyFor('holderB'), Q, { w: workerId, a: appId });
    expect(r.errors).toBeUndefined();
    expect(r.data.worker.continuity.handoffAuthor).toEqual({ userHandle: null, sessionId: sid });
  });

  it('an erased author (soft-deleted user) gives a null handle and no error', async () => {
    const sid = `s-erased-${n}`;
    await endedSession(sid, user.holderA!);
    await handoff('handoffs:0001', { sessionId: sid });
    await db.user.update({ where: { id: user.holderA! }, data: { deletedAt: new Date() } });
    const r = await post(await keyFor('holderB'), Q, { w: workerId, a: appId });
    expect(r.errors).toBeUndefined();
    expect(r.data.worker.continuity.handoffAuthor).toEqual({ userHandle: null, sessionId: sid });
  });

  it('a hand-written handoff (no session envelope) gives an author with nothing known', async () => {
    await handoff('handoffs:0001', {});
    const r = await post(await keyFor('holderB'), Q, { w: workerId, a: appId });
    expect(r.errors).toBeUndefined();
    expect(r.data.worker.continuity.handoff.id).toEqual(expect.any(String));
    expect(r.data.worker.continuity.handoffAuthor).toEqual({ userHandle: null, sessionId: null });
  });

  it('handoffAuthor is null when handoff is null', async () => {
    await endedSession(`s-x-${n}`, user.holderA!);
    const r = await post(await keyFor('holderB'), Q, { w: workerId, a: appId });
    expect(r.errors).toBeUndefined();
    expect(r.data.worker.continuity.handoff).toBeNull();
    expect(r.data.worker.continuity.handoffAuthor).toBeNull();
  });

  it('a caller denied the worker read gets continuity null, unchanged', async () => {
    const sid = `s-deny-${n}`;
    await endedSession(sid, user.holderA!);
    await handoff('handoffs:0001', { sessionId: sid });
    const r = await post(await keyFor('stranger'), Q, { w: workerId, a: appId });
    expect(JSON.stringify(r)).not.toContain(`ha1054-holderA-${n}`);
    expect(r.data?.worker?.continuity ?? null).toBeNull();
  });

  it('exposes nothing of the writing session beyond its id', async () => {
    const sid = `s-leak-${n}`;
    await endedSession(sid, user.holderA!, { transcriptPath: '/secret/transcript', host: 'secret-host', summary: 'secret summary' });
    await handoff('handoffs:0001', { sessionId: sid });
    const r = await post(await keyFor('holderB'), Q, { w: workerId, a: appId });
    expect(r.errors).toBeUndefined();
    const s = JSON.stringify(r.data);
    for (const secret of ['/secret/transcript', 'secret-host', 'secret summary']) expect(s).not.toContain(secret);
  });
});
