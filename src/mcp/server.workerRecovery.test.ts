import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * MCP compaction recovery + the amendable casting — #1015, #1016, #1010.
 *
 * The three gaps share one root cause: on the MCP surface an agent's working
 * identity lives entirely in its context window. `hadron_start_session` hands
 * back the boot briefing and the session id exactly once, and nothing on the
 * wire carries either — no worktree file, no re-read. A compaction therefore
 * silently demotes a worker to "wearing the name", and the only routes back
 * (a second session, or a `force: true` takeover of yourself) corrupt the
 * provenance record the Worker model exists to produce.
 *
 *   #1015 — hadron_get_worker: re-fetch the briefing, rendered LIVE.
 *   #1016 — hadron_whoami: recover your own session id.
 *   #1010 — hadron_update_worker: amend a casting's individuality after the
 *           work that defines it, instead of sealing it at cast time.
 *
 * Every tool delegates to the GraphQL resolvers, so these tests pin BEHAVIOUR
 * (what a compacted agent can recover, and what a stranger cannot learn) rather
 * than re-testing the gates themselves.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { startWorkerSessionGql } from '../test/startWorkerSessionGql.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let user: { id: string };
let outsider: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };

const PERSONA_TEMPLATE = 'You are {{worker.name}}, the {{worker.role}} on this team.';

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'wr-org', urn: `wr-${suffix}.com` },
  });
  user = await db.user.create({
    data: { id: generateId(), githubId: 98610, githubUsername: `wr-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 98611, githubUsername: `wr-out-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' },
  });
  agent = await db.agent.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:backend`,
      name: 'Backend', visibility: 'ORGANIZATION',
      personaRole: 'backend-engineer',
    },
  });
  await serveAgentBootPrompt(db, agent.id, PERSONA_TEMPLATE);
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
});

/** A user caller with an active-App selection — the ordinary MCP shape. */
function hybridAuth(userId = user.id): AuthContext {
  return { userId, appId: app.id, roles: ['READER'], clientId: `user:${userId}` };
}

/**
 * The SAME user after a transparent MCP reconnect: the in-process active-App
 * selection is gone, so `auth` carries no appId (findings:mcp-stale-session-
 * 400-vs-404 — this is the state #1005 was filed about).
 */
function reconnectedAuth(userId = user.id): AuthContext {
  return { userId, roles: ['READER'], clientId: `user:${userId}` };
}

/** A pure App-key principal — a credential, no user identity. */
function appKeyAuth(): AuthContext {
  return { appId: app.id, roles: [] };
}

const worker = (name: string, slug: string, extra: Record<string, unknown> = {}) =>
  db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name, slug, role: 'backend-engineer', ...extra },
  });

/** #3082: a worker session is started through GraphQL (as the CLI does), never over MCP. */
const startGql = (workerRef: string) =>
  startWorkerSessionGql({ workerRef, userId: user.id, appId: app.id, ctx: ctxFor() });

const ctxFor = (userId = user.id): Context =>
  ({ db, userId, appId: app.id, roles: ['READER'], clientId: `user:${userId}` }) as Context;

// #1015 — hadron_get_worker: #3082 turned the tool off over MCP. Its subject was the MCP rendering of Query.worker, whose
// resolver rules (lookup by name/URN/id, App scoping, WORKER_NOT_FOUND for an outsider and an absent name, retired workers)
// are pinned by resolvers.worker.test.ts (Q.worker 'WORKER_NOT_FOUND' cases) and the briefing by resolvers.workerProfile1149.test.ts.

// ---------------------------------------------------------------------------
// #1016 — hadron_whoami
// ---------------------------------------------------------------------------

describe('#1016 — hadron_whoami recovers the session id', () => {
  it('reports the caller\'s open session with its worker, App, and id', async () => {
    const iris = await worker('Iris', 'iris');
    const session = await db.session.create({
      data: {
        id: generateId(), workerId: iris.id, appId: app.id, userId: user.id,
        plan: 'Ship the roster read', type: 'DEVELOPER',
      },
    });

    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_whoami', {});
    expect(out).toContain(session.id);
    expect(out).toContain('Iris');
    expect(out).toContain(`hrn:worker:${org.urn}:team:iris`);
    expect(out).toContain('Team App');
    expect(out).toContain('Ship the roster read');
    // …and tells the model what the id is FOR, which is the point.
    // #3082: whoami now says what the id is FOR in terms of the `session` argument, not a disabled tool's name.
    expect(out).toContain('pass as `session` on a write to attribute it');
  });

  it('works with no App scope — the post-reconnect case it exists for', async () => {
    const iris = await worker('Iris', 'iris');
    const session = await db.session.create({
      data: { id: generateId(), workerId: iris.id, appId: app.id, userId: user.id },
    });
    const out = await createTestableMcpServer(reconnectedAuth()).callToolText('hadron_whoami', {});
    expect(out).toContain(session.id);
  });

  it('does NOT report another user\'s session', async () => {
    // Scoped by identity, not by the wider "sessions I may read" filter — the
    // question is what I am DRIVING, and the answer must not become a roster of
    // colleagues' activity. Both users are members of the same org here, so the
    // GraphQL sessions query WOULD return this row.
    const iris = await worker('Iris', 'iris');
    const theirs = await db.session.create({
      data: { id: generateId(), workerId: iris.id, appId: app.id, userId: outsider.id },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_whoami', {});
    expect(out).not.toContain(theirs.id);
    expect(out).toMatch(/no open sessions/i);
  });

  it('does not let an active-App SELECTION turn co-members\' sessions into mine', async () => {
    // The #932 rule hadron_end_session encodes: a hybrid principal is judged on
    // the USER, never on the App selection.
    const iris = await worker('Iris', 'iris');
    const theirs = await db.session.create({
      data: { id: generateId(), workerId: iris.id, appId: app.id, userId: outsider.id },
    });
    const mine = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_whoami', {});
    expect(out).toContain(mine.id);
    expect(out).not.toContain(theirs.id);
  });

  it('flags a session bound to NO worker — the silent-misattribution shape', async () => {
    // This is the state a driver is in when they BELIEVE they are bound and are
    // not, so it must be visible rather than inferred from an absent line.
    // Two distinct failures live here and the row has to serve both: OMITTING
    // the session on hadron_team_chat_post posts as the human, silently;
    // PASSING this unbound id refuses SESSION_NOT_WORKER_BOUND. Neither
    // produces a worker-attributed message.
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_whoami', {});
    expect(out).toContain(session.id);
    expect(out).toMatch(/NOT bound to a worker/);
    // #1034 (PR #1056 review, Codex): the closing guidance must not tell the
    // caller to post THIS row to team chat. The list deliberately includes
    // unbound sessions, so unconditional "pass the session id to
    // hadron_team_chat_post" advice contradicts the line directly above it and
    // promises a call that is refused. Scoped advice, or none.
    expect(out).toMatch(/bound row|SESSION_NOT_WORKER_BOUND/i);
    expect(out).not.toMatch(/^\s*Pass the session id to hadron_team_chat_post/m);
  });

  it('excludes ended sessions by default, and includes them on request', async () => {
    const iris = await worker('Iris', 'iris');
    const ended = await db.session.create({
      data: {
        id: generateId(), workerId: iris.id, appId: app.id, userId: user.id,
        endedAt: new Date(),
      },
    });
    const srv = createTestableMcpServer(hybridAuth());

    const open = await srv.callToolText('hadron_whoami', {});
    expect(open).not.toContain(ended.id);

    const all = await srv.callToolText('hadron_whoami', { includeEnded: true });
    expect(all).toContain(ended.id);
    expect(all).toContain('[ENDED]');
  });

  it('ignores a soft-deleted session', async () => {
    const iris = await worker('Iris', 'iris');
    const deleted = await db.session.create({
      data: {
        id: generateId(), workerId: iris.id, appId: app.id, userId: user.id,
        deletedAt: new Date(),
      },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_whoami', {});
    expect(out).not.toContain(deleted.id);
  });

  it('a pure App-key caller sees its own App\'s sessions', async () => {
    // The same scope hadron_end_session already lets an App key act on.
    const appSession = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: null },
    });
    const out = await createTestableMcpServer(appKeyAuth()).callToolText('hadron_whoami', {});
    expect(out).toContain(appSession.id);
  });

  it('a pure App-key caller does NOT see a user\'s session in that App', async () => {
    const userSession = await db.session.create({
      data: { id: generateId(), appId: app.id, userId: user.id },
    });
    const out = await createTestableMcpServer(appKeyAuth()).callToolText('hadron_whoami', {});
    expect(out).not.toContain(userSession.id);
  });

  it('says nothing is open rather than erroring when there are no sessions', async () => {
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_whoami', {});
    expect(out).toMatch(/no open sessions/i);
    expect(out).toContain('hadron_start_session');
  });
});

// ---------------------------------------------------------------------------
// #1010 — updateWorker
// ---------------------------------------------------------------------------

describe('#1010 — the worker read', () => {
  // #3082: hadron_update_worker is off over MCP; its three tests (no-op update, refuse a non-staffer, refuse a pure
  // App-key) were the MCP rendering of Mutation.updateWorker, covered by resolvers.worker.test.ts (updateWorker cases).
  describe('the GraphQL surface', () => {
    it('reads a worker by NAME through Query.worker with appRef', async () => {
      await worker('Iris', 'iris');
      const found = await resolvers.Query.worker({}, { ref: 'Iris', appRef: app.id }, ctxFor());
      expect(found?.name).toBe('Iris');
    });

    it('does not resolve a bare NAME without appRef — the form is additive', async () => {
      // Pre-#1015 behaviour is preserved exactly: without appRef the ref must
      // be an id or URN, and anything else is WORKER_NOT_FOUND. Branching on
      // shape alone would have re-labelled that standing no-oracle refusal.
      await worker('Iris', 'iris');
      await expect(resolvers.Query.worker({}, { ref: 'Iris' }, ctxFor())).rejects.toThrow(
        /Worker not found/,
      );
    });

    it('an unresolvable appRef collapses into WORKER_NOT_FOUND, not APP_NOT_FOUND', async () => {
      // PR review (Codex): resolveAppRef throws before the gated helper's
      // collapse, which would let a caller tell a nonexistent App apart from a
      // live one with no such worker — an existence oracle over other tenants'
      // App refs, reintroduced through the very argument that gates the lookup.
      await worker('Iris', 'iris');
      const bogus = resolvers.Query.worker(
        {},
        { ref: 'Iris', appRef: `${org.urn}:no-such-app` },
        ctxFor(),
      );
      await expect(bogus).rejects.toThrow(/Worker not found/);
      await expect(bogus).rejects.toMatchObject({ extensions: { code: 'WORKER_NOT_FOUND' } });
    });

    it('…the SAME refusal a live App with no such worker gives', async () => {
      const absent = resolvers.Query.worker(
        {},
        { ref: 'NoSuchWorker', appRef: app.id },
        ctxFor(),
      );
      await expect(absent).rejects.toMatchObject({ extensions: { code: 'WORKER_NOT_FOUND' } });
    });

    it('propagates a DB failure instead of reporting it as a missing worker', async () => {
      // PR review (Copilot): the gate reaches the database via isAppParticipant,
      // so a blanket catch turned a connection failure into "no such worker" —
      // an outage reported as a missing row, on the one surface whose contract
      // is that absence and denial look identical. Hiding WHY a caller was
      // refused is the point here; hiding THAT the database is down never is.
      await worker('Iris', 'iris');
      const boom = new Error('connection terminated unexpectedly');
      const spy = vi
        .spyOn(db.orgMember, 'findFirst')
        .mockRejectedValueOnce(boom as never);
      try {
        await expect(
          resolvers.Query.worker({}, { ref: 'Iris', appRef: app.id }, ctxFor()),
        ).rejects.toThrow(/connection terminated/);
      } finally {
        spy.mockRestore();
      }
    });

    it('an id still wins over a supplied appRef', async () => {
      const iris = await worker('Iris', 'iris');
      const found = await resolvers.Query.worker({}, { ref: iris.id, appRef: app.id }, ctxFor());
      expect(found?.id).toBe(iris.id);
    });
  });
});

// ---------------------------------------------------------------------------
// #1029 — handoff delivery on the MCP surface
// ---------------------------------------------------------------------------

describe('#1100 — ending with `summary` instead of `handoff` is called out', () => {
  const endWith = async (
    srv: ReturnType<typeof createTestableMcpServer>,
    args: Record<string, unknown>,
  ) => {
    const id = await startGql('Iris');
    return { id, receipt: await srv.callToolText('hadron_end_session', { id, ...args }) };
  };

  it('warns when a worker-bound session ends with summary set and no handoff', async () => {
    // The footgun: `summary` reads like the closing note and is display-only,
    // so choosing it succeeds, returns a normal receipt, and writes NO
    // continuity. Said in the receipt because this is the last moment it is
    // still fixable — the prose is still in the caller's context.
    await worker('Iris', 'iris');
    const { receipt } = await endWith(createTestableMcpServer(hybridAuth()), {
      summary: 'shipped the parser rewrite',
    });
    expect(receipt).toContain('summary` is display-only');
    expect(receipt).toContain('receive NOTHING');
  });

  it('does NOT warn when no handoff and no summary — that is a legitimate choice', async () => {
    // The spare. Ending without a handoff on purpose keeps its quieter wording;
    // a warning on every such end would train the reader to skip it.
    await worker('Iris', 'iris');
    const { receipt } = await endWith(createTestableMcpServer(hybridAuth()), {});
    expect(receipt).toContain('No handoff written.');
    expect(receipt).not.toContain('display-only');
  });

  it('does NOT warn when a handoff WAS written, even alongside a summary', async () => {
    await worker('Iris', 'iris');
    const { receipt } = await endWith(createTestableMcpServer(hybridAuth()), {
      summary: 'shipped it', handoff: 'the migration is half-applied',
    });
    expect(receipt).toContain('Handoff written');
    expect(receipt).not.toContain('display-only');
  });

  it('the recovery the warning ADVISES is the one that actually works', async () => {
    // I first wrote this test against "re-end the same session with `handoff`",
    // which is what I had drafted into the receipt. It FAILED: the server
    // refuses a second handoff for an ended stint — "the sequence is
    // append-only … start a new session to record new state."
    //
    // So the mistake is NOT recoverable in place, and the receipt now says the
    // remedy the server itself names. Pinned here because the receipt makes a
    // promise to a caller at their worst moment; if this stops working, the
    // promise becomes a dead end and this fails instead.
    await worker('Iris', 'iris');
    const srv = createTestableMcpServer(hybridAuth());
    const { id } = await endWith(srv, { summary: 'wrote it into the wrong field' });

    // Re-ending the SAME stint is refused, and says why.
    const retry = await srv.callToolText('hadron_end_session', {
      id, handoff: 'PR #1134 merged; #1100 is next.',
    });
    expect(retry).toContain('append-only');

    // The remedy that works: bind again and end THAT stint with the handoff.
    const second = await startGql('Iris');
    await srv.callToolText('hadron_end_session', {
      id: second,
      handoff: 'PR #1134 merged; #1100 is next.',
    });

    // #3082: the rebind receipt (hadron_start_session) no longer renders over MCP for a worker; the handoff the next
    // stint would be handed is the stored one, read here from the worker's handoffs: branch.
    const fresh = await db.worker.findUniqueOrThrow({ where: { appId_slug: { appId: app.id, slug: 'iris' } } });
    const kept = await db.node.findMany({
      where: { memoryId: fresh.memoryId!, loc: { startsWith: 'handoffs:' }, deletedAt: null },
      select: { content: true },
    });
    expect(kept.map((c) => c.content).join('\n')).toContain('#1100 is next');
  });
});

