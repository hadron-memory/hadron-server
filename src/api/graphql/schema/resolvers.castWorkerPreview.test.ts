/**
 * #964 — castWorkerPreview: the dry-run for the one IRREVERSIBLE act in the
 * team feature (a cast name is permanent, cor:agt:020:02).
 *
 * Shape (decided): a separate QUERY sharing castWorker's resolution half
 * (`resolveCastTarget`) — same arguments, same typed refusals, same MINT
 * gate — that returns an unsaved projection (no fake Worker id). The
 * contract line under test throughout: THE PREVIEW RESERVES NOTHING.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

function ctx(userId?: string, appId?: string): Context {
  return { db, userId, appId, roles: ['READER'] };
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let org: { id: string; urn: string };
let admin: { id: string };
let outsider: { id: string };
let teamAgent: { id: string; systemMemoryId: string };
let roleAgent: { id: string };
let app: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'cwp-org', urn: `cwp-org-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 98200, githubUsername: `cwp-admin-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 98201, githubUsername: `cwp-out-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });

  const created = await M.createAgent({}, { orgId: org.id, name: 'CWP Team Agent' }, ctx(admin.id));
  teamAgent = { id: created.id, systemMemoryId: created.systemMemoryId };
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      data: { names: ['Fred', 'Gwen', 'Hans'] },
    },
  });

  const role = await M.createAgent(
    {},
    {
      orgId: org.id,
      name: 'CWP Backend Engineer',
      personaRole: 'backend-engineer',
      personaPrompt: 'You are {{name}}, a {{role}}.',
    },
    ctx(admin.id),
  );
  roleAgent = { id: role.id };

  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'CWP Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: roleAgent.id } });
});

const preview = (c: Context, args: Record<string, unknown> = {}) =>
  Q.castWorkerPreview({}, { appRef: app.id, ...args }, c);

describe('#964 — castWorkerPreview', () => {
  it('register mode: previews the next free name, the composed prompt, and the resolved Team Agent — writing NOTHING', async () => {
    await db.worker.create({ data: { appId: app.id, agentId: roleAgent.id, name: 'Fred' } });
    const p = await preview(ctx(admin.id), { role: 'backend-engineer' });
    expect(p.name).toBe('Gwen');
    expect(p.role).toBe('backend-engineer');
    expect(p.agentId).toBe(roleAgent.id);
    expect(p.teamAgentId).toBe(teamAgent.id);
    expect(p.prompt).toBe('You are Gwen, a backend-engineer.');
    expect(p.hasNamePlaceholder).toBe(true);
    // Reserves nothing, creates nothing.
    expect(await db.worker.count({ where: { appId: app.id } })).toBe(1);
  });

  it('the preview matches what the real cast then allocates', async () => {
    const p = await preview(ctx(admin.id), { role: 'backend-engineer' });
    const worker = await M.castWorker({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id));
    expect(worker.name).toBe(p.name);
  });

  it('a previewed name is NOT reserved — someone else can take it first, by design', async () => {
    const p = await preview(ctx(admin.id), { role: 'backend-engineer' });
    expect(p.name).toBe('Fred');
    await db.worker.create({ data: { appId: app.id, agentId: roleAgent.id, name: 'Fred' } });
    // The next preview simply moves on; the earlier one held no lease.
    expect((await preview(ctx(admin.id), { role: 'backend-engineer' })).name).toBe('Gwen');
  });

  it('explicit name: free previews with the override appended; taken refuses WORKER_NAME_TAKEN (retired included)', async () => {
    const p = await preview(ctx(admin.id), {
      agentRef: roleAgent.id,
      name: 'Zoe',
      promptOverride: 'Be terse.',
    });
    expect(p.name).toBe('Zoe');
    expect(p.teamAgentId).toBeNull();
    expect(p.prompt).toBe('You are Zoe, a backend-engineer.\n\nBe terse.');
    await db.worker.create({
      data: { appId: app.id, agentId: roleAgent.id, name: 'zoe', retiredAt: new Date() },
    });
    await expectCode(
      preview(ctx(admin.id), { agentRef: roleAgent.id, name: 'Zoe' }),
      'WORKER_NAME_TAKEN',
    );
  });

  it('typed refusals behave identically to the cast (the point of a preview)', async () => {
    // Unknown role → the agent resolution refusal, not a silent guess.
    await expectCode(preview(ctx(admin.id), { role: 'no-such-role' }), 'WORKER_AGENT_NOT_FOUND');
    // Exhausted register.
    for (const name of ['Fred', 'Gwen', 'Hans']) {
      await db.worker.create({ data: { appId: app.id, agentId: roleAgent.id, name } });
    }
    await expectCode(preview(ctx(admin.id), { role: 'backend-engineer' }), 'WORKER_REGISTER_EXHAUSTED');
  });

  it('flags a nameless template before the name is burned', async () => {
    await db.agent.update({
      where: { id: roleAgent.id },
      data: { personaPrompt: 'You are a {{role}}.' },
    });
    const p = await preview(ctx(admin.id), { role: 'backend-engineer' });
    expect(p.hasNamePlaceholder).toBe(false);
    expect(p.prompt).toBe('You are a backend-engineer.');
  });

  it('takes the MINT gate, not a read gate: outsiders and pure App-key principals are refused', async () => {
    await expectCode(preview(ctx(outsider.id), { role: 'backend-engineer' }), 'FORBIDDEN');
    // Staffing is a human act — the pure App-key principal is denied for the
    // cast, so the preview matches.
    await expectCode(preview(ctx(undefined, app.id), { role: 'backend-engineer' }), 'FORBIDDEN');
  });
});
