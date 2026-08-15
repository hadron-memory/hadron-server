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
      personaPrompt: 'You are {{name}}, a {{role}}.',
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
  it('lists roles with register, conventions, and the description', async () => {
    const page = await teamRoles(ctx(contrib.id));
    expect(page.total).toBe(2);
    const be = page.items.find((r: any) => r.role === 'backend-engineer');
    expect(be.loc).toBe('roles:backend-engineer');
    expect(be.description).toBe('Server-side work');
    expect(be.register.map((n: any) => n.name)).toEqual(['Fred', 'Gwen', 'Hans']);
    expect(be.nameRange).toBe('F-J');
    expect(be.nameConvention).toContain('Initial identifies');
    expect(be.freeCount).toBe(3);
    expect(be.exhausted).toBe(false);
  });

  it('taken is judged against the FULL roster, case-insensitively, retired included', async () => {
    const gwen = await db.worker.create({
      data: { appId: app.id, agentId: roleAgent.id, name: 'gWeN', retiredAt: new Date() },
    });
    const page = await teamRoles(ctx(contrib.id));
    const be = page.items.find((r: any) => r.role === 'backend-engineer');
    const entry = be.register.find((n: any) => n.name === 'Gwen');
    expect(entry.taken).toBe(true);
    expect(entry.heldBy?.id).toBe(gwen.id);
    expect(be.freeCount).toBe(2);
  });

  it('exhausted flips when every name is taken (and for an empty register)', async () => {
    for (const name of ['Fred', 'Gwen', 'Hans']) {
      await db.worker.create({ data: { appId: app.id, agentId: roleAgent.id, name } });
    }
    const page = await teamRoles(ctx(contrib.id));
    const be = page.items.find((r: any) => r.role === 'backend-engineer');
    expect(be.freeCount).toBe(0);
    expect(be.exhausted).toBe(true);
  });

  it('resolves the role-agent (the casting default) and hasNamePlaceholder', async () => {
    const page = await teamRoles(ctx(contrib.id));
    const be = page.items.find((r: any) => r.role === 'backend-engineer');
    expect(be.roleAgent?.id).toBe(roleAgent.id);
    expect(be.hasNamePlaceholder).toBe(true);
    // No installed agent carries frontend-engineer dressing → null, null.
    const fe = page.items.find((r: any) => r.role === 'frontend-engineer');
    expect(fe.roleAgent).toBeNull();
    expect(fe.hasNamePlaceholder).toBeNull();
  });

  it('flags a nameless template — the pre-guard corpus check', async () => {
    await db.agent.update({
      where: { id: roleAgent.id },
      data: { personaPrompt: 'You are a {{role}} with no name.' },
    });
    const page = await teamRoles(ctx(contrib.id));
    const be = page.items.find((r: any) => r.role === 'backend-engineer');
    expect(be.hasNamePlaceholder).toBe(false);
  });

  it('detection shares the composer\'s exact token: "{{ name }}" is NOT bound (#985 review)', async () => {
    await db.agent.update({
      where: { id: roleAgent.id },
      data: { personaPrompt: 'You are {{ name }}, a {{role}}.' },
    });
    const page = await teamRoles(ctx(contrib.id));
    const be = page.items.find((r: any) => r.role === 'backend-engineer');
    // applyPersonaTemplate leaves "{{ name }}" literal, so this template
    // produces nameless workers — the flag must say so.
    expect(be.hasNamePlaceholder).toBe(false);
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
  it('mints roles:<role> with the register in data.names and returns the projection', async () => {
    const role = await M.createTeamRole(
      {},
      {
        appRef: app.id,
        role: 'qa-engineer',
        names: ['Quinn', 'Rosa'],
        nameRange: 'Q-T',
        description: 'Quality work',
      },
      ctx(contrib.id),
    );
    expect(role.role).toBe('qa-engineer');
    expect(role.register.map((n: any) => n.name)).toEqual(['Quinn', 'Rosa']);
    expect(role.nameRange).toBe('Q-T');
    const node = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'roles:qa-engineer', memoryId: teamAgent.systemMemoryId } },
    });
    expect((node.data as any).names).toEqual(['Quinn', 'Rosa']);
    expect(node.description).toBe('Quality work');
  });

  it('refuses an existing role → TEAM_ROLE_EXISTS', async () => {
    await expectCode(
      M.createTeamRole(
        {},
        { appRef: app.id, role: 'backend-engineer', names: ['Zed'] },
        ctx(contrib.id),
      ),
      'TEAM_ROLE_EXISTS',
    );
  });

  it('refuses a name held by another register → TEAM_ROLE_NAME_DUPLICATE', async () => {
    await expectCode(
      M.createTeamRole(
        {},
        { appRef: app.id, role: 'qa-engineer', names: ['Quinn', 'Kira'] },
        ctx(contrib.id),
      ),
      'TEAM_ROLE_NAME_DUPLICATE',
    );
  });

  it('validates names against the provided nameRange; allowOutOfRange overrides', async () => {
    await expectCode(
      M.createTeamRole(
        {},
        { appRef: app.id, role: 'qa-engineer', names: ['Quinn', 'Bob'], nameRange: 'Q-T' },
        ctx(contrib.id),
      ),
      'TEAM_ROLE_NAME_OUT_OF_RANGE',
    );
    const role = await M.createTeamRole(
      {},
      {
        appRef: app.id,
        role: 'qa-engineer',
        names: ['Quinn', 'Bob'],
        nameRange: 'Q-T',
        allowOutOfRange: true,
      },
      ctx(contrib.id),
    );
    expect(role.register.map((n: any) => n.name)).toEqual(['Quinn', 'Bob']);
  });

  it('rejects a multi-atom role slug', async () => {
    await expectCode(
      M.createTeamRole({}, { appRef: app.id, role: 'a:b', names: ['X'] }, ctx(contrib.id)),
      'BAD_USER_INPUT',
    );
  });

  it('rejects a malformed nameRange instead of silently disabling the check (#984 review)', async () => {
    await expectCode(
      M.createTeamRole(
        {},
        { appRef: app.id, role: 'qa-engineer', names: ['Quinn'], nameRange: 'not-a-range' },
        ctx(contrib.id),
      ),
      'BAD_USER_INPUT',
    );
  });

  it('tolerates a legacy malformed STORED range when the argument is omitted', async () => {
    // Hand-authored before this surface existed — the row must stay editable.
    await db.node.update({
      where: {
        loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId },
      },
      data: { data: { names: ['Fred'], nameRange: 'whatever goes' } },
    });
    const role = await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'backend-engineer', names: ['Fred', 'Bob'] },
      ctx(contrib.id),
    );
    expect(role.register.map((n: any) => n.name)).toContain('Bob');
  });

  it('two concurrent creates cannot both claim one name — the register lock serializes (#984 review)', async () => {
    const results = await Promise.allSettled([
      M.createTeamRole({}, { appRef: app.id, role: 'ops-a', names: ['Vera'] }, ctx(contrib.id)),
      M.createTeamRole({}, { appRef: app.id, role: 'ops-b', names: ['Vera'] }, ctx(contrib.id)),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as GraphQLError).extensions?.code).toBe('TEAM_ROLE_NAME_DUPLICATE');
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
      M.createTeamRole({}, { appRef: app.id, role: 'ops', names: ['Uma'] }, ctx(contrib.id)),
      'TEAM_AGENT_AMBIGUOUS',
    );
    // …an outsider gets FORBIDDEN, never the candidate list.
    await expectCode(
      M.createTeamRole({}, { appRef: app.id, role: 'ops', names: ['Uma'] }, ctx(outsider.id)),
      'FORBIDDEN',
    );
  });

  it('write gate is the definition-edit gate: org READER refused, CONTRIBUTOR admitted', async () => {
    await expect(
      M.createTeamRole({}, { appRef: app.id, role: 'ops', names: ['Uma'] }, ctx(reader.id)),
    ).rejects.toThrow(/Forbidden/);
    const role = await M.createTeamRole(
      {},
      { appRef: app.id, role: 'ops', names: ['Uma'] },
      ctx(contrib.id),
    );
    expect(role.role).toBe('ops');
  });
});

