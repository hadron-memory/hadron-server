import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #940 — hadron_start_session delegates to resolvers.Mutation.startSession
 * (findings:node-write-surface-invariants — MCP tools delegate, never
 * re-implement), which is what gives MCP the workerRef binding at parity with
 * GraphQL: WORKER_RETIRED, SESSION_WORKER_NOT_IN_APP, and the WORKER_TAKEN
 * informed-takeover refusal (cor:agt:020:03) all come from the ONE gated
 * path. Typed refusals surface as tool TEXT, never as a throw.
 *
 * #3082: MCP no longer binds a worker (MCP_WORKER_BINDING_UNSUPPORTED, pinned in server.mcpTeamCut3082.test.ts), so the
 * worker-bind tests here were deleted; the same rules (WORKER_TAKEN, WORKER_RETIRED, name resolution, cross-App ref,
 * briefing) are pinned at the resolver in resolvers.worker.test.ts / resolvers.workerNameRef.test.ts /
 * resolvers.serveBind2047.test.ts / resolvers.sessionAppRef.test.ts. Only the plain (workerless) start stays.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import { serveEveryAgent } from '../test/servedBootPrompt.js';
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

describe('hadron_start_session without a worker (#940, #990)', () => {
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

  it('says nothing about briefings when no worker is bound', async () => {
    const srv = createTestableMcpServer(hybridAuth());
    const out = await srv.callToolText('hadron_start_session', { description: 'solo work' });
    expect(out).toContain('Session started:');
    expect(out).not.toContain('Working as');
    expect(out).not.toContain('briefing');
  });
});
