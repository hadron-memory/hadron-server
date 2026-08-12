/**
 * #935 — the hadron_create_persona MCP tool: a THIN delegation to
 * resolvers.Mutation.createTeamPersona (findings:node-write-surface-
 * invariants — MCP tools delegate, never re-implement). These tests pin the
 * delegation round trip and the principal-shape behavior at the tool level:
 * a hybrid user+selection caller mints on the USER's rights and defaults the
 * App from the active selection; a pure App-key principal is refused by the
 * resolver's gate (findings:auth-appid-credential-vs-selection).
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

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'mcp-persona-org', urn: `mcp-persona-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 93520, githubUsername: `mcp-persona-admin-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  const ctx: Context = { db, userId: admin.id, roles: ['READER'] };
  const teamAgent = await M.createAgent({}, { orgId: org.id, name: 'MCP Team Agent' }, ctx);
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      content: 'You are {{name}}, a {{role}}.',
      data: { names: ['Iris', 'Henry'] },
    },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'MCP Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
});

function hybridAuth(userId: string): AuthContext {
  return { userId, appId: app.id, roles: ['READER'], clientId: `user:${userId}` };
}

describe('hadron_create_persona (#935)', () => {
  it('mints via the active-App selection and prints the boot briefing', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    const out = await srv.callToolText('hadron_create_persona', { role: 'backend-engineer' });
    expect(out).toContain('Persona minted: **Iris** (backend-engineer)');
    expect(out).toContain('You are Iris, a backend-engineer.');
    // The full operation ran: the persona is a real Agent on the roster.
    const agent = await db.agent.findFirst({ where: { personaName: 'Iris' } });
    expect(agent).not.toBeNull();
    const roster = await db.appAgent.findUnique({
      where: { appId_agentId: { appId: app.id, agentId: agent!.id } },
    });
    expect(roster).not.toBeNull();
  });

  it('accepts an explicit app URN and name', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    const out = await srv.callToolText('hadron_create_persona', {
      role: 'backend-engineer',
      app: app.urn,
      name: 'Zoe',
    });
    expect(out).toContain('Persona minted: **Zoe**');
  });

  it('a pure App-key principal is refused by the resolver gate', async () => {
    const srv = createTestableMcpServer({ appId: app.id, clientId: `app:${app.id}` });
    const out = await srv.callToolText('hadron_create_persona', { role: 'backend-engineer' });
    expect(out).toContain('Error:');
    expect(out).toContain('not authorized');
    expect(await db.agent.findFirst({ where: { personaName: 'Iris' } })).toBeNull();
  });

  it('surfaces the typed refusal messages as tool text', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    const out = await srv.callToolText('hadron_create_persona', { role: 'astronaut' });
    expect(out).toContain('Error:');
    expect(out).toContain('astronaut');
    expect(out).toContain('backend-engineer'); // lists the available roles
  });
});
