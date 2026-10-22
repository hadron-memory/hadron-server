import { Prisma } from '../../../generated/prisma/index.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #974 (re-cut) — the Worker model (spec cor:dmo:050:11, cor:agt:020:01/:02).
 *
 * A persona is universal DRESSING on an Agent (`personaRole` + the
 * `systemPrompt` template with {{name}}/{{role}} placeholders); the Worker is
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { waitForLockWaiters } from '../../../test/lockWait.js';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { deleteUserAccount } from '../../../controller/operations/deleteUser.js';
import { sessionActivityAt, loadLastEventBySession, isSessionLive } from '../../../lib/sessionActivity.js';
import { lockWorkerNames } from '../../../lib/workerName.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const W = (resolvers as any).Worker;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const F = resolvers as any; // payload field resolvers (#1073)

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
  // the role-resolution key, systemPrompt the {{name}}/{{role}} template.
  const role = await M.createAgent(
    {},
    {
      orgId: org.id,
      name: 'Backend Engineer',
      personaRole: 'backend-engineer',
      systemPrompt: TEMPLATE,
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

  it('a blank caller-supplied name counts as ABSENT and refuses (#1050)', async () => {
    // Whitespace was never a name (cor:agt:020:02). It used to fall through to
    // the register; with no register to fall through to, it is the same
    // refusal as passing nothing — which is the point: one rule, not two.
    await expectCode(cast({ role: 'backend-engineer', name: '   ' }), 'WORKER_NAME_REQUIRED');
  });

  it('multiple castings of ONE agent in one App are legal — Iris and Henry, same agent', async () => {
    const a = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const b = await cast({ agentRef: roleAgent.id, name: 'Henry' });
    expect(a.agentId).toBe(roleAgent.id);
    expect(b.agentId).toBe(roleAgent.id);
    expect(await db.worker.count({ where: { appId: app.id, agentId: roleAgent.id } })).toBe(2);
  });
});

describe('castWorker — confusable naming (#1677)', () => {
  it('preserves display spelling and refuses a confusable with the historical name', async () => {
    const existing = await cast({ agentRef: roleAgent.id, name: 'Ａlice' });
    expect(existing.name).toBe('Ａlice');
    await db.worker.update({ where: { id: existing.id }, data: { retiredAt: new Date() } });
    for (const operation of [M.castWorker, Q.castWorkerPreview]) {
      await expect(operation({}, { appRef: app.id, agentRef: roleAgent.id, name: 'Alice' }, ctx(admin.id)))
        .rejects.toMatchObject({ extensions: { code: 'WORKER_NAME_CONFUSABLE', collidingName: 'Ａlice', workerId: existing.id } });
    }
    expect(await db.worker.count({ where: { appId: app.id } })).toBe(1);
    await expectCode(cast({ agentRef: roleAgent.id, name: 'ＡLICE' }), 'WORKER_NAME_TAKEN');
  });

  it.each([
    ['mira', 'Μira'], // stored lowercase Latin, Greek capital Mu candidate
    ['Μira', 'mira'], // the reverse insertion order
  ])('refuses %s then %s across case variants of the reserved name', async (first, second) => {
    const existing = await cast({ agentRef: roleAgent.id, name: first });
    for (const operation of [M.castWorker, Q.castWorkerPreview]) {
      await expect(operation({}, { appRef: app.id, agentRef: roleAgent.id, name: second }, ctx(admin.id)))
        .rejects.toMatchObject({ extensions: { code: 'WORKER_NAME_CONFUSABLE', collidingName: first, workerId: existing.id } });
    }
    expect(await db.worker.count({ where: { appId: app.id } })).toBe(1);
  });

  it('allows the same skeleton in different Apps', async () => {
    await cast({ agentRef: roleAgent.id, name: 'Alice' });
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
    await db.appAgent.create({ data: { appId: other.id, agentId: roleAgent.id } });
    const worker = await M.castWorker({}, { appRef: other.id, agentRef: roleAgent.id, name: 'Ａlice' }, ctx(admin.id));
    expect(worker.name).toBe('Ａlice');
  });

  it('does not reveal collision details before staffing authorization', async () => {
    await cast({ agentRef: roleAgent.id, name: 'Alice' });
    for (const operation of [M.castWorker, Q.castWorkerPreview]) {
      await expect(operation({}, { appRef: app.id, agentRef: roleAgent.id, name: 'Ａlice' }, ctx(outsider.id)))
        .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    }
  });

  it('serializes concurrent distinct spellings before checking and insertion', async () => {
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { acquired = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = db.$transaction(async (tx) => { await lockWorkerNames(tx, app.id); acquired(); await gate; }, { timeout: 20_000 });
    await held;
    const results = Promise.allSettled([
      cast({ agentRef: roleAgent.id, name: 'Alice' }),
      cast({ agentRef: roleAgent.id, name: 'Ａlice' }),
    ]);
    try { await waitForLockWaiters(db, 2); } finally { release(); }
    await holder;
    const settled = await results;
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { extensions: { code: 'WORKER_NAME_CONFUSABLE' } },
    });
    expect(await db.worker.count({ where: { appId: app.id } })).toBe(1);
  });
});

describe('castWorker — broadcast-word names refused (#1870, cor:agt:020:02)', () => {
  it('refuses a name whose MENTION TOKEN is a broadcast word, any spelling, and writes nothing', async () => {
    // The refusal matches the token, not the raw name (#1870 brief, Vera
    // #10580): All, TEAM and All! all slug to a broadcast token, so each
    // would wake every registered destination on a tagless reply (#1867).
    for (const name of ['All', 'TEAM', 'All!']) {
      await expectCode(cast({ role: 'backend-engineer', name }), 'WORKER_NAME_RESERVED');
    }
    expect(await db.worker.count({ where: { appId: app.id } })).toBe(0);
  });

  it('a name that merely CONTAINS the word is allowed ("teamster")', async () => {
    await expect(cast({ role: 'backend-engineer', name: 'teamster' })).resolves.toMatchObject({
      name: 'teamster',
    });
  });

  it('the preview refuses the same names — shared resolution, no drift (#964)', async () => {
    const Q = (resolvers as unknown as { Query: Record<string, (p: unknown, a: unknown, c: Context) => Promise<unknown>> }).Query;
    await expectCode(
      Q.castWorkerPreview({}, { appRef: app.id, role: 'backend-engineer', name: 'All' }, ctx(admin.id)),
      'WORKER_NAME_RESERVED',
    );
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
    // ref fails BEFORE the install check. #1946 (ruling A): that answers as
    // not installed (one answer for absent and not-installed, no id), and the
    // tombstone never casts either way.
    await db.agent.update({ where: { id: roleAgent.id }, data: { deletedAt: new Date() } });
    await expectCode(cast({ agentRef: roleAgent.id, name: 'Zoe' }), 'WORKER_AGENT_NOT_INSTALLED');
    expect(await db.worker.count({ where: { appId: app.id } })).toBe(0);
  });

  it('neither agentRef nor role → BAD_USER_INPUT', async () => {
    await expectCode(cast({ name: 'Zoe' }), 'BAD_USER_INPUT');
  });

  it('agentRef without a name → WORKER_NAME_REQUIRED (#1050)', async () => {
    // Previously BAD_USER_INPUT, because with no role there was no register to
    // name. The missing thing was always the NAME, and now the error says so.
    await expectCode(cast({ agentRef: teamAgent.id }), 'WORKER_NAME_REQUIRED');
  });

  it('a multi-atom role is rejected before touching anything', async () => {
    await expectCode(cast({ role: 'roles:sneaky', name: 'Zoe' }), 'BAD_USER_INPUT');
  });
});

describe('#1024 — Worker.repos (resolved role affinity)', () => {
  const roleNodeRepos = (role: string, repos: unknown) =>
    db.node.upsert({
      where: { loc_memoryId: { loc: `roles:${role}`, memoryId: teamAgent.systemMemoryId } },
      create: {
        id: generateId(),
        memoryId: teamAgent.systemMemoryId,
        loc: `roles:${role}`,
        name: role,
        data: { repos } as any,
      },
      update: { data: { repos } as any },
    });

  it('resolves the affinity of the worker\'s role', async () => {
    await roleNodeRepos('backend-engineer', ['hadron-memory/hadron-server']);
    const worker = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    expect(await W.repos(worker, {}, ctx(admin.id))).toEqual([
      'hadron-memory/hadron-server',
    ]);
  });

  it('is [] for a worker with no role, and for a role with no definition', async () => {
    const worker = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    expect(await W.repos({ ...worker, role: null }, {}, ctx(admin.id))).toEqual([]);
    expect(await W.repos({ ...worker, role: 'astronaut' }, {}, ctx(admin.id))).toEqual([]);
  });

  it('finds a role that sorts past the first page of a large roster', async () => {
    // The `teamRoles` query pages at 50. Routing this lookup through it made an
    // App with more than 50 roles answer [] for everything past the first page
    // — a suppressed warning indistinguishable from "no affinity configured"
    // (PR #1071 review, Codex).
    for (let i = 0; i < 60; i++) {
      await createRoleNode(teamAgent.systemMemoryId, `filler-${String(i).padStart(3, '0')}`);
    }
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: teamAgent.systemMemoryId,
        loc: 'roles:zz-late-role',
        name: 'zz-late-role',
        data: { repos: ['acme/late'] } as any,
      },
    });
    const worker = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    expect(await W.repos({ ...worker, role: 'zz-late-role' }, {}, ctx(admin.id))).toEqual([
      'acme/late',
    ]);
  });

  it('works for an App with SEVERAL roles: branches (TEAM_AGENT_AMBIGUOUS)', async () => {
    // A supported configuration. The single-Team-Agent lookup threw
    // TEAM_AGENT_AMBIGUOUS, and the catch turned that into [] for every
    // worker — so those Apps could never use the field at all.
    await createRoleNode(roleAgent.systemMemoryId, 'designer');
    await db.node.update({
      where: {
        loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId },
      },
      data: { data: { repos: ['acme/api'] } as any },
    });
    const worker = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    expect(await W.repos(worker, {}, ctx(admin.id))).toEqual(['acme/api']);
  });

  it('an EMPTY affinity on the first definition wins over a later one (#1071 review)', async () => {
    // "Empty" is an answer, not the absence of one: it means "spans
    // everything, never warn" — which is exactly what a coordinator role
    // declares. Recording only non-empty results made an empty first-installed
    // definition invisible, so a later agent's repos silently won and the role
    // that deliberately spans everything got a FALSE mismatch warning.
    await db.node.update({
      where: {
        loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId },
      },
      data: { data: { repos: [] } as any },
    });
    // A second installed agent declares the SAME role with real repos.
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: roleAgent.systemMemoryId,
        loc: 'roles:backend-engineer',
        name: 'backend-engineer',
        data: { repos: ['acme/should-not-win'] } as any,
      },
    });

    const worker = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    expect(await W.repos(worker, {}, ctx(admin.id))).toEqual([]);
  });

  it('an UNREADABLE earlier memory stops the walk rather than letting a later one win', async () => {
    // Skipping an unreadable memory let a later agent's duplicate role supply
    // an affinity the earlier, unreadable one might have overridden — a false
    // mismatch warning conjured out of a memory nobody could read
    // (PR #1071 review, Codex).
    //
    // The team agent is installed first, so its encrypted memory stops the
    // walk: the role-agent's later definition must NOT win.
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: roleAgent.systemMemoryId,
        loc: 'roles:backend-engineer',
        name: 'backend-engineer',
        data: { repos: ['acme/should-not-win'] } as any,
      },
    });
    await db.memory.update({
      where: { id: teamAgent.systemMemoryId },
      data: { isEncrypted: true },
    });

    const worker = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    expect(await W.repos(worker, {}, ctx(admin.id))).toEqual([]);
  });

  it('propagates an unexpected error instead of degrading to no affinity', async () => {
    // The catch around the role load tolerates ONE thing: an encrypted system
    // memory with no session key. A bare catch would turn a DB or runtime
    // failure into [] — which reads as "no affinity configured", is a normal
    // answer by design, and is therefore undiagnosable
    // (review:narrow-catch-blocks; PR #1071 review, Copilot).
    const worker = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const spy = vi
      .spyOn(db.node, 'findMany')
      .mockRejectedValueOnce(new Error('connection reset'));
    try {
      await expect(W.repos(worker, {}, ctx(admin.id))).rejects.toThrow(/connection reset/);
    } finally {
      spy.mockRestore();
    }
  });

  it('memoizes the roster within a QUERY, and never within a mutation', async () => {
    // The memo exists so a 50-worker LISTING does not reload the roster 50
    // times. It is scoped to queries because a request-scoped memo over data
    // the same request can WRITE is stale by construction — review found three
    // separate writers that would have had to invalidate it, and the set is
    // open. A mutation pays the re-read and can never read its own stale
    // answer (PR #1071 review, Codex rounds 4-7).
    await db.node.update({
      where: {
        loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId },
      },
      data: { data: { repos: ['acme/api'] } as any },
    });
    const a = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const b = await cast({ agentRef: roleAgent.id, name: 'Henry' });
    const query = { operation: { operation: 'query' } };
    const mutation = { operation: { operation: 'mutation' } };

    const shared = ctx(admin.id);
    let spy = vi.spyOn(db.appAgent, 'findMany');
    try {
      expect(await W.repos(a, {}, shared, query)).toEqual(['acme/api']);
      const afterFirst = spy.mock.calls.length;
      expect(await W.repos(b, {}, shared, query)).toEqual(['acme/api']);
      expect(spy.mock.calls.length).toBe(afterFirst); // memoized
    } finally {
      spy.mockRestore();
    }

    const inMutation = ctx(admin.id);
    spy = vi.spyOn(db.appAgent, 'findMany');
    try {
      expect(await W.repos(a, {}, inMutation, mutation)).toEqual(['acme/api']);
      const afterFirst = spy.mock.calls.length;
      expect(await W.repos(b, {}, inMutation, mutation)).toEqual(['acme/api']);
      // Re-read, deliberately: a mutation must not serve its own stale answer.
      expect(spy.mock.calls.length).toBeGreaterThan(afterFirst);
    } finally {
      spy.mockRestore();
    }
  });

  it('propagates an unexpected error instead of degrading to no affinity', async () => {
    // The catch around the role load tolerates ONE thing: an encrypted system
    // memory with no session key. A bare catch would turn a DB or runtime
    // failure into [] — which reads as "no affinity configured", is a normal
    // answer by design, and is therefore undiagnosable
    // (review:narrow-catch-blocks; PR #1071 review, Copilot).
    const worker = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const spy = vi
      .spyOn(db.node, 'findMany')
      .mockRejectedValueOnce(new Error('connection reset'));
    try {
      await expect(W.repos(worker, {}, ctx(admin.id))).rejects.toThrow(/connection reset/);
    } finally {
      spy.mockRestore();
    }
  });


  it('MASKS to [] for a caller outside the App — the Session.worker nesting path', async () => {
    // Session.worker reaches a Worker through a wider gate that admits any org
    // member and survives leaving the App, so an ungated field here would
    // publish the team's repo list through any historical session.
    //
    // HONEST NOTE on what this asserts: the OUTCOME is pinned, the mechanism is
    // not. `teamRoles` runs the same predicate the mask wraps, so today this
    // passes whether or not the mask is present — deleting it leaves the suite
    // green. The mask is defence-in-depth against those two gates diverging
    // (see the field's JSDoc); this test guarantees the outsider sees nothing,
    // by whichever gate gets there first.
    await roleNodeRepos('backend-engineer', ['hadron-memory/hadron-server']);
    const worker = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    expect(await W.repos(worker, {}, ctx(outsider.id))).toEqual([]);
  });
});

