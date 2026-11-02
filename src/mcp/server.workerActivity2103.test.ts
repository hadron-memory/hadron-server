/** #2103: roster history is recorded activity, distinct from liveness/end time. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { createTestableMcpServer } from './server.js';
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

/** Drive the registered production handler, including its real batched activity fold. */
async function rosterLine() {
  const output = await createTestableMcpServer(auth).callToolText('hadron_list_workers', {});
  const line = output.split('\n').find(value => value.startsWith('- History '));
  expect(line, output).toBeDefined();
  return line!;
}

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

describe('#2103 registered list_workers historical activity', () => {
  it('held but idle OPEN session uses last activity, not start/update or current liveness', async () => {
    const row = await session(null);
    const line = await rosterLine();
    expect(line).toContain('held by YOU, no live session, last recorded activity 4h ago');
    expect(line).not.toMatch(/last driven|never driven|ended/);
    expect((await db.session.findUniqueOrThrow({ where: { id: row.id } })).endedAt).toBeNull();
  });

  it('ended session renders activity age even when its end is much more recent', async () => {
    const row = await session(ago(77));
    const line = await rosterLine();
    expect(line).toContain('held by YOU, no live session, last recorded activity 4h ago');
    // #3077: the check status now names WHY it is NO_SESSION, as a closed reason with no time. #2103's rule is that
    // the ACTIVITY part makes no end-time claim, so it is judged with the check segment removed.
    expect(line).toMatch(/, check NO_SESSION \(ended\)$/);
    expect(line.replace(/, check [^,]*$/, '')).not.toMatch(/last driven|never driven|ended|1h ago|2d ago|3d ago/);
    expect((await db.session.findUniqueOrThrow({ where: { id: row.id } })).endedAt).not.toBeNull();
  });

  it('held never-driven worker retains the never and no-live states with no invented timestamp', async () => {
    expect(await rosterLine()).toContain('held by YOU, no live session, never driven');
    expect(await rosterLine()).not.toMatch(/last recorded activity|last driven|ended|ago/);
  });

  it('currently live worker keeps live state without a historical age or end claim', async () => {
    const row = await session(null);
    await db.session.update({ where: { id: row.id }, data: { updatedAt: ago(7) } });
    const line = await rosterLine();
    expect(line).toContain('held by YOU, session live');
    expect(line).not.toMatch(/no live session|never driven|last recorded activity|last driven|ended|ago/);
  });
});
