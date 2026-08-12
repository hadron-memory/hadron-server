/**
 * #943 — `SessionInput.appRef`: the write path that makes the team-chat
 * authorship gate reachable.
 *
 * The headline test is the dogfood repro (found on the first real team App,
 * 2026-08-12): a USER starts a session bound to a persona AND to the team App,
 * then posts into the team chat as that persona. Before `appRef`,
 * `Session.appId` was stamped only from an App-key credential, so this exact
 * sequence was structurally impossible — `createTeamChatMessage` refused every
 * CLI-started session with `SESSION_NOT_IN_APP` (cor:agt:020:04 condition b).
 *
 * The rest is the auth matrix, one case per PRINCIPAL SHAPE (the #935/#936
 * template): AppMember, org member, non-member, user-owned-App owner, pure
 * App-key credential, and the HYBRID user+active-App-selection shape that
 * findings:auth-appid-credential-vs-selection says is the one that gets
 * skipped.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { buildSchema, type GraphQLInputObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

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

const startSession = (c: Context, input: Record<string, unknown>) =>
  M.startSession({}, { input: { id: generateId(), tool: 'claude-code', ...input } }, c);

let org: { id: string; urn: string };
let admin: { id: string };
let contrib: { id: string };
let appMember: { id: string };
let outsider: { id: string; handle: string };
let teamAgent: { id: string; urn: string; systemMemoryId: string };
let app: { id: string; urn: string };
let otherApp: { id: string; urn: string };
let ownedApp: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'sar-org', urn: `sar-org-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 94301, githubUsername: `sar-admin-${suffix}`, roles: ['READER'] },
  });
  contrib = await db.user.create({
    data: { id: generateId(), githubId: 94302, githubUsername: `sar-contrib-${suffix}`, roles: ['READER'] },
  });
  appMember = await db.user.create({
    data: { id: generateId(), githubId: 94303, githubUsername: `sar-member-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: {
      id: generateId(),
      githubId: 94304,
      githubUsername: `sar-outsider-${suffix}`,
      handle: `sar-outsider-${suffix}`.replace(/[^a-z0-9-]/gi, '-'),
      roles: ['READER'],
    },
    select: { id: true, handle: true },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: contrib.id, role: 'CONTRIBUTOR' },
  });

  // The Team Agent — through the real mutation, with the roles: branch marker
  // createTeamPersona locates it by (mirrors resolvers.teamChat.test.ts).
  const created = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgent = { id: created.id, urn: created.urn, systemMemoryId: created.systemMemoryId };
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      content: 'You are {{name}}, a {{role}}.',
      data: { names: ['Ada', 'Henry'] },
    },
  });

  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: appMember.id, role: 'reader' } });

  // A second App in the SAME org, with no members — the mismatch counterparty.
  otherApp = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Other App', urn: `${org.urn}:other` },
  });

  // A user-owned App (spec 047: organizationId NULL, ownerUserId set).
  ownedApp = await db.app.create({
    data: {
      id: generateId(),
      ownerUserId: outsider.id,
      name: 'Solo App',
      urn: `${outsider.handle}:solo`,
    },
  });
});

describe('#943 acceptance — a user-started session can author in the team chat', () => {
  it('appRef + agentRef, then createTeamChatMessage posts as the persona', async () => {
    // 1. The persona (Ada), minted from the Team Agent's role definition.
    const persona = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );

    // 2. `hadron team session start --as Ada` — a USER-authenticated session
    //    (no App key anywhere), bound to both the persona and the App.
    const session = await startSession(ctx(contrib.id), {
      appRef: app.urn,
      agentRef: persona.urn,
    });
    expect(session.appId).toBe(app.id);
    expect(session.agentId).toBe(persona.id);
    expect(session.userId).toBe(contrib.id);

    // 3. `hadron chat post` — this returned SESSION_NOT_IN_APP before #943.
    const message = await M.createTeamChatMessage(
      {},
      { appRef: app.id, body: 'shipping the appRef fix', sessionRef: session.id },
      ctx(contrib.id),
    );
    expect(message.authorAgentId).toBe(persona.id);
    expect(message.authorName).toBe(persona.personaName);
    expect(message.sessionId).toBe(session.id);
    // #914: the envelope's author is the persona, the node's createdBy is the
    // human driver — attribution resolves persona -> session -> driver.
    expect(message.authorUserId).toBeNull();
  });
});

describe('#943 — appRef resolution', () => {
  it('accepts a PK and a URN alike (cor:api:140)', async () => {
    const byId = await startSession(ctx(contrib.id), { appRef: app.id });
    expect(byId.appId).toBe(app.id);
    const byUrn = await startSession(ctx(contrib.id), { appRef: app.urn });
    expect(byUrn.appId).toBe(app.id);
  });

  it('leaves appId null when appRef is absent or whitespace-only', async () => {
    expect((await startSession(ctx(contrib.id), {})).appId).toBeNull();
    expect((await startSession(ctx(contrib.id), { appRef: '   ' })).appId).toBeNull();
  });

  it('rejects an unknown appRef with BAD_USER_INPUT', async () => {
    await expectCode(
      startSession(ctx(contrib.id), { appRef: `${org.urn}:no-such-app` }),
      'BAD_USER_INPUT',
    );
  });

  it('rejects a soft-deleted App with BAD_USER_INPUT', async () => {
    const dead = await db.app.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        name: 'Dead App',
        urn: `${org.urn}:dead`,
        deletedAt: new Date(),
      },
    });
    await expectCode(startSession(ctx(admin.id), { appRef: dead.id }), 'BAD_USER_INPUT');
  });

  it('rejects an uninstalled App: APP_UNINSTALLED by PK, BAD_USER_INPUT by URN', async () => {
    const gone = await db.app.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        name: 'Uninstalled App',
        urn: `${org.urn}:gone`,
        uninstalledAt: new Date(),
      },
    });
    // By PK the row is unambiguous, so the refusal is the specific one.
    await expectCode(startSession(ctx(admin.id), { appRef: gone.id }), 'APP_UNINSTALLED');
    // By URN it is not found at all, and that is correct rather than a gap
    // (#944 review): App URNs are unique only among ACTIVE rows (spec 021
    // FR-027), so this URN may name several uninstalled rows — and may later
    // name a different LIVE App. Pinned so the asymmetry is deliberate.
    await expectCode(startSession(ctx(admin.id), { appRef: gone.urn }), 'BAD_USER_INPUT');
  });

  it('declares appRef on SessionInput in the SDL (#789 drift class)', () => {
    const input = buildSchema(typeDefs).getType('SessionInput') as GraphQLInputObjectType;
    expect(Object.keys(input.getFields())).toContain('appRef');
    expect(String(input.getFields().appRef.type)).toBe('String');
  });
});

describe('#943 — the App-membership gate, one case per principal shape', () => {
  it('admits an AppMember at any role (including "reader")', async () => {
    const s = await startSession(ctx(appMember.id), { appRef: app.id });
    expect(s.appId).toBe(app.id);
  });

  it('admits an org member with CONTRIBUTOR+ on the App\'s org', async () => {
    const s = await startSession(ctx(contrib.id), { appRef: app.id });
    expect(s.appId).toBe(app.id);
  });

  it('refuses a caller who belongs to neither the App nor its org', async () => {
    await expectCode(startSession(ctx(outsider.id), { appRef: app.id }), 'FORBIDDEN');
  });

  it('refuses an anonymous caller (no user, no App key)', async () => {
    await expectCode(startSession({ db }, { appRef: app.id }), 'FORBIDDEN');
  });

  it('admits the owner of a user-owned App, and only the owner', async () => {
    const s = await startSession(ctx(outsider.id), { appRef: ownedApp.id });
    expect(s.appId).toBe(ownedApp.id);
    // spec 047 / findings:org-xor-owner-null-comparison-bypass: both Apps'
    // organizationId is NULL for a second user-owned App, so an org-column
    // comparison would read null !== null and admit this caller.
    const foreign = await db.app.create({
      data: { id: generateId(), ownerUserId: contrib.id, name: 'Their App', urn: `their-app-${generateId().slice(-8)}:solo` },
    });
    await expectCode(startSession(ctx(outsider.id), { appRef: foreign.id }), 'FORBIDDEN');
    // …and an org ADMIN of an unrelated org gets no path in either.
    await expectCode(startSession(ctx(admin.id), { appRef: ownedApp.id }), 'FORBIDDEN');
  });
});

describe('#943 — App-key precedence', () => {
  it('accepts an App-key principal whose appRef names its own App', async () => {
    const s = await startSession(ctx(undefined, app.id), { appRef: app.urn });
    expect(s.appId).toBe(app.id);
    expect(s.userId).toBeNull();
  });

  it('refuses an App-key principal whose appRef names a DIFFERENT App', async () => {
    await expectCode(
      startSession(ctx(undefined, app.id), { appRef: otherApp.id }),
      'SESSION_APP_MISMATCH',
    );
  });

  it('still stamps ctx.appId when an App-key caller sends no appRef', async () => {
    const s = await startSession(ctx(undefined, app.id), {});
    expect(s.appId).toBe(app.id);
  });

  it('judges a HYBRID principal (user + active-App selection) on the USER', async () => {
    // MCP's requireAppScope fills auth.appId from the user's active-App
    // SELECTION, which is not a credential
    // (findings:auth-appid-credential-vs-selection) — so the membership gate
    // still runs even when the ref matches the selection.
    await expectCode(
      startSession(ctx(outsider.id, app.id), { appRef: app.id }),
      'FORBIDDEN',
    );
    const s = await startSession(ctx(contrib.id, app.id), { appRef: app.id });
    expect(s.appId).toBe(app.id);
    // A mismatch is refused for the hybrid shape too — one rule, no ambiguity
    // about which App the session belongs to.
    await expectCode(
      startSession(ctx(contrib.id, app.id), { appRef: otherApp.id }),
      'SESSION_APP_MISMATCH',
    );
  });
});

describe('#944 review — the bound agent must be on the App\'s roster to author', () => {
  /**
   * Codex P1 / Copilot on PR #944. `appRef` and `agentRef` are authorized
   * INDEPENDENTLY — the agent gate only requires readability, so a PUBLIC
   * agent of another tenant can legitimately be bound to a session. Without a
   * roster check at post time, a participant could author into their team's
   * chat under that foreign agent's identity. The mention filter already
   * resolves Agent refs only when INSTALLED, so the write side was the
   * asymmetric half.
   */
  it('refuses a foreign PUBLIC agent bound to a session of this App', async () => {
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'sar-other-org', urn: `sar-other-${generateId().slice(-8)}.com` },
    });
    const foreignAgent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: otherOrg.id,
        name: 'Impostor',
        personaName: 'Ada',
        urn: `${otherOrg.urn}:impostor`,
        visibility: 'PUBLIC',
      },
    });
    // Binding succeeds — attribution is not authorship (a PUBLIC agent is
    // readable by anyone, which is exactly why the gate can't live here).
    const session = await startSession(ctx(contrib.id), {
      appRef: app.id,
      agentRef: foreignAgent.id,
    });
    expect(session.agentId).toBe(foreignAgent.id);
    // Authorship is refused.
    await expectCode(
      M.createTeamChatMessage(
        {},
        { appRef: app.id, body: 'hello from nowhere', sessionRef: session.id },
        ctx(contrib.id),
      ),
      'SESSION_AGENT_NOT_IN_APP',
    );
  });

  it('refuses an own-org agent that is not installed in the App', async () => {
    const notInstalled = await M.createAgent(
      {},
      { orgId: org.id, name: 'Unrostered', personaName: 'Mallory' },
      ctx(admin.id),
    );
    const session = await startSession(ctx(contrib.id), {
      appRef: app.id,
      agentRef: notInstalled.id,
    });
    await expectCode(
      M.createTeamChatMessage(
        {},
        { appRef: app.id, body: 'not on the team', sessionRef: session.id },
        ctx(contrib.id),
      ),
      'SESSION_AGENT_NOT_IN_APP',
    );
  });

  it('honours an uninstall that happens AFTER the session started', async () => {
    // Why the check lives at post time and not at bind time: this sequence is
    // inexpressible with a bind-time gate.
    const persona = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );
    const session = await startSession(ctx(contrib.id), {
      appRef: app.id,
      agentRef: persona.urn,
    });
    // Posting works while the persona is on the roster.
    await M.createTeamChatMessage(
      {},
      { appRef: app.id, body: 'still on the team', sessionRef: session.id },
      ctx(contrib.id),
    );
    // Uninstall is a hard row delete (AppAgent has no soft-delete).
    await db.appAgent.delete({
      where: { appId_agentId: { appId: app.id, agentId: persona.id } },
    });
    await expectCode(
      M.createTeamChatMessage(
        {},
        { appRef: app.id, body: 'after the uninstall', sessionRef: session.id },
        ctx(contrib.id),
      ),
      'SESSION_AGENT_NOT_IN_APP',
    );
  });
});

describe('#943 — the gate the fix makes reachable stays closed elsewhere', () => {
  it('a session of App A still cannot author into App B\'s chat', async () => {
    const persona = await M.createTeamPersona(
      {},
      { appRef: app.id, role: 'backend-engineer' },
      ctx(admin.id),
    );
    const session = await startSession(ctx(contrib.id), {
      appRef: app.id,
      agentRef: persona.urn,
    });
    await db.appAgent.create({ data: { appId: otherApp.id, agentId: teamAgent.id } });
    await expectCode(
      M.createTeamChatMessage(
        {},
        { appRef: otherApp.id, body: 'wrong room', sessionRef: session.id },
        ctx(contrib.id),
      ),
      'SESSION_NOT_IN_APP',
    );
  });
});
