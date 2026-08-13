/**
 * #935 — createTeamPersona: server-side persona instantiation (spec
 * cor:agt:020:01/:02).
 *
 * The operation reads the role definition (prompt template + name register)
 * from the Team Agent's system memory, allocates a name against the
 * personaName uniqueness constraint (retrying past PERSONA_NAME_TAKEN /
 * AGENT_URN_TAKEN in register mode — the constraint IS the allocation
 * primitive), creates the persona through the shared createAgentCore, and
 * installs it into the team App's roster.
 *
 * The auth matrix is tested one case per PRINCIPAL SHAPE
 * (findings:auth-appid-credential-vs-selection): org admin, org contributor,
 * app member (non-org), app 'reader' member, non-member, unauthenticated,
 * pure App-key, hybrid user+selection.
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

const TEMPLATE =
  'You are {{name}}, a {{role}} on this team.\nWork from your own memories.';

let org: { id: string; urn: string };
let admin: { id: string };
let contrib: { id: string };
let appMember: { id: string };
let appReader: { id: string };
let outsider: { id: string };
let teamAgent: { id: string; urn: string; systemMemoryId: string };
let app: { id: string; urn: string };

/** Create a roles:<role> definition node in a system memory. */
async function createRoleNode(
  memoryId: string,
  role: string,
  opts: { names?: unknown; content?: string | null; description?: string } = {},
) {
  return db.node.create({
    data: {
      id: generateId(),
      memoryId,
      loc: `roles:${role}`,
      name: role,
      description: opts.description,
      content: opts.content === undefined ? TEMPLATE : opts.content,
      data: opts.names === undefined ? { names: ['Iris', 'Henry', 'Ada'] } : ({ names: opts.names } as any),
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'team-org', urn: `team-org-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 93501, githubUsername: `tp-admin-${suffix}`, roles: ['READER'] },
  });
  contrib = await db.user.create({
    data: { id: generateId(), githubId: 93502, githubUsername: `tp-contrib-${suffix}`, roles: ['READER'] },
  });
  appMember = await db.user.create({
    data: { id: generateId(), githubId: 93503, githubUsername: `tp-member-${suffix}`, roles: ['READER'] },
  });
  appReader = await db.user.create({
    data: { id: generateId(), githubId: 93504, githubUsername: `tp-reader-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 93505, githubUsername: `tp-outsider-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: contrib.id, role: 'CONTRIBUTOR' },
  });

  // The Team Agent — created through the real mutation so it owns a real
  // system memory; the role definitions then live as CONTENT in that memory
  // (cor:agt:020:01).
  const created = await M.createAgent(
    {},
    { orgId: org.id, name: 'Team Agent' },
    ctx(admin.id),
  );
  teamAgent = { id: created.id, urn: created.urn, systemMemoryId: created.systemMemoryId };
  await createRoleNode(teamAgent.systemMemoryId, 'backend-engineer');

  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });

  // App members who are NOT org members — the everyday-flow principals.
  await db.appMember.create({ data: { appId: app.id, userId: appMember.id, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: appReader.id, role: 'reader' } });
});

describe('createTeamPersona — happy path', () => {
  it('allocates the first register name, composes the prompt, and installs into the App', async () => {
    const agent = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );
    expect(agent.personaName).toBe('Iris');
    expect(agent.personaRole).toBe('backend-engineer');
    expect(agent.personaPrompt).toBe(
      'You are Iris, a backend-engineer on this team.\nWork from your own memories.',
    );
    // Owned by the App's owner (the org), with its own real system memory.
    expect(agent.organizationId).toBe(org.id);
    expect(agent.ownerUserId).toBeNull();
    expect(agent.systemMemoryId).toBeTruthy();
    // On the roster immediately.
    const roster = await db.appAgent.findUnique({
      where: { appId_agentId: { appId: app.id, agentId: agent.id } },
    });
    expect(roster).not.toBeNull();
  });

  it('accepts the App URN as appRef (cor:api:140)', async () => {
    const agent = await M.createTeamPersona(
      {},
      { appRef: app.urn, role: 'backend-engineer' },
      ctx(admin.id),
    );
    expect(agent.personaName).toBe('Iris');
  });

  it('a caller-supplied name wins over the register', async () => {
    const agent = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer', name: 'Zoe' },
      ctx(admin.id),
    );
    expect(agent.personaName).toBe('Zoe');
    expect(agent.personaPrompt).toContain('You are Zoe,');
  });

  it('a blank caller-supplied name is absent (cor:agt:020:02) — register allocates', async () => {
    const agent = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer', name: '   ' },
      ctx(admin.id),
    );
    expect(agent.personaName).toBe('Iris');
  });
});

describe('createTeamPersona — persona metadata (#950)', () => {
  it('an org-owned team App mints an ORGANIZATION-visible persona (the roster is shared)', async () => {
    const agent = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );
    expect(agent.visibility).toBe('ORGANIZATION');
  });

  it('the description is synthesized, never the role node\'s own description', async () => {
    // The role node describes the ARTIFACT — that string must not land on the
    // persona (and would be identical for every persona of the role).
    const roleNode = await db.node.findFirstOrThrow({
      where: { memoryId: teamAgent.systemMemoryId, loc: 'roles:backend-engineer' },
    });
    await db.node.update({
      where: { id: roleNode.id },
      data: { description: 'Role definition + name register for backend engineers' },
    });
    const agent = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );
    expect(agent.description).toBe('AI coding agent using backend-engineer role');
  });

  it('data.personaDescription on the role node wins, with {{name}}/{{role}} substituted', async () => {
    const roleNode = await db.node.findFirstOrThrow({
      where: { memoryId: teamAgent.systemMemoryId, loc: 'roles:backend-engineer' },
    });
    await db.node.update({
      where: { id: roleNode.id },
      data: {
        description: 'Role definition + name register for backend engineers',
        data: { names: ['Iris'], personaDescription: '{{name}} — {{role}} on the Micromentor team' },
      },
    });
    const agent = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );
    expect(agent.description).toBe('Iris — backend-engineer on the Micromentor team');
  });

  it('a blank data.personaDescription falls back to the synthesized one', async () => {
    const roleNode = await db.node.findFirstOrThrow({
      where: { memoryId: teamAgent.systemMemoryId, loc: 'roles:backend-engineer' },
    });
    await db.node.update({
      where: { id: roleNode.id },
      data: { data: { names: ['Iris'], personaDescription: '   ' } },
    });
    const agent = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );
    expect(agent.description).toBe('AI coding agent using backend-engineer role');
  });
});

describe('createTeamPersona — name allocation', () => {
  it('advances past taken names (PERSONA_NAME_TAKEN retry contract)', async () => {
    const first = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );
    const second = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );
    expect(first.personaName).toBe('Iris');
    expect(second.personaName).toBe('Henry');
  });

  it('two RACING mints get different names', async () => {
    const [a, b] = await Promise.all([
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id)),
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id)),
    ]);
    expect(a.personaName).not.toBe(b.personaName);
    expect(['Iris', 'Henry']).toContain(a.personaName);
    expect(['Iris', 'Henry']).toContain(b.personaName);
  });

  it('register names are case-insensitively reserved — "iris" taken blocks "Iris"', async () => {
    await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer', name: 'iris' },
      ctx(admin.id),
    );
    const next = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );
    expect(next.personaName).toBe('Henry');
  });

  it('a caller-supplied taken name is the typed PERSONA_NAME_TAKEN — no silent retry', async () => {
    await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer', name: 'Iris' },
      ctx(admin.id),
    );
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer', name: 'Iris' }, ctx(admin.id)),
      'PERSONA_NAME_TAKEN',
    );
  });

  it('register exhausted → PERSONA_REGISTER_EXHAUSTED', async () => {
    for (const _ of [1, 2, 3]) {
      await M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id));
    }
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id)),
      'PERSONA_REGISTER_EXHAUSTED',
    );
  });

  it('empty register + no explicit name → PERSONA_REGISTER_EXHAUSTED', async () => {
    await createRoleNode(teamAgent.systemMemoryId, 'qa', { names: [] });
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'qa' }, ctx(admin.id)),
      'PERSONA_REGISTER_EXHAUSTED',
    );
  });

  it('a soft-deleted persona keeps its name reserved forever (cor:agt:020:02)', async () => {
    const iris = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );
    expect(iris.personaName).toBe('Iris');
    await M.deleteAgent({}, { ref: iris.id }, ctx(admin.id));
    // The register must NOT hard-delete the tombstone and recycle "Iris" —
    // history still references her (Codex P1 on PR #936).
    const next = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );
    expect(next.personaName).toBe('Henry');
    const tombstone = await db.agent.findUnique({ where: { id: iris.id } });
    expect(tombstone?.personaName).toBe('Iris');
    // An explicit re-mint of the retired name is the typed persona refusal.
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer', name: 'Iris' }, ctx(admin.id)),
      'PERSONA_NAME_TAKEN',
    );
  });

  it('a NON-persona tombstone still reclaims its URN slot (pre-#935 behavior preserved)', async () => {
    const scratch = await M.createAgent({}, { orgId: org.id, name: 'Scratch' }, ctx(admin.id));
    await M.deleteAgent({}, { ref: scratch.id }, ctx(admin.id));
    const again = await M.createAgent({}, { orgId: org.id, name: 'Scratch' }, ctx(admin.id));
    expect(again.urn).toBe(scratch.urn);
    expect(again.id).not.toBe(scratch.id);
  });

  it('a case-insensitive register duplicate keeps the FIRST spelling', async () => {
    await createRoleNode(teamAgent.systemMemoryId, 'writer', { names: ['Ana', 'ANA', 'Ben'] });
    const first = await M.createTeamPersona({}, { appRef: app.id, role: 'writer' }, ctx(admin.id));
    const second = await M.createTeamPersona({}, { appRef: app.id, role: 'writer' }, ctx(admin.id));
    expect(first.personaName).toBe('Ana');
    expect(second.personaName).toBe('Ben');
  });

  it('a non-persona Agent squatting the name slug advances the register (AGENT_URN_TAKEN)', async () => {
    // An ordinary agent named "Iris" holds urn <org>:iris but reserves no
    // personaName — the register loop must still move on to Henry.
    await M.createAgent({}, { orgId: org.id, name: 'Iris' }, ctx(admin.id));
    const agent = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );
    expect(agent.personaName).toBe('Henry');
  });
});

describe('createTeamPersona — Team Agent location and role definition', () => {
  it('unknown role → PERSONA_ROLE_NOT_FOUND listing available roles', async () => {
    try {
      await M.createTeamPersona({}, { appRef: app.id, role: 'astronaut' }, ctx(admin.id));
      expect.fail('expected PERSONA_ROLE_NOT_FOUND');
    } catch (e) {
      expect((e as GraphQLError).extensions?.code).toBe('PERSONA_ROLE_NOT_FOUND');
      expect((e as GraphQLError).extensions?.availableRoles).toEqual(['backend-engineer']);
    }
  });

  it('role node without a template → PERSONA_ROLE_INVALID', async () => {
    await createRoleNode(teamAgent.systemMemoryId, 'qa', { content: '   ' });
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'qa' }, ctx(admin.id)),
      'PERSONA_ROLE_INVALID',
    );
  });

  it('the template is composed verbatim — internal whitespace/indentation survives (edges trimmed by #929 normalization)', async () => {
    await createRoleNode(teamAgent.systemMemoryId, 'poet', {
      content: '\nYou are {{name}}.\n\n  - keep this indented\n  - and this\n',
      names: ['Vera'],
    });
    const agent = await M.createTeamPersona({}, { appRef: app.id, role: 'poet' }, ctx(admin.id));
    // Composition does NOT trim the template (PR #936 Copilot review); the
    // stored field's edge-trim comes from the existing persona-field
    // normalization (#929), which is why the leading/trailing newlines are
    // gone while every internal newline and indent survives.
    expect(agent.personaPrompt).toBe('You are Vera.\n\n  - keep this indented\n  - and this');
  });

  it('an encrypted system memory without a session key refuses with the typed SESSION_EXPIRED', async () => {
    await db.memory.update({
      where: { id: teamAgent.systemMemoryId },
      data: { isEncrypted: true },
    });
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id)),
      'SESSION_EXPIRED',
    );
  });

  it('a multi-atom role is rejected before touching the graph', async () => {
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'roles:sneaky' }, ctx(admin.id)),
      'BAD_USER_INPUT',
    );
  });

  it('no installed agent carries a roles: branch → TEAM_AGENT_NOT_FOUND', async () => {
    await db.node.deleteMany({ where: { memoryId: teamAgent.systemMemoryId } });
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id)),
      'TEAM_AGENT_NOT_FOUND',
    );
  });

  it('two installed agents with roles: branches → TEAM_AGENT_AMBIGUOUS; explicit teamAgentRef resolves it', async () => {
    const second = await M.createAgent({}, { orgId: org.id, name: 'Second Team' }, ctx(admin.id));
    await createRoleNode(second.systemMemoryId, 'designer');
    await db.appAgent.create({ data: { appId: app.id, agentId: second.id } });

    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id)),
      'TEAM_AGENT_AMBIGUOUS',
    );
    const agent = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer', teamAgentRef: teamAgent.id },
      ctx(admin.id),
    );
    expect(agent.personaName).toBe('Iris');
  });

  it('teamAgentRef naming an agent NOT installed in the App → TEAM_AGENT_NOT_INSTALLED', async () => {
    const foreign = await M.createAgent({}, { orgId: org.id, name: 'Uninstalled' }, ctx(admin.id));
    await createRoleNode(foreign.systemMemoryId, 'backend-engineer');
    await expectCode(
      M.createTeamPersona(
        {},
        { appRef: app.id, role: 'backend-engineer', teamAgentRef: foreign.id },
        ctx(admin.id),
      ),
      'TEAM_AGENT_NOT_INSTALLED',
    );
  });

  it('uninstalled App → APP_UNINSTALLED', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id)),
      'APP_UNINSTALLED',
    );
  });
});

describe('createTeamPersona — auth matrix (one case per principal shape)', () => {
  it('org ADMIN may mint', async () => {
    const agent = await M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id));
    expect(agent.personaName).toBe('Iris');
  });

  it('org CONTRIBUTOR may mint (parity with the install gate)', async () => {
    const agent = await M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(contrib.id));
    expect(agent.personaName).toBe('Iris');
  });

  it('an AppMember who is NOT an org member may mint (the everyday flow)', async () => {
    const agent = await M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(appMember.id));
    expect(agent.personaName).toBe('Iris');
  });

  it("an AppMember with role 'reader' is denied", async () => {
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(appReader.id)),
      'FORBIDDEN',
    );
  });

  it('a non-member is denied', async () => {
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(outsider.id)),
      'FORBIDDEN',
    );
  });

  it('an unauthenticated caller is denied', async () => {
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(undefined)),
      'FORBIDDEN',
    );
  });

  it('a PURE App-key principal is denied — persona minting is a human act', async () => {
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(undefined, app.id)),
      'FORBIDDEN',
    );
  });

  it("a HYBRID user+selection principal is judged on the USER's rights — the App selection grants nothing", async () => {
    // findings:auth-appid-credential-vs-selection — the case that gets
    // skipped: appReader carries the team App as their active-App selection,
    // and must still be denied.
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(appReader.id, app.id)),
      'FORBIDDEN',
    );
  });

  it('a revoked org membership does not authorize', async () => {
    await db.orgMember.updateMany({
      where: { organizationId: org.id, userId: contrib.id },
      data: { deletedAt: new Date() },
    });
    await expectCode(
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(contrib.id)),
      'FORBIDDEN',
    );
  });
});

describe('createTeamPersona — user-owned team App (spec 047)', () => {
  let owner: { id: string };
  let personalApp: { id: string };

  beforeEach(async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    owner = await db.user.create({
      data: { id: generateId(), name: 'Owner', handle: `tp-owner-${suffix}`, roles: ['READER'] },
    });
    const personalTeam = await M.createAgent({}, { name: 'My Team' }, ctx(owner.id));
    await createRoleNode(personalTeam.systemMemoryId, 'backend-engineer');
    personalApp = await db.app.create({
      data: { id: generateId(), ownerUserId: owner.id, name: 'My Team App', urn: `tp-owner-${suffix}:team` },
    });
    await db.appAgent.create({ data: { appId: personalApp.id, agentId: personalTeam.id } });
  });

  it('the owner mints a user-owned PERSONAL persona', async () => {
    const agent = await M.createTeamPersona(
      {},
      { appRef: personalApp.id, role: 'backend-engineer' },
      ctx(owner.id),
    );
    expect(agent.personaName).toBe('Iris');
    expect(agent.ownerUserId).toBe(owner.id);
    expect(agent.organizationId).toBeNull();
    expect(agent.visibility).toBe('PERSONAL');
  });

  it('anyone else — including a platform admin — is denied (strict owner-only)', async () => {
    await expectCode(
      M.createTeamPersona({}, { appRef: personalApp.id, role: 'backend-engineer' }, ctx(outsider.id)),
      'FORBIDDEN',
    );
    const platformAdmin: Context = { db, userId: outsider.id, roles: ['ADMIN'] };
    await expectCode(
      M.createTeamPersona({}, { appRef: personalApp.id, role: 'backend-engineer' }, platformAdmin),
      'FORBIDDEN',
    );
  });
});

describe('createTeamPersona — install failure compensation', () => {
  it('a mint into a broken install path leaves no dangling Agent behind', async () => {
    // Force the AppAgent create to fail by deleting the App between the gate
    // and the install — the compensation hard-deletes the minted agent + its
    // system memory (cor:agt:020:02 never-did-anything escape hatch).
    const spy = vi.spyOn(db.appAgent, 'create').mockRejectedValueOnce(new Error('boom'));
    await expect(
      M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id)),
    ).rejects.toThrow('boom');
    spy.mockRestore();
    const dangling = await db.agent.findFirst({ where: { personaName: 'Iris' } });
    expect(dangling).toBeNull();
    // The name is free again — the next mint takes it.
    const agent = await M.createTeamPersona({}, { appRef: app.id, role: 'backend-engineer' }, ctx(admin.id));
    expect(agent.personaName).toBe('Iris');
  });
});
