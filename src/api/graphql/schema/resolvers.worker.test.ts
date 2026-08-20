/**
 * #974 (re-cut) — the Worker model (spec cor:dmo:050:11, cor:agt:020:01/:02).
 *
 * A persona is universal DRESSING on an Agent (`personaRole` + the
 * `personaPrompt` template with {{name}}/{{role}} placeholders); the Worker is
 * the named casting of an installed agent into an App — the local identity
 * ("Iris") that does attributable work. `castWorker` mints nothing: it casts
 * an EXISTING installed agent under a name, allocating the name against the
 * `workers_app_name_uniq` constraint (the allocation primitive — advance past
 * WORKER_NAME_TAKEN in register mode). Workers retire (name reserved forever);
 * `deleteWorker` is the only removal escape, for a never-used miscast.
 *
 * The auth matrix is tested one case per PRINCIPAL SHAPE
 * (findings:auth-appid-credential-vs-selection): org admin, org contributor,
 * org reader, app member (non-org), app 'reader' member, non-member,
 * unauthenticated, pure App-key, hybrid user+selection, impersonation.
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
const W = (resolvers as any).Worker;

/** Minimal resolver Context for a given principal shape. */
function ctx(userId?: string, appId?: string): Context {
  return { db, userId, appId, roles: ['READER'] };
}

/** Assert a rejection carrying the given extensions.code. */
async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

/** The role-agent's persona dressing — bound per-worker at read time. */
const TEMPLATE =
  'You are {{name}}, a {{role}} on this team.\nWork from your own memories.';

let org: { id: string; urn: string };
let admin: { id: string };
let contrib: { id: string };
let orgReader: { id: string };
let appMember: { id: string };
let appReader: { id: string };
let outsider: { id: string };
/** The Team Agent — carries ONLY the cast-list register (roles: branch). */
let teamAgent: { id: string; urn: string; systemMemoryId: string };
/** The role-agent — carries ONLY the persona dressing (personaRole/Prompt). */
let roleAgent: { id: string; urn: string; systemMemoryId: string };
let app: { id: string; urn: string };

/** Create a roles:<role> cast-list node in a system memory. Only data.names
 *  is read by castWorker — content is deliberately noise to prove that. */
async function createRoleNode(
  memoryId: string,
  role: string,
  opts: { names?: unknown } = {},
) {
  return db.node.create({
    data: {
      id: generateId(),
      memoryId,
      loc: `roles:${role}`,
      name: role,
      content: 'legacy prompt template — must NOT be read by castWorker',
      data:
        opts.names === undefined
          ? { names: ['Iris', 'Henry', 'Ada'] }
          : ({ names: opts.names } as any),
    },
  });
}

