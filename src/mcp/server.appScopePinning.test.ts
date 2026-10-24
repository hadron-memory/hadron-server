import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1005 — App scope must not evaporate mid-session for a multi-App user.
 *
 * The active-App selection is per-MCP-TRANSPORT-session in-process state
 * (`activeAppByMcpSession`, cleared on transport close). MCP transport sessions
 * are re-created transparently under the client — a server restart answers a
 * stale id with the recoverable 404 and the client silently re-initializes
 * (findings:mcp-stale-session-400-vs-404). The selection does not survive that,
 * so a multi-App user's App-scoped calls succeeded for a while and then began
 * failing with `multiple_apps_resolved`, with nothing in the transcript to
 * explain the change. The reported repro is exactly that shape: four App-scoped
 * calls succeeded, then an identical `hadron_team_chat_read` failed.
 *
 * Two fixes, tested here:
 *
 *   1. **Pin at bind.** `hadron_start_session` pins the session's App, and a
 *      self-describing `workerRef` (id or URN) names its App, so it needs no
 *      prior selection at all. A bare NAME still requires App scope — a name is
 *      unique only within an App (#990).
 *   2. **Recover from the session.** The team tools resolve the App from a
 *      Hadron session id, the durable anchor an agent still holds across a
 *      reconnect. Gated to the caller's OWN session plus live membership, so it
 *      can only re-establish scope the caller could have set by hand.
 *
 * A multi-App cold MCP session is simulated the way the boundary builds one:
 * `auth.appId` unset plus `cachedAppResolution: { kind: 'multi-app' }`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import { composeWorkerUrn } from '../lib/entityRef/workerRef.js';
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
let otherApp: { id: string };
let agent: { id: string };
let worker: { id: string; slug: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'mcp-pin-org', urn: `mcp-pin-${suffix}.com` },
  });
  user = await db.user.create({
    data: { id: generateId(), githubId: 97610, githubUsername: `mcp-pin-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 97611, githubUsername: `mcp-out-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' },
  });
  agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:backend`,
      name: 'Backend',
      visibility: 'ORGANIZATION',
    },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` },
  });
  // The SECOND App is what makes the user multi-App — the whole precondition.
  otherApp = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Other App', urn: `${org.urn}:other` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: otherApp.id, userId: user.id, role: 'owner' } });
  worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' },
  });
});

/**
 * A COLD MCP session for a multi-App user: no App selected, and the boundary's
 * cached resolution says the user's App set is ambiguous. This is the state a
 * transparent reconnect lands in.
 */
function coldMultiAppAuth(): AuthContext {
  return { userId: user.id, roles: ['READER'], clientId: `user:${user.id}` } as AuthContext;
}

const MULTI_APP = { cachedAppResolution: { kind: 'multi-app' as const } };

/**
 * Start a fresh MCP server instance — the post-reconnect shape.
 *
 * The MCP session id must be UNIQUE per instance, because the selection map it
 * keys into (`activeAppByMcpSession`) is module-global and is cleared only on
 * transport close, which a test never triggers. Reusing a literal id would let
 * one test's pin leak into the next and mask exactly the failures these tests
 * exist to pin. Unique-per-instance also mirrors production, where every
 * reconnect gets a freshly generated id.
 */
function coldServer(label = 'sid') {
  return createTestableMcpServer(coldMultiAppAuth(), {
    sessionId: `mcp-${label}-${generateId()}`,
    ...MULTI_APP,
  });
}

describe('#1005 — the active App is pinned at session start', () => {
  it('a worker ID workerRef starts a session with NO prior hadron_set_active_app', async () => {
    // The App is settled by the argument: a worker belongs to exactly one App.
    const srv = coldServer();
    const out = await srv.callToolText('hadron_start_session', {
      description: 'ship the widget',
      workerRef: worker.id,
    });

    expect(out).not.toContain('multiple_apps_resolved');
    expect(out).toContain('Session started:');
    expect(out).toContain('Working as Iris');

    const row = await db.session.findFirstOrThrow({ where: { workerId: worker.id } });
    expect(row.appId).toBe(app.id);
  });

  it('a worker URN workerRef does the same — the cross-App addressing form', async () => {
    const srv = coldServer();
    const out = await srv.callToolText('hadron_start_session', {
      description: 'by urn',
      workerRef: composeWorkerUrn(app.urn, worker.slug),
    });
    expect(out).toContain('Session started:');
    expect(out).toContain('Working as Iris');
  });

  it('after the bind, App-scoped tools work on the SAME MCP session without set_active_app', async () => {
    // The reported repro's calls 2-4: they succeeded only because a selection
    // had been made earlier. Now the bind itself establishes it.
    const srv = coldServer();
    const started = await srv.callToolText('hadron_start_session', {
      description: 'pin it',
      workerRef: worker.id,
    });
    expect(started).toContain('Session started:');

    // Same server instance = same MCP session = the pin is in effect.
    const read = await srv.callToolText('hadron_team_chat_read', { sinceSeq: 0 });
    expect(read).not.toContain('multiple_apps_resolved');
    expect(read).not.toContain('No App context');
  });

  it('a unique authorized bare NAME binds and pins its App (#1597)', async () => {
    const srv = coldServer();
    const out = await srv.callToolText('hadron_start_session', {
      description: 'by name',
      workerRef: 'Iris',
    });
    expect(out).toContain('Session started:');
    expect(out).not.toContain('multiple_apps_resolved');
    expect(await db.session.count({ where: { workerId: worker.id, appId: app.id } })).toBe(1);
  });
});

