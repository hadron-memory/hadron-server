/** #2029 S13 — independent read/filter pins; no S5 writer/schema/service assumptions.
 * Delivery DTO/current-health pins follow S5's frozen canonical service shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
let appId: string, otherAppId: string, workerId: string, otherWorkerId: string, foreignWorkerId: string;
let ctx: Context;
let eventIdPrefix: string, eventSequence: number;
const at = new Date('2026-10-18T10:00:00Z');

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId();
  eventIdPrefix = generateId().slice(0, 26); eventSequence = 0;
  const org = await db.organization.create({ data: { id: generateId(), name: 'health-org', urn: `health-${suffix}.com` } });
  const user = await db.user.create({ data: { id: generateId(), githubId: 99329, githubUsername: `health-${suffix}`, roles: ['READER'] } });
  ctx = { db, userId: user.id, roles: ['READER'] };
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Health Agent' }, ctx);
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Health', urn: `${org.urn}:health` } });
  const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  appId = app.id; otherAppId = other.id;
  const worker = async (a: string, name: string) => db.worker.create({ data: { id: generateId(), appId: a, agentId: agent.id, name, slug: name.toLowerCase() } });
  workerId = (await worker(appId, 'Target')).id;
  otherWorkerId = (await worker(appId, 'Sibling')).id;
  foreignWorkerId = (await worker(otherAppId, 'Foreign')).id;
});

const event = (subjectWorkerId: string, extra: Record<string, unknown> = {}) => db.agentTeamEvent.create({ data: {
  id: eventIdPrefix + (++eventSequence).toString(16).padStart(6, '0'), appId, subjectWorkerId, type: 'task.created', createdAt: at, ...extra,
} as any });
const read = (extra: Record<string, unknown> = {}) => Q.agentTeamEvents({}, { appRef: appId, workerRef: workerId, ...extra }, ctx);

describe('S13 worker-filtered immutable event history', () => {
  it('applies worker filtering before the page limit, rather than filtering a capped page', async () => {
    await event(otherWorkerId);
    const wanted = await event(workerId);
    expect((await read({ limit: 1 })).map((e: any) => e.id)).toEqual([wanted.id]);
  });
  it('resolves a worker name inside the authorized App', async () => {
    await event(otherWorkerId);
    const wanted = await event(workerId);
    expect((await read({ workerRef: 'Target' })).map((e: any) => e.id)).toEqual([wanted.id]);
  });
  it.each(['foreign', 'absent'])('conceals a %s worker with fixed WORKER_NOT_FOUND', async (kind) => {
    await expect(read({ workerRef: kind === 'foreign' ? foreignWorkerId : generateId() })).rejects.toMatchObject({ extensions: { code: 'WORKER_NOT_FOUND' } });
  });
  it('intersects worker, type and alarm filters without admitting another worker', async () => {
    await event(otherWorkerId, { type: 'task.stalled', severity: 'alarm' });
    await event(workerId);
    const wanted = await event(workerId, { type: 'task.stalled', severity: 'alarm' });
    expect((await read({ types: ['task.stalled'], alarmsOnly: true })).map((e: any) => e.id)).toEqual([wanted.id]);
  });
  it('resolves a same-App cursor before filtering and preserves equal-timestamp continuation', async () => {
    const cursor = await event(otherWorkerId);
    const wanted = await event(workerId);
    await event(otherWorkerId);
    expect((await read({ after: cursor.id, limit: 2 })).map((e: any) => e.id)).toEqual([wanted.id]);
  });
  it('returns an empty worker page even when other workers have history', async () => {
    await event(otherWorkerId);
    expect(await read()).toEqual([]);
  });
  it.each(['malformed', 'missing', 'foreign'])('conceals a %s cursor before applying the worker filter', async kind => {
    const foreign = await db.agentTeamEvent.create({ data: { appId: otherAppId, subjectWorkerId: foreignWorkerId, type: 'task.created', createdAt: at } });
    const after = kind === 'malformed' ? 'not-an-event-id' : kind === 'missing' ? generateId() : foreign.id;
    await expect(read({ after })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
  it('keeps since strictly greater and intersects it with worker scope', async () => {
    await event(workerId);
    await event(otherWorkerId, { createdAt: new Date(at.getTime() + 1) });
    const wanted = await event(workerId, { createdAt: new Date(at.getTime() + 1) });
    expect((await read({ since: at.toISOString() })).map((e: any) => e.id)).toEqual([wanted.id]);
  });
  it('intersects the existing task filter with worker scope', async () => {
    const task = await M.createAgentTask({}, { input: { appRef: appId, title: 'S13 task filter' } }, ctx);
    await event(otherWorkerId, { taskId: task.id });
    const wanted = await event(workerId, { taskId: task.id });
    await event(workerId);
    expect((await read({ taskId: task.id })).map((e: any) => e.id)).toEqual([wanted.id]);
  });
  it('preserves the unfiltered history contract and ascending equal-time order', async () => {
    const first = await event(otherWorkerId); const second = await event(workerId);
    expect((await Q.agentTeamEvents({}, { appRef: appId }, ctx)).map((e: any) => e.id)).toEqual([first.id, second.id]);
  });
  it('the live own-App key gets worker filtering, and revocation still wins', async () => {
    const key = await db.appKey.create({ data: { appId, keyHash: `h-${generateId()}`, keyPreview: 's13k' } });
    const keyCtx: Context = { db, appId, appKeyId: key.id, roles: [] };
    await event(otherWorkerId); const wanted = await event(workerId);
    expect((await Q.agentTeamEvents({}, { appRef: appId, workerRef: workerId, limit: 1 }, keyCtx)).map((e: any) => e.id)).toEqual([wanted.id]);
    await db.appKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    await expect(Q.agentTeamEvents({}, { appRef: appId, workerRef: workerId }, keyCtx)).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
  });
  it('denies a nonparticipant before revealing worker-reference existence', async () => {
    const user = await db.user.create({ data: { githubId: 9932030, githubUsername: 's13-outsider', roles: ['READER'] } });
    for (const ref of [workerId, foreignWorkerId, generateId()]) await expect(Q.agentTeamEvents({}, { appRef: appId, workerRef: ref }, { db, userId: user.id, roles: ['READER'] })).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
  });
  it('GraphQL exposes the worker filter instead of rejecting or ignoring it', async () => {
    await event(otherWorkerId); const wanted = await event(workerId);
    const { ApolloServer } = await import('@apollo/server'); const { typeDefs } = await import('./typeDefs.js');
    const server = new ApolloServer<Context>({ typeDefs, resolvers: resolvers as any });
    try {
      const r = await server.executeOperation({ query: 'query($app: String!, $worker: String!) { agentTeamEvents(appRef: $app, workerRef: $worker, limit: 1) { id } }', variables: { app: appId, worker: workerId } }, { contextValue: ctx });
      expect(r.body.kind).toBe('single'); if (r.body.kind !== 'single') throw new Error('expected single response');
      expect(r.body.singleResult.errors).toBeUndefined();
      expect((r.body.singleResult.data as any).agentTeamEvents.map((e: any) => e.id)).toEqual([wanted.id]);
    } finally { await server.stop(); }
  });
  it('MCP forwards workerRef before its limit and returns no sibling event', async () => {
    const sibling = await event(otherWorkerId); const wanted = await event(workerId);
    const { createTestableMcpServer } = await import('../../../mcp/server.js');
    const server = createTestableMcpServer({ userId: ctx.userId, roles: ['READER'] } as never, { sessionId: `s13-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
    const response: any = await server.callTool('hadron_team_events', { appRef: appId, workerRef: workerId, limit: 1 });
    expect(response.isError).not.toBe(true);
    expect(response.content[0].text).toContain(wanted.id);
    expect(response.content[0].text).not.toContain(sibling.id);
  });

  it('revoked keys and foreign Apps are concealed before worker resolution', async () => {
    const key = await db.appKey.create({ data: { appId, keyHash: `h-${generateId()}`, keyPreview: 's13r', revokedAt: new Date() } });
    const context: Context = { db, appId, appKeyId: key.id, roles: [] };
    for (const ref of [workerId, foreignWorkerId, generateId()]) await expect(Q.agentTeamEvents({}, { appRef: appId, workerRef: ref }, context)).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
    await db.appKey.update({ where: { id: key.id }, data: { revokedAt: null } });
    await expect(Q.agentTeamEvents({}, { appRef: otherAppId, workerRef: foreignWorkerId }, context)).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
    await expect(Q.agentTeamEvents({}, { appRef: appId, workerRef: workerId }, { ...context, sessionId: generateId() })).rejects.toMatchObject({ extensions: { code: 'APP_KEY_SESSION_BOUND' } });
  });

});
