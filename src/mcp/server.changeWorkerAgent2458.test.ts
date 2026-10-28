/**
 * #2458 — hadron_change_worker_agent is a THIN delegation to resolvers.Mutation.changeWorkerAgent
 * (findings:node-write-surface-invariants): a manager's change round-trips by worker NAME, and a typed refusal
 * (here a pure App key, which manages nothing) surfaces as tool text with nothing written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
let app: any, admin: any, oldAgent: any, newAgent: any, worker: any;

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().toLowerCase();
  const org = await db.organization.create({ data: { name: 'mcp-casting', urn: `mcp-casting-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 92458100, githubUsername: `mcp-casting-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const ctx: Context = { db, userId: admin.id, roles: ['READER'] };
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  oldAgent = await M.createAgent({}, { orgId: org.id, name: 'Security', personaRole: 'security-engineer' }, ctx);
  newAgent = await M.createAgent({}, { orgId: org.id, name: 'Specs', personaRole: 'specs-engineer' }, ctx);
  await db.appAgent.create({ data: { appId: app.id, agentId: oldAgent.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: newAgent.id } });
  worker = await M.castWorker({}, { appRef: app.id, agentRef: oldAgent.id, name: 'Ruin' }, ctx);
});

const userAuth = (): AuthContext => ({ userId: admin.id, appId: app.id, roles: ['READER'], clientId: `user:${admin.id}` });

describe('hadron_change_worker_agent (#2458)', () => {
  it('changes the agent by worker name and reports the new role', async () => {
    const out = await createTestableMcpServer(userAuth()).callToolText('hadron_change_worker_agent', { workerRef: 'Ruin', agent: newAgent.id });
    expect(out).toContain('**Ruin** now casts agent');
    expect(out).toContain('role specs-engineer');
    expect(await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).toMatchObject({ agentId: newAgent.id, role: 'specs-engineer' });
  });

  it('an App key manages nothing: refused as tool text, nothing written', async () => {
    const out = await createTestableMcpServer({ appId: app.id, roles: [] } as AuthContext)
      .callToolText('hadron_change_worker_agent', { workerRef: worker.id, agent: newAgent.id });
    expect(out).not.toContain('now casts');
    expect(await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).toMatchObject({ agentId: oldAgent.id, role: 'security-engineer' });
    expect(await db.agentTeamEvent.count({ where: { type: 'worker.casting' } })).toBe(0);
  });

  it('an unexpected fault in the resolver is the generic envelope, not its message (#1789)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(M, 'changeWorkerAgent').mockRejectedValue(new Error('/srv/private/driver canary'));
    const res = (await createTestableMcpServer(userAuth()).callTool('hadron_change_worker_agent', { workerRef: 'Ruin', agent: newAgent.id })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toContain('private');
    expect(res.content[0].text).toMatch(/Request id/i);
  });
});
