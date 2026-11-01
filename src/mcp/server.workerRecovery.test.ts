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

const ctxFor = (userId = user.id): Context =>
  ({ db, userId, appId: app.id, roles: ['READER'], clientId: `user:${userId}` }) as Context;

// ---------------------------------------------------------------------------
// #1016 — hadron_whoami
// ---------------------------------------------------------------------------

describe('#1016 — hadron_whoami recovers the session id', () => {


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

describe('#1010 — hadron_update_worker and the worker read', () => {


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
    const { id } = await resolvers.Mutation.startSession({}, { input: { id: generateId(), workerRef: 'Iris', tool: 'vitest' } }, { db, ...hybridAuth() } as Context);
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


});

describe('#1029 — the handoff arrives at bind, and recovery re-fetches it', () => {


  it('refuses a handoff on a session with no worker rather than dropping it', async () => {
    const srv = createTestableMcpServer(hybridAuth());
    const bare = (await srv.callToolText('hadron_start_session', { description: 'no worker' }))
      .match(/Session started: (\S+)/)![1];
    const out = await srv.callToolText('hadron_end_session', { id: bare, handoff: 'nowhere to go' });
    expect(out).toContain('not bound to a worker');
    expect((await db.session.findUniqueOrThrow({ where: { id: bare } })).endedAt).toBeNull();
  });
});
