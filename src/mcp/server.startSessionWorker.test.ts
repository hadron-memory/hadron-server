import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #940 — hadron_start_session delegates to resolvers.Mutation.startSession
 * (findings:node-write-surface-invariants — MCP tools delegate, never
 * re-implement), which is what gives MCP the workerRef binding at parity with
 * GraphQL: WORKER_RETIRED, SESSION_WORKER_NOT_IN_APP, and the WORKER_TAKEN
 * informed-takeover refusal (cor:agt:020:03) all come from the ONE gated
 * path. Typed refusals surface as tool TEXT, never as a throw.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { serveAgentBootPrompt, serveEveryAgent } from '../test/servedBootPrompt.js';
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
let otherApp: { id: string };
let agent: { id: string };
let worker: { id: string };
let otherAppWorker: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'mcp-ssw-org', urn: `mcp-ssw-${suffix}.com` },
  });
  user = await db.user.create({
    data: { id: generateId(), githubId: 97510, githubUsername: `mcp-ssw-${suffix}`, roles: ['READER'] },
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
  otherApp = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Other App', urn: `${org.urn}:other` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' },
  });
  otherAppWorker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: otherApp.id, agentId: agent.id, name: 'Nadia', slug: 'nadia' },
  });
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});

/** Hybrid principal: user credential + the team App as active selection. */
function hybridAuth(): AuthContext {
  return { userId: user.id, appId: app.id, roles: ['READER'], clientId: `user:${user.id}` };
}

describe('hadron_start_session workerRef parity (#940)', () => {
  it('binds the worker through the delegated resolver, stamping agentId and plan', async () => {
    const srv = createTestableMcpServer(hybridAuth());
    const out = await srv.callToolText('hadron_start_session', {
      description: 'ship the widget',
      workerRef: worker.id,
    });
    expect(out).toContain('Session started:');
    expect(out).toContain(`Working as Iris (worker id: ${worker.id})`);
    const sessionId = out.match(/Session started: (\S+)/)?.[1];
    const row = await db.session.findUniqueOrThrow({ where: { id: sessionId! } });
    expect(row.workerId).toBe(worker.id);
    expect(row.agentId).toBe(agent.id);
    expect(row.appId).toBe(app.id);
    expect(row.userId).toBe(user.id);
    expect(row.plan).toBe('ship the widget');
  });

  it('a taken worker returns the WORKER_TAKEN text (who, when, how to force) — not a throw', async () => {
    const srv = createTestableMcpServer(hybridAuth());
    await srv.callToolText('hadron_start_session', {
      description: 'first driver',
      workerRef: worker.id,
    });
    const out = await srv.callToolText('hadron_start_session', {
      description: 'second driver',
      workerRef: worker.id,
    });
    expect(out).toContain('Error:');
    expect(out).toContain('taken');
    expect(out).toContain('force: true');
    // Nothing was created for the refused start.
    expect(await db.session.count({ where: { workerId: worker.id } })).toBe(1);
  });

  it('force: true takes over', async () => {
    const srv = createTestableMcpServer(hybridAuth());
    await srv.callToolText('hadron_start_session', {
      description: 'first driver',
      workerRef: worker.id,
    });
    const out = await srv.callToolText('hadron_start_session', {
      description: 'takeover',
      workerRef: worker.id,
      force: true,
    });
    expect(out).toContain('Session started:');
    expect(await db.session.count({ where: { workerId: worker.id } })).toBe(2);
  });

  it('a retired worker refuses as text (WORKER_RETIRED path)', async () => {
    await db.worker.update({ where: { id: worker.id }, data: { retiredAt: new Date() } });
    const srv = createTestableMcpServer(hybridAuth());
    const out = await srv.callToolText('hadron_start_session', {
      description: 'nope',
      workerRef: worker.id,
    });
    expect(out).toContain('Error:');
    expect(out).toContain('retired');
  });

  it("a worker of a DIFFERENT App than the selection now BINDS — the ref wins (#1037)", async () => {
    // FLIPPED by #1037 (review:convention-ratchets-must-be-flipped): this
    // asserted the refusal that issue exists to remove. A worker id names its
    // own App, and the active-App selection is connection state any later bind
    // silently re-points — so refusing here meant a worker following the
    // documented procedure could not bind at all from a connection that had
    // touched a second App. The selection yields; the participant gate does
    // not, and it is what still bounds this (the caller is an org CONTRIBUTOR,
    // so they genuinely participate in otherApp).
    const srv = createTestableMcpServer(hybridAuth());
    const out = await srv.callToolText('hadron_start_session', {
      description: 'other app',
      workerRef: otherAppWorker.id,
    });
    expect(out).toContain('Session started:');
    const sessionId = out.match(/Session started: (\S+)/)![1];
    const row = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    // Attributed to the WORKER's App, not the one that was selected.
    expect(row.appId).toBe(otherApp.id);
    expect(row.workerId).toBe(otherAppWorker.id);
  });

  it('without workerRef the tool still starts a plain session (the pre-#940 shape)', async () => {
    const srv = createTestableMcpServer(hybridAuth());
    const out = await srv.callToolText('hadron_start_session', { description: 'plain' });
    expect(out).toContain('Session started:');
    const sessionId = out.match(/Session started: (\S+)/)?.[1];
    const row = await db.session.findUniqueOrThrow({ where: { id: sessionId! } });
    expect(row.workerId).toBeNull();
    expect(row.appId).toBe(app.id);
    expect(row.plan).toBe('plain');
  });
});

