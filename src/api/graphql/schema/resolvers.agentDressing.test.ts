/**
 * #928 — team-persona phase 1 (hadron-concept 2026-08-11-agent-personas),
 * re-scoped by #974 (2026-08-14-agent-persona-scoping).
 *
 * A persona — a named AI team member ("Iris") driven by external coding
 * sessions or portal chat — IS an Agent: `personaName` / `personaRole` /
 * `personaPrompt` are pure-metadata columns. Since #974 a persona is also
 * TEAM-BOUND (`personaName ⇒ teamAppId`, cor:agt:020:01), so `createAgent`
 * refuses `personaName` outright and `updateAgent` sets it only on an agent
 * that already has a team; the name is unique per TEAM App, case-insensitively
 * (`agents_team_persona_name_uniq`), and a collision is the typed
 * `PERSONA_NAME_TAKEN` — the atomic allocation primitive callers retry against
 * (D-2026-08-11-006, re-scoped by D-2026-08-14-001). The allocation contract
 * itself is exercised in resolvers.teamPersona.test.ts, which mints through
 * the one operation that can.
 *
 * Session grows coding-provenance fields (`transcriptPath` / `host` /
 * `tool`) and an `agentRef` input (cor:api:140) that resolves to
 * `Session.agentId`, gated by the agent read gate.
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

function ctx(userId?: string): Context {
  return { db, userId, roles: ['READER'] };
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

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let adminA: { id: string };
let adminB: { id: string };
let readerA: { id: string };
let outsider: { id: string };
let userOne: { id: string };
let userTwo: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgA = await db.organization.create({
    data: { id: generateId(), name: 'persona-a', urn: `persona-a-${suffix}.com` },
  });
  orgB = await db.organization.create({
    data: { id: generateId(), name: 'persona-b', urn: `persona-b-${suffix}.com` },
  });
  adminA = await db.user.create({
    data: { id: generateId(), githubId: 92801, githubUsername: `persona-admin-a-${suffix}`, roles: ['READER'] },
  });
  adminB = await db.user.create({
    data: { id: generateId(), githubId: 92802, githubUsername: `persona-admin-b-${suffix}`, roles: ['READER'] },
  });
  readerA = await db.user.create({
    data: { id: generateId(), githubId: 92803, githubUsername: `persona-reader-a-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 92804, githubUsername: `persona-outsider-${suffix}`, roles: ['READER'] },
  });
  userOne = await db.user.create({
    data: { id: generateId(), name: 'User One', handle: `persona-user-one-${suffix}`, roles: ['READER'] },
  });
  userTwo = await db.user.create({
    data: { id: generateId(), name: 'User Two', handle: `persona-user-two-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: orgA.id, userId: adminA.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: orgB.id, userId: adminB.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: orgA.id, userId: readerA.id, role: 'READER' },
  });
});

/**
 * Mint a real team in `orgA`: a Team Agent with a `roles:` branch, a team App,
 * and the roster join — the fixture `createTeamPersona` needs. Returns the App
 * plus a `mint()` that produces personas bound to it.
 */
async function makeTeam(slug: string) {
  const teamAgent = await M.createAgent({}, { orgId: orgA.id, name: `Team Agent ${slug}` }, ctx(adminA.id));
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      content: 'You are {{name}}, a {{role}}.',
      data: { names: ['Iris', 'Henry', 'Ada'] } as any,
    },
  });
  const teamApp = await db.app.create({
    data: { id: generateId(), organizationId: orgA.id, name: `App ${slug}`, urn: `${orgA.urn}:${slug}` },
  });
  await db.appAgent.create({ data: { appId: teamApp.id, agentId: teamAgent.id } });
  return {
    app: teamApp,
    mint: (name?: string) =>
      M.createTeamPersona(
        {},
        { appRef: teamApp.id, role: 'backend-engineer', name: name ?? null },
        ctx(adminA.id),
      ),
  };
}

