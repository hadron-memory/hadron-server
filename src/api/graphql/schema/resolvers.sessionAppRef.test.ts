import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #943 — `SessionInput.appRef`: the write path that makes the team-chat
 * authorship gate reachable.
 *
 * The headline test is the dogfood repro (found on the first real team App,
 * 2026-08-12, re-cut by #974): a USER starts a session bound to a Worker AND
 * to the team App, then posts into the team chat as that worker. Before
 * `appRef`, `Session.appId` was stamped only from an App-key credential, so
 * this exact sequence was structurally impossible — `createTeamChatMessage`
 * refused every CLI-started session with `SESSION_NOT_IN_APP`
 * (cor:agt:020:04 condition b).
 *
 * The rest is the auth matrix, one case per PRINCIPAL SHAPE (the #935/#936
 * template): AppMember, org member, non-member, user-owned-App owner, pure
 * App-key credential, and the HYBRID user+active-App-selection shape that
 * findings:auth-appid-credential-vs-selection says is the one that gets
 * skipped — plus the #974 `SessionInput.workerRef` contract (binding the
 * named identity, deriving the App from the worker behind the same gate).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { buildSchema, type GraphQLInputObjectType } from 'graphql';
import type { Request } from 'express';
import { db } from '../../../integrations/db/client.js';
import { hashAppKey, resolveAuthContext } from '../../../middleware/auth.js';
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
  // the worker bootstraps locate it by (mirrors resolvers.teamChat.test.ts).
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
  it('appRef + workerRef, then createTeamChatMessage posts as the worker', async () => {
    // 1. The worker (Ada) — the named casting of the Team Agent (#974).
    const ada = await M.castWorker(
      {},
      { appRef: app.id, agentRef: teamAgent.id, name: 'Ada' },
      ctx(admin.id),
    );

    // 2. `hadron team session start --as Ada` — a USER-authenticated session
    //    (no App key anywhere), bound to both the worker and the App.
    const session = await startSession(ctx(contrib.id), {
      appRef: app.urn,
      workerRef: ada.id,
    });
    expect(session.appId).toBe(app.id);
    expect(session.workerId).toBe(ada.id);
    // Session.agentId records the ROLE-agent behind the casting.
    expect(session.agentId).toBe(teamAgent.id);
    expect(session.userId).toBe(contrib.id);

    // 3. `hadron chat post` — this returned SESSION_NOT_IN_APP before #943.
    const message = await M.createTeamChatMessage(
      {},
      { appRef: app.id, body: 'shipping the appRef fix', sessionRef: session.id },
      ctx(contrib.id),
    );
    expect(message.authorWorkerId).toBe(ada.id);
    expect(message.authorName).toBe('Ada');
    expect(message.sessionId).toBe(session.id);
    // #914: the envelope's author is the worker, the node's createdBy is the
    // human driver — attribution resolves worker -> session -> driver.
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

  it('refuses a still-valid key of an uninstalled App without appRef (#1001)', async () => {
    const rawKey = `hdr_app_${randomBytes(32).toString('hex')}`;
    await db.appKey.create({ data: {
      id: generateId(), appId: app.id, keyHash: hashAppKey(rawKey),
      keyPreview: `${rawKey.slice(0, 12)}...`,
    } });
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    const auth = await resolveAuthContext({
      headers: { authorization: `Bearer ${rawKey}` },
    } as unknown as Request, db);
    expect(auth.appId).toBe(app.id);
    await expectCode(startSession({ db, ...auth } as Context, {}), 'APP_UNINSTALLED');
    expect(await db.session.count()).toBe(0);
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: null } });
    expect((await startSession({ db, ...auth } as Context, {})).appId).toBe(app.id);
  });

  it('waits for an in-flight uninstall before starting an ambient-App session', async () => {
    let releaseUninstall!: () => void;
    let didUpdate!: () => void;
    const release = new Promise<void>((resolve) => { releaseUninstall = resolve; });
    const updated = new Promise<void>((resolve) => { didUpdate = resolve; });
    const uninstall = db.$transaction(async (tx) => {
      await tx.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
      didUpdate();
      await release;
    });
    await updated;
    try {
      const attempted = expectCode(startSession(ctx(undefined, app.id), {}), 'APP_UNINSTALLED');
      await new Promise((resolve) => setTimeout(resolve, 100));
      releaseUninstall();
      await uninstall;
      await attempted;
      expect(await db.session.count({ where: { appId: app.id } })).toBe(0);
    } finally {
      releaseUninstall();
      await uninstall;
    }
  });

  it('refuses a stale active-App selection when no explicit App is named (#1001)', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expectCode(startSession(ctx(contrib.id, app.id), {}), 'APP_UNINSTALLED');
    expect(await db.session.count()).toBe(0);
    // A user selection is a fallback, so an explicit live App still wins.
    const named = await startSession(ctx(contrib.id, app.id), { appRef: otherApp.id });
    expect(named.appId).toBe(otherApp.id);
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

    // SUPERSEDED BY #1037 (review:convention-ratchets-must-be-flipped). This
    // asserted that a MISMATCH is refused for the hybrid shape too — "one rule,
    // no ambiguity" (#943). That rule conflated the two meanings of ctx.appId:
    // for the hybrid shape it is the active-App SELECTION, which any later bind
    // in another App silently re-points, so refusing here meant a multi-App
    // caller could not deliberately open a session in another App without
    // re-pinning first. An explicit argument now beats connection state; a
    // CREDENTIAL still does not (the App-key case above is unchanged, and is
    // what "one rule" was actually protecting).
    //
    // The membership gate is what still bounds this, and it is asserted above:
    // the outsider is FORBIDDEN whether or not their selection agrees.
    const elsewhere = await startSession(ctx(contrib.id, app.id), { appRef: otherApp.id });
    expect(elsewhere.appId).toBe(otherApp.id);
    await expectCode(
      startSession(ctx(outsider.id, app.id), { appRef: otherApp.id }),
      'FORBIDDEN',
    );
  });
});

