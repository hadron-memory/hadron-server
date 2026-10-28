import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #960 — the team-role platform surface: teamRoles read +
 * createTeamRole/updateTeamRole writes.
 *
 * The read's reason to exist is the FREE column: `taken` is judged against
 * the App's FULL worker roster (names unique per App, case-insensitively,
 * forever — cor:agt:020:02/#972), which a client cannot see in full, so a
 * client-computed column systematically over-reports names as free (the
 * hadron-cli#383 failure shape). The writes own the register-diff invariants
 * (hadron-cli#410): a minted name never leaves the register, no name in two
 * of the App's registers, sibling data keys always survive, added names
 * validate against nameRange.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import * as nodeWrite from './resolvers.mutation.node.js';
import { workerSlugBase } from '../../../lib/workerSlug.js';

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
let contrib: { id: string };
let reader: { id: string };
let appMember: { id: string };
let outsider: { id: string };
let teamAgent: { id: string; urn: string; systemMemoryId: string };
let roleAgent: { id: string };
let app: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'tr-org', urn: `tr-org-${suffix}.com` },
  });
  const mkUser = async (n: number) =>
    db.user.create({
      data: { id: generateId(), githubId: 98100 + n, githubUsername: `tr${n}-${suffix}`, roles: ['READER'] },
    });
  admin = await mkUser(1);
  contrib = await mkUser(2);
  reader = await mkUser(3);
  appMember = await mkUser(4);
  outsider = await mkUser(5);
  await db.orgMember.createMany({
    data: [
      { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
      { id: generateId(), organizationId: org.id, userId: contrib.id, role: 'CONTRIBUTOR' },
      { id: generateId(), organizationId: org.id, userId: reader.id, role: 'READER' },
    ],
  });

  const created = await M.createAgent({}, { orgId: org.id, name: 'TR Team Agent' }, ctx(admin.id));
  teamAgent = { id: created.id, urn: created.urn, systemMemoryId: created.systemMemoryId };
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      description: 'Server-side work',
      data: {
        names: ['Fred', 'Gwen', 'Hans'],
        nameRange: 'F-J',
        nameConvention: 'Initial identifies the role at a glance.',
      },
    },
  });
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:frontend-engineer',
      name: 'frontend-engineer',
      data: { names: ['Kira', 'Liam'] },
    },
  });
  // A role SUB-node — content under a role, not a role definition.
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:backend-engineer:notes',
      name: 'notes',
    },
  });

  const role = await M.createAgent(
    {},
    {
      orgId: org.id,
      name: 'TR Backend Engineer',
      personaRole: 'backend-engineer',
      systemPrompt: 'You are {{name}}, a {{role}}.',
    },
    ctx(admin.id),
  );
  roleAgent = { id: role.id };

  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'TR Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: roleAgent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: appMember.id, role: 'reader' } });
});

const teamRoles = (c: Context, args: Record<string, unknown> = {}) =>
  Q.teamRoles({}, { appRef: app.id, ...args }, c);