describe('createAgent — persona columns (#928, team-bound since #974)', () => {
  it('refuses personaName: a persona needs a team App, so only createTeamPersona may mint one', async () => {
    await expectCode(
      M.createAgent(
        {},
        { orgId: orgA.id, name: 'Backend Worker', personaName: 'Iris' },
        ctx(adminA.id),
      ),
      'PERSONA_TEAM_REQUIRED',
    );
    // Same for a user-owned agent — there is no team-less persona anywhere.
    await expectCode(
      M.createAgent({}, { name: 'My Backend Helper', personaName: 'Iris' }, ctx(userOne.id)),
      'PERSONA_TEAM_REQUIRED',
    );
  });

  it('the other two persona fields carry no invariant and still persist', async () => {
    const agent = await M.createAgent(
      {},
      {
        orgId: orgA.id,
        name: 'Backend Worker',
        personaRole: 'backend-engineer',
        personaPrompt: 'You are Iris, a senior backend engineer.',
      },
      ctx(adminA.id),
    );
    expect(agent.personaName).toBeNull();
    expect(agent.personaRole).toBe('backend-engineer');
    expect(agent.personaPrompt).toBe('You are Iris, a senior backend engineer.');
    expect(agent.teamAppId).toBeNull();
  });

  it('trims persona fields; blank-after-trim is stored as NULL and reserves nothing (#929 review)', async () => {
    // A whitespace-only personaName is ABSENT (cor:agt:020:02), so it is not
    // the team-bound refusal either — it simply stores nothing.
    const blank = await M.createAgent(
      {},
      { orgId: orgA.id, name: 'Blank One', personaName: '   ', personaRole: ' ', personaPrompt: '' },
      ctx(adminA.id),
    );
    expect(blank.personaName).toBeNull();
    expect(blank.personaRole).toBeNull();
    expect(blank.personaPrompt).toBeNull();
    const blank2 = await M.createAgent(
      {},
      { orgId: orgA.id, name: 'Blank Two', personaName: '  ' },
      ctx(adminA.id),
    );
    expect(blank2.personaName).toBeNull();
  });

  it('two teams in one org may each have an Iris — the name is scoped to the team (#974)', async () => {
    const eng = await makeTeam('eng-team');
    const data = await makeTeam('data-team');
    const a = await eng.mint();
    const b = await data.mint();
    expect(a.personaName).toBe('Iris');
    expect(b.personaName).toBe('Iris');
    expect(a.teamAppId).toBe(eng.app.id);
    expect(b.teamAppId).toBe(data.app.id);
    // Within one team the name is still taken, case-insensitively.
    await expectCode(eng.mint('iris'), 'PERSONA_NAME_TAKEN');
  });
});

describe('createAgent / updateAgent — the slug dot reservation (#974, cor:urn:010:03)', () => {
  it('refuses an agent name whose derived slug carries a dot', async () => {
    await expectCode(
      M.createAgent({}, { orgId: orgA.id, name: 'Acme Inc. Bot' }, ctx(adminA.id)),
      'BAD_USER_INPUT',
    );
  });

  it('refuses a dotted rename slug', async () => {
    const agent = await M.createAgent({}, { orgId: orgA.id, name: 'Plain Worker' }, ctx(adminA.id));
    await expectCode(
      M.updateAgent({}, { ref: agent.id, urn: 'eng-team.iris' }, ctx(adminA.id)),
      'BAD_USER_INPUT',
    );
    // A dot-free rename still works.
    const renamed = await M.updateAgent({}, { ref: agent.id, urn: 'plain-worker-2' }, ctx(adminA.id));
    expect(renamed.urn).toBe(`${orgA.urn}:plain-worker-2`);
  });

  it("refuses to rename a PERSONA's slug — it is server-derived (cor:agt:020:06)", async () => {
    const eng = await makeTeam('eng-team');
    const iris = await eng.mint();
    expect(iris.urn).toBe(`${orgA.urn}:eng-team.iris`);
    await expectCode(
      M.updateAgent({}, { ref: iris.id, urn: 'iris' }, ctx(adminA.id)),
      'BAD_USER_INPUT',
    );
  });
});