describe('castWorker — naming (#1050: the register is gone)', () => {
  it('a nameless cast REFUSES — there is no pool to draw from', async () => {
    await expectCode(cast({ role: 'backend-engineer' }), 'WORKER_NAME_REQUIRED');
    // And says why, because "required" alone invites the reader to look for
    // the setting that would make it optional.
    try {
      await cast({ role: 'backend-engineer' });
      expect.fail('expected WORKER_NAME_REQUIRED');
    } catch (e) {
      expect((e as GraphQLError).message).toMatch(/permanent within the App/);
    }
  });

  it('a legacy data.names register on the role node allocates NOTHING', async () => {
    // The fixture role node still carries names. Before #1050 a nameless cast
    // returned "Iris" from it; the register's removal is only real if a node
    // that still HAS one changes nothing.
    const node = await db.node.findFirstOrThrow({
      where: { memoryId: teamAgent.systemMemoryId, loc: 'roles:backend-engineer' },
    });
    expect((node.data as { names?: string[] }).names?.length).toBeGreaterThan(0);
    await expectCode(cast({ role: 'backend-engineer' }), 'WORKER_NAME_REQUIRED');
  });

  it('two RACING casts of ONE name: exactly one wins — the unique constraint is the primitive', async () => {
    // What the register never was: the thing that made concurrent casting
    // safe. workers_app_name_uniq did that, and still does.
    const results = await Promise.allSettled([
      cast({ agentRef: roleAgent.id, name: 'Iris' }),
      cast({ agentRef: roleAgent.id, name: 'Iris' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(((failed[0] as PromiseRejectedResult).reason as GraphQLError).extensions?.code).toBe(
      'WORKER_NAME_TAKEN',
    );
    expect(await db.worker.count({ where: { appId: app.id, name: 'Iris' } })).toBe(1);
  });

  it('names are case-insensitively reserved — "iris" taken blocks "Iris"', async () => {
    await cast({ agentRef: roleAgent.id, name: 'iris' });
    await expectCode(cast({ agentRef: roleAgent.id, name: 'Iris' }), 'WORKER_NAME_TAKEN');
  });

  it('a RETIRED worker keeps its name reserved forever (cor:agt:020:02)', async () => {
    // The invariant the register was often credited with, demonstrated without
    // one: permanence comes from the constraint, not from a bookkeeping list.
    const iris = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    await M.retireWorker({}, { workerRef: iris.id }, ctx(admin.id));
    await expectCode(cast({ agentRef: roleAgent.id, name: 'Iris' }), 'WORKER_NAME_TAKEN');
  });

  it('an ENCRYPTED system memory no longer blocks a cast at all', async () => {
    // Casting used to read the register out of `data` — ciphertext under spec
    // 041 — so a nameless cast into an encrypted system memory refused
    // SESSION_EXPIRED. Casting now reads no system memory whatsoever.
    await db.memory.update({
      where: { id: teamAgent.systemMemoryId },
      data: { isEncrypted: true },
    });
    const worker = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    expect(worker.name).toBe('Zoe');
  });
});

describe('castWorker — App and agent resolution', () => {
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
      { name: 'My Engineer', personaRole: 'backend-engineer', systemPrompt: TEMPLATE },
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
    const ok = await M.deleteWorker({}, { workerRef: worker.id, confirmNoExternalAttribution: true }, ctx(admin.id));
    expect(ok).toBe(true);
    expect(await db.worker.findUnique({ where: { id: worker.id } })).toBeNull();
    expect(await db.memory.findUnique({ where: { id: worker.memoryId } })).toBeNull();
    // A true hard delete — unlike retirement, the name is free again.
    const recast = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    expect(recast.name).toBe('Zoe');
  });

  it('#2046 S9-3: exhausted serialization retries answer WORKER_DELETE_CONFLICT (transient, 3 attempts), never WORKER_IN_USE', async () => {
    const worker = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    let attempts = 0;
    const flaky = new Proxy(db, {
      get: (t, k, r) => k === '$transaction'
        ? async () => { attempts++; throw new Prisma.PrismaClientKnownRequestError('serialization', { code: 'P2034', clientVersion: 'test' }); }
        : Reflect.get(t, k, r),
    });
    await expectCode(M.deleteWorker({}, { workerRef: worker.id, confirmNoExternalAttribution: true }, { ...ctx(admin.id), db: flaky }), 'WORKER_DELETE_CONFLICT');
    expect(attempts).toBe(3);
    expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
  });

  it('an open bound session refuses with WORKER_IN_USE', async () => {
    const worker = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    await db.session.create({
      data: { id: generateId(), appId: app.id, workerId: worker.id },
    });
    await expectCode(M.deleteWorker({}, { workerRef: worker.id, confirmNoExternalAttribution: true }, ctx(admin.id)), 'WORKER_IN_USE');
    expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
  });

  it('a working memory holding a node refuses with WORKER_IN_USE', async () => {
    const worker = await cast({ agentRef: roleAgent.id, name: 'Zoe' });
    await db.node.create({
      data: { id: generateId(), memoryId: worker.memoryId!, loc: 'scratch', name: 'scratch' },
    });
    await expectCode(M.deleteWorker({}, { workerRef: worker.id, confirmNoExternalAttribution: true }, ctx(admin.id)), 'WORKER_IN_USE');
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
    // #1742: a denial answers like an absent worker, so the read is no existence oracle.
    await expectCode(Q.worker({}, { ref: iris.id }, ctx(outsider.id)), 'WORKER_NOT_FOUND');
  });

  it('a pure App-key reads its OWN App staff; a foreign App key is denied', async () => {
    const own = await Q.worker({}, { ref: iris.id }, ctx(undefined, app.id));
    expect(own.name).toBe('Iris');
    const foreignApp = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` },
    });
    await expectCode(Q.worker({}, { ref: iris.id }, ctx(undefined, foreignApp.id)), 'WORKER_NOT_FOUND'); // #1742
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
    await expectCode(Q.worker({}, { ref: iris.id }, impOther), 'WORKER_NOT_FOUND'); // #1742
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

describe('#1344 — heldWorkers across readable Apps', () => {
  let workerSeq = 0;

  async function createHeld(
    appId: string,
    name: string,
    heldByUserId: string | null,
    over: { heldAt?: Date | null; retiredAt?: Date | null; createdAt?: Date } = {},
  ) {
    workerSeq += 1;
    return db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS,
        id: generateId(),
        appId,
        agentId: roleAgent.id,
        name,
        slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${workerSeq}`,
        role: 'backend-engineer',
        heldByUserId,
        heldAt: over.heldAt === undefined ? new Date() : over.heldAt,
        retiredAt: over.retiredAt ?? null,
        ...(over.createdAt ? { createdAt: over.createdAt } : {}),
      },
    });
  }

  it('supports self and other-user refs, with App identity and deterministic pagination', async () => {
    await db.user.update({
      where: { id: admin.id },
      data: { handle: 'held-self', email: 'held-self@example.com' },
    });
    await db.user.update({
      where: { id: appMember.id },
      data: { handle: 'held-other', email: 'held-other@example.com' },
    });
    const first = await createHeld(app.id, 'First', admin.id, {
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const second = await createHeld(app.id, 'Second', appMember.id, {
      createdAt: new Date('2026-01-02T00:00:00Z'),
    });
    await createHeld(app.id, 'Third', appMember.id, {
      createdAt: new Date('2026-01-03T00:00:00Z'),
    });

    const self = await Q.heldWorkers({}, { userRef: 'hrn:user:held-self' }, ctx(admin.id));
    expect(self.total).toBe(1);
    expect(self.items[0].id).toBe(first.id);

    // By HANDLE: the holder shares no org with this viewer, so their email is
    // not the viewer's to resolve (#1347 review; the email test below).
    const other = await Q.heldWorkers(
      {},
      { userRef: 'held-other', limit: 1, offset: 1 },
      ctx(admin.id),
    );
    expect(other.total).toBe(2);
    expect(other.items.map((row: { id: string }) => row.id)).not.toContain(second.id);
    expect(other.items).toHaveLength(1);
    expect(await W.appUrn(other.items[0], {}, ctx(admin.id))).toBe(`hrn:app:${app.urn}`);

    const negativeOffset = await Q.heldWorkers(
      {},
      { userRef: appMember.id, limit: 1, offset: -1 },
      ctx(admin.id),
    );
    expect(negativeOffset.total).toBe(2);
    expect(negativeOffset.items.map((row: { id: string }) => row.id)).toEqual([second.id]);
  });

  it('unions org-owned and user-owned Apps, but only where the viewer passes the shared gate', async () => {
    const personal = await db.app.create({
      data: {
        id: generateId(),
        ownerUserId: admin.id,
        name: 'Personal Team',
        urn: `held-owner-${Date.now()}:personal`,
      },
    });
    const orgWorker = await createHeld(app.id, 'Org Held', appMember.id);
    const personalWorker = await createHeld(personal.id, 'Personal Held', appMember.id);

    const ownerView = await Q.heldWorkers({}, { userRef: appMember.id }, ctx(admin.id));
    expect(new Set(ownerView.items.map((row: { id: string }) => row.id))).toEqual(
      new Set([orgWorker.id, personalWorker.id]),
    );

    // Direct App membership admits the org App, but never somebody else's
    // strict-owner personal App.
    const holderView = await Q.heldWorkers({}, { userRef: appMember.id }, ctx(appMember.id));
    expect(holderView.items.map((row: { id: string }) => row.id)).toEqual([orgWorker.id]);

    // Platform authority applies to org Apps, never to another user's
    // strict-owner App (spec 047).
    const platformAdmin: Context = { db, userId: outsider.id, roles: ['ADMIN'] };
    const platformView = await Q.heldWorkers({}, { userRef: appMember.id }, platformAdmin);
    expect(platformView.items.map((row: { id: string }) => row.id)).toEqual([orgWorker.id]);
  });

  it('a pure App key is bounded to its own App; a foreign key sees no relation', async () => {
    const held = await createHeld(app.id, 'Key Scoped', admin.id);
    const own = await Q.heldWorkers({}, { userRef: admin.id }, ctx(undefined, app.id));
    expect(own.items.map((row: { id: string }) => row.id)).toEqual([held.id]);

    const foreign = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Foreign Key', urn: `${org.urn}:foreign-key` },
    });
    expect(await Q.heldWorkers({}, { userRef: admin.id }, ctx(undefined, foreign.id))).toEqual({
      items: [],
      total: 0,
    });
  });

  it('admits direct App participants and org contributors; outsiders and org readers see an empty page', async () => {
    const worker = await createHeld(app.id, 'Shared', admin.id);
    for (const viewer of [appReader.id, contrib.id]) {
      const page = await Q.heldWorkers({}, { userRef: admin.id }, ctx(viewer));
      expect(page.total).toBe(1);
      expect(page.items[0].id).toBe(worker.id);
    }
    for (const viewer of [outsider.id, orgReader.id]) {
      const page = await Q.heldWorkers({}, { userRef: admin.id }, ctx(viewer));
      expect(page).toEqual({ items: [], total: 0 });
    }
  });

  it('revoked org membership immediately removes rows, totals, and page membership', async () => {
    await createHeld(app.id, 'Revoked Scope', admin.id);
    expect((await Q.heldWorkers({}, { userRef: admin.id }, ctx(contrib.id))).total).toBe(1);
    await db.orgMember.updateMany({
      where: { organizationId: org.id, userId: contrib.id },
      data: { deletedAt: new Date() },
    });
    expect(await Q.heldWorkers({}, { userRef: admin.id }, ctx(contrib.id))).toEqual({
      items: [],
      total: 0,
    });
  });

  it('does not disclose private holder state through inclusion, even when Worker identity is otherwise reachable', async () => {
    await db.user.update({ where: { id: admin.id }, data: { handle: 'visible-target' } });
    const hidden = await createHeld(app.id, 'Visible Identity', admin.id);
    // Worker identity fields are attribution-level and can be reached through
    // the wider historical Session.worker surface; working state is not.
    expect(await W.urn(hidden, {}, ctx(outsider.id))).toContain('visible-identity');
    expect(await W.heldByUserId(hidden, {}, ctx(outsider.id))).toBeNull();
    expect(await W.appUrn(hidden, {}, ctx(outsider.id))).toBeNull();
    expect(await Q.heldWorkers({}, { userRef: 'visible-target' }, ctx(outsider.id))).toEqual({
      items: [],
      total: 0,
    });
    expect(await Q.heldWorkers({}, { userRef: 'missing-target' }, ctx(outsider.id))).toEqual({
      items: [],
      total: 0,
    });

    await db.user.createMany({
      data: [
        {
          id: generateId(),
          handle: `amb-held-a-${generateId().slice(-6)}`,
          email: 'AmbHeld@example.com',
          roles: ['READER'],
        },
        {
          id: generateId(),
          handle: `amb-held-b-${generateId().slice(-6)}`,
          email: 'ambheld@example.com',
          roles: ['READER'],
        },
      ],
    });
    expect(await Q.heldWorkers({}, { userRef: 'AMBHELD@example.com' }, ctx(outsider.id))).toEqual({
      items: [],
      total: 0,
    });
  });

  it('uses current holder only: released and reassigned workers do not match the former holder', async () => {
    const released = await createHeld(app.id, 'Released', appMember.id);
    const reassigned = await createHeld(app.id, 'Reassigned', appMember.id);
    await db.worker.update({
      where: { id: released.id },
      data: { heldByUserId: null, heldAt: null },
    });
    await db.worker.update({
      where: { id: reassigned.id },
      data: { heldByUserId: admin.id, heldAt: new Date() },
    });

    expect(await Q.heldWorkers({}, { userRef: appMember.id }, ctx(admin.id))).toEqual({
      items: [],
      total: 0,
    });
    const current = await Q.heldWorkers({}, { userRef: admin.id }, ctx(admin.id));
    expect(current.items.map((row: { id: string }) => row.id)).toContain(reassigned.id);
  });

  it('preserves null heldAt and retired lifecycle semantics', async () => {
    const nullStamp = await createHeld(app.id, 'Null Stamp', appMember.id, { heldAt: null });
    const retired = await createHeld(app.id, 'Retired Held', appMember.id, {
      retiredAt: new Date(),
    });
    const active = await Q.heldWorkers({}, { userRef: appMember.id }, ctx(admin.id));
    expect(active.items.map((row: { id: string }) => row.id)).toEqual([nullStamp.id]);
    expect(await W.heldAt(active.items[0], {}, ctx(admin.id))).toBeNull();

    const all = await Q.heldWorkers(
      {},
      { userRef: appMember.id, includeRetired: true },
      ctx(admin.id),
    );
    expect(new Set(all.items.map((row: { id: string }) => row.id))).toEqual(
      new Set([nullStamp.id, retired.id]),
    );
  });

  it('keeps held workers visible after App uninstall, matching the point-read contract', async () => {
    const held = await createHeld(app.id, 'Uninstalled Held', admin.id);
    await db.app.update({
      where: { id: app.id },
      data: { uninstalledAt: new Date() },
    });

    for (const viewer of [admin.id, appMember.id]) {
      const page = await Q.heldWorkers({}, { userRef: admin.id }, ctx(viewer));
      expect(page.total).toBe(1);
      expect(page.items.map((row: { id: string }) => row.id)).toEqual([held.id]);
    }
  });

  it('an EMAIL userRef resolves only for a caller who may see that user\'s personal fields (#1347 review)', async () => {
    await db.user.update({ where: { id: admin.id }, data: { handle: 'mail-target', email: 'mail-target@example.com' } });
    const held = await createHeld(app.id, 'Mail Held', admin.id);
    const ids = (page: { items: { id: string }[] }) => page.items.map((row) => row.id);
    // A direct App member from no shared org reads the App's workers, but not
    // the holder's email: the email must name nobody for them.
    expect(await Q.heldWorkers({}, { userRef: 'mail-target@example.com' }, ctx(appMember.id))).toEqual({ items: [], total: 0 });
    expect(ids(await Q.heldWorkers({}, { userRef: 'mail-target' }, ctx(appMember.id)))).toEqual([held.id]);
    // A pure App key has no personal-field reach at all.
    expect(await Q.heldWorkers({}, { userRef: 'mail-target@example.com' }, ctx(undefined, app.id))).toEqual({ items: [], total: 0 });
    expect(ids(await Q.heldWorkers({}, { userRef: admin.id }, ctx(undefined, app.id)))).toEqual([held.id]);
    // Self, and a caller sharing an org, still resolve it.
    expect(ids(await Q.heldWorkers({}, { userRef: 'mail-target@example.com' }, ctx(admin.id)))).toEqual([held.id]);
    expect(ids(await Q.heldWorkers({}, { userRef: 'MAIL-TARGET@example.com' }, ctx(contrib.id)))).toEqual([held.id]);
  });

  it('impersonation reads only the shared org\'s Apps, and never a user-owned App', async () => {
    const personal = await db.app.create({
      data: { id: generateId(), ownerUserId: contrib.id, name: 'Contrib Personal', urn: `imp-owner-${Date.now()}:personal` },
    });
    const orgHeld = await createHeld(app.id, 'Imp Org', admin.id);
    await createHeld(personal.id, 'Imp Personal', admin.id);
    const imp = (orgId: string): Context =>
      ({ db, userId: contrib.id, roles: [], impersonation: { sessionId: 'imp', actorUserId: outsider.id, orgId, expiresAt: new Date(Date.now() + 60_000) } }) as Context;
    // Unimpersonated, contrib reads both: the org App as a CONTRIBUTOR, the personal App as its owner.
    expect((await Q.heldWorkers({}, { userRef: admin.id }, ctx(contrib.id))).total).toBe(2);
    const inOrg = await Q.heldWorkers({}, { userRef: admin.id }, imp(org.id));
    expect(inOrg.items.map((row: { id: string }) => row.id)).toEqual([orgHeld.id]);
    expect(await Q.heldWorkers({}, { userRef: admin.id }, imp(generateId()))).toEqual({ items: [], total: 0 });
  });

  it('a soft-deleted App\'s worker is refused by the id point read and by releaseWorker too (#1347 review)', async () => {
    const held = await createHeld(app.id, 'Deleted Point', admin.id);
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    // #1742: refused as an absent worker, the same answer as a missing row.
    await expectCode(Q.worker({}, { ref: held.id }, ctx(admin.id)), 'WORKER_NOT_FOUND');
    // releaseWorker runs the read gate before its idempotent return: an
    // unheld worker there would otherwise hand back its row.
    const unheld = await createHeld(app.id, 'Deleted Unheld', null);
    await expectCode(M.releaseWorker({}, { workerRef: unheld.id }, ctx(admin.id)), 'WORKER_NOT_FOUND');
    await expectCode(M.releaseWorker({}, { workerRef: held.id }, ctx(admin.id)), 'WORKER_NOT_FOUND');
    expect((await db.worker.findUniqueOrThrow({ where: { id: held.id } })).heldByUserId).toBe(admin.id);
  });

  it('appUrn is the App\'s CANONICAL URN, the value App.urn answers, even for a legacy stored shape (#1347 review)', async () => {
    const legacy = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Legacy', urn: `${org.urn}::legacy-team` },
    });
    const held = await createHeld(legacy.id, 'Legacy Held', admin.id);
    const page = await Q.heldWorkers({}, { userRef: admin.id }, ctx(admin.id));
    const item = page.items.find((row: { id: string }) => row.id === held.id);
    const expected = (resolvers as any).App.urn({ urn: legacy.urn });
    expect(expected).toBe(`hrn:app:${org.urn}:legacy-team`);
    expect(await W.appUrn(item, {}, ctx(admin.id), { operation: { operation: 'query' } })).toBe(expected);
  });

  it('the page binds no App-id list for an org CONTRIBUTOR, however many Apps the org has (#1347 review)', async () => {
    for (let i = 0; i < 5; i++) {
      await db.app.create({ data: { id: generateId(), organizationId: org.id, name: `Many ${i}`, urn: `${org.urn}:many-${i}` } });
    }
    await createHeld(app.id, 'Bounded', admin.id);
    const appScans = vi.spyOn(db.app, 'findMany');
    try {
      expect((await Q.heldWorkers({}, { userRef: admin.id }, ctx(contrib.id))).total).toBe(1);
      expect(appScans).not.toHaveBeenCalled();
    } finally {
      appScans.mockRestore();
    }
  });

  it('a soft-deleted App\'s held workers are gone from the page and the total', async () => {
    await createHeld(app.id, 'Deleted App Held', admin.id);
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    for (const c of [ctx(admin.id), ctx(undefined, app.id)]) {
      expect(await Q.heldWorkers({}, { userRef: admin.id }, c)).toEqual({ items: [], total: 0 });
    }
  });

  it('DIFFERENTIAL: a held worker is on the page exactly when the point read worker(ref) admits it (#1347 review)', async () => {
    // The page's App set (workerReadableAppIds, with a hand-written platform
    // arm) and the point gate (requireWorkerReadAccess) are two implementations
    // of one audience. This matrix pins them together across principal and
    // App shapes, so a change to either that is not made to the other reds.
    const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'other-org', urn: `other-org-${Date.now()}.com` } });
    const shapes = {
      live: app,
      uninstalled: await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Gone', urn: `${org.urn}:gone`, uninstalledAt: new Date() } }),
      deleted: await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Dead', urn: `${org.urn}:dead`, deletedAt: new Date() } }),
      userOwned: await db.app.create({ data: { id: generateId(), ownerUserId: admin.id, name: 'Mine', urn: `diff-owner-${Date.now()}:mine` } }),
      otherOrg: await db.app.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'Elsewhere', urn: `${otherOrg.urn}:team` } }),
    };
    await db.appMember.create({ data: { appId: shapes.uninstalled.id, userId: appMember.id, role: 'member' } });
    const workers = new Map<string, string>();
    for (const [shape, a] of Object.entries(shapes)) workers.set((await createHeld(a.id, `Diff ${shape}`, admin.id)).id, shape);
    const imp = (userId: string, orgId: string): Context =>
      ({ db, userId, roles: [], impersonation: { sessionId: 'imp', actorUserId: outsider.id, orgId, expiresAt: new Date(Date.now() + 60_000) } }) as Context;
    const principals: Record<string, Context> = {
      orgAdmin: ctx(admin.id),
      contributor: ctx(contrib.id),
      orgReader: ctx(orgReader.id),
      appMember: ctx(appMember.id),
      appReader: ctx(appReader.id),
      outsider: ctx(outsider.id),
      platformAdmin: { db, userId: outsider.id, roles: ['ADMIN'] },
      appKey: ctx(undefined, app.id),
      foreignAppKey: ctx(undefined, shapes.otherOrg.id),
      hybrid: ctx(appMember.id, shapes.otherOrg.id),
      impersonatedAdminInOrg: imp(admin.id, org.id),
      impersonatedAdminElsewhere: imp(admin.id, otherOrg.id),
    };
    let admitted = 0;
    for (const [who, c] of Object.entries(principals)) {
      const page = await Q.heldWorkers({}, { userRef: admin.id, includeRetired: true, limit: 200 }, c);
      const onPage = new Set(page.items.map((row: { id: string }) => row.id));
      expect(page.total, who).toBe(onPage.size);
      for (const [workerId, shape] of workers) {
        const pointRead = await Q.worker({}, { ref: workerId }, c).then(() => true, () => false);
        expect(onPage.has(workerId), `${who} / ${shape}`).toBe(pointRead);
        if (pointRead) admitted++;
      }
    }
    // Not vacuous in either direction: the matrix holds admits and refusals.
    expect(admitted).toBeGreaterThan(10);
    expect(admitted).toBeLessThan(Object.keys(principals).length * workers.size);
  });

  it('preloads multiple-live-session activity once for the page, including held-but-idle workers', async () => {
    const driven = await createHeld(app.id, 'Driven', appMember.id);
    const idle = await createHeld(app.id, 'Idle', appMember.id);
    const now = new Date();
    await db.session.createMany({
      data: [
        {
          id: generateId(), appId: app.id, workerId: driven.id, userId: appMember.id,
          startedAt: now, updatedAt: now,
        },
        {
          id: generateId(), appId: app.id, workerId: driven.id, userId: appMember.id,
          startedAt: new Date(now.getTime() - 60_000),
          updatedAt: new Date(now.getTime() - 30_000),
        },
        {
          id: generateId(), appId: app.id, workerId: idle.id, userId: appMember.id,
          startedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
          updatedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
          endedAt: null,
        },
      ],
    });

    const raw = vi.spyOn(db, '$queryRaw');
    const appReads = vi.spyOn(db.app, 'findUnique');
    const requestCtx = ctx(admin.id);
    const page = await Q.heldWorkers({}, { userRef: appMember.id }, requestCtx);
    expect(raw).toHaveBeenCalledTimes(1);
    const byName = new Map(page.items.map((row: { name: string }) => [row.name, row]));
    expect(await W.hasLiveSession(byName.get('Driven'), {}, requestCtx)).toBe(true);
    expect(await W.lastActiveAt(byName.get('Driven'), {}, requestCtx)).toBeInstanceOf(Date);
    expect(await W.hasLiveSession(byName.get('Idle'), {}, requestCtx)).toBe(false);
    expect(await W.lastActiveAt(byName.get('Idle'), {}, requestCtx)).toBeInstanceOf(Date);
    await W.appUrn(byName.get('Driven'), {}, requestCtx, { operation: { operation: 'query' } });
    expect(raw).toHaveBeenCalledTimes(1);
    expect(appReads).not.toHaveBeenCalled();
    raw.mockRestore();
    appReads.mockRestore();
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
    // The team agent has no systemPrompt dressing.
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
// hadron-cli#487 — is anyone actually driving this worker?
// ---------------------------------------------------------------------------

/**
 * Ada's finding: ten issues were dispatched to a worker whose entire history
 * was two sessions of 2m26s and 41s. Nothing rendered that differently from a
 * worker driven yesterday, so a coordinator can dispatch into a channel nobody
 * reads and get no signal at all — a failure that is silent, compounds daily,
 * and is invisible precisely to the role whose job is to notice it.
 *
 * Both fields are WORKING STATE, so both mask to null on deny rather than
 * answering "no": `hasLiveSession: false` on a caller who may not know would
 * state a fact the server never computed.
 */
describe('hadron-cli#487 — Worker.hasLiveSession / lastActiveAt', () => {
  const bindAs = (userId: string, workerId: string) =>
    M.startSession(
      {}, { input: { id: generateId(), workerRef: workerId, appRef: app.id } }, ctx(userId),
    );

  /**
   * #1114 — the cases the differential above cannot decide.
   *
   * That test pins the two derivations to EACH OTHER; it would pass with both
   * of them wrong in the same direction. These assert the answer absolutely,
   * and every one of them was unreachable before this change: the reaper ended
   * any session idle enough to produce them, so an open-and-stale row could not
   * exist to be asked about.
   */
  describe('liveness is derived, not "the row is open" (#1114)', () => {
    const mins = (n: number) => new Date(Date.now() - n * 60_000);

    /** An OPEN session on a worker, with activity stamps we choose. */
    async function openSession(workerId: string, over: {
      startedAt: Date; updatedAt?: Date | null; eventAt?: Date;
    }) {
      const id = generateId();
      await db.session.create({
        data: {
          id, workerId, appId: app.id, userId: appMember.id,
          startedAt: over.startedAt, updatedAt: over.updatedAt ?? null,
          endedAt: null, autoExpiredAt: null,
        },
      });
      if (over.eventAt) {
        await db.usageEvent.create({
          data: { countsAsActivity: true, id: generateId(), sessionId: id, type: 'read', createdAt: over.eventAt },
        });
      }
      return id;
    }

    afterEach(() => {
      delete process.env.SESSION_IDLE_WINDOW_MS;
      delete process.env.SESSION_IDLE_WINDOW_DEVELOPER_MS;
    });

    it('an OPEN session nobody has driven for days does not read as live', async () => {
      const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
      await openSession(w.id, { startedAt: mins(4320), updatedAt: mins(4320) }); // 3 days
      expect(await W.hasLiveSession(w, {}, ctx(admin.id))).toBe(false);
      // ...and the session is STILL OPEN. Liveness described it; nothing ended
      // it, which is the whole point of the change.
      const row = await db.session.findFirstOrThrow({ where: { workerId: w.id } });
      expect(row.endedAt).toBeNull();
    });

    it('the same session reads live again the moment it is driven', async () => {
      // Recovery matters more than the negative case: an idle session is not
      // dead, and coming back must need no takeover and no repair.
      const w = await cast({ agentRef: roleAgent.id, name: 'Jonas' });
      const id = await openSession(w.id, { startedAt: mins(4320), updatedAt: mins(4320) });
      expect(await W.hasLiveSession(w, {}, ctx(admin.id))).toBe(false);

      await db.session.update({ where: { id }, data: { updatedAt: new Date() } });
      expect(await W.hasLiveSession(w, {}, ctx(admin.id))).toBe(true);
    });

    it('a usage event inside the window is enough on its own', async () => {
      // The heartbeat input that lives OUTSIDE the session row — #1081's whole
      // subject, and the one a narrowed activity set would drop first.
      const w = await cast({ agentRef: roleAgent.id, name: 'Mira' });
      await openSession(w.id, {
        startedAt: mins(4320), updatedAt: mins(4320), eventAt: mins(1),
      });
      expect(await W.hasLiveSession(w, {}, ctx(admin.id))).toBe(true);
    });

    it('honours the configured window rather than a hardcoded one', async () => {
      const w = await cast({ agentRef: roleAgent.id, name: 'Pia' });
      await openSession(w.id, { startedAt: mins(120), updatedAt: mins(120) }); // 2h idle
      expect(await W.hasLiveSession(w, {}, ctx(admin.id))).toBe(true); // 24h default

      process.env.SESSION_IDLE_WINDOW_MS = String(60 * 60 * 1000); // 1h
      expect(await W.hasLiveSession(w, {}, ctx(admin.id))).toBe(false);
    });

    it('a per-type window beats the fleet-wide one', async () => {
      const w = await cast({ agentRef: roleAgent.id, name: 'Tove' });
      await openSession(w.id, { startedAt: mins(120), updatedAt: mins(120) });
      process.env.SESSION_IDLE_WINDOW_MS = String(60 * 60 * 1000); // 1h -> stale
      process.env.SESSION_IDLE_WINDOW_DEVELOPER_MS = String(10 * 60 * 60 * 1000); // 10h -> live
      expect(await W.hasLiveSession(w, {}, ctx(admin.id))).toBe(true);
    });

    it('one stale worker does not drag a live sibling down', async () => {
      const live = await cast({ agentRef: roleAgent.id, name: 'Ada' });
      const stale = await cast({ agentRef: roleAgent.id, name: 'Udo' });
      await openSession(live.id, { startedAt: mins(1), updatedAt: mins(1) });
      await openSession(stale.id, { startedAt: mins(4320), updatedAt: mins(4320) });
      expect(await W.hasLiveSession(live, {}, ctx(admin.id))).toBe(true);
      expect(await W.hasLiveSession(stale, {}, ctx(admin.id))).toBe(false);
    });
  });

  it('a cast-but-never-driven worker reads null, NOT a zero timestamp', async () => {
    // The distinction the whole issue is about: "nobody has ever picked this
    // up" must not render as "idle since the epoch" or as "idle since it was
    // cast", both of which are answers to a question nobody asked.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    expect(await W.lastActiveAt(w, {}, ctx(admin.id))).toBeNull();
    expect(await W.hasLiveSession(w, {}, ctx(admin.id))).toBe(false);
  });

  it('an OPEN session reads live, and last-active tracks the heartbeat', async () => {
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const s = await bindAs(appMember.id, w.id);

    expect(await W.hasLiveSession(w, {}, ctx(admin.id))).toBe(true);
    const atStart = await W.lastActiveAt(w, {}, ctx(admin.id));
    expect(atStart).toBeInstanceOf(Date);

    // `updatedAt` is the explicit heartbeat (#930), and the roster must move
    // with it — otherwise a session driven all day reads as idle since bind.
    const later = new Date(Date.now() + 60_000);
    await db.session.update({ where: { id: s.id }, data: { updatedAt: later } });
    expect((await W.lastActiveAt(w, {}, ctx(admin.id)))?.getTime()).toBe(later.getTime());
  });

  it('ENDING a session clears liveness but keeps the last-driven instant', async () => {
    // Exactly Dara's shape in the issue: sessions that happened, ended, and
    // left a name looking identical to one never touched. It must not.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const s = await bindAs(appMember.id, w.id);
    await M.endSession({}, { id: s.id }, ctx(appMember.id));

    expect(await W.hasLiveSession(w, {}, ctx(admin.id))).toBe(false);
    expect(await W.lastActiveAt(w, {}, ctx(admin.id))).toBeInstanceOf(Date);
  });

  it('a SOFT-DELETED session is not liveness — the binder predicate wins', async () => {
    // startSession refuses WORKER_TAKEN on `endedAt: null, deletedAt: null`.
    // A roster that omitted `deletedAt` would advertise a worker as busy that
    // a binder can take without even a prompt (PR #1000 review, Codex P2).
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const s = await bindAs(appMember.id, w.id);
    await db.session.update({ where: { id: s.id }, data: { deletedAt: new Date() } });

    expect(await W.hasLiveSession(w, {}, ctx(admin.id))).toBe(false);
    expect(await W.lastActiveAt(w, {}, ctx(admin.id))).toBeNull();
  });

  it('ANY open session makes it live, even when a newer one has ended', async () => {
    // `force` lets several sessions coexist, so liveness ORs across rows
    // rather than reading the most recent — which may be the ended one.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const open = await bindAs(appMember.id, w.id);
    // #1617 C: a forced rebind now ends the holder's superseded row, so the
    // coexisting newer session is seeded directly (pre-#1617 data shape).
    const forced = await db.session.create({
      data: { id: generateId(), userId: appMember.id, appId: app.id, workerId: w.id, type: 'DEVELOPER', startedAt: new Date() },
    });
    await M.endSession({}, { id: forced.id }, ctx(appMember.id));

    expect(await db.session.count({ where: { workerId: w.id, endedAt: null } })).toBe(1);
    expect(open.id).toBeTruthy();
    expect(await W.hasLiveSession(w, {}, ctx(admin.id))).toBe(true);
  });

  it('MASKS to null for a caller outside the App — not to false', async () => {
    // `Session.worker` reaches Worker rows through a wider gate than the
    // worker queries (#983), so an ungated answer publishes current staffing
    // to a former member off a historical session. And the mask must be null:
    // false is an assertion, null is a refusal to assert.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    await bindAs(appMember.id, w.id);

    expect(await W.hasLiveSession(w, {}, ctx(outsider.id))).toBeNull();
    expect(await W.lastActiveAt(w, {}, ctx(outsider.id))).toBeNull();
    // …while the same live worker reads true for someone inside the App, so
    // the null above is the GATE and not an empty result set.
    expect(await W.hasLiveSession(w, {}, ctx(admin.id))).toBe(true);
  });

  it('does NOT report the REAPER as the last drive', async () => {
    // The reaper ends an idle session with an updateMany, and @updatedAt moves
    // to the reaping instant — so folding it in would shift lastActiveAt
    // forward by the whole idle window and make an ABANDONED worker read as
    // recently driven. Which is the precise signal this field exists to give.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const s = await bindAs(appMember.id, w.id);

    const drivenAt = (await W.lastActiveAt(w, {}, ctx(admin.id))) as Date;
    // What a reap looks like on the row: both stamps set, and updatedAt
    // dragged a day forward with them.
    const reapedAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.session.update({
      where: { id: s.id },
      data: { endedAt: reapedAt, autoExpiredAt: reapedAt, updatedAt: reapedAt },
    });

    const after = (await W.lastActiveAt(w, {}, ctx(admin.id))) as Date;
    expect(after.getTime()).toBeLessThan(reapedAt.getTime());
    expect(after.getTime()).toBeLessThanOrEqual(drivenAt.getTime());
    expect(await W.hasLiveSession(w, {}, ctx(admin.id))).toBe(false);
  });

  it('DOES count an explicit endSession as a drive — only the reaper is excluded', async () => {
    // The spare, not just the fire: ending your own session is a driver
    // action, so its updatedAt must still count. Only auto-expiry is dropped.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const s = await bindAs(appMember.id, w.id);
    const endedAt = new Date(Date.now() + 60_000);
    await db.session.update({
      where: { id: s.id },
      data: { endedAt, autoExpiredAt: null, updatedAt: endedAt },
    });

    expect((await W.lastActiveAt(w, {}, ctx(admin.id)))?.getTime()).toBe(endedAt.getTime());
  });

  it('does NOT count a POST-END metadata write as a drive', async () => {
    // updateSession deliberately permits writes after endedAt — a merge lands
    // days after the stint that produced it — and @updatedAt moves with them.
    // Attributing that to the worker says someone was driving it on the day
    // the PR merged (PR #1086 review, Codex P2).
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const s = await bindAs(appMember.id, w.id);
    const endedAt = new Date(Date.now() + 60_000);
    await db.session.update({ where: { id: s.id }, data: { endedAt } });

    // Three days later the PR merges and its number is attributed back.
    const merged = new Date(endedAt.getTime() + 3 * 24 * 60 * 60 * 1000);
    await db.session.update({
      where: { id: s.id },
      data: { prNumber: 1086, updatedAt: merged },
    });

    const at = (await W.lastActiveAt(w, {}, ctx(admin.id))) as Date;
    expect(at.getTime()).toBe(endedAt.getTime());
  });

  it('does NOT count a LATE usage event either — the cap is the end, not the source', async () => {
    // hadron_record_work takes an ended session on purpose (late attribution,
    // cor:agt:020:05), so the same postdating arrives through a second door.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const s = await bindAs(appMember.id, w.id);
    const endedAt = new Date(Date.now() + 60_000);
    await db.session.update({ where: { id: s.id }, data: { endedAt } });
    await db.usageEvent.create({
      data: { countsAsActivity: true,
        id: generateId(), sessionId: s.id, type: 'read',
        createdAt: new Date(endedAt.getTime() + 86_400_000),
      },
    });

    expect((await W.lastActiveAt(w, {}, ctx(admin.id)))?.getTime()).toBe(endedAt.getTime());
  });

  it('counts an attributed usage event as activity', async () => {
    // The third input of the shared derivation, and the one a roster would
    // otherwise miss for a session driven entirely through MCP.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const s = await bindAs(appMember.id, w.id);
    const eventAt = new Date(Date.now() + 120_000);
    await db.usageEvent.create({
      data: { countsAsActivity: true, id: generateId(), sessionId: s.id, type: 'read', createdAt: eventAt },
    });

    expect((await W.lastActiveAt(w, {}, ctx(admin.id)))?.getTime()).toBe(eventAt.getTime());
  });

  it('the SQL and the TS derivation agree, on EVERY session shape', async () => {
    // Copilot on PR #1086 flagged an unused import, and the dead import was the
    // TELL: rewriting the loader as aggregating SQL left lib/sessionActivity.ts
    // unused HERE, so the roster and the takeover prompt now derive "last
    // driven" from two independent implementations. Both are necessary — one
    // must aggregate inside the query, the other folds rows already loaded —
    // so the answer is not to delete one but to make them unable to disagree
    // silently. Both review findings on this PR had to be applied twice.
    //
    // ONE WORKER PER SHAPE, deliberately. The first version of this test put
    // every shape on one worker and compared the folded MAX, so any row that
    // was not the maximum contributed nothing — dropping the reaper exclusion
    // from the TS side passed. An aggregate assertion hides its components,
    // which is the same loose-assertion family as @Jonas's index comparison on
    // hadron-cli#521. Proven: each mutation below now reddens this test.
    const t = (offsetMinutes: number) => new Date(Date.now() + offsetMinutes * 60_000);
    const shapes: Record<string, {
      startedAt: Date; updatedAt: Date | null; endedAt: Date | null;
      autoExpiredAt: Date | null; eventAt?: Date; eventCounts?: boolean;
    }> = {
      Iris: { startedAt: t(-500), updatedAt: t(-400), endedAt: null, autoExpiredAt: null },
      Jonas: { startedAt: t(-300), updatedAt: t(-200), endedAt: t(-200), autoExpiredAt: null },
      // Reaped: every stamp dragged to the reaping instant, plus an event that
      // predates it — the value the exclusion has to fall back to.
      Mira: {
        startedAt: t(-900), updatedAt: t(-100), endedAt: t(-100), autoExpiredAt: t(-100),
        eventAt: t(-880),
      },
      // Ended, then a merge attributed the PR back long afterwards.
      Pia: { startedAt: t(-800), updatedAt: t(-10), endedAt: t(-700), autoExpiredAt: null },
      // Never touched after bind.
      Tove: { startedAt: t(-50), updatedAt: null, endedAt: null, autoExpiredAt: null },
      // #1114 — OPEN BUT STALE. Impossible before: the reaper ended a session
      // this idle, so no fixture could hold one and both derivations agreed by
      // never being asked. It is now the ordinary state of a worker whose
      // driver walked away, and it is the shape liveness has to get right.
      Gil: { startedAt: t(-5000), updatedAt: t(-4000), endedAt: null, autoExpiredAt: null },
      // Open and recently driven only by a usage event — the heartbeat input
      // that lives outside the session row.
      Udo: { startedAt: t(-5000), updatedAt: t(-4000), endedAt: null, autoExpiredAt: null,
             eventAt: t(-1) },
      // #1623 review (Bob, P3): one row just INSIDE and one just OUTSIDE the
      // 24h window. Without them no fixture sat in the band where a window
      // fork between the SQL roster and the TS predicate would disagree, so a
      // +1h fork on either side passed this test.
      Ada: { startedAt: t(-1500), updatedAt: t(-1430), endedAt: null, autoExpiredAt: null },
      Bo: { startedAt: t(-1500), updatedAt: t(-1450), endedAt: null, autoExpiredAt: null },
      // #1653 / DY-2: a RECENT event written while the session was lapsed is
      // attribution, not activity. Both derivations must still read it lapsed.
      Ida: { startedAt: t(-5000), updatedAt: t(-4000), endedAt: null, autoExpiredAt: null,
             eventAt: t(-1), eventCounts: false },
    };

    const workers: Record<string, { id: string; appId: string }> = {};
    const sessionIds: string[] = [];
    for (const [name, shape] of Object.entries(shapes)) {
      const w = await cast({ agentRef: roleAgent.id, name });
      workers[name] = w;
      const id = generateId();
      sessionIds.push(id);
      const { eventAt, eventCounts = true, ...row } = shape;
      await db.session.create({
        data: { id, workerId: w.id, appId: app.id, userId: appMember.id, ...row },
      });
      if (eventAt) {
        await db.usageEvent.create({
          data: { countsAsActivity: eventCounts, id: generateId(), sessionId: id, type: 'read', createdAt: eventAt },
        });
      }
    }

    const rows = await db.session.findMany({ where: { id: { in: sessionIds } } });
    const lastEvent = await loadLastEventBySession(db as never, sessionIds);

    for (const [name, w] of Object.entries(workers)) {
      const row = rows.find((r) => r.workerId === w.id)!;
      const expected = sessionActivityAt(row, lastEvent.get(row.id));
      const actual = (await W.lastActiveAt(w, {}, ctx(admin.id))) as Date;
      // #1114: LIVENESS is now derived by both implementations too, so it joins
      // the differential rather than getting its own looser test. cor:agt:020:11
      // requires the roster and the binder to share one predicate; two copies
      // that must agree are pinned here or they drift.
      const nowForLiveness = new Date();
      expect(
        await W.hasLiveSession(w, {}, ctx(admin.id)),
        `${name}: SQL liveness disagrees with isSessionLive`,
      ).toBe(isSessionLive(row, lastEvent.get(row.id), nowForLiveness));
      // Second-precision: updated_at is timestamp WITHOUT time zone, so a raw
      // round-trip is not bit-identical.
      expect(
        Math.abs(actual.getTime() - expected.getTime()),
        `${name}: SQL ${actual.toISOString()} vs TS ${expected.toISOString()}`,
      ).toBeLessThan(1000);
    }
    // The window-band pair must actually straddle the window, or it pins nothing.
    expect(await W.hasLiveSession(workers.Ada, {}, ctx(admin.id))).toBe(true);
    expect(await W.hasLiveSession(workers.Bo, {}, ctx(admin.id))).toBe(false);
    expect(await W.hasLiveSession(workers.Ida, {}, ctx(admin.id))).toBe(false);
  });

  it('one worker going live does not make its sibling live', async () => {
    // The loader answers per APP in one query, so a mis-keyed fold would
    // smear one worker's session across the roster.
    const driven = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const idle = await cast({ agentRef: roleAgent.id, name: 'Jonas' });
    await bindAs(appMember.id, driven.id);

    expect(await W.hasLiveSession(driven, {}, ctx(admin.id))).toBe(true);
    expect(await W.hasLiveSession(idle, {}, ctx(admin.id))).toBe(false);
    expect(await W.lastActiveAt(idle, {}, ctx(admin.id))).toBeNull();
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

  it('a STALE open session no longer refuses forever — no force needed (#1114)', async () => {
    // The consumer #1114 obligated. With nothing ending an abandoned session,
    // an `endedAt IS NULL` gate would refuse this bind for good, leaving
    // `force: true` as the only route — the reflexive override this refusal
    // exists to prevent. Derived liveness answers it: nobody is driving that
    // session, so the name is simply available.
    const w = await heldBy(contrib.id);
    const first = await bind(contrib.id, w.id);
    // Age the session past the window WITHOUT ending it.
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
    await db.session.updateMany({
      where: { id: first.id }, data: { startedAt: old, updatedAt: old },
    });

    const second = await bind(contrib.id, w.id);
    expect(second.workerId).toBe(w.id);

    // #1617 C (Holger, 2026-10-05): the same person's rebind now ENDS the old
    // row as superseded, so open-but-not-live rows stop piling up. It is an
    // act, not an inference from silence, so it is never marked auto-expired,
    // and the new session chains to it.
    const prior = await db.session.findUniqueOrThrow({ where: { id: first.id } });
    expect(prior.endedAt).not.toBeNull();
    expect(prior.autoExpiredAt).toBeNull();
    expect(prior.summary).toBe(`superseded by session ${second.id}`);
    expect(second.prevSessionId).toBe(first.id);
  });

  describe('#1617 C — a bind ends the same person\'s superseded sessions (Holger, 2026-10-05)', () => {
    it('a forced rebind ends the LIVE own session it displaces', async () => {
      const w = await heldBy(contrib.id);
      const first = await bind(contrib.id, w.id);
      const second = await M.startSession(
        {},
        { input: { id: generateId(), workerRef: w.id, appRef: app.id, force: true } },
        ctx(contrib.id),
      );
      const prior = await db.session.findUniqueOrThrow({ where: { id: first.id } });
      expect(prior.endedAt).not.toBeNull();
      expect(prior.summary).toBe(`superseded by session ${second.id}`);
      expect(await db.session.count({ where: { workerId: w.id, endedAt: null } })).toBe(1);
    });

    it('never touches another person\'s or an App key\'s open session on that worker', async () => {
      const w = await heldBy(contrib.id);
      const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
      const others = await Promise.all([
        db.session.create({ data: { id: generateId(), userId: appMember.id, appId: app.id, workerId: w.id, type: 'DEVELOPER', startedAt: old, updatedAt: old } }),
        db.session.create({ data: { id: generateId(), userId: null, appId: app.id, workerId: w.id, type: 'DEVELOPER', startedAt: old, updatedAt: old } }),
      ]);
      await bind(contrib.id, w.id);
      for (const o of others) {
        expect((await db.session.findUniqueOrThrow({ where: { id: o.id } })).endedAt).toBeNull();
      }
    });

    it('#1625 P2-2: a bind of a name the caller ALREADY holds still waits on the Worker lock', async () => {
      const w = await heldBy(contrib.id);
      let unblock!: () => void;
      const gate = new Promise<void>((r) => { unblock = r; });
      let locked!: () => void;
      const lockedNow = new Promise<void>((r) => { locked = r; });
      const blocker = db.$transaction(async (tx) => {
        // NO KEY UPDATE: it conflicts with the bind's FOR UPDATE but NOT with the
        // KEY SHARE the session insert's foreign key takes, so only the bind's
        // own Worker lock can park it here.
        await tx.$queryRaw`SELECT id FROM workers WHERE id = ${w.id} FOR NO KEY UPDATE`;
        locked();
        await gate;
      }, { timeout: 20_000 });
      await lockedNow;
      const binding = bind(contrib.id, w.id);
      await waitForLockWaiters(db, 1, 3_000); // the bind is parked on the Worker lock
      unblock();
      await blocker;
      expect((await binding).workerId).toBe(w.id);
    });

    it('#1625 P2-2: WORKER_TAKEN is re-decided under the lock, after a session went live during the wait', async () => {
      const w = await heldBy(contrib.id);
      let unblock!: () => void;
      const gate = new Promise<void>((r) => { unblock = r; });
      let locked!: () => void;
      const lockedNow = new Promise<void>((r) => { locked = r; });
      const blocker = db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM workers WHERE id = ${w.id} FOR UPDATE`;
        locked();
        await gate;
        // A concurrent bind's row, committed while ours waits.
        await tx.session.create({
          data: { id: generateId(), userId: contrib.id, appId: app.id, workerId: w.id, type: 'DEVELOPER', startedAt: new Date() },
        });
      }, { timeout: 20_000 });
      await lockedNow;
      const binding = bind(contrib.id, w.id).catch((e: unknown) => e);
      await waitForLockWaiters(db, 1, 3_000);
      unblock();
      await blocker;
      expect(await binding).toMatchObject({ extensions: { code: 'WORKER_TAKEN' } });
    });

    it('#1625 residual P2: a hold taken by someone else during the lock wait refuses even a FORCED bind', async () => {
      const w = await heldBy(contrib.id);
      let unblock!: () => void;
      const gate = new Promise<void>((r) => { unblock = r; });
      let locked!: () => void;
      const lockedNow = new Promise<void>((r) => { locked = r; });
      const blocker = db.$transaction(async (tx) => {
        // NO KEY UPDATE, so only the bind's own Worker lock parks it (see above).
        await tx.$queryRaw`SELECT id FROM workers WHERE id = ${w.id} FOR NO KEY UPDATE`;
        locked();
        await gate;
        // A release and a re-claim by another person, committed while the bind waits.
        await tx.worker.update({ where: { id: w.id }, data: { heldByUserId: appMember.id, heldAt: new Date() } });
      }, { timeout: 20_000 });
      await lockedNow;
      const binding = bind(contrib.id, w.id, true).catch((e: unknown) => e);
      await waitForLockWaiters(db, 1, 3_000);
      unblock();
      await blocker;
      expect(await binding).toMatchObject({ extensions: { code: 'WORKER_HELD' } });
      expect(await db.session.count({ where: { workerId: w.id, userId: contrib.id, endedAt: null } })).toBe(0);
    });

    it('#1625 P2-2: two concurrent forced binds by the holder leave exactly ONE open session', async () => {
      const w = await heldBy(contrib.id);
      await Promise.all([bind(contrib.id, w.id, true), bind(contrib.id, w.id, true)]);
      expect(await db.session.count({ where: { workerId: w.id, endedAt: null } })).toBe(1);
    });

    it('chains the new session to the NEWEST superseded row', async () => {
      const w = await heldBy(contrib.id);
      const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
      const older = await db.session.create({
        data: { id: generateId(), userId: contrib.id, appId: app.id, workerId: w.id, type: 'DEVELOPER', startedAt: new Date(old.getTime() - 60_000), updatedAt: old },
      });
      const newer = await db.session.create({
        data: { id: generateId(), userId: contrib.id, appId: app.id, workerId: w.id, type: 'DEVELOPER', startedAt: old, updatedAt: old },
      });
      const next = await bind(contrib.id, w.id);
      expect(next.prevSessionId).toBe(newer.id);
      for (const id of [older.id, newer.id]) {
        expect((await db.session.findUniqueOrThrow({ where: { id } })).summary).toBe(`superseded by session ${next.id}`);
      }
    });

    it('keeps a summary the driver already wrote', async () => {
      const w = await heldBy(contrib.id);
      const first = await bind(contrib.id, w.id);
      const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
      await db.session.update({ where: { id: first.id }, data: { startedAt: old, updatedAt: old, summary: 'mid #1617' } });
      await bind(contrib.id, w.id);
      const prior = await db.session.findUniqueOrThrow({ where: { id: first.id } });
      expect(prior.endedAt).not.toBeNull();
      expect(prior.summary).toBe('mid #1617');
    });
  });

  it('a session driven a moment ago still refuses, so the gate did not just go away', async () => {
    // The control. Without it, deleting the WORKER_TAKEN check entirely would
    // pass the test above.
    const w = await heldBy(contrib.id);
    await bind(contrib.id, w.id);
    await expectCode(bind(contrib.id, w.id), 'WORKER_TAKEN');
  });

  it('a stale session that gets a usage event refuses again', async () => {
    // Liveness is recency of DRIVING, and a usage event is one of the three
    // heartbeat inputs — so the gate must see it, not just the session row.
    const w = await heldBy(contrib.id);
    const first = await bind(contrib.id, w.id);
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
    await db.session.updateMany({
      where: { id: first.id }, data: { startedAt: old, updatedAt: old },
    });
    await db.usageEvent.create({
      data: { countsAsActivity: true, id: generateId(), sessionId: first.id, type: 'read', createdAt: new Date() },
    });
    await expectCode(bind(contrib.id, w.id), 'WORKER_TAKEN');
  });

  // #1034: the WORKER_TAKEN message is where the worker-session/chat-session
  // collision reaches a human, and it is the failure a team new to the surface
  // walks into — archive the window, assume the worker came free, meet a
  // refusal with no way to read it.
  it('a takeover refusal on YOUR OWN open session says so, and explains the chat session did not end it', async () => {
    // Post-#1050 this is the common shape: the name is yours, so HELD does not
    // fire, and what you meet is your own binding left open by a conversation
    // that closed. Telling the driver "show the user who is driving it" — the
    // old wording — sends them looking for a colleague who does not exist.
    const w = await heldBy(contrib.id);
    await bind(contrib.id, w.id);

    await expect(bind(contrib.id, w.id)).rejects.toThrow(/worker session/i);
    try {
      await bind(contrib.id, w.id);
      expect.unreachable('binding an already-bound worker must refuse');
    } catch (e) {
      const msg = (e as GraphQLError).message;
      expect(msg).toMatch(/YOUR OWN/);
      expect(msg).toMatch(/ending a chat session never ends a worker session/i);
      // And NOT the other-driver instruction, which is the wrong action here.
      expect(msg).not.toMatch(/show the user who is driving it/i);
    }
  });

  it("a takeover refusal on someone ELSE's session keeps the show-the-user instruction", async () => {
    // The two arms must stay distinct: naming the caller's own session is only
    // right when it IS theirs. An unheld worker driven by another member still
    // refuses TAKEN, and there the original instruction is the correct one.
    const w = await cast({ agentRef: roleAgent.id, name: 'Kira' }, ctx(admin.id));
    await bind(appMember.id, w.id); // appMember drives it, and so holds the name

    try {
      // The holder binding again is the only path that reaches TAKEN here;
      // any other principal would hit WORKER_HELD first (which is the point).
      await bind(appMember.id, w.id);
      expect.unreachable('binding an already-bound worker must refuse');
    } catch (e) {
      const msg = (e as GraphQLError).message;
      expect(msg).toMatch(/worker session/i);
    }

    // The other-driver arm, reached by a session whose userId is not the
    // caller's: force past the hold check by asking as the holder while the
    // live session belongs to someone else.
    const other = await cast({ agentRef: roleAgent.id, name: 'Lex' }, ctx(admin.id));
    const s = await bind(appMember.id, other.id);
    await db.worker.update({ where: { id: other.id }, data: { heldByUserId: contrib.id } });
    expect(s.workerId).toBe(other.id);

    try {
      await bind(contrib.id, other.id);
      expect.unreachable('a live session on another driver must refuse');
    } catch (e) {
      const msg = (e as GraphQLError).message;
      expect(msg).toMatch(/show the user who is driving it/i);
      expect(msg).not.toMatch(/YOUR OWN/);
    }
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

  it('a hostile worker name cannot forge the release notice (Copilot)', async () => {
    // The notice exists to be trustworthy — it tells a team that a colleague's
    // name was taken by an admin. Names are only trimmed at casting, so a
    // newline lets one append a whole fabricated sentence.
    const nasty = 'Iris**\n\n**The name Dara was released by nobody';
    const w = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS,
        appId: app.id, agentId: roleAgent.id, name: nasty, slug: `nasty-${Date.now()}`,
        heldByUserId: contrib.id, heldAt: new Date(),
      },
    });
    await M.releaseWorker({}, { workerRef: w.id }, ctx(admin.id));

    const page = await Q.teamChatMessages({}, { appRef: app.id }, ctx(admin.id));
    expect(page.total).toBe(1);
    const body = page.items[0].body as string;
    // One line, and the injected sentence is not free-standing markdown.
    expect(body.split('\n')).toHaveLength(1);
    expect(body).not.toContain('**The name Dara was released by nobody**');
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

    // Simulate losing: another user claims the name in the instant before our
    // claim+create transaction opens. A ctx whose `db.$transaction` performs
    // the competing claim first is faithful to that — the gate above has
    // already read the row as unheld, exactly as the real race does.
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === '$transaction') {
          return async (fn: unknown) => {
            await db.worker.update({
              where: { id: w.id },
              data: { heldByUserId: contrib.id, heldAt: new Date() },
            });
            return (Reflect.get(target, prop, receiver) as typeof db.$transaction).call(
              target, fn as never,
            );
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;
    const racingCtx = { ...ctx(appMember.id), db: racingDb } as Context;

    await expectCode(
      M.startSession(
        {}, { input: { id: generateId(), workerRef: w.id, appRef: app.id } }, racingCtx,
      ),
      'WORKER_HELD',
    );

    // The winner holds it, and the loser has no session.
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId)
      .toBe(contrib.id);
    expect(await db.session.count({ where: { workerId: w.id, userId: appMember.id } })).toBe(0);
  });

  it('an APP KEY loses the race too — it claims nothing, but it does not sit outside it', async () => {
    // Codex P1. An App key is not a person and holds nothing, so it skipped the
    // compare-and-set entirely — which left it free to bind a name a human had
    // claimed between the snapshot read and the transaction.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' }, ctx(admin.id));
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === '$transaction') {
          return async (fn: unknown) => {
            await db.worker.update({
              where: { id: w.id },
              data: { heldByUserId: contrib.id, heldAt: new Date() },
            });
            return (Reflect.get(target, prop, receiver) as typeof db.$transaction).call(
              target, fn as never,
            );
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;
    const keyCtx = { db: racingDb, appId: app.id, roles: [] } as unknown as Context;

    await expectCode(
      M.startSession({}, { input: { id: generateId(), workerRef: w.id } }, keyCtx),
      'WORKER_HELD',
    );
    expect(await db.session.count({ where: { workerId: w.id } })).toBe(0);
  });

  it('a REVOKED member cannot take a name on a stale App selection', async () => {
    // Codex P1, and it is #1037's own rule applied to this PR's new write: when
    // appId came from an MCP active-App SELECTION and the worker is of that
    // same App, neither gate above re-runs isAppParticipant — so a member whose
    // access was revoked while their connection stayed open could take a name
    // and block the people who do belong. A hold is standing, not just scope.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' }, ctx(admin.id));
    const gone = await db.user.create({
      data: { id: generateId(), githubId: 96201, githubUsername: `wh-gone-${Date.now()}`, roles: ['READER'] },
    });
    const membership = await db.appMember.create({
      data: { appId: app.id, userId: gone.id, role: 'member' },
    });
    // The selection is still pinned to the App; the membership is gone.
    await db.appMember.delete({
      where: { appId_userId: { appId: membership.appId, userId: membership.userId } },
    });

    // #1937: a revoked member reads the App's staff no more than anyone else does, so the
    // answer is the absent ref's, not a FORBIDDEN that says the worker exists.
    await expectCode(
      M.startSession(
        {}, { input: { id: generateId(), workerRef: w.id } }, ctx(gone.id, app.id),
      ),
      'WORKER_NOT_FOUND',
    );
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId).toBeNull();
  });

  it('a SOFT-DELETED claimant cannot take a name', async () => {
    // Codex P2: a start already in flight when deleteUserAccount runs could
    // land its claim after the deletion released everything, leaving an
    // unauthenticatable tombstone holding the worker. The User row survives a
    // soft delete, so the FK cannot catch it.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' }, ctx(admin.id));
    await db.user.update({ where: { id: contrib.id }, data: { deletedAt: new Date() } });
    try {
      await expectCode(
        M.startSession(
          {}, { input: { id: generateId(), workerRef: w.id, appRef: app.id } }, ctx(contrib.id),
        ),
        'FORBIDDEN',
      );
      expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId).toBeNull();
    } finally {
      await db.user.update({ where: { id: contrib.id }, data: { deletedAt: null } });
    }
  });

  it('a FAILED bind does not leave the name claimed — claim and create are one act', async () => {
    // The claim used to commit as a separate write before session.create ran,
    // so a create that then failed left the caller holding a name they never
    // bound. They are one transaction now.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' }, ctx(admin.id));
    const dupe = generateId();
    await M.startSession({}, { input: { id: dupe, appRef: app.id } }, ctx(appReader.id));

    // Same session id → the create fails, after the claim would have committed.
    await expect(
      M.startSession(
        {}, { input: { id: dupe, workerRef: w.id, appRef: app.id } }, ctx(appMember.id),
      ),
    ).rejects.toThrow();

    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId).toBeNull();
  });

  it('holder fields are masked for a caller outside the App', async () => {
    // Session.worker reaches a Worker row through a gate that admits any org
    // member and survives a user leaving the App (#983), so an ungated holder
    // would let a former member read current staffing off a historical session.
    const w = await heldBy(contrib.id);
    const row = await db.worker.findUniqueOrThrow({ where: { id: w.id } });
    expect(await W.heldByUserId(row, {}, ctx(contrib.id))).toBe(contrib.id);
    expect(await W.heldByUserId(row, {}, ctx(outsider.id))).toBeNull();
    expect(await W.heldAt(row, {}, ctx(outsider.id))).toBeNull();
  });

  it('heldAt reads null when there is no holder, even if the column lags', async () => {
    // The FK is ON DELETE SET NULL and Postgres clears only the id column, so
    // a raw hard delete of a user leaves a vestigial timestamp. The invariant
    // holds because the field enforces it.
    const w = await heldBy(contrib.id);
    await db.worker.update({ where: { id: w.id }, data: { heldByUserId: null } });
    const row = await db.worker.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.heldAt).not.toBeNull(); // the column still carries it
    expect(await W.heldAt(row, {}, ctx(contrib.id))).toBeNull();
  });

  it('releaseWorker is not a read surface for workers you may not see', async () => {
    // The idempotent "already unheld" return sat ABOVE every access check, so a
    // caller holding an id or URN could confirm a foreign worker exists and
    // collect its scalars through a mutation, while Query.worker would refuse
    // them. A shortcut placed above an authorization check is an authorization
    // hole whatever the shortcut is for.
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' }, ctx(admin.id));
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId).toBeNull();
    // #1742: and the refusal itself reads like an absent worker.
    await expectCode(M.releaseWorker({}, { workerRef: w.id }, ctx(outsider.id)), 'WORKER_NOT_FOUND');
  });

  it('releasing an unheld worker is idempotent, not an error', async () => {
    const w = await heldBy(contrib.id);
    await M.releaseWorker({}, { workerRef: w.id }, ctx(contrib.id));
    const again = await M.releaseWorker({}, { workerRef: w.id }, ctx(contrib.id));
    expect(again.worker.heldByUserId).toBeNull();
    // #1073: nothing was released, and the payload says so rather than
    // implying an act. This is what makes `forced: false` unambiguous here.
    expect(again.releasedFromUserId).toBeNull();
    expect(again.forced).toBe(false);
    expect(again.notified).toBeNull();
  });

  // ── #1073 — the payload: what the call DID, not what the caller predicted ──
  //
  // `releaseWorker` used to return the post-release Worker, whose
  // heldByUserId is null by construction, so a client could report only who
  // held the name when it last looked. Per cor:agt:020:09 the two paths are
  // different ACTS, and a receipt that cannot tell them apart describes an act
  // that may not have happened.
  describe('the release payload (#1073)', () => {
    it('a SELF-release: names the holder ended, forced false, no notice owed', async () => {
      const w = await heldBy(contrib.id);
      const out = await M.releaseWorker({}, { workerRef: w.id }, ctx(contrib.id));

      expect(out.worker.heldByUserId).toBeNull();
      // The holder the WRITE ended — reported even though the returned Worker
      // can no longer carry it, which is the whole gap this closes.
      expect(out.releasedFromUserId).toBe(contrib.id);
      expect(out.forced).toBe(false);
      // null, NOT false: no notice was owed. Collapsing these is what would
      // make "we may have silently failed to announce this" unrenderable.
      expect(out.notified).toBeNull();
    });

    it('an ADMIN force-release: forced true, and the notice reported as posted', async () => {
      const w = await heldBy(contrib.id);
      const out = await M.releaseWorker({}, { workerRef: w.id }, ctx(admin.id));

      expect(out.releasedFromUserId).toBe(contrib.id);
      expect(out.forced).toBe(true);
      expect(out.notified).toBe(true);
    });

    it('forced distinguishes the ACTS, not the callers — same admin, both paths', async () => {
      // The discriminating pair. `forced` is "was that holder someone other
      // than me", not "am I an admin" — an admin releasing their OWN name is
      // not a force-release and owes no notice.
      const own = await heldBy(admin.id, 'Ada');
      const ownOut = await M.releaseWorker({}, { workerRef: own.id }, ctx(admin.id));
      expect(ownOut.forced).toBe(false);
      expect(ownOut.notified).toBeNull();

      const other = await heldBy(contrib.id, 'Gil');
      const otherOut = await M.releaseWorker({}, { workerRef: other.id }, ctx(admin.id));
      expect(otherOut.forced).toBe(true);
      expect(otherOut.notified).toBe(true);
    });

    it('releasedFrom resolves to the user, and is null when nothing was released', async () => {
      const w = await heldBy(contrib.id);
      const out = await M.releaseWorker({}, { workerRef: w.id }, ctx(contrib.id));
      const user = await F.ReleaseWorkerPayload.releasedFrom(out, {}, ctx(contrib.id));
      expect(user?.id).toBe(contrib.id);

      const again = await M.releaseWorker({}, { workerRef: w.id }, ctx(contrib.id));
      expect(await F.ReleaseWorkerPayload.releasedFrom(again, {}, ctx(contrib.id))).toBeNull();
    });

    // ── PR #1124 review, Codex P1 — releasedFrom is SANITIZED ────────────────
    //
    // It shipped as a full `User` on the argument that this audience can
    // already read the same object through `AppMember.user`. Both halves of
    // that are false where it matters: `leaveApp` DELETES the AppMember row
    // and leaves the hold standing, which is the departed colleague the
    // force-release path exists for; and `Worker` only ever exposed
    // `heldByUserId`, a bare id, so there was no route from this surface to a
    // `User` to inherit.
    it('releasedFrom carries ONLY the sanitized projection, never User’s ungated tail', async () => {
      // The discriminating assertion is on the KEY SET, not on a sample of
      // field values: `policy`, `identityProvider`, `externalId`, `githubId`,
      // `roles` and `maxReferrals` default-resolve on `User` with no gate of
      // their own. Dropping the `select` puts every one of them back, and only
      // a key-set assertion reds on that.
      const w = await heldBy(contrib.id);
      const out = await M.releaseWorker({}, { workerRef: w.id }, ctx(contrib.id));
      const projection = await F.ReleaseWorkerPayload.releasedFrom(out, {}, ctx(contrib.id));

      expect(Object.keys(projection!).sort()).toEqual(['handle', 'id', 'name']);
      for (const leaked of ['policy', 'identityProvider', 'externalId', 'githubId', 'roles']) {
        expect(projection).not.toHaveProperty(leaked);
      }
    });

    it('an app-only holder’s name is withheld from the admin who released them', async () => {
      // The case the P1 named, built rather than argued. `appMember` holds a
      // name and is in the App but in NO org, which is what a departed
      // colleague looks like after `leaveApp` — so the org ADMIN who may force
      // -release them has no other route to their `User`, and the #384 gate
      // must still answer for `name`.
      await db.user.update({
        where: { id: appMember.id },
        data: { name: 'Departed Colleague', handle: 'departed-colleague' },
      });
      const w = await heldBy(appMember.id, 'Ada');
      const out = await M.releaseWorker({}, { workerRef: w.id }, ctx(admin.id));
      expect(out.forced).toBe(true);

      const seenByAdmin = await F.ReleaseWorkerPayload.releasedFrom(out, {}, ctx(admin.id));
      // Who, yes — the release is unusable otherwise. Their name, no.
      expect(seenByAdmin!.id).toBe(appMember.id);
      expect(seenByAdmin!.handle).toBe('departed-colleague');
      expect(await F.ReleasedFromUser.name(seenByAdmin, {}, ctx(admin.id))).toBeNull();
      // And the gate is the shared one, so the user themselves still sees it.
      expect(await F.ReleasedFromUser.name(seenByAdmin, {}, ctx(appMember.id))).toBe(
        'Departed Colleague',
      );
    });

    it('a co-member DOES see the name — the gate, not a blanket withholding', async () => {
      // The other side of the pair. Without this, replacing the gate with
      // `() => null` would pass, and the field would be decorative.
      await db.user.update({ where: { id: contrib.id }, data: { name: 'Contrib Person' } });
      const w = await heldBy(contrib.id);
      const out = await M.releaseWorker({}, { workerRef: w.id }, ctx(admin.id));
      const seen = await F.ReleaseWorkerPayload.releasedFrom(out, {}, ctx(admin.id));
      expect(await F.ReleasedFromUser.name(seen, {}, ctx(admin.id))).toBe('Contrib Person');
    });

    it('worker is read back BEFORE the team-chat notice, not after', async () => {
      // Codex P2. The notice is a network call; re-reading after it widened the
      // window in which another caller could bind to the length of that call,
      // so the payload could carry a NEW holder. Driven by binding the name
      // from inside the notice — the interval, made observable.
      const w = await heldBy(contrib.id);
      const teamChat = await import('./resolvers.teamChat.js');
      const spy = vi
        .spyOn(teamChat.teamChatMutations, 'createTeamChatMessage')
        .mockImplementation(async () => {
          await db.worker.update({
            where: { id: w.id },
            data: { heldByUserId: outsider.id, heldAt: new Date() },
          });
          return {} as never;
        });
      try {
        const out = await M.releaseWorker({}, { workerRef: w.id }, ctx(admin.id));
        // Reading after the notice would report the interloper's hold while
        // documenting a null one.
        expect(out.worker.heldByUserId).toBeNull();
        expect(out.releasedFromUserId).toBe(contrib.id);
      } finally {
        spy.mockRestore();
      }
    });

    it('reports notified: false when the notice was OWED and failed', async () => {
      // The state a plain boolean cannot express, and the reason for the
      // tri-state: the release STOOD and the announcement did not happen. An
      // unreachable chat must never block an admin recovering a departed
      // colleague's names — but the caller has to be able to see it.
      const w = await heldBy(contrib.id);
      const teamChat = await import('./resolvers.teamChat.js');
      const spy = vi
        .spyOn(teamChat.teamChatMutations, 'createTeamChatMessage')
        .mockRejectedValue(new Error('chat unreachable'));
      try {
        const out = await M.releaseWorker({}, { workerRef: w.id }, ctx(admin.id));
        expect(out.forced).toBe(true);
        expect(out.notified).toBe(false);
        // The release itself still happened — that is the contract.
        expect(out.worker.heldByUserId).toBeNull();
        expect(out.releasedFromUserId).toBe(contrib.id);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── #1073 — the optional hold precondition ────────────────────────────────
  //
  // The two release paths are different ACTS: the holder's own release
  // notifies nobody, an admin force-release announces itself in the team chat.
  // A client can only classify from a pre-read, and the hold can change in
  // between — so without a precondition the act performed differs from the act
  // described, and the dangerous direction is silent: a pre-read showing
  // "unheld" skips the confirmation entirely, so a hold taken in the interval
  // is force-released with no one asked and a public notice posted.

  it('expectedHolderUserId matching the actual holder releases normally', async () => {
    const w = await heldBy(contrib.id);
    await M.releaseWorker({}, { workerRef: w.id, expectedHolderUserId: contrib.id }, ctx(contrib.id));
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId).toBeNull();
  });

  it('expectedHolderUserId naming the WRONG holder refuses WORKER_HOLD_STALE', async () => {
    const w = await heldBy(contrib.id);
    await expectCode(
      M.releaseWorker({}, { workerRef: w.id, expectedHolderUserId: appMember.id }, ctx(admin.id)),
      'WORKER_HOLD_STALE',
    );
    // …and the hold is untouched: a refused release must not half-happen.
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId)
      .toBe(contrib.id);
  });

  it('the refusal names who holds it NOW, not the stale value the caller sent', async () => {
    const w = await heldBy(contrib.id);
    try {
      await M.releaseWorker({}, { workerRef: w.id, expectedHolderUserId: appMember.id }, ctx(admin.id));
      expect.unreachable('a stale expectation must refuse');
    } catch (e) {
      const ext = (e as GraphQLError).extensions as { heldByUserId?: string | null };
      // The caller re-prompts from this, so echoing their own guess back would
      // be worse than useless.
      expect(ext.heldByUserId).toBe(contrib.id);
    }
  });

  it('expectedHolderUserId refuses when the name has since become UNHELD', async () => {
    const w = await heldBy(contrib.id);
    await M.releaseWorker({}, { workerRef: w.id }, ctx(contrib.id)); // someone got there first
    await expectCode(
      M.releaseWorker({}, { workerRef: w.id, expectedHolderUserId: contrib.id }, ctx(admin.id)),
      'WORKER_HOLD_STALE',
    );
  });

  it('expectUnheld: true on an actually-unheld name is the idempotent no-op', async () => {
    const w = await cast({ agentRef: roleAgent.id, name: 'Nia' }, ctx(admin.id));
    const out = await M.releaseWorker({}, { workerRef: w.id, expectUnheld: true }, ctx(admin.id));
    expect((out.worker as { heldByUserId: string | null }).heldByUserId).toBeNull();
    expect(out.releasedFromUserId).toBeNull();
  });

  it('expectUnheld: true refuses when a hold was taken in the interval — the silent force-release', async () => {
    // THE case #1073 exists for. Without the assertion this call would
    // force-release contrib's hold, post a public notice, and report success
    // to an admin who was never asked, because their pre-read said "unheld".
    const w = await heldBy(contrib.id);
    await expectCode(
      M.releaseWorker({}, { workerRef: w.id, expectUnheld: true }, ctx(admin.id)),
      'WORKER_HOLD_STALE',
    );
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId)
      .toBe(contrib.id);
    // …and crucially NO team-chat notice was posted, because no release
    // happened. "Refused" and "released but quietly" are indistinguishable from
    // the worker row alone, and the notice is the part a caller must not
    // discover afterwards.
    // loc-scope-ok: deliberately cross-memory — `cleanDb` runs per test, so
    // "no chat node exists ANYWHERE" is a strictly stronger assertion than
    // scoping to one memory, and it cannot pass by looking in the wrong place.
    const posts = await db.node.count({ where: { loc: { startsWith: 'chats:team' } } });
    expect(posts).toBe(0);
  });

  it('a HOLDER asserting a different user is refused, not authorized as the holder', async () => {
    // PR #1084 review, Codex P1. Everything after the assertion decides
    // authorization from the hold we READ — the isHolder branch, the admin gate
    // it skips, and the notice only a non-holder release posts. If the guarded
    // write could target a different user than that decision was made against,
    // holder A asserting B (with the hold moving A→B in between) would release
    // B under A's holder authorization, skipping the admin gate AND the public
    // notice: the silent force-release this feature exists to prevent,
    // reintroduced by the mechanism meant to prevent it.
    const w = await heldBy(contrib.id);
    await expectCode(
      // contrib IS the holder, so without this rejection they are authorized —
      // and appMember is somebody else entirely.
      M.releaseWorker(
        {}, { workerRef: w.id, expectedHolderUserId: appMember.id }, ctx(contrib.id),
      ),
      'WORKER_HOLD_STALE',
    );
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId)
      .toBe(contrib.id);
  });

  it('the refusal does not claim a force-release when the caller holds it themselves', async () => {
    // PR #1084 review, Copilot. The throw happens BEFORE the holder is compared
    // to the caller, so the account now holding the name may BE the caller — a
    // caller asserting expectUnheld who turns out to hold it is the plain case.
    // Releasing then posts nothing and is not a force-release, so a message
    // saying "someone else" or "this would be a force-release" would send them
    // to a confirmation they do not owe.
    const w = await heldBy(contrib.id);
    try {
      await M.releaseWorker({}, { workerRef: w.id, expectUnheld: true }, ctx(contrib.id));
      expect.unreachable('a stale unheld assertion must refuse');
    } catch (e) {
      const err = e as GraphQLError;
      expect((err.extensions as { code?: string }).code).toBe('WORKER_HOLD_STALE');
      expect(err.message).not.toMatch(/someone else/i);
      expect(err.message).not.toMatch(/force-release/i);
      // The client decides the relationship itself, from the id it is handed.
      expect((err.extensions as { heldByUserId?: string | null }).heldByUserId).toBe(contrib.id);
    }
  });

  it('passing BOTH assertions is BAD_USER_INPUT — they contradict', async () => {
    const w = await heldBy(contrib.id);
    await expectCode(
      M.releaseWorker(
        {}, { workerRef: w.id, expectedHolderUserId: contrib.id, expectUnheld: true }, ctx(admin.id),
      ),
      'BAD_USER_INPUT',
    );
  });

  it('passing NEITHER keeps the unconditional behaviour — the change is additive', async () => {
    const w = await heldBy(contrib.id);
    await M.releaseWorker({}, { workerRef: w.id }, ctx(admin.id));
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId).toBeNull();
  });

  it('a forwarded undefined is NOT an assertion — presence semantics are not relied on', async () => {
    // findings:optional-arg-meets-presence-semantics: a layer that forwards the
    // argument unconditionally sends undefined, which is PRESENT. If that were
    // read as an assertion, every such caller would start being refused.
    const w = await heldBy(contrib.id);
    await M.releaseWorker(
      {},
      { workerRef: w.id, expectedHolderUserId: undefined, expectUnheld: undefined },
      ctx(contrib.id),
    );
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId).toBeNull();
  });

});

describe('#1050 — deleting a holder releases their names', () => {
  it('a soft-deleted account stops holding, and the casting survives intact', async () => {
    // The FK is ON DELETE SET NULL, but deleteUserAccount SOFT-deletes the User
    // row, so that action never fires: an unauthenticatable tombstone would go
    // on holding every one of its names forever, and each subsequent binder
    // would be refused by an account that cannot release them (PR #1052 review,
    // Codex P2). Holding must not strand a name behind someone who is gone.
    const leaver = await db.user.create({
      data: { id: generateId(), githubId: 96001, githubUsername: `wh-leaver-${Date.now()}`, roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: leaver.id, role: 'CONTRIBUTOR' },
    });
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' }, ctx(admin.id));
    await M.startSession(
      {}, { input: { id: generateId(), workerRef: w.id, appRef: app.id } }, ctx(leaver.id),
    );
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId)
      .toBe(leaver.id);

    await deleteUserAccount(db, { targetUserId: leaver.id, actorUserId: leaver.id });

    const after = await db.worker.findUniqueOrThrow({ where: { id: w.id } });
    expect(after.heldByUserId).toBeNull();
    expect(after.heldAt).toBeNull();
    // The casting itself is untouched — the name stays allocated to it.
    expect(after.name).toBe('Iris');
    expect(after.retiredAt).toBeNull();
  });
});

/**
 * #2252 Slice A (R189) — Worker.model / modelReportedAt / tier: derived read fields.
 *
 * Same fold and same gate as `family`: the newest open session's report, never
 * an older session's when the newest reported none, masked to null on deny.
 * Self-declared and advisory; nothing here authorizes or routes.
 */
describe('#2252 — Worker.model / modelReportedAt / tier', () => {
  const OPUS = 'claude-opus-5-5';
  const SONNET = 'claude-sonnet-5-5';
  const mins = (n: number) => new Date(Date.now() - n * 60_000);
  const fields = async (workerId: string, c: Context = ctx(admin.id)) => {
    const row = await db.worker.findUniqueOrThrow({ where: { id: workerId } });
    return {
      model: await W.model(row, {}, c),
      modelReportedAt: await W.modelReportedAt(row, {}, c),
      tier: await W.tier(row, {}, c),
    };
  };
  const open = (workerId: string, data: Record<string, unknown> = {}) =>
    db.session.create({ data: { id: generateId(), workerId, appId: app.id, userId: appMember.id, ...data } });

  it('is null on every field for an unbound worker, and once its session ends', async () => {
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    expect(await fields(w.id)).toEqual({ model: null, modelReportedAt: null, tier: null });
    const s = await open(w.id, { llmModel: OPUS, modelReportedAt: mins(5), startedAt: mins(10) });
    expect(await fields(w.id)).toMatchObject({ model: OPUS, tier: 'high' });
    await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
    expect(await fields(w.id)).toEqual({ model: null, modelReportedAt: null, tier: null });
  });

  it('reads the newest open session, and a newer bind that reported none does not inherit the older one\'s', async () => {
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const reported = mins(30);
    await open(w.id, { llmModel: OPUS, modelReportedAt: reported, startedAt: mins(60) });
    expect(await fields(w.id)).toEqual({ model: OPUS, modelReportedAt: reported, tier: 'high' });
    await open(w.id, { startedAt: mins(10) });
    expect(await fields(w.id)).toEqual({ model: null, modelReportedAt: null, tier: null });
  });

  it('model and timestamp belong to the SAME session, and a tied start breaks by id', async () => {
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const at = mins(20);
    const low = await db.session.create({ data: { id: '0000-low', workerId: w.id, appId: app.id, userId: appMember.id, startedAt: at, llmModel: OPUS, modelReportedAt: mins(3) } });
    const high = await db.session.create({ data: { id: 'zzzz-high', workerId: w.id, appId: app.id, userId: appMember.id, startedAt: at, llmModel: SONNET, modelReportedAt: mins(9) } });
    expect(low.id < high.id).toBe(true);
    expect(await fields(w.id)).toEqual({ model: SONNET, modelReportedAt: high.modelReportedAt, tier: 'mid' });
  });

  it('a report stamps modelReportedAt: bind, update, and a repeated same-model report refreshes it; other writes and a null report do not', async () => {
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    const s = await M.startSession({}, { input: { id: generateId(), workerRef: w.id, appRef: app.id, llmModel: SONNET } }, ctx(appMember.id));
    const first = (await fields(w.id)).modelReportedAt as Date;
    expect(first).toBeInstanceOf(Date);
    expect(Math.abs(first.getTime() - Date.now())).toBeLessThan(60_000);
    await db.session.update({ where: { id: s.id }, data: { modelReportedAt: mins(120) } });
    const old = (await fields(w.id)).modelReportedAt as Date;
    // Unrelated writes (a branch edit, a model-less update) never move it.
    await M.updateSession({}, { id: s.id, branch: 'feature/x' }, ctx(appMember.id));
    await M.updateSession({}, { id: s.id, llmModel: null }, ctx(appMember.id));
    expect((await fields(w.id)).modelReportedAt).toEqual(old);
    // The same model reported again is still a report.
    await M.updateSession({}, { id: s.id, llmModel: SONNET }, ctx(appMember.id));
    const again = (await fields(w.id)).modelReportedAt as Date;
    expect(again.getTime()).toBeGreaterThan(old.getTime());
    // A switch changes model and tier on the next read.
    await M.updateSession({}, { id: s.id, llmModel: OPUS }, ctx(appMember.id));
    expect(await fields(w.id)).toMatchObject({ model: OPUS, tier: 'high' });
  });

  it('a session that never reported keeps a null timestamp even when it has a model (no historical backfill)', async () => {
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    await open(w.id, { llmModel: SONNET });
    expect(await fields(w.id)).toEqual({ model: SONNET, modelReportedAt: null, tier: 'mid' });
  });

  it('an unmapped model has a model and no tier', async () => {
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    await open(w.id, { llmModel: 'gpt-5.1-codex', modelReportedAt: mins(1) });
    expect(await fields(w.id)).toMatchObject({ model: 'gpt-5.1-codex', tier: null });
  });

  it('is masked to null for a caller outside the App, on the same gate as family', async () => {
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    await open(w.id, { llmModel: OPUS, modelReportedAt: mins(1) });
    expect(await fields(w.id, ctx(outsider.id))).toEqual({ model: null, modelReportedAt: null, tier: null });
  });

  it('the held-workers page serves them from the same single fold query', async () => {
    const w = await cast({ agentRef: roleAgent.id, name: 'Iris' });
    await db.worker.update({ where: { id: w.id }, data: { heldByUserId: appMember.id } });
    await open(w.id, { llmModel: OPUS, modelReportedAt: mins(1) });
    const raw = vi.spyOn(db, '$queryRaw');
    try {
      const page = await Q.heldWorkers({}, { userRef: appMember.id }, ctx(admin.id));
      const row = page.items.find((r: { id: string }) => r.id === w.id);
      expect(await W.model(row, {}, ctx(admin.id))).toBe(OPUS);
      expect(await W.tier(row, {}, ctx(admin.id))).toBe('high');
      expect(await W.modelReportedAt(row, {}, ctx(admin.id))).toBeInstanceOf(Date);
      expect(raw).toHaveBeenCalledTimes(1);
    } finally {
      raw.mockRestore();
    }
  });
});