describe('#960 — teamRoles read', () => {
  it('lists roles with their description — and NO register (#1050)', async () => {
    const page = await teamRoles(ctx(contrib.id));
    expect(page.total).toBe(2);
    const be = page.items.find((r: any) => r.role === 'backend-engineer');
    expect(be.loc).toBe('roles:backend-engineer');
    expect(be.description).toBe('Server-side work');
    // The register projection is gone from the type entirely. This read once
    // existed CHIEFLY to answer "which names are free", which needed the App's
    // full roster and so could not be computed client-side; with names no
    // longer drawn from a pool there is no such question.
    expect(be.register).toBeUndefined();
    expect(be.freeCount).toBeUndefined();
    expect(be.exhausted).toBeUndefined();
    expect(be.nameRange).toBeUndefined();
    expect(be.nameConvention).toBeUndefined();
  });

  it('a legacy data.names on the node is neither read nor projected', async () => {
    // The fixture role node still carries names, a range and a convention.
    // They stay on the node — historical record of what was allocated — and
    // the read simply does not look at them.
    const node = await db.node.findFirstOrThrow({
      where: { memoryId: teamAgent.systemMemoryId, loc: 'roles:backend-engineer' },
    });
    const data = node.data as { names?: string[]; nameRange?: string };
    expect(data.names).toEqual(['Fred', 'Gwen', 'Hans']);
    expect(data.nameRange).toBe('F-J');

    const page = await teamRoles(ctx(contrib.id));
    const be = page.items.find((r: any) => r.role === 'backend-engineer');
    expect(be.register).toBeUndefined();
    expect(be.nameRange).toBeUndefined();
  });

  it('resolves the role-agent (the casting default); hasNamePlaceholder is retired and always null (#2049)', async () => {
    const page = await teamRoles(ctx(contrib.id));
    const be = page.items.find((r: any) => r.role === 'backend-engineer');
    expect(be.roleAgent?.id).toBe(roleAgent.id);
    // No installed agent carries frontend-engineer dressing → no role-agent.
    const fe = page.items.find((r: any) => r.role === 'frontend-engineer');
    expect(fe.roleAgent).toBeNull();
    // Deprecated field: whatever the template says, it resolves null.
    for (const prompt of ['You are {{name}}.', 'You are {{worker.name}}.', 'You are a {{role}} with no name.']) {
      await db.agent.update({ where: { id: roleAgent.id }, data: { systemPrompt: prompt } });
      const again = await teamRoles(ctx(contrib.id));
      for (const item of again.items) expect(item.hasNamePlaceholder).toBeNull();
    }
  });

  it('excludes role SUB-nodes and paginates deterministically', async () => {
    const page = await teamRoles(ctx(contrib.id), { limit: 1, offset: 1 });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    // loc asc: backend-engineer, frontend-engineer.
    expect(page.items[0].role).toBe('frontend-engineer');
  });

  it('read gate: AppMember and the App\'s own key read; an outsider is refused', async () => {
    expect((await teamRoles(ctx(appMember.id))).total).toBe(2);
    expect((await teamRoles(ctx(undefined, app.id))).total).toBe(2);
    await expectCode(teamRoles(ctx(outsider.id)), 'FORBIDDEN');
  });
});

