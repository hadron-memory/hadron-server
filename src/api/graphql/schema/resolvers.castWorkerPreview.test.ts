import { buildSchema, type GraphQLObjectType } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
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
import { workerSlugBase } from '../../../lib/workerSlug.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';

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
  // #1050: a LEGACY role node that still carries data.names. Kept in the
  // fixture on purpose — the register is gone, and the proof that it is gone is
  // that a node still holding one changes nothing about a cast or a preview.
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
    },
    ctx(admin.id),
  );
  roleAgent = { id: role.id };
  await serveAgentBootPrompt(db, role.id, 'You are {{name}}, a {{role}}.');

  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'CWP Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: roleAgent.id } });
});

const preview = (c: Context, args: Record<string, unknown> = {}) =>
  Q.castWorkerPreview({}, { appRef: app.id, ...args }, c);

describe('#964 — castWorkerPreview', () => {
  it('a nameless preview REFUSES — there is no register to allocate from (#1050)', async () => {
    // The register used to answer this call. Its removal makes a name the
    // caller's to supply, and the preview must refuse exactly where the cast
    // does, since answering "what would the cast do" is its whole contract.
    await expectCode(preview(ctx(admin.id), { role: 'backend-engineer' }), 'WORKER_NAME_REQUIRED');
  });

  it('a legacy data.names register on the role node is INERT — it allocates nothing', async () => {
    // The fixture's role node still lists Fred/Gwen/Hans. Before #1050 this
    // preview returned "Fred"; now the names are historical data nobody reads.
    // Left in place rather than migrated away: the list records what was once
    // allocated to the role, and erasing it would destroy provenance to tidy a
    // field with no reader.
    const node = await db.node.findFirstOrThrow({
      where: { memoryId: teamAgent.systemMemoryId, loc: 'roles:backend-engineer' },
    });
    expect((node.data as { names?: string[] }).names).toEqual(['Fred', 'Gwen', 'Hans']);
    await expectCode(preview(ctx(admin.id), { role: 'backend-engineer' }), 'WORKER_NAME_REQUIRED');
  });

  it('the preview matches what the real cast then does — refusal included', async () => {
    // The parity that matters is not "same name" any more, it is same VERDICT.
    await expectCode(preview(ctx(admin.id), { role: 'backend-engineer' }), 'WORKER_NAME_REQUIRED');
    await expectCode(
      M.castWorker({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id)),
      'WORKER_NAME_REQUIRED',
    );
    // And with a name, both agree on it.
    const p = await preview(ctx(admin.id), { role: 'backend-engineer', name: 'Zara' });
    const worker = await M.castWorker(
      {}, { appRef: app.id, role: 'backend-engineer', name: 'Zara' }, ctx(admin.id),
    );
    expect(worker.name).toBe(p.name);
  });

  it('a previewed name is NOT reserved — someone else can take it first, by design', async () => {
    const p = await preview(ctx(admin.id), { role: 'backend-engineer', name: 'Fred' });
    expect(p.name).toBe('Fred');
    await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: roleAgent.id, name: 'Fred', slug: 'fred' } });
    // The preview held no lease, so the same call now refuses.
    await expectCode(
      preview(ctx(admin.id), { role: 'backend-engineer', name: 'Fred' }),
      'WORKER_NAME_TAKEN',
    );
  });

  it('explicit name: free previews the served prompt with the name bound; taken refuses WORKER_NAME_TAKEN (retired included)', async () => {
    const p = await preview(ctx(admin.id), {
      agentRef: roleAgent.id,
      name: 'Zoe',
    });
    expect(p.name).toBe('Zoe');
    expect(p.prompt).toBe('You are Zoe, a backend-engineer.');
    await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: roleAgent.id, name: 'zoe', slug: 'zoe', retiredAt: new Date() },
    });
    await expectCode(
      preview(ctx(admin.id), { agentRef: roleAgent.id, name: 'Zoe' }),
      'WORKER_NAME_TAKEN',
    );
  });

  it('binds {{worker.name}} in the preview prompt with the new variable set (#2049)', async () => {
    await serveAgentBootPrompt(db, roleAgent.id, 'You are {{worker.name}}, the {{worker.role}}.');
    const p = await preview(ctx(admin.id), { role: 'backend-engineer', name: 'Gwen' });
    expect(p.prompt).toBe('You are Gwen, the backend-engineer.');
    expect(p.hasNamePlaceholder).toBeNull();
  });

  it('the SDL keeps hasNamePlaceholder on TeamRole and CastWorkerPreview, deprecated (#2049)', () => {
    const schema = buildSchema(typeDefs.replace('#graphql', ''), { assumeValidSDL: true });
    for (const type of ['TeamRole', 'CastWorkerPreview']) {
      const field = (schema.getType(type) as GraphQLObjectType).getFields().hasNamePlaceholder;
      expect(field.deprecationReason).toMatch(/#2049/);
      expect(String(field.type)).toBe('Boolean');
    }
  });

  it('typed refusals behave identically to the cast (the point of a preview)', async () => {
    // Unknown role → the agent resolution refusal, not a silent guess.
    await expectCode(
      preview(ctx(admin.id), { role: 'no-such-role', name: 'Zed' }),
      'WORKER_AGENT_NOT_FOUND',
    );
    // A taken name — the refusal that replaced WORKER_REGISTER_EXHAUSTED as the
    // "you cannot have this one" answer, now that names are chosen not drawn.
    await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: roleAgent.id, name: 'Fred', slug: workerSlugBase('Fred') },
    });
    await expectCode(
      preview(ctx(admin.id), { role: 'backend-engineer', name: 'Fred' }),
      'WORKER_NAME_TAKEN',
    );
  });

  it('binds a template without a name token as written; hasNamePlaceholder is retired and null (#2049)', async () => {
    await serveAgentBootPrompt(db, roleAgent.id, 'You are a {{role}}.');
    const p = await preview(ctx(admin.id), { role: 'backend-engineer', name: 'Gwen' });
    expect(p.hasNamePlaceholder).toBeNull();
    expect(p.prompt).toBe('You are a backend-engineer.');
  });

  it('binds only the exact token: "{{ name }}" stays literal, and the retired field stays null (#985 review, #2049)', async () => {
    await serveAgentBootPrompt(db, roleAgent.id, 'You are {{ name }}, a {{role}}.');
    const p = await preview(ctx(admin.id), { role: 'backend-engineer', name: 'Gwen' });
    expect(p.hasNamePlaceholder).toBeNull();
    expect(p.prompt).toBe('You are {{ name }}, a backend-engineer.');
  });

  it('takes the MINT gate, not a read gate: outsiders and pure App-key principals are refused', async () => {
    await expectCode(preview(ctx(outsider.id), { role: 'backend-engineer', name: 'Gwen' }), 'FORBIDDEN');
    // Staffing is a human act — the pure App-key principal is denied for the
    // cast, so the preview matches.
    await expectCode(preview(ctx(undefined, app.id), { role: 'backend-engineer', name: 'Gwen' }), 'FORBIDDEN');
  });
});