describe('#944/#974 review — agent binding alone cannot author; the worker-App pin gates at post time', () => {
  /**
   * Codex P1 / Copilot on PR #944, re-cut by #974: `appRef` and `agentRef`
   * are authorized INDEPENDENTLY — the agent gate only requires readability,
   * so a PUBLIC agent of another tenant can legitimately be bound to a
   * session. Chat authorship now requires a WORKER binding (the worker-App
   * pin replaced the old SESSION_AGENT_NOT_IN_APP roster check), so an
   * agent-only binding must never confer a voice in the team chat.
   */
  it('a foreign PUBLIC agent can be bound, but confers no authorship', async () => {
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'sar-other-org', urn: `sar-other-${generateId().slice(-8)}.com` },
    });
    const foreignAgent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: otherOrg.id,
        name: 'Impostor',
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
    expect(session.workerId).toBeNull();
    // Authorship is refused: no Worker binding, no voice.
    await expectCode(
      M.createTeamChatMessage(
        {},
        { appRef: app.id, body: 'hello from nowhere', sessionRef: session.id },
        ctx(contrib.id),
      ),
      'SESSION_NOT_WORKER_BOUND',
    );
  });

  it('honours a retirement that happens AFTER the session started', async () => {
    // Why the check lives at post time and not at bind time: this sequence is
    // inexpressible with a bind-time gate. (An agent uninstall no longer
    // severs authorship — the Worker row survives it, cor:dmo:050:11;
    // retirement is the revocation lever.)
    const rae = await M.castWorker(
      {},
      { appRef: app.id, agentRef: teamAgent.id, name: 'Rae' },
      ctx(admin.id),
    );
    const session = await startSession(ctx(contrib.id), {
      appRef: app.id,
      workerRef: rae.id,
    });
    // Posting works while the worker is active.
    await M.createTeamChatMessage(
      {},
      { appRef: app.id, body: 'still casting', sessionRef: session.id },
      ctx(contrib.id),
    );
    await M.retireWorker({}, { workerRef: rae.id }, ctx(admin.id));
    await expectCode(
      M.createTeamChatMessage(
        {},
        { appRef: app.id, body: 'after the retirement', sessionRef: session.id },
        ctx(contrib.id),
      ),
      'WORKER_RETIRED',
    );
  });
});