describe('#960 — createTeamRole', () => {
  it('mints roles:<role> with a description and returns the projection', async () => {
    const role = await M.createTeamRole(
      {},
      { appRef: app.id, role: 'qa-engineer', description: 'Quality work' },
      ctx(admin.id),
    );
    expect(role.role).toBe('qa-engineer');
    const node = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'roles:qa-engineer', memoryId: teamAgent.systemMemoryId } },
    });
    expect(node.description).toBe('Quality work');
    // #1050: a role definition owns no `data` at all now — it is a definition,
    // not an allocation pool.
    expect(node.data ?? null).toBeNull();
  });

  it('refuses an existing role → TEAM_ROLE_EXISTS', async () => {
    await expectCode(
      M.createTeamRole(
        {},
        { appRef: app.id, role: 'backend-engineer' },
        ctx(admin.id),
      ),
      'TEAM_ROLE_EXISTS',
    );
  });

  it('rejects a multi-atom role slug', async () => {
    await expectCode(
      M.createTeamRole({}, { appRef: app.id, role: 'a:b', names: ['X'] }, ctx(admin.id)),
      'BAD_USER_INPUT',
    );
  });

  it('two concurrent creates of ONE role cannot both land — the write lock serializes (#1050)', async () => {
    // The lock outlived the register. It no longer guards a name list; what it
    // still guards is a role DEFINITION write, where two creates of the same
    // role would otherwise both pass the TEAM_ROLE_EXISTS check and both
    // write. Renamed withRegisterLock → withRoleWriteLock to say so.
    const results = await Promise.allSettled([
      M.createTeamRole({}, { appRef: app.id, role: 'ops' }, ctx(admin.id)),
      M.createTeamRole({}, { appRef: app.id, role: 'ops' }, ctx(admin.id)),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as GraphQLError).extensions?.code).toBe('TEAM_ROLE_EXISTS');
  });

  // ── Team Agent LOCATION (#1050: moved here from the castWorker suite) ─────
  // These refusals live in locateTeamAgent and used to be exercised through a
  // nameless cast, which had to find the Team Agent to read its register.
  // Casting no longer touches a system memory at all, so the coverage moved to
  // a surface that still reaches the code rather than being deleted with the
  // path that happened to call it.

  it('no installed agent carries a roles: branch → TEAM_AGENT_NOT_FOUND', async () => {
    await db.node.deleteMany({ where: { memoryId: teamAgent.systemMemoryId } });
    await expectCode(
      M.createTeamRole({}, { appRef: app.id, role: 'ops' }, ctx(admin.id)),
      'TEAM_AGENT_NOT_FOUND',
    );
  });

  it('teamAgentRef naming an agent NOT installed here → TEAM_AGENT_NOT_INSTALLED', async () => {
    const foreign = await M.createAgent({}, { orgId: org.id, name: 'TR Foreign Team' }, ctx(admin.id));
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: foreign.systemMemoryId,
        loc: 'roles:backend-engineer',
        name: 'backend-engineer',
      },
    });
    await expectCode(
      M.createTeamRole({}, { appRef: app.id, role: 'ops', teamAgentRef: foreign.id }, ctx(admin.id)),
      'TEAM_AGENT_NOT_INSTALLED',
    );
  });

  it('an encrypted system memory without a session key refuses with the typed SESSION_EXPIRED', async () => {
    // Role node `data` is ciphertext under spec 041, and this surface still
    // reads role nodes — so the refusal survives here even though casting,
    // which no longer reads them, cannot produce it any more.
    await db.memory.update({
      where: { id: teamAgent.systemMemoryId },
      data: { isEncrypted: true },
    });
    await expectCode(
      M.createTeamRole({}, { appRef: app.id, role: 'ops' }, ctx(admin.id)),
      'SESSION_EXPIRED',
    );
  });

  it('locator errors are held behind the read-audience gate — no topology probe (#984 review)', async () => {
    // A second installed agent with a roles: branch makes the locator
    // ambiguous — TEAM_AGENT_AMBIGUOUS discloses candidate names + URNs.
    const second = await M.createAgent({}, { orgId: org.id, name: 'TR Second Team Agent' }, ctx(admin.id));
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: second.systemMemoryId,
        loc: 'roles:designer',
        name: 'designer',
        data: { names: ['Nia'] },
      },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: second.id } });
    // A participant sees the real refusal…
    await expectCode(
      M.createTeamRole({}, { appRef: app.id, role: 'ops' }, ctx(admin.id)),
      'TEAM_AGENT_AMBIGUOUS',
    );
    // …an outsider gets FORBIDDEN, never the candidate list.
    await expectCode(
      M.createTeamRole({}, { appRef: app.id, role: 'ops' }, ctx(outsider.id)),
      'FORBIDDEN',
    );
  });

  it('write gate is the definition-edit gate: org READER and CONTRIBUTOR refused, ADMIN admitted', async () => {
    await expect(
      M.createTeamRole({}, { appRef: app.id, role: 'ops', names: ['Uma'] }, ctx(reader.id)),
    ).rejects.toThrow(/Forbidden/);
    await expectCode(M.createTeamRole({}, { appRef: app.id, role: 'ops' }, ctx(contrib.id)), 'FORBIDDEN');
    const role = await M.createTeamRole(
      {},
      { appRef: app.id, role: 'ops', names: ['Uma'] },
      ctx(admin.id),
    );
    expect(role.role).toBe('ops');
  });
});

