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

const PERSONA_TEMPLATE = 'You are {{name}}, the {{role}} on this team.';

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
      personaRole: 'backend-engineer', systemPrompt: PERSONA_TEMPLATE,
    },
  });
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
// #1015 — hadron_get_worker
// ---------------------------------------------------------------------------

describe('#1015 — hadron_get_worker re-fetches the boot briefing', () => {
  it('returns identity plus the resolved briefing, by NAME', async () => {
    await worker('Iris', 'iris');
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_get_worker', {
      workerRef: 'Iris',
    });

    expect(out).toContain('Iris');
    expect(out).toContain('backend-engineer');
    expect(out).toContain(`hrn:worker:${org.urn}:team:iris`);
    // The briefing itself, with the template placeholders bound.
    expect(out).toContain('You are Iris, the backend-engineer on this team.');
    expect(out).toContain('Boot briefing');
    // #1090: the receipt stamps THIS rendering — composition time plus the
    // role Agent's generic updatedAt, both from the one agent read that
    // supplied the template. No per-override mtime exists, so it says so.
    expect(out).toMatch(/rendered at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(out).toMatch(/role Agent updated at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(out).toContain('no per-override mtime is tracked');
  });

  it('reports a null role-Agent updatedAt honestly instead of inventing a stamp (#1090)', async () => {
    const nullStampAgent = await db.agent.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:null-stamp`,
        name: 'Null stamp', visibility: 'ORGANIZATION',
        personaRole: 'archivist', systemPrompt: 'You are {{name}}, the {{role}}.',
        updatedAt: null,
      },
    });
    await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: nullStampAgent.id, name: 'Stale', slug: 'stale', role: 'archivist' },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_get_worker', { workerRef: 'Stale' });
    expect(out).toContain('You are Stale, the archivist.');
    expect(out).toContain('role Agent updated at: not recorded');
    expect(out).toMatch(/rendered at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('resolves a name case-insensitively, the way a human types it', async () => {
    await worker('Iris', 'iris');
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_get_worker', {
      workerRef: 'iris',
    });
    expect(out).toContain('You are Iris');
  });

  it('works by URN with NO App scope — the post-reconnect case', async () => {
    // This is the scenario the issue is really about: the selection evaporated,
    // so a bare name has nothing to resolve against, but a URN names its own
    // App and must not demand a hadron_set_active_app first.
    await worker('Iris', 'iris');
    const out = await createTestableMcpServer(reconnectedAuth()).callToolText('hadron_get_worker', {
      workerRef: `hrn:worker:${org.urn}:team:iris`,
    });
    expect(out).toContain('You are Iris, the backend-engineer on this team.');
  });

  it('works by id with no App scope', async () => {
    const iris = await worker('Iris', 'iris');
    const out = await createTestableMcpServer(reconnectedAuth()).callToolText('hadron_get_worker', {
      workerRef: iris.id,
    });
    expect(out).toContain('You are Iris');
  });

  it('recovers App scope for a bare NAME from the session id', async () => {
    // The other half of #1005/#1016: the Hadron session is the durable anchor
    // that survives the reconnect, so it can stand in for the lost selection.
    const iris = await worker('Iris', 'iris');
    const session = await db.session.create({
      data: { id: generateId(), workerId: iris.id, appId: app.id, userId: user.id },
    });
    await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });

    const out = await createTestableMcpServer(reconnectedAuth()).callToolText('hadron_get_worker', {
      workerRef: 'Iris',
      session: session.id,
    });
    expect(out).toContain('You are Iris');
  });

  it('refuses a bare NAME with no App context, and says what to do', async () => {
    await worker('Iris', 'iris');
    const out = await createTestableMcpServer(reconnectedAuth()).callToolText('hadron_get_worker', {
      workerRef: 'Iris',
    });
    expect(out).not.toContain('You are Iris');
    expect(out).toMatch(/only unique within an App/);
    // The remedy is named, and so is the form that needs none of it.
    expect(out).toMatch(/id or URN/);
  });

  it('renders the briefing LIVE, so a changed template is picked up', async () => {
    // The contract says never to cache the briefing precisely because it is
    // rendered from the role agent's template. If this read were a snapshot it
    // would reintroduce the staleness the contract forbids.
    await worker('Iris', 'iris');
    const srv = createTestableMcpServer(hybridAuth());
    expect(await srv.callToolText('hadron_get_worker', { workerRef: 'Iris' })).toContain(
      'the backend-engineer on this team',
    );

    await db.agent.update({
      where: { id: agent.id },
      data: { systemPrompt: 'You are {{name}}. The team ships on Fridays.' },
    });

    const after = await srv.callToolText('hadron_get_worker', { workerRef: 'Iris' });
    expect(after).toContain('The team ships on Fridays.');
    expect(after).not.toContain('on this team.');
  });

  /**
   * #1120 review (Codex P2) — the recovery read must hand back YOUR session id
   * even when someone else's live session sorts ahead of it.
   *
   * Two questions were being answered from one row: "is anyone driving this"
   * (any live session) and "what is my session id" (the caller's own). While
   * the scan was ordered by `startedAt` that mostly coincided; ordering by
   * heartbeat made it come apart, and the id silently vanished from the ONE
   * read whose purpose is restoring it after a context compaction.
   */
  it('names the CALLER\'s own live session, not whichever sorts first', async () => {
    const w = await worker('Iris', 'iris');
    const older = new Date(Date.now() - 60 * 60 * 1000);

    // The caller's own session, started EARLIER and with no recent heartbeat.
    const mine = generateId();
    await db.session.create({
      data: {
        id: mine, workerId: w.id, appId: app.id, userId: user.id,
        startedAt: older, updatedAt: older,
      },
    });
    // Someone else's, started later AND touched a moment ago — so it sorts
    // first under heartbeat ordering.
    await db.session.create({
      data: {
        id: generateId(), workerId: w.id, appId: app.id, userId: outsider.id,
        startedAt: new Date(), updatedAt: new Date(),
      },
    });

    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_get_worker', {
      workerRef: 'Iris',
    });

    // Taken — any live session answers that.
    expect(out).toContain('taken');
    // ...and the caller still gets their OWN id back, which is the point.
    expect(out).toContain(`Your active session: ${mine}`);
  });

  it("finds the caller's session even when it would not survive the shared cap", async () => {
    // #1120 review, Codex P2 (second time on this line). Selecting `mine` out
    // of the CAPPED set was still order-dependent: past the cap, the caller's
    // own session is simply absent. The recovery guarantee cannot be a
    // by-product of surviving a bound shared with everyone else's sessions, so
    // it gets its own query scoped to the caller.
    //
    // Seeded PAST the cap for real. A first draft simulated it with four rows
    // and "worst possible ordering", and the discriminating mutation — putting
    // `mine` back inside the capped set — still passed, because with four rows
    // the cap never bites. A bound can only be tested by exceeding it.
    const w = await worker('Mira', 'mira');
    const ancient = new Date(Date.now() - 10 * 60 * 60 * 1000);
    const mine = generateId();
    await db.session.create({
      data: {
        id: mine, workerId: w.id, appId: app.id, userId: user.id,
        startedAt: ancient, updatedAt: ancient,
      },
    });
    // Live ONLY through a usage event — the heartbeat input the ordering
    // cannot see, so nothing keeps this row inside a shared prefix.
    await db.usageEvent.create({
      data: { countsAsActivity: true, id: generateId(), sessionId: mine, type: 'read', createdAt: new Date() },
    });
    // More live sessions than OPEN_SESSION_SCAN_CAP, all newer by updatedAt.
    const now = new Date();
    await db.session.createMany({
      data: Array.from({ length: 220 }, () => ({
        id: generateId(), workerId: w.id, appId: app.id, userId: outsider.id,
        startedAt: now, updatedAt: now,
      })),
    });

    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_get_worker', {
      workerRef: 'Mira',
    });
    expect(out).toContain('taken');
    expect(out).toContain(`Your active session: ${mine}`);
  });

  it('does NOT name a session belonging to someone else', async () => {
    // The control, and the privacy half: whose session it is otherwise stays
    // behind the takeover refusal, which is a deliberate act rather than a
    // listing.
    const w = await worker('Jonas', 'jonas');
    await db.session.create({
      data: {
        id: generateId(), workerId: w.id, appId: app.id, userId: outsider.id,
        startedAt: new Date(), updatedAt: new Date(),
      },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_get_worker', {
      workerRef: 'Jonas',
    });
    expect(out).toContain('taken');
    expect(out).not.toContain('Your active session');
  });

  it('composes promptOverride into the briefing', async () => {
    await worker('Iris', 'iris', { promptOverride: 'You authored the Academy history.' });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_get_worker', {
      workerRef: 'Iris',
    });
    expect(out).toContain('You are Iris, the backend-engineer on this team.');
    expect(out).toContain('You authored the Academy history.');
  });

  it('surfaces the RAW override separately, so an edit can round-trip', async () => {
    // PR review (Codex): hadron_update_worker REPLACES the override, so a
    // caller extending one needs the override ALONE. Returning only the
    // composed briefing would have them paste template+override back into the
    // override field, after which rendering prepends the template again — and
    // every subsequent edit compounds the duplication.
    await worker('Iris', 'iris', { promptOverride: 'You authored the Academy history.' });
    const srv = createTestableMcpServer(hybridAuth());
    const out = await srv.callToolText('hadron_get_worker', { workerRef: 'Iris' });
    expect(out).toMatch(/Prompt override/);

    // Round-trip it verbatim: the resolved briefing must be unchanged, i.e. the
    // template appears exactly once and is not folded into the override.
    await srv.callToolText('hadron_update_worker', {
      workerRef: 'Iris',
      promptOverride: 'You authored the Academy history.',
    });
    const after = await srv.callToolText('hadron_get_worker', { workerRef: 'Iris' });
    expect(after.match(/You are Iris, the backend-engineer on this team\./g)).toHaveLength(1);
  });

  it('masks the raw override from a caller who may not see worker internals', async () => {
    await worker('Iris', 'iris', { promptOverride: 'private individuality' });
    const out = await createTestableMcpServer({
      userId: outsider.id, appId: app.id, roles: ['READER'], clientId: `user:${outsider.id}`,
    }).callToolText('hadron_get_worker', { workerRef: `hrn:worker:${org.urn}:team:iris` });
    expect(out).not.toContain('private individuality');
  });

  it('reports whether the worker is currently taken', async () => {
    const iris = await worker('Iris', 'iris');
    const free = await createTestableMcpServer(hybridAuth()).callToolText('hadron_get_worker', {
      workerRef: 'Iris',
    });
    expect(free).toMatch(/free/);

    await db.session.create({
      data: { id: generateId(), workerId: iris.id, appId: app.id, userId: user.id },
    });
    const taken = await createTestableMcpServer(hybridAuth()).callToolText('hadron_get_worker', {
      workerRef: 'Iris',
    });
    expect(taken).toMatch(/taken/);
  });

  it('names the driving session when it is the CALLER\'S OWN', async () => {
    // The point of the read is recovery, so an agent that lost its session id
    // gets it back here — but only its own.
    const iris = await worker('Iris', 'iris');
    const mine = await db.session.create({
      data: { id: generateId(), workerId: iris.id, appId: app.id, userId: user.id },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_get_worker', {
      workerRef: 'Iris',
    });
    expect(out).toContain(mine.id);
  });

  it('does not name someone else\'s driving session', async () => {
    // Whose session it is stays behind the takeover refusal — a deliberate act,
    // not a listing (hadron_list_workers' rule).
    const iris = await worker('Iris', 'iris');
    const theirs = await db.session.create({
      data: { id: generateId(), workerId: iris.id, appId: app.id, userId: outsider.id },
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_get_worker', {
      workerRef: 'Iris',
    });
    expect(out).toMatch(/taken/);
    expect(out).not.toContain(theirs.id);
    expect(out).not.toContain(outsider.id);
  });

  it('a retired worker is readable and marked RETIRED', async () => {
    // Retirement preserves history; the roster must stay legible.
    await worker('Gone', 'gone', { retiredAt: new Date() });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_get_worker', {
      workerRef: 'Gone',
    });
    expect(out).toContain('RETIRED');
  });

  it('says so plainly when there is no briefing to give', async () => {
    await db.agent.update({ where: { id: agent.id }, data: { systemPrompt: null } });
    await worker('Bare', 'bare');
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_get_worker', {
      workerRef: 'Bare',
    });
    expect(out).toMatch(/No boot briefing/);
  });

  describe('the roster is not an existence oracle', () => {
    it('an outsider naming a real worker gets WORKER_NOT_FOUND, not FORBIDDEN', async () => {
      await worker('Iris', 'iris');
      // Denial and absence must be indistinguishable, or guessing names becomes
      // a probe for another tenant's staff (#990's gate ordering).
      const out = await createTestableMcpServer({
        userId: outsider.id, appId: app.id, roles: ['READER'], clientId: `user:${outsider.id}`,
      }).callToolText('hadron_get_worker', { workerRef: 'Iris' });

      expect(out).not.toContain('You are Iris');
      expect(out).toMatch(/not found/i);
    });

    it('…the SAME answer an absent name gets', async () => {
      const absent = await createTestableMcpServer({
        userId: outsider.id, appId: app.id, roles: ['READER'], clientId: `user:${outsider.id}`,
      }).callToolText('hadron_get_worker', { workerRef: 'NoSuchWorker' });
      expect(absent).toMatch(/not found/i);
    });
  });
});

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
    expect(out).toContain('hadron_team_chat_post');
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

describe('#1010 — a casting\'s individuality is amendable', () => {
  it('sets an override, and it reaches the resolved briefing', async () => {
    await worker('Iris', 'iris');
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_update_worker', {
      workerRef: 'Iris',
      promptOverride: 'You authored the Academy history.',
    });

    expect(out).toContain('Updated');
    // The echo shows what the worker will actually be told at its next bind —
    // template plus override, composed.
    expect(out).toContain('You are Iris, the backend-engineer on this team.');
    expect(out).toContain('You authored the Academy history.');

    const row = await db.worker.findFirstOrThrow({ where: { name: 'Iris' } });
    expect(row.promptOverride).toBe('You authored the Academy history.');
  });

  it('amends a worker that has already done work — the case that motivated it', async () => {
    // deleteWorker + re-cast refuses WORKER_IN_USE once a session was bound, so
    // exactly the workers with an identity to record were the ones that could
    // not be re-cast. This is the path that has to work.
    const iris = await worker('Iris', 'iris');
    await db.session.create({
      data: { id: generateId(), workerId: iris.id, appId: app.id, userId: user.id },
    });

    await createTestableMcpServer(hybridAuth()).callToolText('hadron_update_worker', {
      workerRef: 'Iris',
      promptOverride: 'Discovered through the work.',
    });
    expect((await db.worker.findUniqueOrThrow({ where: { id: iris.id } })).promptOverride).toBe(
      'Discovered through the work.',
    );
  });

  it('does not touch a sibling casting of the same role agent', async () => {
    // The whole reason the role agent's shared systemPrompt cannot hold this.
    await worker('Iris', 'iris');
    const fred = await worker('Fred', 'fred');
    await createTestableMcpServer(hybridAuth()).callToolText('hadron_update_worker', {
      workerRef: 'Iris',
      promptOverride: 'Iris authored the Academy history.',
    });
    expect((await db.worker.findUniqueOrThrow({ where: { id: fred.id } })).promptOverride).toBeNull();
  });

  it('an empty string clears the override', async () => {
    await worker('Iris', 'iris', { promptOverride: 'stale' });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_update_worker', {
      workerRef: 'Iris',
      promptOverride: '',
    });
    expect(out).toMatch(/cleared/i);
    expect((await db.worker.findFirstOrThrow({ where: { name: 'Iris' } })).promptOverride).toBeNull();
  });

  it('a whitespace-only override is absent, matching castWorker', async () => {
    await worker('Iris', 'iris', { promptOverride: 'stale' });
    await createTestableMcpServer(hybridAuth()).callToolText('hadron_update_worker', {
      workerRef: 'Iris',
      promptOverride: '   ',
    });
    expect((await db.worker.findFirstOrThrow({ where: { name: 'Iris' } })).promptOverride).toBeNull();
  });

  it('omitting promptOverride preserves it rather than clearing it', async () => {
    // PR review (Copilot): the tool description promised omission preserves,
    // but the zod arg was REQUIRED — so a model that read the contract and
    // followed it hit a hard validation error. Making the arg optional without
    // fixing the forwarding would have been worse still: the resolver
    // distinguishes omitted from null by PRESENCE, so an unconditionally
    // forwarded `undefined` lands in the clear branch and wipes the override.
    await worker('Iris', 'iris', { promptOverride: 'keep me' });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_update_worker', {
      workerRef: 'Iris',
    });
    expect(out).toMatch(/no change requested/);
    expect(out).toContain('keep me');
    expect((await db.worker.findFirstOrThrow({ where: { name: 'Iris' } })).promptOverride).toBe(
      'keep me',
    );
  });

  it('leaves the permanent facts of the casting alone', async () => {
    const iris = await worker('Iris', 'iris');
    await createTestableMcpServer(hybridAuth()).callToolText('hadron_update_worker', {
      workerRef: 'Iris',
      promptOverride: 'new text',
    });
    const after = await db.worker.findUniqueOrThrow({ where: { id: iris.id } });
    expect(after.name).toBe('Iris');
    expect(after.slug).toBe('iris');
    expect(after.role).toBe('backend-engineer');
    expect(after.agentId).toBe(agent.id);
  });

  it('refuses for a RETIRED worker, and says why', async () => {
    await worker('Gone', 'gone', { retiredAt: new Date(), promptOverride: 'old' });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_update_worker', {
      workerRef: 'Gone',
      promptOverride: 'never delivered',
    });
    expect(out).toMatch(/retired/i);
    expect((await db.worker.findFirstOrThrow({ where: { name: 'Gone' } })).promptOverride).toBe('old');
  });

  it('refuses a caller who may not staff the App', async () => {
    await worker('Iris', 'iris');
    const out = await createTestableMcpServer({
      userId: outsider.id, appId: app.id, roles: ['READER'], clientId: `user:${outsider.id}`,
    }).callToolText('hadron_update_worker', { workerRef: 'Iris', promptOverride: 'mine now' });

    expect(out).not.toMatch(/^Updated/m);
    expect((await db.worker.findFirstOrThrow({ where: { name: 'Iris' } })).promptOverride).toBeNull();
  });

  it('refuses a PURE App-key principal — staffing is a human act', async () => {
    await worker('Iris', 'iris');
    const out = await createTestableMcpServer(appKeyAuth()).callToolText('hadron_update_worker', {
      workerRef: 'Iris',
      promptOverride: 'by a robot',
    });
    expect(out).not.toMatch(/^Updated/m);
    expect((await db.worker.findFirstOrThrow({ where: { name: 'Iris' } })).promptOverride).toBeNull();
  });

  describe('the GraphQL surface', () => {
    it('preserves the override when promptOverride is OMITTED', async () => {
      // Omitted-preserves / null-clears is the partial-update convention every
      // other surface follows; collapsing them would make clearing impossible.
      const iris = await worker('Iris', 'iris', { promptOverride: 'keep me' });
      await resolvers.Mutation.updateWorker({}, { workerRef: iris.id }, ctxFor());
      expect((await db.worker.findUniqueOrThrow({ where: { id: iris.id } })).promptOverride).toBe(
        'keep me',
      );
    });

    it('clears the override on an explicit null', async () => {
      const iris = await worker('Iris', 'iris', { promptOverride: 'drop me' });
      await resolvers.Mutation.updateWorker(
        {},
        { workerRef: iris.id, promptOverride: null },
        ctxFor(),
      );
      expect(
        (await db.worker.findUniqueOrThrow({ where: { id: iris.id } })).promptOverride,
      ).toBeNull();
    });

    it('stores a non-blank override RAW, without trimming the author\'s whitespace', async () => {
      const iris = await worker('Iris', 'iris');
      await resolvers.Mutation.updateWorker(
        {},
        { workerRef: iris.id, promptOverride: '  indented prose\n' },
        ctxFor(),
      );
      expect((await db.worker.findUniqueOrThrow({ where: { id: iris.id } })).promptOverride).toBe(
        '  indented prose\n',
      );
    });

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

    it('refuses when the worker is retired between the check and the write', async () => {
      // PR review (Copilot): the refusal read retiredAt from a row resolved
      // earlier, so a retireWorker landing in between let the write through and
      // amended a retired casting the contract says it refuses. The write is now
      // guarded on the state the check consumed.
      const iris = await worker('Iris', 'iris');
      const ctx = ctxFor();
      // Simulate the race precisely: the resolver's own resolve step returns a
      // live row, and retirement commits before the write.
      const original = db.app.findUniqueOrThrow.bind(db.app);
      const spy = vi.spyOn(db.app, 'findUniqueOrThrow').mockImplementationOnce((async (a: never) => {
        const row = await original(a);
        await db.worker.update({ where: { id: iris.id }, data: { retiredAt: new Date() } });
        return row;
      }) as never);
      try {
        await expect(
          resolvers.Mutation.updateWorker(
            {},
            { workerRef: iris.id, promptOverride: 'slipped through' },
            ctx,
          ),
        ).rejects.toMatchObject({ extensions: { code: 'WORKER_RETIRED' } });
      } finally {
        spy.mockRestore();
      }
      expect(
        (await db.worker.findUniqueOrThrow({ where: { id: iris.id } })).promptOverride,
      ).toBeNull();
    });

    it('reports NOT_FOUND, not RETIRED, when the worker is deleted mid-flight', async () => {
      // PR review (Codex): a concurrent deleteWorker also yields zero rows, and
      // it is permitted to — its "never used" test is about bound sessions and
      // working-memory content, and setting an override makes a worker neither.
      // The two answers point opposite ways for the caller: deletion FREES the
      // name to be cast again, retirement reserves it forever.
      const iris = await worker('Iris', 'iris');
      const original = db.app.findUniqueOrThrow.bind(db.app);
      const spy = vi.spyOn(db.app, 'findUniqueOrThrow').mockImplementationOnce((async (a: never) => {
        const row = await original(a);
        await db.worker.delete({ where: { id: iris.id } });
        return row;
      }) as never);
      try {
        await expect(
          resolvers.Mutation.updateWorker(
            {},
            { workerRef: iris.id, promptOverride: 'too late' },
            ctxFor(),
          ),
        ).rejects.toMatchObject({ extensions: { code: 'WORKER_NOT_FOUND' } });
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
    const started = await srv.callToolText('hadron_start_session', {
      workerRef: 'Iris', description: 'stint one',
    });
    const id = started.match(/Session started: (\S+)/)![1];
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
    const second = await srv.callToolText('hadron_start_session', {
      workerRef: 'Iris', description: 'stint two',
    });
    await srv.callToolText('hadron_end_session', {
      id: second.match(/Session started: (\S+)/)![1],
      handoff: 'PR #1134 merged; #1100 is next.',
    });

    const rebound = await srv.callToolText('hadron_start_session', {
      workerRef: 'Iris', description: 'stint three',
    });
    expect(rebound).toContain('#1100 is next');
  });
});

describe('#1029 — the handoff arrives at bind, and recovery re-fetches it', () => {
  it('hadron_start_session renders the previous stint\'s handoff after the briefing', async () => {
    const w = await worker('Iris', 'iris');
    const srv = createTestableMcpServer(hybridAuth());
    const started = await srv.callToolText('hadron_start_session', {
      workerRef: 'Iris', description: 'stint one',
    });
    const sessionId = started.match(/Session started: (\S+)/)![1];
    await srv.callToolText('hadron_end_session', {
      id: sessionId,
      handoff: 'PR #1045 is open. Do NOT rerun the backfill.',
    });

    // A fresh bind — the acceptance narrative's step 6. Nothing asks for the
    // handoff; the bind delivers it.
    const rebound = await srv.callToolText('hadron_start_session', {
      workerRef: 'Iris', description: 'stint two',
    });
    expect(rebound).toContain('Boot briefing');
    expect(rebound).toContain('Handoff from the previous session');
    expect(rebound).toContain('Do NOT rerun the backfill');
    expect(w.id).toBeTruthy();
  });

  it('hadron_get_worker carries it too — the post-compaction reader', async () => {
    await worker('Iris', 'iris');
    const srv = createTestableMcpServer(hybridAuth());
    const started = await srv.callToolText('hadron_start_session', {
      workerRef: 'Iris', description: 'stint one',
    });
    await srv.callToolText('hadron_end_session', {
      id: started.match(/Session started: (\S+)/)![1],
      handoff: 'the migration is half-applied',
    });
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_get_worker', {
      workerRef: 'Iris',
    });
    expect(out).toContain('the migration is half-applied');
  });

  it('names an auto-expired stint rather than presenting stale prose as current', async () => {
    const w = await worker('Iris', 'iris');
    const srv = createTestableMcpServer(hybridAuth());
    const s1 = (await srv.callToolText('hadron_start_session', { workerRef: 'Iris', description: 'one' }))
      .match(/Session started: (\S+)/)![1];
    await srv.callToolText('hadron_end_session', { id: s1, handoff: 'state as of stint one' });

    // Stint two is REAPED — the #930 reaper stamps both columns and writes no
    // handoff, because nobody closed it deliberately.
    const s2 = (await srv.callToolText('hadron_start_session', { workerRef: 'Iris', description: 'two' }))
      .match(/Session started: (\S+)/)![1];
    const now = new Date();
    await db.session.update({ where: { id: s2 }, data: { endedAt: now, autoExpiredAt: now } });

    const out = await srv.callToolText('hadron_get_worker', { workerRef: 'Iris' });
    expect(out).toContain('No current handoff');
    expect(out).toContain('auto-expired by the server');
    // Still handed over, but framed as history.
    expect(out).toContain('state as of stint one');
    expect(out).toContain('history, not as the current state of play');
    expect(w.id).toBeTruthy();
  });

  it('a retried hadron_end_session writes no second handoff and does not move endedAt', async () => {
    // The MCP tool reimplements the end with its own raw update, which is how
    // the guard ended up on the GraphQL resolver only (PR #1045 review, Codex
    // P1). Both now come from the shared writer plus first-end-wins here.
    await worker('Iris', 'iris');
    const srv = createTestableMcpServer(hybridAuth());
    const s1 = (await srv.callToolText('hadron_start_session', { workerRef: 'Iris', description: 'one' }))
      .match(/Session started: (\S+)/)![1];
    await srv.callToolText('hadron_end_session', { id: s1, handoff: 'stint one' });
    const endedAt = (await db.session.findUniqueOrThrow({ where: { id: s1 } })).endedAt;

    const s2 = (await srv.callToolText('hadron_start_session', { workerRef: 'Iris', description: 'two' }))
      .match(/Session started: (\S+)/)![1];
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
    const s1 = (await srv.callToolText('hadron_start_session', { workerRef: 'Iris', description: 'one' }))
      .match(/Session started: (\S+)/)![1];
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


// ---------------------------------------------------------------------------
// #1053 — recording against an ended session says so
// ---------------------------------------------------------------------------

describe('#1053 — hadron_record_work names an ended session', () => {
  async function boundSession(): Promise<string> {
    await worker('Iris', 'iris');
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_start_session', {
      workerRef: 'Iris', description: 'stint',
    });
    return out.match(/Session started: (\S+)/)![1];
  }

  it('a live session records with a clean receipt and no warning', async () => {
    const sid = await boundSession();
    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_record_work', {
      session: sid, tool: 'github', kind: 'pr', ref: 'acme/repo#1', action: 'opened',
    });
    expect(out).toContain('Recorded');
    expect(out).not.toContain('ALREADY ENDED');
  });

  it('a REAPED session still records — and the receipt says the binding is gone', async () => {
    // The observed incident: two milestones recorded twelve minutes after the
    // reap, both with clean receipts, and the worker would have finished the
    // stint believing it was still bound.
    const sid = await boundSession();
    const now = new Date();
    await db.session.update({ where: { id: sid }, data: { endedAt: now, autoExpiredAt: now } });

    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_record_work', {
      session: sid, tool: 'github', kind: 'pr', ref: 'acme/repo#2', action: 'merged',
    });
    // The record is KEPT — late attribution is the worklog's point
    // (cor:agt:020:05), so refusing here would invalidate durable law.
    expect(out).toContain('Recorded');
    expect(out).toContain('ALREADY ENDED');
    expect(out).toContain('end reason: unknown');
    expect(out).toContain('hadron_whoami');
    // The warning must NOT claim attribution stops — that is the behaviour
    // this change exists to defend, and saying otherwise would send a worker
    // rebinding to recover records it never lost (PR #1055 review, both bots).
    expect(out).toContain('further records against it will be too');
    // No clause may read as "attribution stops" — the third wording of this
    // one sentence, each earlier draft caught by review (PR #1055).
    expect(out).not.toMatch(/will not be attributed/);
    expect(out).not.toMatch(/nothing new is being attributed/);
  });

  it('distinguishes a deliberate close from a reap — they mean different things', async () => {
    const sid = await boundSession();
    await createTestableMcpServer(hybridAuth()).callToolText('hadron_end_session', { id: sid });

    const out = await createTestableMcpServer(hybridAuth()).callToolText('hadron_record_work', {
      session: sid, tool: 'github', kind: 'pr', ref: 'acme/repo#3', action: 'merged',
    });
    expect(out).toContain('Recorded');
    expect(out).toContain('end reason: ended');
    expect(out).not.toContain('auto-expired');
  });
});


describe('#1053 — hadron_end_session does not read as a fresh close when it was not', () => {
  it('an ALREADY-ended session says so rather than reporting a clean end', async () => {
    // end_session is idempotent (first end wins, #1050), so a plain
    // "Session ended" on a session that closed hours ago is a second false
    // liveness signal — in the very tool the old guidance called the loud one.
    await worker('Iris', 'iris');
    const srv = createTestableMcpServer(hybridAuth());
    const started = await srv.callToolText('hadron_start_session', {
      workerRef: 'Iris', description: 'stint',
    });
    const sid = started.match(/Session started: (\S+)/)![1];
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
    const started = await srv.callToolText('hadron_start_session', {
      workerRef: 'Iris', description: 'stint',
    });
    const sid = started.match(/Session started: (\S+)/)![1];
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
    const started = await srv.callToolText('hadron_start_session', {
      workerRef: 'Iris', description: 'stint',
    });
    const sid = started.match(/Session started: (\S+)/)![1];

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