describe('#1029 — the handoff arrives at bind, and recovery re-fetches it', () => {
  // #3082: three MCP-rendering tests were removed here: hadron_start_session's handoff-after-briefing render (a worker
  // bind is refused over MCP), and hadron_get_worker's handoff and auto-expired-framing reads (tool off). The handoff
  // continuity they carried is Worker.continuity, pinned by resolvers.nodeMemoryGate2193.test.ts.

  it('a retried hadron_end_session writes no second handoff and does not move endedAt', async () => {
    // The MCP tool reimplements the end with its own raw update, which is how
    // the guard ended up on the GraphQL resolver only (PR #1045 review, Codex
    // P1). Both now come from the shared writer plus first-end-wins here.
    await worker('Iris', 'iris');
    const srv = createTestableMcpServer(hybridAuth());
    const s1 = await startGql('Iris');
    await srv.callToolText('hadron_end_session', { id: s1, handoff: 'stint one' });
    const endedAt = (await db.session.findUniqueOrThrow({ where: { id: s1 } })).endedAt;

    const s2 = await startGql('Iris');
    await srv.callToolText('hadron_end_session', { id: s2, handoff: 'stint two' });

    // The retry of the OLDER session.
    const retried = await srv.callToolText('hadron_end_session', { id: s1, handoff: 'stint one' });
    expect(retried).toContain('STILL OPEN');

    const fresh = await db.worker.findUniqueOrThrow({
      where: { appId_slug: { appId: app.id, slug: 'iris' } },
    });
    const children = await db.node.findMany({
      where: { memoryId: fresh.memoryId!, loc: { startsWith: 'handoffs:' }, deletedAt: null },
      orderBy: { loc: 'asc' },
      select: { content: true },
    });
    expect(children.map((c) => c.content)).toEqual(['stint one', 'stint two']);
    expect((await db.session.findUniqueOrThrow({ where: { id: s1 } })).endedAt).toEqual(endedAt);
  });

  it('a plain re-end does not move endedAt — it orders the whole continuity chain', async () => {
    // The handoff-carrying retry is refused earlier by the shared guard, so
    // this is the path that actually exercises first-end-wins: ending again
    // with no handoff, e.g. to attach late metrics. `endedAt` decides which
    // stint is "previous" for both Worker.continuity and prevSessionId, so
    // re-stamping it re-orders a worker's history around a stint that finished
    // long ago.
    await worker('Iris', 'iris');
    const srv = createTestableMcpServer(hybridAuth());
    const s1 = await startGql('Iris');
    await srv.callToolText('hadron_end_session', { id: s1, summary: 'first' });
    const endedAt = (await db.session.findUniqueOrThrow({ where: { id: s1 } })).endedAt;
    expect(endedAt).not.toBeNull();

    await srv.callToolText('hadron_end_session', { id: s1, summary: 'late metrics', turnCount: 9 });
    const after = await db.session.findUniqueOrThrow({ where: { id: s1 } });
    expect(after.endedAt).toEqual(endedAt);
    expect(after.turnCount).toBe(9);
  });

  it('refuses a handoff on a session with no worker rather than dropping it', async () => {
    const srv = createTestableMcpServer(hybridAuth());
    const bare = (await srv.callToolText('hadron_start_session', { description: 'no worker' }))
      .match(/Session started: (\S+)/)![1];
    const out = await srv.callToolText('hadron_end_session', { id: bare, handoff: 'nowhere to go' });
    expect(out).toContain('not bound to a worker');
    expect((await db.session.findUniqueOrThrow({ where: { id: bare } })).endedAt).toBeNull();
  });
});


