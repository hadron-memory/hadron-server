import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1009 / #1006 — the MCP surface tells the truth about itself.
 *
 * Two silent failures with the same shape, and the same remedy:
 *
 *   - #1009: everything the server keeps per MCP TRANSPORT session (the active
 *     App, the active memory, the spec-026 engagement flag) is reset when a
 *     client transparently re-initializes after a server restart. Nothing marks
 *     the boundary, so the refusal that follows reads as "this tool is broken"
 *     or "this client can't do that" rather than "state was lost". The server
 *     has always KNOWN — reaching the transport-creation block with a session id
 *     in hand means the client presented one it did not know and asked to
 *     initialize — and threw the fact away.
 *   - #1006: a deployment behind the docs served a `hadron_start_session` with
 *     no `workerRef`. MCP drops unknown arguments, so the call returned a
 *     healthy-looking session that was never bound to a worker, silently
 *     breaking `cor:agt:020:03` provenance. Diagnosing it required diffing the
 *     served tool list against `main`.
 *
 * Both are answered by stating the thing instead of leaving it to be inferred:
 * capability tokens on `hadron_server_info`, and a reconnect note on the
 * refusals that a reconnect causes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { serveEveryAgent } from '../test/servedBootPrompt.js';
import { generateId } from '../lib/id.js';
import { startWorkerSessionGql } from '../test/startWorkerSessionGql.js';
import { createTestableMcpServer } from './server.js';
import { MCP_SURFACE_CAPABILITIES } from './deploymentInfo.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let user: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };
let worker: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'mcp-rc-org', urn: `mcp-rc-${suffix}.com` },
  });
  user = await db.user.create({
    data: { id: generateId(), githubId: 97710, githubUsername: `mcp-rc-${suffix}`, roles: ['READER'] },
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
  // A second App makes the user multi-App, which is the precondition for the
  // App-scope refusals under test.
  await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Other App', urn: `${org.urn}:other` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' },
  });
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});

const MULTI_APP = { cachedAppResolution: { kind: 'multi-app' as const } };

function userAuth(): AuthContext {
  return { userId: user.id, roles: ['READER'], clientId: `user:${user.id}` } as AuthContext;
}

/** A cold multi-App MCP session. `isReconnect` distinguishes fresh from rebuilt. */
function server(opts: { isReconnect?: boolean } = {}) {
  return createTestableMcpServer(userAuth(), {
    sessionId: `mcp-rc-${generateId()}`,
    ...MULTI_APP,
    ...opts,
  });
}

describe('#1006 — the surface states its capabilities', () => {
  it('hadron_server_info lists capability tokens', async () => {
    const out = await server().callToolText('hadron_server_info', {});
    expect(out).toContain('capabilities:');
    for (const token of MCP_SURFACE_CAPABILITIES) {
      expect(out).toContain(token);
    }
  });

  it('#3082 — no longer advertises worker-model: MCP carries agents, not workers', async () => {
    // The #1006 token answered "can this deployment bind a worker over MCP?". Since the team cut it cannot
    // (hadron_start_session refuses workerRef), so the honest answer is the token's absence.
    const out = await server().callToolText('hadron_server_info', {});
    expect(out).not.toContain('worker-model');
    expect(MCP_SURFACE_CAPABILITIES).not.toContain('worker-model');
  });

  it('still reports server and version (the #190 dual-namespace signal)', async () => {
    const out = await server().callToolText('hadron_server_info', {});
    expect(out).toContain('server:');
    expect(out).toContain('version:');
  });

  it('#1246 — hadron_whoami renders liveness and a human hold as independent state', async () => {
    const client = server();
    const sessionId = await startWorkerSessionGql({ workerRef: worker.id, userId: user.id, appId: app.id });
    const out = await client.callToolText('hadron_whoami', { session: sessionId });

    expect(out).toMatch(/recently active inside its idle window/);
    expect(out).toMatch(/session block falls away/);
    expect(out).toMatch(/human HOLD remains independent until explicit release/);
    expect(out).toMatch(/created by hadron_start_session has no hard expiry/);
    expect(out).toMatch(/stays open until hadron_end_session/);
    expect(out).toMatch(/non-null hard expiry.*ended by the reaper/);
  });
});

