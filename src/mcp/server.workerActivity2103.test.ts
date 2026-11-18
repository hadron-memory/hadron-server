/** #2103: roster history is recorded activity, distinct from liveness/end time. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn() }));

let auth: AuthContext;
let workerId: string;
let appId: string;
let userId: string;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('SESSION_IDLE_WINDOW_DEVELOPER_MS', String(60 * 60_000));
  const org = await db.organization.create({ data: { name: 'Activity2103', urn: 'activity2103.example' } });
  const user = await db.user.create({ data: { githubId: 2103001, githubUsername: 'activity-holder', roles: ['READER'] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'CONTRIBUTOR' } });
  const agent = await db.agent.create({ data: {
    organizationId: org.id, name: 'Activity role', urn: 'activity2103.example:role', visibility: 'ORGANIZATION',
  } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Activity team', urn: 'activity2103.example:team' } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  const worker = await db.worker.create({ data: {
    ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: 'History', slug: 'history', role: 'engineer', heldByUserId: userId,
  } });
  workerId = worker.id;
  auth = { userId, appId, roles: ['READER'], clientId: `user:${userId}` };
});
afterEach(() => vi.unstubAllEnvs());

/**
 * #3082: hadron_list_workers no longer registers over MCP, so the roster's activity facts are read from the resolvers it
 * folded (Worker.hasLiveSession, Worker.lastActiveAt), with the same expectations as the rendered roster line had.
 */
async function facts() {
  const w = await db.worker.findUniqueOrThrow({ where: { id: workerId } });
  const ctx = { db, userId, appId, roles: ['READER'] } as never;
  const W = resolvers.Worker as any;
  return {
    live: await W.hasLiveSession(w, {}, ctx) as boolean | null,
    last: await W.lastActiveAt(w, {}, ctx) as Date | null,
  };
}
const ageMin = (d: Date) => Math.round((Date.now() - d.getTime()) / 60_000);

async function session(endedAt: Date | null) {
  const row = await db.session.create({ data: {
    id: generateId(), workerId, appId, userId, type: 'DEVELOPER',
    startedAt: ago(3 * 24 * 60), updatedAt: ago(2 * 24 * 60), endedAt,
  } });
  await db.usageEvent.create({ data: {
    sessionId: row.id, type: 'read', countsAsActivity: true, createdAt: ago(4 * 60 + 17),
  } });
  return row;
}

describe('#2103 Worker.hasLiveSession / lastActiveAt historical activity', () => {
  it('held but idle OPEN session uses last activity, not start/update or current liveness', async () => {
    const row = await session(null);
    const f = await facts();
    expect(f.live).toBe(false);
    expect(ageMin(f.last!)).toBe(4 * 60 + 17);
    expect((await db.session.findUniqueOrThrow({ where: { id: row.id } })).endedAt).toBeNull();
  });

  it('ended session renders activity age even when its end is much more recent', async () => {
    const row = await session(ago(77));
    const f = await facts();
    expect(f.live).toBe(false);
    // the ACTIVITY makes no end-time claim: it is the event's age, not the end (77m), start (3d) or update (2d)
    expect(ageMin(f.last!)).toBe(4 * 60 + 17);
    expect((await db.session.findUniqueOrThrow({ where: { id: row.id } })).endedAt).not.toBeNull();
  });

  it('held never-driven worker retains the never and no-live states with no invented timestamp', async () => {
    expect(await facts()).toEqual({ live: false, last: null });
  });

  it('currently live worker keeps live state without a historical age or end claim', async () => {
    const row = await session(null);
    await db.session.update({ where: { id: row.id }, data: { updatedAt: ago(7) } });
    const f = await facts();
    expect(f.live).toBe(true);
  });
});
