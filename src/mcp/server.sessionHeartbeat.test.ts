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
      personaPrompt: 'You are {{name}}, a {{role}}.',
    },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  worker = await db.worker.create({
    data: { appId: app.id, agentId: agent.id, name: 'Dara', slug: 'dara', role: 'server-engineer' },
  });
});

function auth(userId = user.id): AuthContext {
  return { userId, appId: app.id, roles: ['READER'], clientId: `user:${userId}` };
}

/** A live worker session attributed to `userId`, last touched LONG_AGO. */
async function staleSession(userId = user.id): Promise<string> {
  const s = await db.session.create({
    data: { id: generateId(), workerId: worker.id, appId: app.id, userId },
  });
  await db.$executeRaw`UPDATE sessions SET updated_at = ${LONG_AGO} WHERE id = ${s.id}`;
  return s.id;
}

const updatedAt = async (id: string) =>
  (await db.session.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } })).updatedAt;

describe('#1081 — every tool handed a session id heartbeats it', () => {
  it('hadron_team_chat_read — the pure-read case that wrote nothing at all', async () => {
    const id = await staleSession();
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_team_chat_read', { session: id, sinceSeq: 0 });
    // This is the coordinator's day: reading the chat kept no session alive
    // before #1081, because a read writes no rows the reaper can see.
    expect((await updatedAt(id))!.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it('hadron_team_chat_post', async () => {
    const id = await staleSession();
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_team_chat_post', { session: id, body: 'hello' });
    expect((await updatedAt(id))!.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it('hadron_list_workers and hadron_get_worker', async () => {
    for (const [tool, args] of [
      ['hadron_list_workers', {}],
      ['hadron_get_worker', { workerRef: 'Dara' }],
    ] as const) {
      const id = await staleSession();
      const srv = createTestableMcpServer(auth());
      await srv.callToolText(tool, { ...(args as object), session: id } as never);
      expect((await updatedAt(id))!.getTime(), tool).toBeGreaterThan(LONG_AGO.getTime());
    }
  });

  it('hadron_record_work — including the kinds that never touched the row', async () => {
    // Only kind:'pr' with a `#N` ref used to touch the Session, as a side effect
    // of denormalizing prNumber. A branch record heartbeats now too.
    const id = await staleSession();
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_record_work', {
      session: id, tool: 'github', kind: 'branch', ref: 'o/r:feat/x', action: 'pushed',
    });
    expect((await updatedAt(id))!.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it('hadron_team_work_items', async () => {
    const id = await staleSession();
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_team_work_items', { session: id });
    expect((await updatedAt(id))!.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });
});

describe('#1081 — the heartbeat is not a hole', () => {
  it('does NOT touch a session attributed to someone else', async () => {
    const theirs = await staleSession(other.id);
    // Snapshot what is actually STORED rather than asserting the literal we
    // wrote: `updated_at` is a timestamp-without-zone column, so a raw-SQL
    // write round-trips through a zone conversion and the literal is not what
    // comes back. The property under test is "unchanged", which does not need
    // to know the value.
    const before = await updatedAt(theirs);
    const srv = createTestableMcpServer(auth(user.id));
    await srv.callToolText('hadron_team_chat_read', { session: theirs, sinceSeq: 0 });
    // Otherwise any caller could keep an arbitrary session alive by naming it.
    expect((await updatedAt(theirs))!.getTime()).toBe(before!.getTime());
  });

  it('does NOT revive an ENDED session, and leaves autoExpiredAt intact', async () => {
    const id = await staleSession();
    const reapedAt = new Date('2026-02-02T00:00:00.000Z');
    await db.session.update({
      where: { id },
      data: { endedAt: reapedAt, autoExpiredAt: reapedAt },
    });
    await db.$executeRaw`UPDATE sessions SET updated_at = ${LONG_AGO} WHERE id = ${id}`;
    const before = await updatedAt(id);
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_team_chat_read', { session: id, sinceSeq: 0 });
    const row = await db.session.findUniqueOrThrow({ where: { id } });
    expect(row.updatedAt!.getTime()).toBe(before!.getTime());
    expect(row.endedAt!.getTime()).toBe(reapedAt.getTime());
    expect(row.autoExpiredAt!.getTime()).toBe(reapedAt.getTime());
  });

  it('a bogus session id is a silent no-op, never an error', async () => {
    const srv = createTestableMcpServer(auth());
    const out = await srv.callToolText('hadron_team_chat_read', {
      session: 'no-such-session',
      app: app.id,
      sinceSeq: 0,
    });
    // A heartbeat is bookkeeping: it must never turn a caller's read into a
    // failure, and must not disclose whether the named session exists.
    expect(out).not.toMatch(/heartbeat/i);
  });
});