/** Shorthand: cast through the mutation as the given principal. */
async function cast(args: Record<string, unknown>, c: Context = ctx(admin.id)) {
  return M.castWorker({}, { appRef: app.id, ...args }, c);
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'worker-org', urn: `worker-org-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 97401, githubUsername: `wk-admin-${suffix}`, roles: ['READER'] },
  });
  contrib = await db.user.create({
    data: { id: generateId(), githubId: 97402, githubUsername: `wk-contrib-${suffix}`, roles: ['READER'] },
  });
  orgReader = await db.user.create({
    data: { id: generateId(), githubId: 97406, githubUsername: `wk-orgreader-${suffix}`, roles: ['READER'] },
  });
  appMember = await db.user.create({
    data: { id: generateId(), githubId: 97403, githubUsername: `wk-member-${suffix}`, roles: ['READER'] },
  });
  appReader = await db.user.create({
    data: { id: generateId(), githubId: 97404, githubUsername: `wk-reader-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 97405, githubUsername: `wk-outsider-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: contrib.id, role: 'CONTRIBUTOR' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: orgReader.id, role: 'READER' },
  });

  // The Team Agent — created through the real mutation so it owns a real
  // system memory; the cast-list register lives as CONTENT there
  // (cor:agt:020:01 — cast lists are ergonomics, never gates).
  const team = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgent = { id: team.id, urn: team.urn, systemMemoryId: team.systemMemoryId };
  await createRoleNode(teamAgent.systemMemoryId, 'backend-engineer');

  // The role-agent — the persona dressing lives HERE (#974): personaRole is
  // the role-resolution key, personaPrompt the {{name}}/{{role}} template.
  const role = await M.createAgent(
    {},
    {
      orgId: org.id,
      name: 'Backend Engineer',
      personaRole: 'backend-engineer',
      personaPrompt: TEMPLATE,
    },
    ctx(admin.id),
  );
  roleAgent = { id: role.id, urn: role.urn, systemMemoryId: role.systemMemoryId };

  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: roleAgent.id } });

  // App members who are NOT org members — the everyday-flow principals.
  await db.appMember.create({ data: { appId: app.id, userId: appMember.id, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: appReader.id, role: 'reader' } });
});

describe('castWorker — happy path', () => {
  it('explicit agent + name: creates the row, defaults the role, provisions the memory', async () => {
    const worker = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    expect(worker.name).toBe('Zoe');
    expect(worker.appId).toBe(app.id);
    expect(worker.agentId).toBe(roleAgent.id);
    // Role defaults from the agent's personaRole dressing.
    expect(worker.role).toBe('backend-engineer');
    expect(worker.promptOverride).toBeNull();
    expect(worker.retiredAt).toBeNull();
    expect(worker.createdBy).toBe(admin.id);
    // Working memory provisioned at cast: app-class, in the App's container,
    // owner follows the App (org XOR ownerUserId), flat slug (the #723 rule).
    expect(worker.memoryId).toBeTruthy();
    const memory = await db.memory.findUniqueOrThrow({ where: { id: worker.memoryId } });
    expect(memory.class).toBe('app');
    expect(memory.appId).toBe(app.id);
    expect(memory.organizationId).toBe(org.id);
    expect(memory.ownerUserId).toBeNull();
    expect(memory.visibility).toBeNull();
    expect(memory.urn).toBe(`${org.urn}:team-zoe`);
  });

  it('accepts the App URN as appRef (cor:api:140)', async () => {
    const worker = await M.castWorker(
      {},
      { appRef: app.urn, agentRef: roleAgent.id, name: 'Zoe' },
      ctx(admin.id),
    );
    expect(worker.name).toBe('Zoe');
    expect(worker.appId).toBe(app.id);
  });

  it('an explicit role wins over the agent personaRole', async () => {
    const worker = await cast({ agentRef: roleAgent.id, role: 'debugger', name: 'Zoe' });
    expect(worker.role).toBe('debugger');
  });

  it('stores a promptOverride verbatim', async () => {
    const worker = await cast({
      agentRef: roleAgent.id,
      name: 'Zoe',
      promptOverride: 'Prefer boring solutions.',
    });
    expect(worker.promptOverride).toBe('Prefer boring solutions.');
  });

  it('a blank caller-supplied name is absent (cor:agt:020:02) — register allocates', async () => {
    const worker = await cast({ role: 'backend-engineer', name: '   ' });
    expect(worker.name).toBe('Iris');
  });

  it('multiple castings of ONE agent in one App are legal — Iris and Henry, same agent', async () => {
    const a = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const b = await cast({ agentRef: roleAgent.id, name: 'Henry' });
    expect(a.agentId).toBe(roleAgent.id);
    expect(b.agentId).toBe(roleAgent.id);
    expect(await db.worker.count({ where: { appId: app.id, agentId: roleAgent.id } })).toBe(2);
  });
});

describe('castWorker — agent resolution', () => {
  it('role picks the single installed agent whose personaRole matches', async () => {
    const worker = await cast({ role: 'backend-engineer', name: 'Zoe' });
    expect(worker.agentId).toBe(roleAgent.id);
  });

  it('the personaRole match is case-insensitive', async () => {
    const worker = await cast({ role: 'Backend-Engineer', name: 'Zoe' });
    expect(worker.agentId).toBe(roleAgent.id);
    // The casting's role keeps the caller's (normalized-by-trim) spelling.
    expect(worker.role).toBe('Backend-Engineer');
  });

  it('no installed agent carries the personaRole → WORKER_AGENT_NOT_FOUND', async () => {
    await expectCode(cast({ role: 'astronaut', name: 'Zoe' }), 'WORKER_AGENT_NOT_FOUND');
  });

  it('two installed agents with the personaRole → WORKER_AGENT_AMBIGUOUS; agentRef resolves it', async () => {
    const second = await M.createAgent(
      {},
      { orgId: org.id, name: 'Backend Two', personaRole: 'backend-engineer' },
      ctx(admin.id),
    );
    await db.appAgent.create({ data: { appId: app.id, agentId: second.id } });
    await expectCode(cast({ role: 'backend-engineer', name: 'Zoe' }), 'WORKER_AGENT_AMBIGUOUS');
    const worker = await cast({ role: 'backend-engineer', agentRef: second.id, name: 'Zoe' });
    expect(worker.agentId).toBe(second.id);
  });

  it('a soft-deleted agent no longer resolves by role', async () => {
    await db.agent.update({ where: { id: roleAgent.id }, data: { deletedAt: new Date() } });
    await expectCode(cast({ role: 'backend-engineer', name: 'Zoe' }), 'WORKER_AGENT_NOT_FOUND');
  });

  it('agentRef naming an agent NOT installed here → WORKER_AGENT_NOT_INSTALLED', async () => {
    const foreign = await M.createAgent({}, { orgId: org.id, name: 'Uninstalled' }, ctx(admin.id));
    await expectCode(cast({ agentRef: foreign.id, name: 'Zoe' }), 'WORKER_AGENT_NOT_INSTALLED');
  });

  it('agentRef naming a soft-deleted installed agent refuses (ref resolution excludes tombstones)', async () => {
    // resolveAgentRef excludes soft-deleted rows by default, so the explicit
    // ref fails BEFORE the install check — translated to the typed
    // BAD_USER_INPUT (matching startSession's agentRef handling), and the
    // tombstone never casts either way.
    await db.agent.update({ where: { id: roleAgent.id }, data: { deletedAt: new Date() } });
    await expectCode(cast({ agentRef: roleAgent.id, name: 'Zoe' }), 'BAD_USER_INPUT');
    expect(await db.worker.count({ where: { appId: app.id } })).toBe(0);
  });

  it('neither agentRef nor role → BAD_USER_INPUT', async () => {
    await expectCode(cast({ name: 'Zoe' }), 'BAD_USER_INPUT');
  });

  it('agentRef without role, name, or a personaRole to default from → BAD_USER_INPUT', async () => {
    // The team agent carries no persona dressing: nothing names a register.
    await expectCode(cast({ agentRef: teamAgent.id }), 'BAD_USER_INPUT');
  });

  it('a multi-atom role is rejected before touching anything', async () => {
    await expectCode(cast({ role: 'roles:sneaky', name: 'Zoe' }), 'BAD_USER_INPUT');
  });
});

describe('castWorker — name allocation (the register)', () => {
  it('allocates first-to-last, advancing past taken names (WORKER_NAME_TAKEN retry contract)', async () => {
    const first = await cast({ role: 'backend-engineer' });
    const second = await cast({ role: 'backend-engineer' });
    expect(first.name).toBe('Iris');
    expect(second.name).toBe('Henry');
  });

  it('two RACING casts get different names — the unique constraint is the primitive', async () => {
    const [a, b] = await Promise.all([
      cast({ role: 'backend-engineer' }),
      cast({ role: 'backend-engineer' }),
    ]);
    expect(a.name).not.toBe(b.name);
    expect(['Iris', 'Henry']).toContain(a.name);
    expect(['Iris', 'Henry']).toContain(b.name);
  });

  it('register names are case-insensitively reserved — "iris" taken blocks "Iris"', async () => {
    await cast({ agentRef: roleAgent.id, name: 'iris' });
    const next = await cast({ role: 'backend-engineer' });
    expect(next.name).toBe('Henry');
  });

  it('a caller-supplied taken name is the typed WORKER_NAME_TAKEN — no silent retry', async () => {
    await cast({ agentRef: roleAgent.id, name: 'Iris' });
    await expectCode(cast({ agentRef: roleAgent.id, name: 'Iris' }), 'WORKER_NAME_TAKEN');
  });

  it('the explicit-name reservation is case-insensitive — "IRIS" collides with "Iris"', async () => {
    await cast({ agentRef: roleAgent.id, name: 'Iris' });
    await expectCode(cast({ agentRef: roleAgent.id, name: 'IRIS' }), 'WORKER_NAME_TAKEN');
  });

  it('names that share a lossy @mention slug are BOTH castable — one uniqueness layer only', async () => {
    // "Mary Jane" and "Mary-Jane" both slug to @mary-jane. That collision is
    // accepted by decision (Holger, 2026-08-14, reversing a PR #978 review
    // suggestion): cor:agt:020:02 keeps the case-insensitive NAME as the only
    // uniqueness layer, and a shared mention address — inherent to the shipped
    // one-format mention contract, and identical under the old persona model —
    // simply reaches both workers.
    const mj = await cast({ agentRef: roleAgent.id, name: 'Mary Jane' });
    const mj2 = await cast({ agentRef: roleAgent.id, name: 'Mary-Jane' });
    expect(mj.name).toBe('Mary Jane');
    expect(mj2.name).toBe('Mary-Jane');
    expect(mj.id).not.toBe(mj2.id);
  });

  it('a RETIRED worker keeps its name reserved forever (cor:agt:020:02)', async () => {
    const iris = await cast({ role: 'backend-engineer' });
    expect(iris.name).toBe('Iris');
    await M.retireWorker({}, { workerRef: iris.id }, ctx(admin.id));
    // The register must NOT recycle "Iris" — history references her.
    const next = await cast({ role: 'backend-engineer' });
    expect(next.name).toBe('Henry');
    // An explicit re-cast of the retired name is the typed refusal.
    await expectCode(cast({ agentRef: roleAgent.id, name: 'Iris' }), 'WORKER_NAME_TAKEN');
  });

  it('register exhausted → WORKER_REGISTER_EXHAUSTED', async () => {
    for (const _ of [1, 2, 3]) {
      await cast({ role: 'backend-engineer' });
    }
    await expectCode(cast({ role: 'backend-engineer' }), 'WORKER_REGISTER_EXHAUSTED');
  });

  it('empty register + no explicit name → WORKER_REGISTER_EXHAUSTED', async () => {
    await createRoleNode(teamAgent.systemMemoryId, 'qa', { names: [] });
    // Explicit agentRef + role: the register lookup uses the explicit role.
    await expectCode(cast({ agentRef: roleAgent.id, role: 'qa' }), 'WORKER_REGISTER_EXHAUSTED');
  });

  it('a case-insensitive register duplicate keeps the FIRST spelling', async () => {
    await createRoleNode(teamAgent.systemMemoryId, 'writer', { names: ['Ana', 'ANA', 'Ben'] });
    const first = await cast({ agentRef: roleAgent.id, role: 'writer' });
    const second = await cast({ agentRef: roleAgent.id, role: 'writer' });
    expect(first.name).toBe('Ana');
    expect(second.name).toBe('Ben');
  });

  it('a role with no roles:<role> node → WORKER_ROLE_NOT_FOUND listing available roles', async () => {
    try {
      await cast({ agentRef: roleAgent.id, role: 'astronaut' });
      expect.fail('expected WORKER_ROLE_NOT_FOUND');
    } catch (e) {
      expect((e as GraphQLError).extensions?.code).toBe('WORKER_ROLE_NOT_FOUND');
      expect((e as GraphQLError).extensions?.availableRoles).toEqual(['backend-engineer']);
    }
  });
});

describe('castWorker — Team Agent location', () => {
  it('no installed agent carries a roles: branch → TEAM_AGENT_NOT_FOUND', async () => {
    await db.node.deleteMany({ where: { memoryId: teamAgent.systemMemoryId } });
    await expectCode(cast({ role: 'backend-engineer' }), 'TEAM_AGENT_NOT_FOUND');
  });

  it('two installed agents with roles: branches → TEAM_AGENT_AMBIGUOUS; teamAgentRef resolves it', async () => {
    // Give the role-agent's system memory a roles: branch too.
    await createRoleNode(roleAgent.systemMemoryId, 'designer');
    await expectCode(cast({ role: 'backend-engineer' }), 'TEAM_AGENT_AMBIGUOUS');
    const worker = await cast({ role: 'backend-engineer', teamAgentRef: teamAgent.id });
    expect(worker.name).toBe('Iris');
  });

  it('teamAgentRef naming an agent NOT installed here → TEAM_AGENT_NOT_INSTALLED', async () => {
    const foreign = await M.createAgent({}, { orgId: org.id, name: 'Foreign Team' }, ctx(admin.id));
    await createRoleNode(foreign.systemMemoryId, 'backend-engineer');
    await expectCode(
      cast({ role: 'backend-engineer', teamAgentRef: foreign.id }),
      'TEAM_AGENT_NOT_INSTALLED',
    );
  });

  it('an encrypted system memory without a session key refuses with the typed SESSION_EXPIRED', async () => {
    // The register lives in `data`, which is ciphertext under spec 041.
    await db.memory.update({
      where: { id: teamAgent.systemMemoryId },
      data: { isEncrypted: true },
    });
    await expectCode(cast({ role: 'backend-engineer' }), 'SESSION_EXPIRED');
  });

  it('an explicit name never touches the register — encryption does not block it', async () => {
    await db.memory.update({
      where: { id: teamAgent.systemMemoryId },
      data: { isEncrypted: true },
    });
    const worker = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    expect(worker.name).toBe('Zoe');
  });

  it('uninstalled App → APP_UNINSTALLED', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expectCode(cast({ agentRef: roleAgent.id, name: 'Zoe' }), 'APP_UNINSTALLED');
  });
});

describe('castWorker — auth matrix (one case per principal shape)', () => {
  const args = () => ({ agentRef: roleAgent.id, name: 'Zoe' });

  it('org ADMIN may cast', async () => {
    expect((await cast(args(), ctx(admin.id))).name).toBe('Zoe');
  });

  it('org CONTRIBUTOR may cast', async () => {
    expect((await cast(args(), ctx(contrib.id))).name).toBe('Zoe');
  });

  it('an org READER (member, but below CONTRIBUTOR) is denied', async () => {
    await expectCode(cast(args(), ctx(orgReader.id)), 'FORBIDDEN');
  });

  it('an AppMember who is NOT an org member may cast (the everyday flow)', async () => {
    expect((await cast(args(), ctx(appMember.id))).name).toBe('Zoe');
  });

  it("an AppMember with role 'reader' is denied", async () => {
    await expectCode(cast(args(), ctx(appReader.id)), 'FORBIDDEN');
  });

  it('a non-member is denied', async () => {
    await expectCode(cast(args(), ctx(outsider.id)), 'FORBIDDEN');
  });

  it('an unauthenticated caller is denied', async () => {
    await expectCode(cast(args(), ctx(undefined)), 'FORBIDDEN');
  });

  it('a PURE App-key principal is denied — staffing is a human act', async () => {
    await expectCode(cast(args(), ctx(undefined, app.id)), 'FORBIDDEN');
  });

  it("a HYBRID user+selection principal is judged on the USER's rights", async () => {
    // findings:auth-appid-credential-vs-selection — appReader carries the App
    // as their active-App selection, and must still be denied.
    await expectCode(cast(args(), ctx(appReader.id, app.id)), 'FORBIDDEN');
  });

  it('an impersonation session never staffs — support views are read-only', async () => {
    const imp: Context = {
      db,
      userId: admin.id,
      roles: [],
      impersonation: { orgId: org.id } as any,
    };
    await expectCode(cast(args(), imp), 'FORBIDDEN');
  });

  it('a revoked org membership does not authorize', async () => {
    await db.orgMember.updateMany({
      where: { organizationId: org.id, userId: contrib.id },
      data: { deletedAt: new Date() },
    });
    await expectCode(cast(args(), ctx(contrib.id)), 'FORBIDDEN');
  });
});

describe('castWorker — user-owned App (spec 047)', () => {
  let owner: { id: string; handle: string };
  let personalApp: { id: string };
  let personalAgent: { id: string };

  beforeEach(async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    owner = await db.user.create({
      data: { id: generateId(), name: 'Owner', handle: `wk-owner-${suffix}`, roles: ['READER'] },
    });
    const agent = await M.createAgent(
      {},
      { name: 'My Engineer', personaRole: 'backend-engineer', personaPrompt: TEMPLATE },
      ctx(owner.id),
    );
    personalAgent = { id: agent.id };
    personalApp = await db.app.create({
      data: { id: generateId(), ownerUserId: owner.id, name: 'My Team App', urn: `${owner.handle}:team` },
    });
    await db.appAgent.create({ data: { appId: personalApp.id, agentId: personalAgent.id } });
  });

  it('the owner casts; the working memory follows the App owner (owner XOR)', async () => {
    const worker = await M.castWorker(
      {},
      { appRef: personalApp.id, agentRef: personalAgent.id, name: 'Zoe' },
      ctx(owner.id),
    );
    expect(worker.name).toBe('Zoe');
    const memory = await db.memory.findUniqueOrThrow({ where: { id: worker.memoryId } });
    expect(memory.ownerUserId).toBe(owner.id);
    expect(memory.organizationId).toBeNull();
    expect(memory.urn).toBe(`${owner.handle}:team-zoe`);
  });

  it('anyone else — including a platform admin — is denied (strict owner-only)', async () => {
    await expectCode(
      M.castWorker({}, { appRef: personalApp.id, agentRef: personalAgent.id, name: 'Zoe' }, ctx(outsider.id)),
      'FORBIDDEN',
    );
    const platformAdmin: Context = { db, userId: outsider.id, roles: ['ADMIN'] };
    await expectCode(
      M.castWorker({}, { appRef: personalApp.id, agentRef: personalAgent.id, name: 'Zoe' }, platformAdmin),
      'FORBIDDEN',
    );
  });
});

describe('retireWorker', () => {
  it('stamps retiredAt/retiredBy and is idempotent — the second call returns unchanged', async () => {
    const worker = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    const retired = await M.retireWorker({}, { workerRef: worker.id }, ctx(admin.id));
    expect(retired.retiredAt).toBeInstanceOf(Date);
    expect(retired.retiredBy).toBe(admin.id);
    // Idempotent: the guarded claim (retiredAt: null) never re-stamps.
    const again = await M.retireWorker({}, { workerRef: worker.id }, ctx(contrib.id));
    expect(again.retiredAt?.getTime()).toBe(retired.retiredAt?.getTime());
    expect(again.retiredBy).toBe(admin.id);
  });

  it('the name stays reserved for castWorker after retirement', async () => {
    const worker = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    await M.retireWorker({}, { workerRef: worker.id }, ctx(admin.id));
    await expectCode(cast({ agentRef: roleAgent.id, name: 'Zoe' }), 'WORKER_NAME_TAKEN');
  });

  it("uses the staffing gate — an AppMember with role 'reader' is denied", async () => {
    const worker = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    await expectCode(M.retireWorker({}, { workerRef: worker.id }, ctx(appReader.id)), 'FORBIDDEN');
  });

  it('unknown workerRef → WORKER_NOT_FOUND', async () => {
    await expectCode(M.retireWorker({}, { workerRef: 'nope' }, ctx(admin.id)), 'WORKER_NOT_FOUND');
  });
});

describe('deleteWorker — the never-used-miscast escape', () => {
  it('removes the worker AND its empty working memory, freeing the name', async () => {
    const worker = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    expect(worker.memoryId).toBeTruthy();
    const ok = await M.deleteWorker({}, { workerRef: worker.id }, ctx(admin.id));
    expect(ok).toBe(true);
    expect(await db.worker.findUnique({ where: { id: worker.id } })).toBeNull();
    expect(await db.memory.findUnique({ where: { id: worker.memoryId } })).toBeNull();
    // A true hard delete — unlike retirement, the name is free again.
    const recast = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    expect(recast.name).toBe('Zoe');
  });

  it('any session EVER bound — ended included — refuses with WORKER_IN_USE', async () => {
    const worker = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    await db.session.create({
      data: { id: generateId(), appId: app.id, workerId: worker.id, endedAt: new Date() },
    });
    await expectCode(M.deleteWorker({}, { workerRef: worker.id }, ctx(admin.id)), 'WORKER_IN_USE');
    expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
  });

  it('a working memory holding a node refuses with WORKER_IN_USE', async () => {
    const worker = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    await db.node.create({
      data: { id: generateId(), memoryId: worker.memoryId!, loc: 'scratch', name: 'scratch' },
    });
    await expectCode(M.deleteWorker({}, { workerRef: worker.id }, ctx(admin.id)), 'WORKER_IN_USE');
    expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
    expect(await db.memory.findUnique({ where: { id: worker.memoryId } })).not.toBeNull();
  });

  it('unknown workerRef → WORKER_NOT_FOUND', async () => {
    await expectCode(M.deleteWorker({}, { workerRef: 'nope' }, ctx(admin.id)), 'WORKER_NOT_FOUND');
  });
});

describe('worker / workers queries', () => {
  let iris: { id: string };
  let henry: { id: string };

  beforeEach(async () => {
    iris = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    henry = await cast({ agentRef: roleAgent.id, name: 'Henry' });
  });

  it("worker(ref) admits an AppMember at ANY role — 'reader' included", async () => {
    const worker = await Q.worker({}, { ref: iris.id }, ctx(appReader.id));
    expect(worker.name).toBe('Iris');
  });

  it('worker(ref) denies a non-member', async () => {
    await expectCode(Q.worker({}, { ref: iris.id }, ctx(outsider.id)), 'FORBIDDEN');
  });

  it('a pure App-key reads its OWN App staff; a foreign App key is denied', async () => {
    const own = await Q.worker({}, { ref: iris.id }, ctx(undefined, app.id));
    expect(own.name).toBe('Iris');
    const foreignApp = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` },
    });
    await expectCode(Q.worker({}, { ref: iris.id }, ctx(undefined, foreignApp.id)), 'FORBIDDEN');
  });

  it("impersonation reads are bounded to the support session's org (#876 class)", async () => {
    const impSame: Context = {
      db,
      userId: contrib.id,
      roles: [],
      impersonation: { orgId: org.id } as any,
    };
    const worker = await Q.worker({}, { ref: iris.id }, impSame);
    expect(worker.name).toBe('Iris');
    const impOther: Context = {
      db,
      userId: contrib.id,
      roles: [],
      impersonation: { orgId: 'some-other-org' } as any,
    };
    await expectCode(Q.worker({}, { ref: iris.id }, impOther), 'FORBIDDEN');
  });

  it('unknown ref → WORKER_NOT_FOUND', async () => {
    await expectCode(Q.worker({}, { ref: 'nope' }, ctx(admin.id)), 'WORKER_NOT_FOUND');
  });

  it('workers returns {items, total}, oldest-first', async () => {
    const page = await Q.workers({}, { appRef: app.id }, ctx(admin.id));
    expect(page.total).toBe(2);
    expect(page.items.map((w: { name: string }) => w.name)).toEqual(['Iris', 'Henry']);
  });

  it('retired castings are hidden unless includeRetired', async () => {
    await M.retireWorker({}, { workerRef: iris.id }, ctx(admin.id));
    const active = await Q.workers({}, { appRef: app.id }, ctx(admin.id));
    expect(active.total).toBe(1);
    expect(active.items[0].name).toBe('Henry');
    const all = await Q.workers({}, { appRef: app.id, includeRetired: true }, ctx(admin.id));
    expect(all.total).toBe(2);
    expect(all.items.map((w: { name: string }) => w.name)).toEqual(['Iris', 'Henry']);
  });

  it('limit/offset paginate; total stays the full count (cor:api:120:02)', async () => {
    const page = await Q.workers({}, { appRef: app.id, limit: 1, offset: 1 }, ctx(admin.id));
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].name).toBe('Henry');
  });

  it('workers denies a non-member', async () => {
    await expectCode(Q.workers({}, { appRef: app.id }, ctx(outsider.id)), 'FORBIDDEN');
  });
});

