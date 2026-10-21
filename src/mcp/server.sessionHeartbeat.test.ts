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
      systemPrompt: 'You are {{name}}, a {{role}}.',
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

describe('#1081 — every tool handed a session id heartbeats it', () => {
  it('hadron_team_chat_read — the pure-read case that wrote nothing at all', async () => {
    const id = await staleSession();
    const before = await updatedAt(id);
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_team_chat_read', { session: id, sinceSeq: 0 });
    // This is the coordinator's day: reading the chat kept no session alive
    // before #1081, because a read writes no rows the reaper can see.
    expect((await updatedAt(id))!.getTime()).toBeGreaterThan(before!.getTime());
  });

  it('hadron_team_chat_post', async () => {
    const id = await staleSession();
    const before = await updatedAt(id);
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_team_chat_post', { session: id, body: 'hello' });
    expect((await updatedAt(id))!.getTime()).toBeGreaterThan(before!.getTime());
  });

  it('hadron_list_workers and hadron_get_worker', async () => {
    for (const [tool, args] of [
      ['hadron_list_workers', {}],
      ['hadron_get_worker', { workerRef: 'Dara' }],
    ] as const) {
      const id = await staleSession();
      const before = await updatedAt(id);
      const srv = createTestableMcpServer(auth());
      await srv.callToolText(tool, { ...(args as object), session: id } as never);
      expect((await updatedAt(id))!.getTime(), tool).toBeGreaterThan(before!.getTime());
    }
  });

  it('hadron_record_work — including the kinds that never touched the row', async () => {
    // Only kind:'pr' with a `#N` ref used to touch the Session, as a side effect
    // of denormalizing prNumber. A branch record heartbeats now too.
    const id = await staleSession();
    const before = await updatedAt(id);
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_record_work', {
      session: id, tool: 'github', kind: 'branch', ref: 'o/r:feat/x', action: 'pushed',
    });
    expect((await updatedAt(id))!.getTime()).toBeGreaterThan(before!.getTime());
  });

  it('hadron_team_work_items', async () => {
    const id = await staleSession();
    const before = await updatedAt(id);
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_team_work_items', { session: id });
    expect((await updatedAt(id))!.getTime()).toBeGreaterThan(before!.getTime());
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

describe('#1082 review — the heartbeat re-checks CURRENT eligibility', () => {
  it('a REVOKED org member cannot keep their old session alive', async () => {
    // `Session.userId` is stamped at bind and never revoked, so ownership alone
    // is a HISTORICAL fact. Without a current-participation check a removed
    // member could hold a worker indefinitely with tool calls that are
    // themselves denied — the heartbeat runs before the handler's own gate.
    const id = await staleSession();
    const before = await updatedAt(id);
    await db.orgMember.updateMany({
      where: { organizationId: org.id, userId: user.id },
      data: { deletedAt: new Date() },
    });
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_team_chat_read', { session: id, sinceSeq: 0 });
    expect((await updatedAt(id))!.getTime()).toBe(before!.getTime());
  });

  it('a member in good standing still heartbeats — the guard is not a blanket refusal', async () => {
    const id = await staleSession();
    const before = await updatedAt(id);
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_team_chat_read', { session: id, sinceSeq: 0 });
    expect((await updatedAt(id))!.getTime()).toBeGreaterThan(before!.getTime());
  });

  it('an UNINSTALLED App stops the heartbeat too', async () => {
    const id = await staleSession();
    const before = await updatedAt(id);
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_team_chat_read', { session: id, sinceSeq: 0 });
    expect((await updatedAt(id))!.getTime()).toBe(before!.getTime());
  });
});

describe('#1082 review — the heartbeat genuinely cannot fail a tool call', () => {
  it('a NON-STRING session argument does not throw out of the tool', async () => {
    // createTestableMcpServer bypasses zod, so the handler sees whatever it is
    // given. `.trim()` on a number would have thrown and failed the whole call.
    const srv = createTestableMcpServer(auth());
    const out = await srv.callToolText('hadron_team_chat_read', {
      session: 12345 as never,
      app: app.id,
      sinceSeq: 0,
    });
    expect(typeof out).toBe('string');
    expect(out).not.toMatch(/trim is not a function|TypeError/i);
  });

  it('a DB failure inside the eligibility check does not fail the tool call', async () => {
    const id = await staleSession();
    const before = await updatedAt(id);
    // The eligibility lookup used to sit outside the try/catch, so a transient
    // error here broke the "cannot fail a tool call" promise.
    const spy = vi
      .spyOn(db.session, 'findUnique')
      .mockRejectedValueOnce(new Error('transient db failure'));
    const srv = createTestableMcpServer(auth());
    const out = await srv.callToolText('hadron_team_chat_read', { session: id, sinceSeq: 0 });
    expect(typeof out).toBe('string');
    expect(out).not.toMatch(/transient db failure/);
    // …and it did NOT heartbeat, which is the safe direction: the session ages.
    expect((await updatedAt(id))!.getTime()).toBe(before!.getTime());
    spy.mockRestore();
  });
});

/** A session nobody has driven for longer than its idle window: started AND last touched long ago. */
async function lapsedSession(userId = user.id): Promise<string> {
  const s = await db.session.create({
    data: { id: generateId(), workerId: worker.id, appId: app.id, userId },
  });
  await db.$executeRaw`UPDATE sessions SET started_at = ${LONG_AGO}, updated_at = ${LONG_AGO} WHERE id = ${s.id}`;
  return s.id;
}

describe('#1543 — the heartbeat keeps a LIVE session alive and never revives a lapsed one', () => {
  it('a team tool called through a lapsed session leaves it untouched', async () => {
    for (const [tool, args] of [
      ['hadron_team_chat_read', { sinceSeq: 0 }],
      ['hadron_list_workers', {}],
      ['hadron_team_work_items', {}],
    ] as const) {
      const id = await lapsedSession();
      const before = await updatedAt(id);
      const srv = createTestableMcpServer(auth());
      await srv.callToolText(tool, { ...(args as object), session: id } as never);
      expect((await updatedAt(id))!.getTime(), tool).toBe(before!.getTime());
    }
  });

  it('a post through a lapsed session is refused by the post gate instead of resurrecting it', async () => {
    const id = await lapsedSession();
    const before = await updatedAt(id);
    const srv = createTestableMcpServer(auth());
    const text = await srv.callToolText('hadron_team_chat_post', { session: id, body: 'too late' });
    expect(text).toMatch(/not live/i);
    expect((await updatedAt(id))!.getTime()).toBe(before!.getTime());
  });

  it("a kind:'pr' work record still attributes to a lapsed session, but does not revive it (Codex P1 on #1553)", async () => {
    const id = await lapsedSession();
    const before = await updatedAt(id);
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_record_work', {
      session: id, tool: 'github', kind: 'pr', ref: 'o/r#42', action: 'opened',
    });
    const after = await db.session.findUniqueOrThrow({ where: { id }, select: { prNumber: true, updatedAt: true } });
    expect(after.prNumber).toBe(42); // late attribution still lands
    expect(after.updatedAt!.getTime()).toBe(before!.getTime());
  });

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

  it('control: a live session is still heartbeated by the same tools', async () => {
    const id = await staleSession(); // started now, so live; only its updatedAt is old
    const before = await updatedAt(id);
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_team_work_items', { session: id });
    expect((await updatedAt(id))!.getTime()).toBeGreaterThan(before!.getTime());
  });
});