// #1053 — hadron_record_work: off over MCP (#3082); the receipt wording was MCP-only. The late-attribution rule
// (cor:agt:020:05) is pinned at Mutation.recordWork in the resolver tests.

describe('#1053 — hadron_end_session does not read as a fresh close when it was not', () => {
  it('an ALREADY-ended session says so rather than reporting a clean end', async () => {
    // end_session is idempotent (first end wins, #1050), so a plain
    // "Session ended" on a session that closed hours ago is a second false
    // liveness signal — in the very tool the old guidance called the loud one.
    await worker('Iris', 'iris');
    const srv = createTestableMcpServer(hybridAuth());
    const sid = await startGql('Iris');
    const now = new Date();
    await db.session.update({ where: { id: sid }, data: { endedAt: now, autoExpiredAt: now } });

    const out = await srv.callToolText('hadron_end_session', { id: sid, turnCount: 3 });
    expect(out).toContain('had ALREADY ended');
    expect(out).toContain('end reason: unknown');
    expect(out).toContain('hadron_whoami');
    // Metrics still land; the original end time stands (#1050 first-end-wins).
    const after = await db.session.findUniqueOrThrow({ where: { id: sid } });
    expect(after.turnCount).toBe(3);
    expect(after.endedAt).toEqual(now);
  });

  it('a genuine close still reads as one', async () => {
    await worker('Iris', 'iris');
    const srv = createTestableMcpServer(hybridAuth());
    const sid = await startGql('Iris');
    const out = await srv.callToolText('hadron_end_session', { id: sid });
    // #1034: this session IS worker-bound, so the receipt names the KIND that
    // ended — a strictly stronger assertion than the bare "Session ended" this
    // pinned before, and the distinction the driver needs at exactly the moment
    // they are about to close the window.
    expect(out).toContain('Worker session ended');
    expect(out).not.toContain('ALREADY ended');
  });
});


