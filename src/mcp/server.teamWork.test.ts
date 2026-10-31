import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #947 — the hadron_record_work / hadron_team_work_items MCP tools: THIN
 * delegation to resolvers.Mutation.recordTeamWork /
 * resolvers.Query.teamWorkItems (findings:node-write-surface-invariants —
 * MCP tools delegate, never re-implement). Pins the delegation round trip,
 * the active-App default (same shape as hadron_cast_worker), and that the
 * full operation ran server-side (canonical ref stored on a real worklog
 * node; Session.prNumber denormalized; #974 — output lines carry the bound
 * Worker's name).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { serveEveryAgent } from '../test/servedBootPrompt.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { WORKLOG_OBJECT_TYPE } from '../api/graphql/schema/resolvers.teamWork.js';

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
let session: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'mcp-teamwork-org', urn: `mcp-teamwork-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 94720, githubUsername: `mcp-tw-admin-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  const ctx: Context = { db, userId: admin.id, roles: ['READER'] };
  const teamAgent = await M.createAgent({}, { orgId: org.id, name: 'MCP Team Agent 947' }, ctx);
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      content: 'You are {{worker.name}}, a {{worker.role}}.',
      data: { names: ['Iris'] },
    },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'MCP Team App 947', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
  // #974: the named identity is a Worker casting bound via workerRef — the
  // record's workerName comes from this row.
  const worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: teamAgent.id, name: 'Iris', slug: 'iris' },
  });
  session = await M.startSession(
    {},
    { input: { id: generateId(), appRef: app.id, workerRef: worker.id, transcriptPath: '/tmp/mcp-947.jsonl' } },
    ctx,
  );
});

function hybridAuth(userId: string): AuthContext {
  return { userId, appId: app.id, roles: ['READER'], clientId: `user:${userId}` };
}

describe('hadron_record_work / hadron_team_work_items (#947)', () => {
  it('records via the active-App selection and reads it back by a different spelling', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    const recorded = await srv.callToolText('hadron_record_work', {
      session: session.id,
      tool: 'github',
      kind: 'pr',
      ref: 'https://github.com/Acme/Widgets/pull/371',
      action: 'opened',
    });
    expect(recorded).toContain('Recorded: pr opened acme/widgets#371');
    expect(recorded).toContain(session.id);
    // #974: the output line names the bound Worker.
    expect(recorded).toContain('(Iris)');

    const page = await srv.callToolText('hadron_team_work_items', { ref: 'acme/widgets#371' });
    expect(page).toContain('1 record(s) total');
    expect(page).toContain('pr opened acme/widgets#371');
    expect(page).toContain('[Iris]');

    // The full operation ran server-side: a real worklog node exists with the
    // canonical ref, and the pr convenience denormalized Session.prNumber.
    const node = await db.node.findFirst({ where: { objectType: WORKLOG_OBJECT_TYPE } });
    expect((node!.properties as any).ref).toBe('acme/widgets#371');
    const s = await db.session.findUnique({ where: { id: session.id } });
    expect(s!.prNumber).toBe(371);
  });

  it('surfaces the typed refusal text for an unparseable ref', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    const out = await srv.callToolText('hadron_record_work', {
      session: session.id,
      tool: 'github',
      kind: 'pr',
      ref: '371',
      action: 'opened',
    });
    expect(out).toContain('Error:');
    expect(out).toContain('never infers a repo');
  });

  it('an empty worklog reads as no matching records', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    const out = await srv.callToolText('hadron_team_work_items', {});
    expect(out).toContain('No matching worklog records');
  });
});