describe('#960 — updateTeamRole (#1050: description only)', () => {
  it('edits the description and leaves node data untouched', async () => {
    const before = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId } },
    });
    const role = await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'backend-engineer', description: 'Server and API work' },
      ctx(admin.id),
    );
    expect(role.description).toBe('Server and API work');

    // The legacy register on this node survives the edit verbatim. It is
    // historical, so an edit must neither read it nor rewrite it — the
    // sibling-key preservation that used to be a special measure is now the
    // whole behaviour.
    const after = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId } },
    });
    expect(after.data).toEqual(before.data);
  });

  it('never SENDS a data payload, so it cannot replay a stale snapshot (#1059 review)', async () => {
    // The defect: reading the node's `data` and writing it back looks like
    // "passing it through untouched" and is really a wholesale
    // last-write-wins overwrite of a snapshot taken before the write. Generic
    // writers (updateNode, hadron_update_node_data) do NOT take
    // withRoleWriteLock and this change removed the revision guard, so an edit
    // landing between the role surface's read and its write would be silently
    // reverted — by a surface that claims to edit only the description.
    //
    // Asserting the ABSENCE of `data` on the write, rather than staging the
    // race: a test that writes off-road BEFORE the call proves nothing,
    // because the snapshot it reads is then already current. (That first
    // version passed against the reintroduced bug — a green mutation indicting
    // the test, exactly as review:a-green-mutation-indicts-the-test says.)
    // The guarantee is "we never send data"; that is what is pinned.
    const spy = vi.spyOn(nodeWrite, 'writeNodeCore');
    try {
      await M.updateTeamRole(
        {},
        { appRef: app.id, role: 'backend-engineer', description: 'edited' },
        ctx(admin.id),
      );
      expect(spy).toHaveBeenCalled();
      for (const call of spy.mock.calls) {
        expect(Object.keys(call[0] as object)).not.toContain('data');
      }
    } finally {
      spy.mockRestore();
    }

    // And end-to-end: the description changed, node data is untouched.
    const after = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId } },
    });
    expect(after.description).toBe('edited');
    expect((after.data as Record<string, unknown>).names).toEqual(['Fred', 'Gwen', 'Hans']);
  });

  // ── #1024: repo affinity ──────────────────────────────────────────────────
  it('reads data.repos, and sets it through the surface rather than by hand', async () => {
    await M.createTeamRole({}, { appRef: app.id, role: 'ios-app-engineer' }, ctx(admin.id));
    const created = await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'ios-app-engineer', repos: ['hadron-memory/hadron-ios'] },
      ctx(admin.id),
    );
    expect(created.repos).toEqual(['hadron-memory/hadron-ios']);

    const updated = await M.updateTeamRole(
      {},
      {
        appRef: app.id,
        role: 'ios-app-engineer',
        repos: ['hadron-memory/hadron-ios', 'hadron-memory/hadron-macapp'],
      },
      ctx(admin.id),
    );
    expect(updated.repos).toEqual([
      'hadron-memory/hadron-ios',
      'hadron-memory/hadron-macapp',
    ]);
  });

  it('omitted PRESERVES; an empty array CLEARS', async () => {
    await M.createTeamRole({}, { appRef: app.id, role: 'qa' }, ctx(admin.id));
    await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'qa', repos: ['acme/qa'] },
      ctx(admin.id),
    );
    // A description-only edit must not disturb affinity.
    const desc = await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'qa', description: 'Quality' },
      ctx(admin.id),
    );
    expect(desc.repos).toEqual(['acme/qa']);
    expect(desc.description).toBe('Quality');

    const cleared = await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'qa', repos: [] },
      ctx(admin.id),
    );
    expect(cleared.repos).toEqual([]);
  });

  it('explicit null is OMITTED, not a clear (#1071 review)', async () => {
    // A client whose variables default to null must not silently wipe
    // affinity. The two readings differ and the SDL now says which.
    await M.createTeamRole({}, { appRef: app.id, role: 'qa2' }, ctx(admin.id));
    await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'qa2', repos: ['acme/qa'] },
      ctx(admin.id),
    );
    const kept = await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'qa2', repos: null },
      ctx(admin.id),
    );
    expect(kept.repos).toEqual(['acme/qa']);
  });

  it('a repo write MERGES — sibling data keys survive, including a legacy register', async () => {
    // The role node in this fixture still carries data.names. #1050 left it
    // there as history, and a repos write must not be the thing that finally
    // erases it.
    const before = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId } },
    });
    expect((before.data as { names?: string[] }).names?.length).toBeGreaterThan(0);

    await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'backend-engineer', repos: ['acme/api'] },
      ctx(admin.id),
    );

    const after = await db.node.findUniqueOrThrow({ where: { id: before.id } });
    const data = after.data as { names?: string[]; repos?: string[] };
    expect(data.repos).toEqual(['acme/api']);
    expect(data.names).toEqual((before.data as { names?: string[] }).names);
  });

  it('REFUSES rather than reverting when a generic write races the merge', async () => {
    // Generic node surfaces do not take withRoleWriteLock, so the merge's
    // read-then-write window is real. The #989 revision guard turns what would
    // be a silent revert (PR #1059's P1) into a typed refusal.
    //
    // The race is STAGED INSIDE the window rather than before it: bumping
    // revSeq before the call proves nothing, because the surface re-reads the
    // node at the head of its lock and would simply see the new value. The
    // competing write has to land between that read and the guarded write,
    // which is exactly where this spy puts it.
    const node = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId } },
    });
    const spy = vi
      .spyOn(nodeWrite, 'writeNodeCore')
      .mockImplementation(async (...callArgs: Parameters<typeof nodeWrite.writeNodeCore>) => {
        spy.mockRestore();
        await db.node.update({
          where: { id: node.id },
          data: { revSeq: { increment: 1 }, data: { offRoad: 'landed first' } },
        });
        return nodeWrite.writeNodeCore(...callArgs);
      });

    try {
      await expectCode(
        M.updateTeamRole(
          {},
          { appRef: app.id, role: 'backend-engineer', repos: ['acme/api'] },
          ctx(admin.id),
        ),
        'TEAM_ROLE_DATA_CONFLICT',
      );
    } finally {
      spy.mockRestore();
    }

    // And the competing write survives untouched — the point of refusing.
    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect((after.data as { offRoad?: string }).offRoad).toBe('landed first');
  });

  it('a description-only edit takes NO revision guard', async () => {
    // The guard exists for the data merge, not for the row. Making every
    // description edit a guarded write would pay conflict risk for callers who
    // touched no data at all.
    const spy = vi.spyOn(nodeWrite, 'writeNodeCore');
    try {
      await M.updateTeamRole(
        {},
        { appRef: app.id, role: 'backend-engineer', description: 'just words' },
        ctx(admin.id),
      );
      const opts = spy.mock.calls.at(-1)?.[3] as { guardRevSeq?: number } | undefined;
      expect(opts?.guardRevSeq).toBeUndefined();
      expect(Object.keys(spy.mock.calls.at(-1)?.[0] as object)).not.toContain('data');
    } finally {
      spy.mockRestore();
    }
  });

  it('a malformed data.repos degrades to no affinity rather than failing the read', async () => {
    // A soft signal must not be able to 500 the roster. Non-strings dropped,
    // entries trimmed, blanks removed, order kept, duplicates collapsed.
    await db.node.update({
      where: { loc_memoryId: { loc: 'roles:frontend-engineer', memoryId: teamAgent.systemMemoryId } },
      data: { data: { repos: 'not-an-array' } },
    });
    const page = await teamRoles(ctx(contrib.id));
    expect(page.items.find((r: any) => r.role === 'frontend-engineer').repos).toEqual([]);

    await db.node.update({
      where: { loc_memoryId: { loc: 'roles:frontend-engineer', memoryId: teamAgent.systemMemoryId } },
      data: { data: { repos: ['  a/b  ', 7, '', 'a/b', 'c/d', null] } },
    });
    const page2 = await teamRoles(ctx(contrib.id));
    expect(page2.items.find((r: any) => r.role === 'frontend-engineer').repos).toEqual([
      'a/b',
      'c/d',
    ]);
  });

  it('a role write INVALIDATES the request-scoped affinity cache', async () => {
    // The cache lives for the whole request. A multi-field mutation that reads
    // affinity, writes it, then reads again would otherwise deterministically
    // see the pre-update map (PR #1071 review, Codex).
    const shared = ctx(admin.id);
    const { loadAppRepoAffinity } = await import('./resolvers.teamRole.js');

    await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'backend-engineer', repos: ['acme/before'] },
      shared,
    );
    expect((await loadAppRepoAffinity(shared, app.id)).get('backend-engineer')).toEqual([
      'acme/before',
    ]);

    await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'backend-engineer', repos: ['acme/after'] },
      shared,
    );
    expect((await loadAppRepoAffinity(shared, app.id)).get('backend-engineer')).toEqual([
      'acme/after',
    ]);
  });

  it('a create does NOT write data, so a resurrected role keeps its history', async () => {
    // #1071 review: create takes no repos at all now, precisely so the
    // resurrection path never carries a data write. writeNodeCore preserves the
    // tombstone's data when none is sent.
    const before = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId } },
    });
    const legacyNames = (before.data as { names?: string[] }).names;
    expect(legacyNames?.length).toBeGreaterThan(0);

    await M.deleteTeamRole({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id));
    await M.createTeamRole({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id));

    const after = await db.node.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.deletedAt).toBeNull();
    expect((after.data as { names?: string[] }).names).toEqual(legacyNames);
  });

  it('refuses a non-object data rather than corrupting it (#1071 review)', async () => {
    // A generically authored role node can legally hold a scalar or array in
    // data. Spreading those silently corrupts them — an array becomes numeric
    // keys, a string becomes character keys. This surface only ever promised to
    // modify `repos`.
    await db.node.update({
      where: { loc_memoryId: { loc: 'roles:frontend-engineer', memoryId: teamAgent.systemMemoryId } },
      data: { data: ['not', 'an', 'object'] as any },
    });
    await expectCode(
      M.updateTeamRole(
        {},
        { appRef: app.id, role: 'frontend-engineer', repos: ['acme/x'] },
        ctx(admin.id),
      ),
      'TEAM_ROLE_DATA_NOT_OBJECT',
    );
    // Untouched.
    const after = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'roles:frontend-engineer', memoryId: teamAgent.systemMemoryId } },
    });
    expect(after.data).toEqual(['not', 'an', 'object']);
  });

  it('a GENERIC node write also invalidates the affinity memo (#1071 review)', async () => {
    // updateNode / updateNodeData are supported paths to the same data, so
    // invalidating only from the TeamRole mutations would leave the memo stale
    // for exactly the writers that do not know about it. The shared write seam
    // clears it instead.
    const shared = ctx(admin.id);
    const { loadAppRepoAffinity } = await import('./resolvers.teamRole.js');
    await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'backend-engineer', repos: ['acme/before'] },
      shared,
    );
    expect((await loadAppRepoAffinity(shared, app.id)).get('backend-engineer')).toEqual([
      'acme/before',
    ]);

    const node = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId } },
    });
    await M.updateNodeData(
      {},
      { nodeRef: node.id, data: { repos: ['acme/generic'] } },
      shared,
    );
    expect((await loadAppRepoAffinity(shared, app.id)).get('backend-engineer')).toEqual([
      'acme/generic',
    ]);
  });


  it('refuses an unknown role → WORKER_ROLE_NOT_FOUND with the available list', async () => {
    try {
      await M.updateTeamRole(
        {},
        { appRef: app.id, role: 'no-such-role', description: 'x' },
        ctx(admin.id),
      );
      expect.fail('expected WORKER_ROLE_NOT_FOUND');
    } catch (e) {
      const ext = (e as GraphQLError).extensions as Record<string, unknown>;
      expect(ext.code).toBe('WORKER_ROLE_NOT_FOUND');
      expect(ext.availableRoles).toContain('backend-engineer');
    }
  });

  it('no longer accepts a register, a convention, or a compare-and-swap (#1028 closed)', async () => {
    // The #987 expectedNames CAS existed solely to stop two concurrent
    // WHOLESALE register writes silently dropping each other's newly added
    // free names. A write that owns no list cannot have that hazard, which is
    // why #1028 — the client-side CAS arithmetic — closes rather than ships.
    //
    // Extra arguments are ignored by the resolver rather than refused (they
    // are simply absent from the SDL, so a real GraphQL caller is rejected at
    // validation); what this pins is that they change NOTHING.
    const before = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId } },
    });
    await M.updateTeamRole(
      {},
      {
        appRef: app.id,
        role: 'backend-engineer',
        names: ['Nobody'],
        nameRange: 'A-C',
        expectedNames: ['wrong'],
      } as any,
      ctx(admin.id),
    );
    const after = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId } },
    });
    expect(after.data).toEqual(before.data);
  });

  it('write gate: org READER and CONTRIBUTOR refused, ADMIN admitted', async () => {
    // Definition edits use the same management boundary as Agent edits.
    await expect(
      M.updateTeamRole({}, { appRef: app.id, role: 'backend-engineer', description: 'x' }, ctx(reader.id)),
    ).rejects.toThrow(/Forbidden/);
    await expectCode(M.updateTeamRole({}, { appRef: app.id, role: 'backend-engineer', description: 'x' }, ctx(contrib.id)), 'FORBIDDEN');
    const ok = await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'backend-engineer', description: 'ok' },
      ctx(admin.id),
    );
    expect(ok.description).toBe('ok');
  });
});