describe('#960 — updateTeamRole', () => {
  it('replaces the register while preserving sibling data keys and conventions', async () => {
    // Plant a foreign data key the surface does not own.
    await db.node.update({
      where: {
        loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId },
      },
      data: {
        data: {
          names: ['Fred', 'Gwen', 'Hans'],
          nameRange: 'F-J',
          nameConvention: 'Initial identifies the role at a glance.',
          customKey: { keep: true },
        },
      },
    });
    const role = await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'backend-engineer', names: ['Fred', 'Gwen', 'Hans', 'Iris'] },
      ctx(contrib.id),
    );
    expect(role.register.map((n: any) => n.name)).toEqual(['Fred', 'Gwen', 'Hans', 'Iris']);
    expect(role.nameRange).toBe('F-J');
    const node = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId } },
    });
    expect((node.data as any).customKey).toEqual({ keep: true });
    expect((node.data as any).nameConvention).toContain('Initial identifies');
  });

  it('omitting names edits conventions without touching the register', async () => {
    const role = await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'backend-engineer', nameConvention: 'New convention.' },
      ctx(contrib.id),
    );
    expect(role.register.map((n: any) => n.name)).toEqual(['Fred', 'Gwen', 'Hans']);
    expect(role.nameConvention).toBe('New convention.');
  });

  it('explicit null clears a convention key (and its range check with it)', async () => {
    const role = await M.updateTeamRole(
      {},
      {
        appRef: app.id,
        role: 'backend-engineer',
        names: ['Fred', 'Gwen', 'Hans', 'Zoe'],
        nameRange: null,
      },
      ctx(contrib.id),
    );
    expect(role.nameRange).toBeNull();
    expect(role.register.map((n: any) => n.name)).toContain('Zoe');
  });

  it('refuses removing a MINTED name → TEAM_ROLE_NAME_MINTED; an unminted one may go', async () => {
    await db.worker.create({ data: { appId: app.id, agentId: roleAgent.id, name: 'Fred' } });
    await expectCode(
      M.updateTeamRole(
        {},
        { appRef: app.id, role: 'backend-engineer', names: ['Gwen', 'Hans'] },
        ctx(contrib.id),
      ),
      'TEAM_ROLE_NAME_MINTED',
    );
    // Dropping unminted Hans while keeping minted Fred is legal.
    const role = await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'backend-engineer', names: ['Fred', 'Gwen'] },
      ctx(contrib.id),
    );
    expect(role.register.map((n: any) => n.name)).toEqual(['Fred', 'Gwen']);
  });

  it('range-checks only ADDED names — stored out-of-range names survive', async () => {
    // Zed is out of F-J but already stored: an unrelated edit must not trip.
    await db.node.update({
      where: {
        loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId },
      },
      data: { data: { names: ['Fred', 'Zed'], nameRange: 'F-J' } },
    });
    const role = await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'backend-engineer', names: ['Fred', 'Zed', 'Gwen'] },
      ctx(contrib.id),
    );
    expect(role.register.map((n: any) => n.name)).toEqual(['Fred', 'Zed', 'Gwen']);
  });

  it('refuses an unknown role → WORKER_ROLE_NOT_FOUND with the available list', async () => {
    try {
      await M.updateTeamRole(
        {},
        { appRef: app.id, role: 'no-such-role', names: ['X'] },
        ctx(contrib.id),
      );
      expect.fail('expected WORKER_ROLE_NOT_FOUND');
    } catch (e) {
      const ext = (e as GraphQLError).extensions as Record<string, unknown>;
      expect(ext.code).toBe('WORKER_ROLE_NOT_FOUND');
      expect(ext.availableRoles).toContain('backend-engineer');
    }
  });

  // ── #987 — expectedNames: compare-and-swap for read-modify-write sugar ──
  //
  // The diff invariants deliberately protect only MINTED names, so two
  // concurrent wholesale writes composed from the same read silently drop
  // each other's newly added FREE names — legal, refusal-free, and exactly
  // the lost update the precondition exists to catch.

  it('a matching expectedNames passes; a stale one refuses TEAM_ROLE_STALE with the current register', async () => {
    const ok = await M.updateTeamRole(
      {},
      {
        appRef: app.id,
        role: 'backend-engineer',
        names: ['Fred', 'Gwen', 'Hans', 'Iris'],
        expectedNames: ['Fred', 'Gwen', 'Hans'],
      },
      ctx(contrib.id),
    );
    expect(ok.register.map((n: any) => n.name)).toEqual(['Fred', 'Gwen', 'Hans', 'Iris']);
    // A second writer still holding the ORIGINAL read is now stale.
    try {
      await M.updateTeamRole(
        {},
        {
          appRef: app.id,
          role: 'backend-engineer',
          names: ['Fred', 'Gwen', 'Hans', 'Jane'],
          expectedNames: ['Fred', 'Gwen', 'Hans'],
        },
        ctx(contrib.id),
      );
      expect.fail('expected TEAM_ROLE_STALE');
    } catch (e) {
      const ext = (e as GraphQLError).extensions as Record<string, unknown>;
      expect(ext.code).toBe('TEAM_ROLE_STALE');
      // The refusal carries the current register, so the client rebases
      // without a second read.
      expect(ext.storedNames).toEqual(['Fred', 'Gwen', 'Hans', 'Iris']);
    }
    // Nothing from the stale write landed.
    const page = await teamRoles(ctx(contrib.id));
    const be = page.items.find((r: any) => r.role === 'backend-engineer');
    expect(be.register.map((n: any) => n.name)).toEqual(['Fred', 'Gwen', 'Hans', 'Iris']);
  });

  it('a reorder is an edit: expectedNames comparison is ordered', async () => {
    await expectCode(
      M.updateTeamRole(
        {},
        {
          appRef: app.id,
          role: 'backend-engineer',
          names: ['Fred', 'Gwen', 'Hans', 'Iris'],
          expectedNames: ['Gwen', 'Fred', 'Hans'],
        },
        ctx(contrib.id),
      ),
      'TEAM_ROLE_STALE',
    );
  });

  it('expectedNames canonicalizes like the register (trim, case-insensitive dedup)', async () => {
    // A client passing back exactly what teamRoles returned always compares
    // clean — and raw spellings that PARSE to the stored register do too.
    const ok = await M.updateTeamRole(
      {},
      {
        appRef: app.id,
        role: 'backend-engineer',
        names: ['Fred', 'Gwen', 'Hans', 'Kilo'],
        allowOutOfRange: true,
        expectedNames: [' Fred ', 'fred', 'Gwen', '', 'Hans'],
      },
      ctx(contrib.id),
    );
    expect(ok.register.map((n: any) => n.name)).toContain('Kilo');
  });

  it('the lost-update race resolves to one winner and one typed refusal (#987)', async () => {
    // Two admins read ['Fred','Gwen','Hans'], each composes a wholesale list
    // adding a different FREE name. Without expectedNames the later write
    // silently drops the earlier add; with it, the register lock serializes
    // the two and the loser gets TEAM_ROLE_STALE.
    const base = ['Fred', 'Gwen', 'Hans'];
    const results = await Promise.allSettled([
      M.updateTeamRole(
        {},
        { appRef: app.id, role: 'backend-engineer', names: [...base, 'Iris'], expectedNames: base },
        ctx(contrib.id),
      ),
      M.updateTeamRole(
        {},
        { appRef: app.id, role: 'backend-engineer', names: [...base, 'Jane'], expectedNames: base },
        ctx(contrib.id),
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as GraphQLError).extensions?.code).toBe('TEAM_ROLE_STALE');
    // The winner's add survived — no silent drop.
    const page = await teamRoles(ctx(contrib.id));
    const be = page.items.find((r: any) => r.role === 'backend-engineer');
    expect(be.register).toHaveLength(4);
  });

  it('the CAS holds against the GENERIC node surface — the cross-surface race (#989 review)', async () => {
    // The register lock only serializes lock participants; updateNode writes
    // the roles: node without it. This interleaves a REAL updateNode into
    // the exact TOCTOU window (after the locked read + expectedNames
    // compare, before the node write) by intercepting the first $queryRaw
    // the write path makes after the compare (loadHeldByName's roster scan).
    // The DB-level guard (the revSeq claim, #989) must catch it: updateNode
    // revisions its write, which claims the next revSeq unconditionally.
    let fired = false;
    const trickyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === '$queryRaw') {
          return async (...qargs: unknown[]) => {
            const res = await (target.$queryRaw as (...a: unknown[]) => Promise<unknown>).apply(
              target,
              qargs,
            );
            if (!fired) {
              fired = true;
              // The off-road write: a generic-surface register edit landing
              // mid-window, adding Ophelia (out of range — the generic
              // surface runs no register invariants, which is the point).
              await M.updateNode(
                {},
                {
                  input: {
                    memoryId: teamAgent.systemMemoryId,
                    loc: 'roles:backend-engineer',
                    data: { names: ['Fred', 'Gwen', 'Hans', 'Ophelia'], nameRange: 'F-J' },
                  },
                },
                ctx(contrib.id),
              );
            }
            return res;
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    try {
      await M.updateTeamRole(
        {},
        {
          appRef: app.id,
          role: 'backend-engineer',
          names: ['Fred', 'Gwen', 'Hans', 'Iris'],
          expectedNames: ['Fred', 'Gwen', 'Hans'],
        },
        { db: trickyDb, userId: contrib.id, roles: ['READER'] } as unknown as Context,
      );
      expect.fail('expected TEAM_ROLE_STALE');
    } catch (e) {
      const ext = (e as GraphQLError).extensions as Record<string, unknown>;
      expect(ext.code).toBe('TEAM_ROLE_STALE');
      // The refusal reports the interleaved state, so the rebase is honest…
      expect(ext.storedNames).toContain('Ophelia');
    }
    expect(fired).toBe(true);
    // …and the off-road write SURVIVED — the stale CAS write clobbered nothing.
    const node = await db.node.findUniqueOrThrow({
      where: {
        loc_memoryId: { loc: 'roles:backend-engineer', memoryId: teamAgent.systemMemoryId },
      },
    });
    expect((node.data as any).names).toEqual(['Fred', 'Gwen', 'Hans', 'Ophelia']);
  });

  it('the whole flow feeds the cast: an added name is what castWorker allocates next', async () => {
    for (const name of ['Fred', 'Gwen', 'Hans']) {
      await db.worker.create({ data: { appId: app.id, agentId: roleAgent.id, name } });
    }
    await M.updateTeamRole(
      {},
      { appRef: app.id, role: 'backend-engineer', names: ['Fred', 'Gwen', 'Hans', 'Ivy'] },
      ctx(contrib.id),
    );
    const worker = await M.castWorker(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(contrib.id),
    );
    expect(worker.name).toBe('Ivy');
  });
});