describe('#1005 — App scope is recoverable from the session after a reconnect', () => {
  /** Start a session on one MCP session, then throw that MCP session away. */
  async function startThenReconnect(): Promise<string> {
    const first = coldServer('before');
    const out = await first.callToolText('hadron_start_session', {
      description: 'work',
      workerRef: worker.id,
    });
    const sessionId = out.match(/Session started: (\S+)/)?.[1];
    expect(sessionId).toBeTruthy();
    return sessionId!;
  }

  it('hadron_team_chat_read recovers the App from the session id — the repro call', async () => {
    const sessionId = await startThenReconnect();

    // The reconnect: a brand-new server instance, fresh auth, a new MCP session
    // id, and no entry in the selection map. This is exactly where the repro's
    // call 5 failed.
    const after = coldServer('after');
    expect(await after.callToolText('hadron_team_chat_read', { sinceSeq: 0 })).toContain(
      'multiple_apps_resolved',
    );

    // With the session id the agent already holds, scope is restored.
    const recovered = await after.callToolText('hadron_team_chat_read', {
      sinceSeq: 0,
      session: sessionId,
    });
    expect(recovered).not.toContain('multiple_apps_resolved');
    expect(recovered).not.toContain('No App context');
  });

  it('hadron_team_chat_post recovers the App from the session it posts as', async () => {
    const sessionId = await startThenReconnect();
    const after = coldServer('after');

    const posted = await after.callToolText('hadron_team_chat_post', {
      body: 'picked this up',
      session: sessionId,
    });
    expect(posted).not.toContain('multiple_apps_resolved');
    expect(posted).toContain('Posted team-chat message');
  });

  it('hadron_record_work recovers the App from its required session', async () => {
    const sessionId = await startThenReconnect();
    const after = coldServer('after');

    const recorded = await after.callToolText('hadron_record_work', {
      session: sessionId,
      tool: 'github',
      kind: 'pr',
      ref: 'acme/widgets#7',
      action: 'opened',
    });
    expect(recorded).not.toContain('multiple_apps_resolved');
    expect(recorded).toContain('Recorded:');
  });

  it('hadron_team_work_items recovers the App from its optional session filter', async () => {
    // The fourth recovery site (Copilot on PR #1007) — uncovered until now.
    const sessionId = await startThenReconnect();
    const after = coldServer('after');

    expect(await after.callToolText('hadron_team_work_items', {})).toContain(
      'multiple_apps_resolved',
    );
    const recovered = await after.callToolText('hadron_team_work_items', { session: sessionId });
    expect(recovered).not.toContain('multiple_apps_resolved');
    expect(recovered).not.toContain('No App context');
  });

  it("does NOT adopt another user's session", async () => {
    // The gate that keeps this from being an App-scope oracle: a session id is
    // not a capability, so naming someone else's must change nothing.
    const sessionId = await startThenReconnect();
    const stranger = createTestableMcpServer(
      { userId: outsider.id, roles: ['READER'], clientId: `user:${outsider.id}` } as AuthContext,
      { sessionId: `mcp-stranger-${generateId()}`, ...MULTI_APP },
    );

    const out = await stranger.callToolText('hadron_team_chat_read', {
      sinceSeq: 0,
      session: sessionId,
    });
    expect(out).toContain('multiple_apps_resolved');
  });

  it('does NOT adopt an App the caller has lost PARTICIPATION in (#475)', async () => {
    // The session row records where the session was attributed, which outlives
    // the authorization that permitted it. Participation is re-checked, not
    // trusted from the row.
    //
    // Both grants have to go: `isAppParticipant` admits an AppMember OR an org
    // CONTRIBUTOR+, so dropping the AppMember row alone leaves this fixture
    // user a participant through the org. That is the shared predicate's
    // documented semantics — the same one that let them start the session — not
    // a hole in the recovery gate.
    const sessionId = await startThenReconnect();
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: user.id } } });
    await db.orgMember.deleteMany({ where: { organizationId: org.id, userId: user.id } });

    const after = coldServer('after');
    const out = await after.callToolText('hadron_team_chat_read', {
      sinceSeq: 0,
      session: sessionId,
    });
    expect(out).toContain('multiple_apps_resolved');
  });

  it('does NOT adopt an uninstalled App', async () => {
    const sessionId = await startThenReconnect();
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });

    const after = coldServer('after');
    const out = await after.callToolText('hadron_team_chat_read', {
      sinceSeq: 0,
      session: sessionId,
    });
    expect(out).toContain('multiple_apps_resolved');
  });

  it('recovers for an org CONTRIBUTOR with no AppMember row (the shared participant gate)', async () => {
    // PR #1007 review, Codex P2 + Copilot: `isAppParticipant` admits an
    // AppMember at any role, an org CONTRIBUTOR+, OR the owner of a user-owned
    // App. A recovery gate keyed on AppMember alone would let this caller start
    // a session and pin an App, then refuse to restore it after a reconnect —
    // a gate drifting from the one beside it.
    const contributor = await db.user.create({
      data: { id: generateId(), githubId: 97612, githubUsername: `mcp-contrib-${generateId().slice(-6)}`, roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' },
    });
    // Multi-App WITHOUT any AppMember row: two Apps in an org they contribute
    // to. The App set is ambiguous, so scope must come from the session.
    const authOf = (): AuthContext =>
      ({ userId: contributor.id, roles: ['READER'], clientId: `user:${contributor.id}` }) as AuthContext;
    const mk = () =>
      createTestableMcpServer(authOf(), {
        sessionId: `mcp-contrib-${generateId()}`,
        ...MULTI_APP,
      });

    const started = await mk().callToolText('hadron_start_session', {
      description: 'contributor work',
      workerRef: worker.id,
    });
    expect(started).toContain('Session started:');
    const sessionId = started.match(/Session started: (\S+)/)?.[1];

    const after = mk();
    expect(await after.callToolText('hadron_team_chat_read', { sinceSeq: 0 })).toContain(
      'multiple_apps_resolved',
    );
    const recovered = await after.callToolText('hadron_team_chat_read', {
      sinceSeq: 0,
      session: sessionId,
    });
    expect(recovered).not.toContain('multiple_apps_resolved');
    expect(recovered).not.toContain('No App context');
  });

  it('recovers for the OWNER of a user-owned App with no AppMember row', async () => {
    // The other non-AppMember participant path. A user-owned App admits its
    // owner and nobody else (spec 047).
    const owner = await db.user.create({
      data: { id: generateId(), githubId: 97613, githubUsername: `mcp-owner-${generateId().slice(-6)}`, roles: ['READER'] },
    });
    const soloAgent = await db.agent.create({
      data: { id: generateId(), ownerUserId: owner.id, urn: `solo-${generateId().slice(-8)}`, name: 'Solo' },
    });
    const soloApp = await db.app.create({
      data: { id: generateId(), ownerUserId: owner.id, name: 'Solo App', urn: `solo-app-${generateId().slice(-8)}` },
    });
    await db.appAgent.create({ data: { appId: soloApp.id, agentId: soloAgent.id } });
    const soloWorker = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: soloApp.id, agentId: soloAgent.id, name: 'Solo Worker', slug: 'solo-worker' },
    });

    const authOf = (): AuthContext =>
      ({ userId: owner.id, roles: ['READER'], clientId: `user:${owner.id}` }) as AuthContext;
    const mk = () =>
      createTestableMcpServer(authOf(), { sessionId: `mcp-owner-${generateId()}`, ...MULTI_APP });

    const started = await mk().callToolText('hadron_start_session', {
      description: 'owner work',
      workerRef: soloWorker.id,
    });
    expect(started).toContain('Session started:');
    const sessionId = started.match(/Session started: (\S+)/)?.[1];

    const after = mk();
    const recovered = await after.callToolText('hadron_team_chat_read', {
      sinceSeq: 0,
      session: sessionId,
    });
    expect(recovered).not.toContain('multiple_apps_resolved');
    expect(recovered).not.toContain('No App context');
  });

  it('an explicit app argument still wins over the session hint', async () => {
    const sessionId = await startThenReconnect();
    const after = coldServer('after');

    // otherApp has no team space and the session belongs to `app` — the point
    // is only that the explicit argument, not the session, chose the App.
    const out = await after.callToolText('hadron_team_chat_read', {
      sinceSeq: 0,
      session: sessionId,
      app: otherApp.id,
    });
    expect(out).not.toContain('multiple_apps_resolved');
  });
});