describe('#990 — workerRef by name, and the briefing always comes back', () => {
  it('binds by NAME, scoped to the active App', async () => {
    const srv = createTestableMcpServer(hybridAuth());
    const out = await srv.callToolText('hadron_start_session', {
      description: 'pick up Iris',
      workerRef: 'Iris',
    });
    expect(out).toContain('Session started:');
    expect(out).toContain(`Working as Iris (worker id: ${worker.id})`);
    const sessionId = out.match(/Session started: (\S+)/)?.[1];
    const row = await db.session.findUniqueOrThrow({ where: { id: sessionId! } });
    expect(row.workerId).toBe(worker.id);
  });

  it('the name is matched case-insensitively', async () => {
    const srv = createTestableMcpServer(hybridAuth());
    const out = await srv.callToolText('hadron_start_session', {
      description: 'lowercase pickup',
      workerRef: 'iris',
    });
    expect(out).toContain(`Working as Iris (worker id: ${worker.id})`);
  });

  it('a name from ANOTHER App does not resolve in this one', async () => {
    // Nadia is real, but staffs otherApp — the active App scopes the lookup.
    const srv = createTestableMcpServer(hybridAuth());
    const out = await srv.callToolText('hadron_start_session', {
      description: 'wrong app',
      workerRef: 'Nadia',
    });
    expect(out).toContain('Error:');
    expect(out).toContain('Worker not found');
    expect(otherAppWorker.id).toBeTruthy();
  });

  it('returns the RESOLVED briefing when the role agent is served a boot prompt', async () => {
    await db.agent.update({ where: { id: agent.id }, data: { personaRole: 'backend-engineer' } });
    await serveAgentBootPrompt(db, agent.id, 'You are {{name}}, a {{role}}. Ship carefully.');
    await db.worker.update({ where: { id: worker.id }, data: { role: 'backend-engineer' } });
    const srv = createTestableMcpServer(hybridAuth());
    const out = await srv.callToolText('hadron_start_session', {
      description: 'brief me',
      workerRef: 'Iris',
    });
    expect(out).toContain('Boot briefing');
    // #1090: the bind receipt stamps the rendering it just made — composition
    // time plus the role Agent's generic updatedAt from the same read.
    expect(out).toMatch(/rendered at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(out).toMatch(/role Agent updated at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(out).toContain('(generic Agent row update)');
    // Rendered live from the served prompt, with {{name}}/{{role}} bound — this is
    // what removes the need for published briefing NODES (hadron-cli#443).
    expect(out).toContain('You are Iris, a backend-engineer. Ship carefully.');
    expect(out).not.toContain('{{name}}');
  });

  it('says nothing about briefings when no worker is bound', async () => {
    const srv = createTestableMcpServer(hybridAuth());
    const out = await srv.callToolText('hadron_start_session', { description: 'solo work' });
    expect(out).toContain('Session started:');
    expect(out).not.toContain('Working as');
    expect(out).not.toContain('briefing');
  });
});

describe('#996 review — a briefing failure must not swallow the session', () => {
  it('still returns the session id when the briefing lookup throws', async () => {
    // The session is COMMITTED before the briefing is rendered. If a transient
    // failure there surfaced as "Error: …", the caller would lose the id, and
    // its retry would hit WORKER_TAKEN for the very session it was told had
    // failed — unable to continue or to end it.
    const spy = vi
      // #1090 moved the bind's briefing composition onto composeWorkerPrompt
      // (one agent read for text + stamps), so the #996 injection point moved
      // with it — the catch contract itself is unchanged.
      .spyOn(await import('../api/graphql/schema/resolvers.worker.js'), 'composeWorkerPrompt')
      .mockRejectedValueOnce(new Error('transient prompt failure'));
    try {
      const srv = createTestableMcpServer(hybridAuth());
      const out = await srv.callToolText('hadron_start_session', {
        description: 'briefing blows up',
        workerRef: 'Iris',
      });
      expect(out).not.toContain('Error:');
      expect(out).toContain('Session started:');
      expect(out).toContain(worker.id);
      expect(out).toContain('could not be rendered');
      // …and the session really is there, bound, and recoverable by id.
      const sessionId = out.match(/Session started: (\S+)/)?.[1];
      const row = await db.session.findUniqueOrThrow({ where: { id: sessionId! } });
      expect(row.workerId).toBe(worker.id);
      expect(row.endedAt).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