describe('#1053 — the reaper racing an end must not produce a fresh-close receipt', () => {
  it('reports an already-ended session when the reap lands mid-call, and keeps the reaper\'s instant', async () => {
    // The reaper claims sessions with its own atomic update, so between a
    // handler's read and its write a session can go from live to reaped.
    // Deciding from the stale read reported a clean end AND overwrote the
    // reaper's endedAt while leaving autoExpiredAt set — a row claiming it
    // auto-expired at one instant and ended at a later one.
    await worker('Iris', 'iris');
    const srv = createTestableMcpServer(hybridAuth());
    const sid = await startGql('Iris');

    const reapedAt = new Date(Date.now() - 60_000);
    const spy = vi
      .spyOn(db.session, 'updateMany')
      .mockImplementationOnce((async (args: { where: Record<string, unknown> }) => {
        // The reap lands after the handler read the row and before it writes.
        await db.session.update({
          where: { id: sid },
          data: { endedAt: reapedAt, autoExpiredAt: reapedAt },
        });
        return db.session.updateMany(args as never);
      }) as never);
    try {
      const out = await srv.callToolText('hadron_end_session', { id: sid });
      expect(out).toContain('had ALREADY ended');
      expect(out).toContain('end reason: unknown');
      expect(out).not.toContain('Session ended: ');
    } finally {
      spy.mockRestore();
    }

    const after = await db.session.findUniqueOrThrow({ where: { id: sid } });
    expect(after.endedAt).toEqual(reapedAt);
    expect(after.autoExpiredAt).toEqual(reapedAt);
  });
});