describe('#943 — the gate the fix makes reachable, after spec 049 Phase 8 (item J)', () => {
  it('a session of App A authors into App B\'s chat iff its driver may write B\'s host memory — and the post says so', async () => {
    // Before Phase 8 this was refused SESSION_NOT_IN_APP: a session of App A
    // never authored in App B. Item J (plan §4.5) replaced the session-App
    // pin and the worker-App pin with ONE check — the Worker's App is the
    // Channel's, or the driver may write the Channel's host memory. contrib
    // is an org CONTRIBUTOR, who may write B's app-class memory, so Ada is
    // ADMITTED and the message records her App beside the Channel's. The
    // refusal direction (a driver who may not write B's host memory:
    // CHANNEL_HOST_NOT_WRITABLE) is pinned in resolvers.channelChat.test.ts.
    const ada = await M.castWorker(
      {},
      { appRef: app.id, agentRef: teamAgent.id, name: 'Ada' },
      ctx(admin.id),
    );
    const session = await startSession(ctx(contrib.id), {
      appRef: app.id,
      workerRef: ada.id,
    });
    await db.appAgent.create({ data: { appId: otherApp.id, agentId: teamAgent.id } });
    const posted = await M.createTeamChatMessage(
      {},
      { appRef: otherApp.id, body: 'cross-team note', sessionRef: session.id },
      ctx(contrib.id),
    );
    expect(posted.authorWorkerId).toBe(ada.id);
    expect(posted.authorAppId).toBe(app.id);
  });
});