describe('deleteTeamRole (#1002, simplified by #1050)', () => {
  const del = (c: Context, args: Record<string, unknown>) =>
    M.deleteTeamRole({}, { appRef: app.id, ...args }, c);

  it('definition removal requires an authorized manager', async () => {
    await expectCode(del(ctx(contrib.id), { role: 'backend-engineer' }), 'FORBIDDEN');
    await expectCode(del(ctx(reader.id), { role: 'backend-engineer' }), 'FORBIDDEN');
  });

  /** Mint a worker holding `name`, as a real cast would. */
  const mintWorker = (name: string) =>
    db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: roleAgent.id, name, slug: workerSlugBase(name) },
    });

  const roleLocs = async () =>
    (
      await db.node.findMany({
        where: { memoryId: teamAgent.systemMemoryId, deletedAt: null, loc: { startsWith: 'roles:' } },
        select: { loc: true },
      })
    ).map((n) => n.loc);

  it('deletes a role and its sub-nodes, unconditionally', async () => {
    // The fixture already gives backend-engineer a roles:<role>:notes child.
    const res = await del(ctx(admin.id), { role: 'backend-engineer' });
    expect(res.role).toBe('backend-engineer');
    // Definition + its notes: a roles:<role>:notes is content OF the role and
    // retires with it.
    expect(res.nodesDeleted).toBe(2);
    expect(await roleLocs()).not.toContain('roles:backend-engineer');
    expect(await roleLocs()).not.toContain('roles:backend-engineer:notes');
  });

  it('deletes a role whose names are MINTED — there is no ledger left to protect (#1050)', async () => {
    // This used to refuse TEAM_ROLE_IN_USE unless transferTo named a
    // successor, because the register entry was the record that a name had
    // been allocated to this role. With no register there is no such record,
    // and the thing that refusal actually protected — name permanence — was
    // never the register's doing.
    await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: roleAgent.id, name: 'Fred', slug: 'fred' },
    });
    const res = await M.deleteTeamRole(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );
    expect(res.role).toBe('backend-engineer');
    // The payload no longer carries a transfer.
    expect(res.transferredNames).toBeUndefined();
    expect(res.transferredTo).toBeUndefined();
  });

  it('refuses an unknown role → WORKER_ROLE_NOT_FOUND', async () => {
    await expectCode(
      M.deleteTeamRole({}, { appRef: app.id, role: 'no-such-role' }, ctx(admin.id)),
      'WORKER_ROLE_NOT_FOUND',
    );
  });

  it('deleting a role NEVER makes a minted name castable again', async () => {
    // The property the transfer machinery was built to preserve, and which
    // turns out not to have needed it: name permanence is enforced by
    // workers_app_name_uniq, not by any register or role bookkeeping. Deleting
    // the role that "owned" a name changes nothing about the name.
    await mintWorker('Kira');
    await del(ctx(admin.id), { role: 'frontend-engineer' });

    await expect(
      db.worker.create({
        data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: roleAgent.id, name: 'Kira', slug: 'kira-2' },
      }),
    ).rejects.toThrow();
  });

  it('runs the definition-edit gate — a reader App member may not retire a role', async () => {
    // requireMemoryWriteAccess signals denial with a plain Error('Forbidden…'),
    // matching how the create/update auth tests above assert it.
    await expect(del(ctx(appMember.id), { role: 'frontend-engineer' })).rejects.toThrow(/Forbidden/);
    await expect(del(ctx(outsider.id), { role: 'frontend-engineer' })).rejects.toThrow(/Forbidden/);
    expect(await roleLocs()).toContain('roles:frontend-engineer');
  });
});
