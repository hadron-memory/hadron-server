/**
 * #931/#932 — the MCP session write gate, exercised through the real tools.
 *
 * The MCP `hadron_end_session` gate is a hand-rolled duplicate of
 * `requireSessionWriteAccess` (the tool predates the delegate-to-resolvers
 * convention), so it can regress independently — these tests pin it at the
 * tool level (Copilot review on PR #932). Covered: the start→end round trip
 * stamps `userId`; a co-member carrying the same App selection (the hybrid
 * OAuth shape — `requireAppScope()` fills auth.appId from the user's
 * active-App SELECTION) cannot end another member's session; a pure App-key
 * principal can end its own App's user-less sessions (never a person's,
 * #1934 / ruling #11860); the attributed user can end their own.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import type { AuthContext } from '../../middleware/auth.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let app: { id: string };
let alice: { id: string };
let bob: { id: string };

function hybridAuth(userId: string): AuthContext {
  // OAuth/user MCP caller with an active-App selection: userId AND appId set.
  return { userId, appId: app.id, roles: ['READER'], clientId: `user:${userId}` };
}
function appKeyAuth(): AuthContext {
  // Pure App-key principal: appId only, no userId.
  return { appId: app.id, clientId: `app:${app.id}` };
}

async function startSessionAs(auth: AuthContext): Promise<string> {
  const srv = createTestableMcpServer(auth);
  const out = await srv.callToolText('hadron_start_session', {
    description: 'gate test session',
  });
  const m = /Session started: (\S+)/.exec(out);
  expect(m, `unexpected start output: ${out}`).toBeTruthy();
  return m![1];
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({
    data: { id: generateId(), name: 'gate-org', urn: `gate-org-${suffix}.com` },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'gate-app', urn: `gate-org-${suffix}.com::gate-app` },
  });
  alice = await db.user.create({
    data: { id: generateId(), githubId: 93201, githubUsername: `gate-alice-${suffix}`, roles: ['READER'] },
  });
  bob = await db.user.create({
    data: { id: generateId(), githubId: 93202, githubUsername: `gate-bob-${suffix}`, roles: ['READER'] },
  });
});

describe('MCP hadron_start_session → hadron_end_session write gate (#931)', () => {
  it('stamps userId on start and lets the attributed user end their own session', async () => {
    const sessionId = await startSessionAs(hybridAuth(alice.id));
    const row = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.userId).toBe(alice.id); // #931: attribution stamped from auth
    expect(row.appId).toBe(app.id);

    const srv = createTestableMcpServer(hybridAuth(alice.id));
    const out = await srv.callToolText('hadron_end_session', { id: sessionId, summary: 'done' });
    expect(out).toContain('Session ended');
    const ended = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(ended.endedAt).not.toBeNull();
    expect(ended.summary).toBe('done');
  });

  it('refuses a co-member carrying the same App selection (#932 Codex P1)', async () => {
    const sessionId = await startSessionAs(hybridAuth(alice.id));

    const srv = createTestableMcpServer(hybridAuth(bob.id));
    const out = await srv.callToolText('hadron_end_session', { id: sessionId, summary: 'hijack' });
    expect(out).toContain('Forbidden');
    const row = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.endedAt).toBeNull(); // untouched
    expect(row.summary).toBeNull();
  });

  it("lets a pure App-key principal end its own App's user-less sessions, but never a person's (#1934, ruling #11860)", async () => {
    // App-key-started session (userId null): the App ends it — #932's purpose.
    const ownSession = await startSessionAs(appKeyAuth());
    const srv = createTestableMcpServer(appKeyAuth());
    expect(await srv.callToolText('hadron_end_session', { id: ownSession })).toContain('Session ended');

    // A user-attributed session of the SAME App: a person is behind it, so the
    // App may not end it (Holger's ruling A via Vera, team chat #11860,
    // reversing #932's "absence of a userId on the CALLER only" rule).
    const userSession = await startSessionAs(hybridAuth(alice.id));
    expect(await srv.callToolText('hadron_end_session', { id: userSession })).toContain('Forbidden');
    expect((await db.session.findUniqueOrThrow({ where: { id: userSession } })).endedAt).toBeNull();
  });

  it('refuses an App-key principal for a different App\'s session', async () => {
    const sessionId = await startSessionAs(hybridAuth(alice.id));
    const org2 = await db.organization.create({
      data: { id: generateId(), name: 'gate-org2', urn: `gate-org2-${Date.now()}.com` },
    });
    const foreignApp = await db.app.create({
      data: { id: generateId(), organizationId: org2.id, name: 'gate-app2', urn: `${org2.urn}::gate-app2` },
    });
    const srv = createTestableMcpServer({ appId: foreignApp.id, clientId: `app:${foreignApp.id}` });
    const out = await srv.callToolText('hadron_end_session', { id: sessionId });
    expect(out).toContain('Forbidden');
  });
});
