import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1081 — MCP tools handed a live session id touch it, so the reaper counts it.
 *
 * The defect: the reaper measures last activity as the greatest of `startedAt`,
 * `updatedAt`, and the newest attributed UsageEvent. On the desktop track a
 * user-credential caller has no transport binding — the worker session is
 * created by `hadron_start_session` mid-conversation, long after the HTTP
 * connection exists, so it can never reach an `X-Hadron-Session` header. With
 * `auth.sessionId` null, usage events are unattributed and nothing bumped
 * `updatedAt`.
 *
 * So the only heartbeat was an ACCIDENT: `hadron_record_work(kind:'pr')`
 * denormalizing `Session.prNumber`. A worker who opened PRs lived; a worker who
 * did not — a coordinator, who reads chat and dispatches — was reaped ~24h after
 * bind regardless of how hard they worked, losing the #1029 handoff each time.
 *
 * What this pins:
 *   - every tool that takes a `session` argument touches it;
 *   - a tool that touches nothing else still heartbeats (the coordinator case:
 *     `team_chat_read` writes no rows at all);
 *   - ownership is re-checked, so naming someone else's session does nothing;
 *   - it cannot revive an ENDED session, and never clears `autoExpiredAt`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let user: { id: string };
let other: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };
let worker: { id: string };

/** A session whose `updatedAt` is old enough that any touch is unmistakable. */
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'hb-org', urn: `hb-${suffix}.com` },
  });
  user = await db.user.create({
    data: { id: generateId(), githubId: 98010, githubUsername: `hb-${suffix}`, roles: ['READER'] },
  });
  other = await db.user.create({
    data: { id: generateId(), githubId: 98011, githubUsername: `hb-o-${suffix}`, roles: ['READER'] },
  });
  for (const u of [user, other]) {
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: u.id, role: 'CONTRIBUTOR' },
    });
  }
  agent = await db.agent.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:se`, name: 'SE',
      visibility: 'ORGANIZATION', personaRole: 'server-engineer',
    },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Dara', slug: 'dara', role: 'server-engineer' },
  });
});

function auth(userId = user.id): AuthContext {
  return { userId, appId: app.id, roles: ['READER'], clientId: `user:${userId}` };
}

/**
 * A live worker session attributed to `userId`, last touched LONG_AGO.
 *
 * Callers must compare against the value this leaves STORED (`updatedAt(id)`),
 * never against `LONG_AGO` itself: `updated_at` is timestamp-without-zone, so a
 * raw-SQL write round-trips through a zone conversion and the literal is not
 * what comes back. Asserting `> LONG_AGO` happens to hold in a positive-offset
 * zone and would pass VACUOUSLY in a negative one — a false green that depends
 * on where the suite runs (PR #1082 review, Copilot).
 */
async function staleSession(userId = user.id): Promise<string> {
  const s = await db.session.create({
    data: { id: generateId(), workerId: worker.id, appId: app.id, userId },
  });
  await db.$executeRaw`UPDATE sessions SET updated_at = ${LONG_AGO} WHERE id = ${s.id}`;
  return s.id;
}

const updatedAt = async (id: string) =>
  (await db.session.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } })).updatedAt;

/** A session nobody has driven for longer than its idle window: started AND last touched long ago. */
async function lapsedSession(userId = user.id): Promise<string> {
  const s = await db.session.create({
    data: { id: generateId(), workerId: worker.id, appId: app.id, userId },
  });
  await db.$executeRaw`UPDATE sessions SET started_at = ${LONG_AGO}, updated_at = ${LONG_AGO} WHERE id = ${s.id}`;
  return s.id;
}

describe('#1543 — the heartbeat keeps a LIVE session alive and never revives a lapsed one', () => {


  it('GraphQL updateSession (pr/branch) does not revive a lapsed session; a live one still advances', async () => {
    const userCtx = { db, userId: user.id, roles: ['CONTRIBUTOR'] } as unknown as Context;
    const lapsed = await lapsedSession();
    const lapsedBefore = await updatedAt(lapsed);
    await (resolvers.Mutation as any).updateSession({}, { id: lapsed, branch: 'feat/late' }, userCtx);
    expect((await updatedAt(lapsed))!.getTime()).toBe(lapsedBefore!.getTime());

    const live = await staleSession(); // started now: live
    const liveBefore = await updatedAt(live);
    await (resolvers.Mutation as any).updateSession({}, { id: live, branch: 'feat/now' }, userCtx);
    expect((await updatedAt(live))!.getTime()).toBeGreaterThan(liveBefore!.getTime());
  });


});