describe('#1009 — a reconnect is legible instead of inferred', () => {
  it('hadron_server_info reports a re-established connection', async () => {
    const out = await server({ isReconnect: true }).callToolText('hadron_server_info', {});
    expect(out).toContain('connection: re-established');
    expect(out).toContain('reset');
  });

  it('says nothing about reconnects on a genuinely fresh session', async () => {
    // The note must mean something. Emitting it always would make it noise, and
    // would misreport a first-connection refusal as lost state.
    const out = await server().callToolText('hadron_server_info', {});
    expect(out).not.toContain('re-established');
  });

  it('the App-scope refusal explains itself after a reconnect', async () => {
    const out = await server({ isReconnect: true }).callToolText('hadron_start_session', {
      description: 'x',
    });
    expect(out).toContain('multiple_apps_resolved');
    expect(out).toContain('re-established');
    expect(out).toContain('RESET');
    // The sentence that flips the reader's conclusion: this is the thing the
    // issue reported being misled by.
    expect(out).toContain('not a client limitation');
  });

  it('the same refusal on a fresh session carries no reconnect note', async () => {
    const out = await server().callToolText('hadron_start_session', { description: 'x' });
    expect(out).toContain('multiple_apps_resolved');
    expect(out).not.toContain('re-established');
  });

  it('the typed no_active_app refusal also explains itself', async () => {
    // The engaged-session branch: hadron_list_apps flips engagedWithNewSurface,
    // switching which of the two refusals fires. Both must carry the note.
    const srv = server({ isReconnect: true });
    await srv.callToolText('hadron_list_apps', {});
    const out = await srv.callToolText('hadron_start_session', { description: 'x' });
    expect(out).toContain('no_active_app');
    expect(out).toContain('re-established');
  });
});

describe('#1009 — App scope recovery reaches the rest of the worker flow', () => {
  /** Start a worker session the way the CLI does (GraphQL; MCP no longer binds workers, #3082). The MCP session is then a new one — the reconnect. */
  async function startThenReconnect(): Promise<string> {
    return startWorkerSessionGql({ workerRef: worker.id, userId: user.id, appId: app.id });
  }

  it('hadron_end_session recovers from its own id — no new argument needed', async () => {
    // The sharpest case in the gap: after a reconnect a multi-App caller could
    // neither continue the session NOR end it, leaving the worker session open
    // and blocking another bind while it still read live.
    const sessionId = await startThenReconnect();
    const after = server({ isReconnect: true });

    const out = await after.callToolText('hadron_end_session', {
      id: sessionId,
      summary: 'done',
    });
    expect(out).not.toContain('multiple_apps_resolved');

    const row = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.endedAt).not.toBeNull();
  });

  // #3082: the list_workers and cast_worker recovery tests were deleted with their tools (disabled). The recovery
  // gate they leaned on is the one hadron_end_session's test above and the stranger test below still pin.

  it("still refuses another user's session as an App hint", async () => {
    // The recovery gate is unchanged by this issue — re-pinned here because
    // the end_session recovery depends on it.
    const sessionId = await startThenReconnect();
    const stranger = await db.user.create({
      data: { id: generateId(), githubId: 97711, githubUsername: `mcp-rc-x-${generateId().slice(-6)}`, roles: ['READER'] },
    });
    const srv = createTestableMcpServer(
      { userId: stranger.id, roles: ['READER'], clientId: `user:${stranger.id}` } as AuthContext,
      { sessionId: `mcp-rc-x-${generateId()}`, ...MULTI_APP },
    );
    expect(await srv.callToolText('hadron_end_session', { id: sessionId, summary: 'x' })).toContain(
      'multiple_apps_resolved',
    );
  });
});
