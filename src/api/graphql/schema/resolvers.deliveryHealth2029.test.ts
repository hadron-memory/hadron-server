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
});