describe('SessionInput.workerRef (#974) — binding the named identity', () => {
  /**
   * Contract (cor:agt:020:03): workerRef is PK-only (workers have no URN);
   * the worker must belong to the session's App; with NO App context the
   * worker's App becomes the session's — behind the SAME participant
   * predicate the appRef path runs, so binding a worker never widens who can
   * attribute a session to an App. Session.agentId is stamped from the
   * casting's role-agent. #940: binding a TAKEN worker (an active session)
   * refuses WORKER_TAKEN unless force — informed takeover is now
   * server-enforced (the thin-client directive), never silent.
   */
  let worker: { id: string };

  beforeEach(async () => {
    worker = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: teamAgent.id, name: 'Iris', slug: 'iris' },
    });
  });

  it('binds the worker and derives the App and role-agent from the casting', async () => {
    const s = await startSession(ctx(contrib.id), { workerRef: worker.id });
    expect(s.workerId).toBe(worker.id);
    expect(s.appId).toBe(app.id);
    expect(s.agentId).toBe(teamAgent.id);
  });

  it('accepts an explicit appRef that matches the worker\'s App', async () => {
    const s = await startSession(ctx(contrib.id), { appRef: app.urn, workerRef: worker.id });
    expect(s.workerId).toBe(worker.id);
    expect(s.appId).toBe(app.id);
  });

  it('refuses an appRef naming a DIFFERENT App than the worker\'s → SESSION_WORKER_NOT_IN_APP', async () => {
    await expectCode(
      startSession(ctx(contrib.id), { appRef: otherApp.id, workerRef: worker.id }),
      'SESSION_WORKER_NOT_IN_APP',
    );
  });

  it('refuses a retired worker → WORKER_RETIRED (the name stays reserved, the identity takes no new sessions)', async () => {
    await db.worker.update({ where: { id: worker.id }, data: { retiredAt: new Date() } });
    await expectCode(startSession(ctx(contrib.id), { workerRef: worker.id }), 'WORKER_RETIRED');
  });

  it('refuses an unknown id-shaped workerRef → WORKER_NOT_FOUND', async () => {
    // cuid-shaped: resolved as an ID, found nowhere.
    await expectCode(
      startSession(ctx(contrib.id), { workerRef: 'c' + 'a'.repeat(24) }),
      'WORKER_NOT_FOUND',
    );
  });

  it('refuses an unknown URN-shaped workerRef → WORKER_NOT_FOUND', async () => {
    await expectCode(
      startSession(ctx(contrib.id), { workerRef: `hrn:worker:${org.urn}:team:ghost` }),
      'WORKER_NOT_FOUND',
    );
  });

  it('a NAME-shaped ref with no App context → SESSION_WORKER_NAME_NEEDS_APP (#990)', async () => {
    // Changed deliberately by #990: a bare string is now a worker NAME, and a
    // name is only unique within an App. Answering WORKER_NOT_FOUND here would
    // claim a lookup that never happened — this says which input is missing.
    // The id and URN shapes above keep the original refusal.
    await expectCode(
      startSession(ctx(contrib.id), { workerRef: 'no-such-worker' }),
      'SESSION_WORKER_NAME_NEEDS_APP',
    );
  });

  it('gates the derived-App path on the same participant predicate (non-member → WORKER_NOT_FOUND, #1937)', async () => {
    // Binding a worker with no App context must not widen who can attribute a
    // session to the worker's App. Since #1937 the non-member gets the absent
    // ref's answer, not a FORBIDDEN that says the worker exists.
    await expectCode(startSession(ctx(outsider.id), { workerRef: worker.id }), 'WORKER_NOT_FOUND');
    expect(await db.session.count()).toBe(0);
  });

  it('refuses the derived-App path into an uninstalled App → APP_UNINSTALLED', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expectCode(startSession(ctx(contrib.id), { workerRef: worker.id }), 'APP_UNINSTALLED');
  });

  it('refuses a worker id under an uninstalled ambient App (#1001)', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expectCode(startSession(ctx(undefined, app.id), { workerRef: worker.id }), 'APP_UNINSTALLED');
    expect(await db.session.count()).toBe(0);
  });

  it('refuses an agentRef that disagrees with the casting → BAD_USER_INPUT; a matching one is fine', async () => {
    const otherAgent = await M.createAgent({}, { orgId: org.id, name: 'Some Other Agent' }, ctx(admin.id));
    await expectCode(
      startSession(ctx(contrib.id), { agentRef: otherAgent.id, workerRef: worker.id }),
      'BAD_USER_INPUT',
    );
    const s = await startSession(ctx(contrib.id), { agentRef: teamAgent.urn, workerRef: worker.id });
    expect(s.workerId).toBe(worker.id);
    expect(s.agentId).toBe(teamAgent.id);
  });

  it('refuses binding a taken worker → WORKER_TAKEN, carrying the takeover-prompt payload (#940)', async () => {
    // #1050: WORKER_TAKEN is now only ever a question about your OWN worker.
    // A DIFFERENT driver is refused earlier and harder — see the WORKER_HELD
    // case below — so the takeover-prompt payload is exercised on the same
    // driver, which is the only principal still allowed to force.
    const first = await startSession(ctx(contrib.id), { workerRef: worker.id });
    expect(first.endedAt).toBeNull();
    try {
      await startSession(ctx(contrib.id), { workerRef: worker.id });
      expect.fail('expected WORKER_TAKEN');
    } catch (e) {
      const ext = (e as GraphQLError).extensions as Record<string, unknown>;
      expect(ext.code).toBe('WORKER_TAKEN');
      // Everything the informed-takeover prompt needs, in one round trip:
      // the blocking session, who last drove it, and when.
      expect(ext.workerId).toBe(worker.id);
      expect(ext.sessionId).toBe(first.id);
      const contribUser = await db.user.findUniqueOrThrow({ where: { id: contrib.id } });
      expect(ext.lastDriver).toBe(contribUser.handle ?? contribUser.githubUsername);
      expect(typeof ext.lastSeenAt).toBe('string');
      expect(new Date(ext.lastSeenAt as string).getTime()).toBeGreaterThan(0);
    }
  });

  it('force: true takes over — the explicit override, never the default (#940)', async () => {
    // Same driver, second live session: the person deciding is the person
    // affected, which is what still makes this forceable under #1050.
    await startSession(ctx(contrib.id), { workerRef: worker.id });
    const second = await startSession(ctx(contrib.id), { workerRef: worker.id, force: true });
    expect(second.workerId).toBe(worker.id);
  });

  it('#1050 — a DIFFERENT driver is refused WORKER_HELD, and force does not help', async () => {
    // SUPERSEDES the pre-#1050 shape of these two tests, which had appMember
    // take over contrib's worker on the strength of a session row. That is the
    // incident (hadron-cli#492): a name is held by a person, so the remedy for
    // wanting someone else's is to cast your own, never to adjudicate whether
    // they are really gone.
    await startSession(ctx(contrib.id), { workerRef: worker.id });
    for (const force of [false, true]) {
      try {
        await startSession(ctx(appMember.id), { workerRef: worker.id, force });
        expect.fail('expected WORKER_HELD');
      } catch (e) {
        const ext = (e as GraphQLError).extensions as Record<string, unknown>;
        expect(ext.code).toBe('WORKER_HELD');
        expect(ext.heldBy).toBe(contrib.id);
      }
    }
  });

  it('an ENDED session frees the worker for ITS HOLDER — but never for anyone else (#940, #1050)', async () => {
    // The #940 half stands: ending a session lifts WORKER_TAKEN. The #1050
    // half is what changed — it does NOT free the NAME, which is the entire
    // point: expiry, a reap, or a closed chat session used to make a held name
    // look available to a stranger.
    const first = await startSession(ctx(contrib.id), { workerRef: worker.id });
    await db.session.update({ where: { id: first.id }, data: { endedAt: new Date() } });
    const second = await startSession(ctx(contrib.id), { workerRef: worker.id });
    expect(second.workerId).toBe(worker.id);
  });

  it('lastDriver names the most recently ACTIVE session, not the newest-created (#983 review)', async () => {
    // force allows several active sessions to coexist; the takeover prompt
    // must name whoever actually drove the worker last.
    // #1050: several active sessions can still coexist via force, but only
    // for the HOLDER — a different driver is refused WORKER_HELD before the
    // liveness check runs. So the coexisting sessions are contrib's own.
    const first = await startSession(ctx(contrib.id), { workerRef: worker.id });
    // #1617 C: a forced rebind now ENDS the holder's own superseded session, so
    // coexisting open rows exist only from before that rule (or seeded data).
    // Seed the newer row directly; the ordering invariant still has to hold.
    await db.session.create({
      data: { id: generateId(), userId: contrib.id, appId: app.id, workerId: worker.id, type: 'DEVELOPER', startedAt: new Date() },
    });
    // The OLDER session heartbeats after the takeover — a usage event lands
    // on it, making contrib the most recent driver despite admin's newer row.
    await db.usageEvent.create({
      data: { countsAsActivity: true,
        id: generateId(),
        type: 'tool_call',
        sessionId: first.id,
        createdAt: new Date(Date.now() + 60_000),
      },
    });
    try {
      await startSession(ctx(contrib.id), { workerRef: worker.id });
      expect.fail('expected WORKER_TAKEN');
    } catch (e) {
      const ext = (e as GraphQLError).extensions as Record<string, unknown>;
      expect(ext.code).toBe('WORKER_TAKEN');
      expect(ext.sessionId).toBe(first.id);
      const contribUser = await db.user.findUniqueOrThrow({ where: { id: contrib.id } });
      expect(ext.lastDriver).toBe(contribUser.handle ?? contribUser.githubUsername);
    }
  });

  it('an unauthorized caller hits WORKER_NOT_FOUND, never WORKER_TAKEN (no driver-identity oracle)', async () => {
    // WORKER_TAKEN discloses who is driving; the App gates must run first.
    // #1937: and the first of them answers like an absent ref.
    await startSession(ctx(contrib.id), { workerRef: worker.id });
    await expectCode(startSession(ctx(outsider.id), { workerRef: worker.id }), 'WORKER_NOT_FOUND');
  });

  it('sessions(workerRef:) filters to that worker\'s sessions inside the ordinary scope', async () => {
    const s1 = await startSession(ctx(contrib.id), { workerRef: worker.id });
    // #940: the worker is taken by s1, so the second binding forces.
    const s2 = await startSession(ctx(contrib.id), { workerRef: worker.id, force: true });
    const unbound = await startSession(ctx(contrib.id), { appRef: app.id });
    const rows = await Q.sessions({}, { workerRef: worker.id }, ctx(contrib.id));
    const ids = rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(s1.id);
    expect(ids).toContain(s2.id);
    expect(ids).not.toContain(unbound.id);
  });

  it('declares workerRef and force on SessionInput in the SDL (#789 drift class)', () => {
    const input = buildSchema(typeDefs).getType('SessionInput') as GraphQLInputObjectType;
    expect(Object.keys(input.getFields())).toContain('workerRef');
    expect(String(input.getFields().workerRef.type)).toBe('String');
    expect(String(input.getFields().force.type)).toBe('Boolean');
  });
});
