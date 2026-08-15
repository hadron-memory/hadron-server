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
    data: { appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' },
  });
  otherAppWorker = await db.worker.create({
    data: { appId: otherApp.id, agentId: agent.id, name: 'Nadia', slug: 'nadia' },
  });
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
    expect(out).toContain(`Working as worker ${worker.id}`);
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

  it("a worker of a DIFFERENT App than the selection refuses (SESSION_WORKER_NOT_IN_APP path)", async () => {
    const srv = createTestableMcpServer(hybridAuth());
    const out = await srv.callToolText('hadron_start_session', {
      description: 'wrong app',
      workerRef: otherAppWorker.id,
    });
    expect(out).toContain('Error:');
    expect(out).toContain('different App');
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
