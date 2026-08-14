/**
 * #974 — the hadron_cast_worker MCP tool: a THIN delegation to
 * resolvers.Mutation.castWorker (findings:node-write-surface-invariants — MCP
 * tools delegate, never re-implement). These tests pin the delegation round
 * trip and the principal-shape behavior at the tool level: a hybrid
 * user+selection caller casts on the USER's rights and defaults the App from
 * the active selection; a pure App-key principal is refused by the resolver's
 * gate (findings:auth-appid-credential-vs-selection); typed refusals surface
 * as tool TEXT, never as a throw.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let admin: { id: string };
let app: { id: string; urn: string };
let roleAgent: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'mcp-worker-org', urn: `mcp-worker-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 97420, githubUsername: `mcp-worker-admin-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  const ctx: Context = { db, userId: admin.id, roles: ['READER'] };

  // The Team Agent carries the cast-list register (roles:<role> node,
  // data.names) — the node's CONTENT is deliberately noise (#974: castWorker
  // reads only data.names; the prompt lives on the role-agent as dressing).
  const teamAgent = await M.createAgent({}, { orgId: org.id, name: 'MCP Team Agent' }, ctx);
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      content: 'legacy template — must not be read',
      data: { names: ['Iris', 'Henry'] },
    },
  });

  // The role-agent carries the persona dressing the boot briefing binds.
  const role = await M.createAgent(
    {},
    {
      orgId: org.id,
      name: 'MCP Backend Engineer',
      personaRole: 'backend-engineer',
      personaPrompt: 'You are {{name}}, a {{role}}.',
    },
    ctx,
  );
  roleAgent = { id: role.id, urn: role.urn };

  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'MCP Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: roleAgent.id } });
});

/** Hybrid principal: user credential + the team App as active selection. */
function hybridAuth(userId: string): AuthContext {
  return { userId, appId: app.id, roles: ['READER'], clientId: `user:${userId}` };
}

describe('hadron_cast_worker (#974)', () => {
  it('casts with an explicit name — worker name, id, and boot briefing in the output', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    const out = await srv.callToolText('hadron_cast_worker', {
      agent: roleAgent.id,
      name: 'Zoe',
    });
    expect(out).toContain('Worker cast: **Zoe** (backend-engineer)');
    // The boot briefing is the agent's template with {{name}}/{{role}} bound.
    expect(out).toContain('Boot briefing:');
    expect(out).toContain('You are Zoe, a backend-engineer.');
    // The full operation ran: a real Worker row, id echoed for session binding.
    const worker = await db.worker.findFirst({ where: { appId: app.id, name: 'Zoe' } });
    expect(worker).not.toBeNull();
    expect(worker!.agentId).toBe(roleAgent.id);
    expect(out).toContain(`Worker id: ${worker!.id}`);
  });

  it('allocates from the register when name is omitted (role resolves the agent too)', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    const out = await srv.callToolText('hadron_cast_worker', { role: 'backend-engineer' });
    expect(out).toContain('Worker cast: **Iris** (backend-engineer)');
    expect(out).toContain('You are Iris, a backend-engineer.');
    // Advances past the taken name on the next cast.
    const next = await srv.callToolText('hadron_cast_worker', { role: 'backend-engineer' });
    expect(next).toContain('Worker cast: **Henry**');
  });

  it('accepts an explicit app URN', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    const out = await srv.callToolText('hadron_cast_worker', {
      app: app.urn,
      agent: roleAgent.urn,
      name: 'Zoe',
    });
    expect(out).toContain('Worker cast: **Zoe**');
  });

  it('a taken name returns a text error, not a throw', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    await srv.callToolText('hadron_cast_worker', { agent: roleAgent.id, name: 'Zoe' });
    const out = await srv.callToolText('hadron_cast_worker', { agent: roleAgent.id, name: 'Zoe' });
    expect(out).toContain('Error:');
    expect(out).toContain('already taken');
    // One Zoe only — the refusal created nothing.
    expect(await db.worker.count({ where: { appId: app.id } })).toBe(1);
  });

  it('a pure App-key principal is refused by the resolver gate', async () => {
    const srv = createTestableMcpServer({ appId: app.id, clientId: `app:${app.id}` });
    const out = await srv.callToolText('hadron_cast_worker', { role: 'backend-engineer' });
    expect(out).toContain('Error:');
    expect(out).toContain('not authorized');
    expect(await db.worker.count({ where: { appId: app.id } })).toBe(0);
  });

  it('surfaces the typed WORKER_ROLE_NOT_FOUND refusal as tool text', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    const out = await srv.callToolText('hadron_cast_worker', {
      agent: roleAgent.id,
      role: 'astronaut',
    });
    expect(out).toContain('Error:');
    expect(out).toContain('astronaut');
    expect(out).toContain('backend-engineer'); // lists the available roles
  });
});