describe('updateAgent — persona columns (#928, team-bound since #974)', () => {
  it('renames, collides, and clears on a real persona', async () => {
    const eng = await makeTeam('eng-team');
    const iris = await eng.mint();
    const henry = await eng.mint();
    expect([iris.personaName, henry.personaName]).toEqual(['Iris', 'Henry']);

    // Rename to a free name in the same team.
    const updated = await M.updateAgent(
      {},
      { ref: henry.id, personaName: 'Zoe', personaPrompt: 'You are Zoe.' },
      ctx(adminA.id),
    );
    expect(updated.personaName).toBe('Zoe');
    expect(updated.personaRole).toBe('backend-engineer');

    // Collision within the team maps to the same typed code as on mint.
    await expectCode(
      M.updateAgent({}, { ref: henry.id, personaName: 'iris' }, ctx(adminA.id)),
      'PERSONA_NAME_TAKEN',
    );

    // Explicit null clears (omitted preserves — exercised implicitly above:
    // the collision attempt did not touch personaRole).
    const cleared = await M.updateAgent({}, { ref: iris.id, personaName: null }, ctx(adminA.id));
    expect(cleared.personaName).toBeNull();
  });

  it('refuses to set personaName on an agent with no team App', async () => {
    const plain = await M.createAgent({}, { orgId: orgA.id, name: 'Worker B' }, ctx(adminA.id));
    await expectCode(
      M.updateAgent({}, { ref: plain.id, personaName: 'Henry' }, ctx(adminA.id)),
      'PERSONA_TEAM_REQUIRED',
    );
  });

  it('the same name is free in another team (#974)', async () => {
    const eng = await makeTeam('eng-team');
    const data = await makeTeam('data-team');
    await eng.mint('Iris');
    const other = await data.mint('Henry');
    const renamed = await M.updateAgent({}, { ref: other.id, personaName: 'Iris' }, ctx(adminA.id));
    expect(renamed.personaName).toBe('Iris');
  });
});

describe('startSession — coding provenance + agentRef (#928)', () => {
  it('persists transcriptPath / host / tool', async () => {
    const s = await M.startSession(
      {},
      {
        input: {
          id: generateId(),
          repo: 'hadron-memory/hadron-cli',
          branch: 'main',
          transcriptPath: '/Users/x/.claude/projects/p/session.jsonl',
          host: 'mbp-holger',
          tool: 'claude-code',
        },
      },
      ctx(readerA.id),
    );
    expect(s.type).toBe('DEVELOPER');
    expect(s.transcriptPath).toBe('/Users/x/.claude/projects/p/session.jsonl');
    expect(s.host).toBe('mbp-holger');
    expect(s.tool).toBe('claude-code');
    expect(s.agentId).toBeNull();
  });

  it('resolves agentRef (URN) to Session.agentId for an org member', async () => {
    const agent = await M.createAgent(
      {},
      { orgId: orgA.id, name: 'Backend Worker' },
      ctx(adminA.id),
    );
    const s = await M.startSession(
      {},
      { input: { id: generateId(), agentRef: agent.urn, tool: 'claude-code' } },
      ctx(readerA.id),
    );
    expect(s.agentId).toBe(agent.id);
  });

  it('rejects an unknown agentRef with BAD_USER_INPUT', async () => {
    await expectCode(
      M.startSession(
        {},
        { input: { id: generateId(), agentRef: `${orgA.urn}:no-such-agent` } },
        ctx(readerA.id),
      ),
      'BAD_USER_INPUT',
    );
  });

  it('treats a whitespace-only agentRef as absent (#929 review)', async () => {
    const s = await M.startSession(
      {},
      { input: { id: generateId(), agentRef: '   ', tool: 'claude-code' } },
      ctx(readerA.id),
    );
    expect(s.agentId).toBeNull();
  });

  it('attributes the session to the calling user and makes it readable by its creator (#929 review P1)', async () => {
    // `outsider` belongs to NO org, so pre-P1 both read gates (app-scoped
    // only) would hide this session from its own creator.
    const s = await M.startSession(
      {},
      { input: { id: generateId(), tool: 'claude-code', host: 'mbp' } },
      ctx(outsider.id),
    );
    expect(s.userId).toBe(outsider.id);
    // Single read: creator sees it; an unrelated user does not.
    const single = await Q.session({}, { id: s.id }, ctx(outsider.id));
    expect(single?.id).toBe(s.id);
    expect(await Q.session({}, { id: s.id }, ctx(userOne.id))).toBeNull();
    // List: creator's scope includes it; org member readerA's does not.
    const mine = await Q.sessions({}, {}, ctx(outsider.id));
    expect(mine.map((x: { id: string }) => x.id)).toContain(s.id);
    const others = await Q.sessions({}, {}, ctx(userOne.id));
    expect(others.map((x: { id: string }) => x.id)).not.toContain(s.id);
  });

  it('refuses to attribute a session to a non-public agent the caller cannot read', async () => {
    const agent = await M.createAgent(
      {},
      { orgId: orgA.id, name: 'Backend Worker' },
      ctx(adminA.id),
    );
    await expect(
      M.startSession(
        {},
        { input: { id: generateId(), agentRef: agent.id } },
        ctx(outsider.id),
      ),
    ).rejects.toThrow(/Forbidden/);
  });
});