describe('Worker field resolvers', () => {
  it('agent and app resolve the casting endpoints', async () => {
    const worker = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    const agent = await W.agent(worker, {}, ctx(admin.id));
    expect(agent?.id).toBe(roleAgent.id);
    const resolvedApp = await W.app(worker, {}, ctx(admin.id));
    expect(resolvedApp?.id).toBe(app.id);
  });

  it('prompt binds {{name}}/{{role}} and appends the override as its own paragraph', async () => {
    const worker = await cast({
      agentRef: roleAgent.id,
      name: 'Zoe',
      promptOverride: 'Prefer boring solutions.',
    });
    const prompt = await W.prompt(worker, {}, ctx(admin.id));
    expect(prompt).toBe(
      'You are Zoe, a backend-engineer on this team.\nWork from your own memories.\n\nPrefer boring solutions.',
    );
  });

  it('prompt binds the CASTING role when it differs from the agent personaRole', async () => {
    const worker = await cast({ agentRef: roleAgent.id, role: 'debugger', name: 'Zoe' });
    const prompt = await W.prompt(worker, {}, ctx(admin.id));
    expect(prompt).toContain('You are Zoe, a debugger on this team.');
  });

  it('override-only when the agent carries no template', async () => {
    // The team agent has no personaPrompt dressing.
    const worker = await cast({
      agentRef: teamAgent.id,
      role: 'coordinator',
      name: 'Zoe',
      promptOverride: 'Coordinate the team.',
    });
    const prompt = await W.prompt(worker, {}, ctx(admin.id));
    expect(prompt).toBe('Coordinate the team.');
  });

  it('null when the agent carries no template and the worker no override', async () => {
    const worker = await cast({ agentRef: teamAgent.id, role: 'coordinator', name: 'Zoe' });
    const prompt = await W.prompt(worker, {}, ctx(admin.id));
    expect(prompt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #1050 — a NAME is held by a person until released
// ---------------------------------------------------------------------------

/**
 * Availability used to be derived from session liveness, which conflated two
 * unrelated questions behind one word (hadron-cli#487): "is this name
 * someone's?" and "is a session live right now?". The second is a timer — so
 * expiry, a reap, or a closed chat session silently freed a name, and an agent
 * following the documented procedure ended a mid-PR driver's session and bound
 * as them (hadron-cli#492).
 *
 * Holding replaces a judgement that cannot be made correctly with a fact.
 */
describe('#1050 — worker name holding', () => {
  const bind = (userId: string, workerId: string, force = false) =>
    M.startSession(
      {}, { input: { id: generateId(), workerRef: workerId, appRef: app.id, force } }, ctx(userId),
    );

  /** Cast a worker and have `userId` claim it by binding — the real sequence. */
  async function heldBy(userId: string, name = 'Iris') {
    const w = await cast({ agentRef: roleAgent.id, name }, ctx(admin.id));
    const s = await bind(userId, w.id);
    await M.endSession({}, { id: s.id }, ctx(userId));
    return w;
  }

  it('casting does NOT hold — a coordinator may staff a roster others claim', async () => {
    // The canonical setup flow is one person casting the team's names and
    // other people binding them. If the caster held, every one of them would
    // be blocked on a release they should never have needed.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' }, ctx(admin.id));
    const row = await db.worker.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.heldByUserId).toBeNull();
    expect(row.heldAt).toBeNull();
  });

  it('binding an UNHELD worker holds it — that is the claim path', async () => {
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' }, ctx(admin.id));
    await bind(appMember.id, w.id);
    const row = await db.worker.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.heldByUserId).toBe(appMember.id);
  });

  it("refuses a name held by someone else — and force does NOT bypass it", async () => {
    // The incident: every step of the documented procedure was followed, and
    // the remedy it advertised was --force. Under holding there is no remedy
    // but casting your own worker, which is the point.
    const w = await heldBy(contrib.id);

    await expectCode(bind(appMember.id, w.id), 'WORKER_HELD');
    await expectCode(bind(appMember.id, w.id, true), 'WORKER_HELD');

    // The refused binds created nothing — only the holder's own claim session
    // exists — and the hold did not move.
    expect(await db.session.count({ where: { workerId: w.id } })).toBe(1);
    expect(await db.session.count({ where: { workerId: w.id, userId: appMember.id } })).toBe(0);
    const row = await db.worker.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.heldByUserId).toBe(contrib.id);
  });

  it('the refusal names the holder, so the caller knows who to ask', async () => {
    const w = await heldBy(contrib.id);
    try {
      await bind(appMember.id, w.id);
      expect.fail('expected WORKER_HELD');
    } catch (e) {
      const err = e as GraphQLError;
      expect(err.extensions?.heldBy).toBe(contrib.id);
      expect(err.message).toMatch(/cast your own worker/);
    }
  });

  it('ENDING the session does not free the name — the core of the fix', async () => {
    // The old model: availability was a timer. A reap, an expiry, or a closed
    // chat session made a name look free while its holder was mid-PR.
    const w = await heldBy(contrib.id);
    const s = await bind(contrib.id, w.id);
    await M.endSession({}, { id: s.id }, ctx(contrib.id));

    // Reaped, for good measure — the #930 reaper stamps both columns.
    const now = new Date();
    await db.session.updateMany({
      where: { id: s.id }, data: { endedAt: now, autoExpiredAt: now },
    });

    const row = await db.worker.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.heldByUserId).toBe(contrib.id);
    await expectCode(bind(appMember.id, w.id), 'WORKER_HELD');
  });

  it('your OWN held worker still refuses WORKER_TAKEN on a live session, and force still works', async () => {
    // The two gates stay distinct: HELD is whose name it is, TAKEN is whether
    // a session is live — and the second is forceable because the driver
    // deciding is the driver affected.
    const w = await heldBy(contrib.id);
    await bind(contrib.id, w.id);
    await expectCode(bind(contrib.id, w.id), 'WORKER_TAKEN');
    const forced = await bind(contrib.id, w.id, true);
    expect(forced.workerId).toBe(w.id);
  });

  it('the holder can release, and the next binder holds it', async () => {
    const w = await heldBy(contrib.id);
    await M.releaseWorker({}, { workerRef: w.id }, ctx(contrib.id));

    const released = await db.worker.findUniqueOrThrow({ where: { id: w.id } });
    expect(released.heldByUserId).toBeNull();
    expect(released.heldAt).toBeNull();
    // Not retired, and the name is still this casting's.
    expect(released.retiredAt).toBeNull();
    expect(released.name).toBe('Iris');

    await bind(appMember.id, w.id);
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId)
      .toBe(appMember.id);
  });

  it('a non-holder who is not staff cannot release', async () => {
    const w = await heldBy(contrib.id);
    await expectCode(M.releaseWorker({}, { workerRef: w.id }, ctx(appMember.id)), 'FORBIDDEN');
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId)
      .toBe(contrib.id);
  });

  it('an ADMIN force-release works and POSTS TO THE TEAM CHAT', async () => {
    // hadron-cli#492 is exactly the case where notice was owed and there was
    // no way to give it. A silent override would rebuild that.
    const w = await heldBy(contrib.id);
    await M.releaseWorker({}, { workerRef: w.id }, ctx(admin.id));

    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId).toBeNull();

    const page = await Q.teamChatMessages({}, { appRef: app.id }, ctx(admin.id));
    expect(page.total).toBe(1);
    expect(page.items[0].body).toContain('Iris');
    expect(page.items[0].body).toMatch(/released/i);
  });

  it('a holder releasing their OWN name posts nothing — no notice is owed', async () => {
    const w = await heldBy(contrib.id);
    await M.releaseWorker({}, { workerRef: w.id }, ctx(contrib.id));
    const page = await Q.teamChatMessages({}, { appRef: app.id }, ctx(contrib.id));
    expect(page.total).toBe(0);
  });

  it('an APP KEY cannot bind a held name either — a hold refuses every non-holder', async () => {
    // PR #1052 review, Codex + Copilot P1. The gate was written
    // `heldByUserId && ctx.userId && heldByUserId !== ctx.userId`, so a pure
    // App-key principal — whose ctx.userId is undefined — sailed past it and
    // could open a session as a name held by a human, forceable or not.
    const w = await heldBy(contrib.id);
    const keyCtx = { db, appId: app.id, roles: [] } as unknown as Context;
    for (const force of [false, true]) {
      await expectCode(
        M.startSession(
          {}, { input: { id: generateId(), workerRef: w.id, force } }, keyCtx,
        ),
        'WORKER_HELD',
      );
    }
    expect(await db.session.count({ where: { workerId: w.id, userId: null } })).toBe(0);
  });

  it('the LOSER of a concurrent claim is refused, not silently attributed', async () => {
    // Both callers read heldByUserId: null and clear the liveness check; the
    // compare-and-set decides which actually took the name. Ignoring its result
    // let the loser open a session as a name someone else now holds — the exact
    // attribution problem the hold exists to prevent.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' }, ctx(admin.id));

    // Simulate losing: the claim's updateMany finds the row already taken.
    const spy = vi
      .spyOn(db.worker, 'updateMany')
      .mockImplementationOnce((async () => {
        await db.worker.update({
          where: { id: w.id },
          data: { heldByUserId: contrib.id, heldAt: new Date() },
        });
        return { count: 0 };
      }) as never);
    try {
      await expectCode(bind(appMember.id, w.id), 'WORKER_HELD');
    } finally {
      spy.mockRestore();
    }

    // The winner holds it, and the loser has no session.
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId)
      .toBe(contrib.id);
    expect(await db.session.count({ where: { workerId: w.id, userId: appMember.id } })).toBe(0);
  });

  it('releaseWorker is not a read surface for workers you may not see', async () => {
    // The idempotent "already unheld" return sat ABOVE every access check, so a
    // caller holding an id or URN could confirm a foreign worker exists and
    // collect its scalars through a mutation, while Query.worker would refuse
    // them. A shortcut placed above an authorization check is an authorization
    // hole whatever the shortcut is for.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' }, ctx(admin.id));
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId).toBeNull();
    await expectCode(M.releaseWorker({}, { workerRef: w.id }, ctx(outsider.id)), 'FORBIDDEN');
  });

  it('releasing an unheld worker is idempotent, not an error', async () => {
    const w = await heldBy(contrib.id);
    await M.releaseWorker({}, { workerRef: w.id }, ctx(contrib.id));
    const again = await M.releaseWorker({}, { workerRef: w.id }, ctx(contrib.id));
    expect(again.heldByUserId).toBeNull();
  });
});
