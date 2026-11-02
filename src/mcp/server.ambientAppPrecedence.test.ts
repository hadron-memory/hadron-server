import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1037 — an explicitly-qualified reference beats connection state.
 *
 * `auth.appId` carries two different trust levels behind one field name
 * (findings:auth-appid-credential-vs-selection): for a pure App-key principal
 * it is a CREDENTIAL, and for a user it is the active-App SELECTION — which any
 * later bind in another App silently re-points. Every case below is a caller
 * who named an App unambiguously (a worker URN, a session) and was answered
 * from that stale pin instead.
 *
 * Two workers hit the `record_work` half within 16 minutes on 2026-08-17, and
 * the bind half was hit on 2026-08-19 by the next worker to pick the issue up —
 * on the first call of the documented procedure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { serveEveryAgent } from '../test/servedBootPrompt.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import type { GraphQLError } from 'graphql';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let user: { id: string };
let outsider: { id: string };
let appA: { id: string; urn: string };
let appB: { id: string; urn: string };
let agent: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const s = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'ap-org', urn: `ap-${s}.com` } });
  user = await db.user.create({
    data: { id: generateId(), githubId: 77101, githubUsername: `ap-${s}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 77102, githubUsername: `ap-out-${s}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' },
  });
  agent = await db.agent.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:be`, name: 'BE',
      visibility: 'ORGANIZATION', personaRole: 'backend-engineer',
    },
  });
  appA = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team A', urn: `${org.urn}:team-a` } });
  appB = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team B', urn: `${org.urn}:team-b` } });
  for (const a of [appA, appB]) await db.appAgent.create({ data: { appId: a.id, agentId: agent.id } });
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: appA.id, agentId: agent.id, name: 'Dara', slug: 'dara' } });
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});

/** A user whose connection is pinned to App B — a later bind in another App. */
const pinnedToB = (userId = user.id): AuthContext =>
  ({ userId, appId: appB.id, roles: ['READER'], clientId: `user:${userId}` });
/** The same user with no selection at all. */
const unpinned = (userId = user.id): AuthContext =>
  ({ userId, roles: ['READER'], clientId: `user:${userId}` });

const DARA_URN = () => `hrn:worker:${org.urn}:team-a:dara`;

async function boundSession(): Promise<string> {
  const out = await createTestableMcpServer(unpinned()).callToolText('hadron_start_session', {
    workerRef: DARA_URN(), description: 'stint',
  });
  const id = out.match(/Session started: (\S+)/)?.[1];
  if (!id) throw new Error(`bind failed: ${out}`);
  return id;
}

describe('#1037 — the bind', () => {
  it('a fully-qualified worker URN binds even when the pin names another App', async () => {
    // The sharpest instance: this is the FIRST call of the documented
    // procedure, and both the tool description and
    // tasks:start-worker-session-desktop promise the URN needs no
    // hadron_set_active_app first. Before the fix this refused, blaming the URN
    // — the one unambiguous thing in the call.
    const out = await createTestableMcpServer(pinnedToB()).callToolText('hadron_start_session', {
      workerRef: DARA_URN(), description: 'stint',
    });
    expect(out).toContain('Session started');
    const id = out.match(/Session started: (\S+)/)![1];
    const session = await db.session.findUniqueOrThrow({ where: { id } });
    // Attributed to the WORKER's App, not the pinned one.
    expect(session.appId).toBe(appA.id);
  });

  it('a bare worker id does too — the other self-describing form', async () => {
    const worker = await db.worker.findFirstOrThrow({ where: { appId: appA.id } });
    const out = await createTestableMcpServer(pinnedToB()).callToolText('hadron_start_session', {
      workerRef: worker.id, description: 'stint',
    });
    expect(out).toContain('Session started');
  });

  it('but it still re-gates: a non-participant cannot bind by URN', async () => {
    // Yielding to the ref must not widen who may attribute a session to an App.
    const out = await createTestableMcpServer(pinnedToB(outsider.id)).callToolText('hadron_start_session', {
      workerRef: DARA_URN(), description: 'stint',
    });
    expect(out).not.toContain('Session started');
    expect(out).toMatch(/not a member|Forbidden|not found/i);
  });

  it('an explicit appRef that disagrees with the worker is still refused, and names both', async () => {
    // Two deliberate statements disagreeing is a client bug, not ambient drift.
    // Asserted against the RESOLVER, because hadron_start_session exposes no
    // appRef argument — the URN and the name cover that surface — so this path
    // is reachable only through GraphQL and the CLI.
    const ctx = {
      db, userId: user.id, roles: ['READER'], clientId: `user:${user.id}`,
    } as unknown as Context;
    await expect(
      resolvers.Mutation.startSession(
        {}, { input: { id: generateId(), workerRef: DARA_URN(), appRef: appB.id } }, ctx,
      ),
    ).rejects.toThrow(/different App/);

    // And the refusal says which App it held, and where that came from — the
    // half the original message omitted entirely.
    try {
      await resolvers.Mutation.startSession(
        {}, { input: { id: generateId(), workerRef: DARA_URN(), appRef: appB.id } }, ctx,
      );
    } catch (e) {
      const err = e as GraphQLError;
      expect(err.message).toContain(appB.urn);
      expect(err.message).toContain('the appRef argument');
      expect(err.extensions?.appSource).toBe('argument');
      expect(err.extensions?.code).toBe('SESSION_WORKER_NOT_IN_APP');
    }
  });

  it('an explicit appRef beats a user SELECTION too (Codex P1)', async () => {
    // The precedence this PR promises was contradicted one level above where it
    // is granted: the #943 SESSION_APP_MISMATCH check keyed on ctx.appId alone,
    // so a user pinned to B could not deliberately open a session in A — even
    // though its own comment said the rule was about an App-key CREDENTIAL.
    const ctx = {
      db, userId: user.id, appId: appB.id, roles: ['READER'], clientId: `user:${user.id}`,
    } as unknown as Context;
    const session = await resolvers.Mutation.startSession(
      {}, { input: { id: generateId(), appRef: appA.id } }, ctx,
    );
    expect(session.appId).toBe(appA.id);
  });

  it('but an App KEY still refuses a disagreeing appRef', async () => {
    // The same check, for the principal shape it was actually written for.
    const keyCtx = { db, appId: appB.id, roles: [] } as unknown as Context;
    await expect(
      resolvers.Mutation.startSession(
        {}, { input: { id: generateId(), appRef: appA.id } }, keyCtx,
      ),
    ).rejects.toThrow(/does not name the App this request is authenticated for/);
  });

  it('a pure App-KEY principal is never re-pointed by a ref — a credential is not a selection', async () => {
    // The principal shape most likely to be skipped, and the one where getting
    // it wrong widens access: for an App key, auth.appId IS the App
    // (findings:auth-appid-credential-vs-selection), so a workerRef naming
    // another App is a client bug, not stale connection state. Asserted at the
    // resolver, where a Context with appId and no userId is exactly that shape.
    //
    // #1937: and since a key reads only its own App's staff, the refusal is the absent ref's envelope. It used to
    // be SESSION_WORKER_NOT_IN_APP with the worker's and its App's ids, which told the key's holder the worker exists.
    const keyCtx = { db, appId: appB.id, roles: [] } as unknown as Context;
    try {
      await resolvers.Mutation.startSession(
        {}, { input: { id: generateId(), workerRef: DARA_URN() } }, keyCtx,
      );
      expect.fail('expected a refusal');
    } catch (e) {
      const err = e as GraphQLError;
      expect(err.message).toBe(`Worker not found: ${DARA_URN()}`);
      expect(err.extensions).toEqual({ code: 'WORKER_NOT_FOUND' });
    }

    // Nothing was created — the refusal is not a partial bind.
    expect(await db.session.count({ where: { appId: appA.id } })).toBe(0);
  });
});

describe('#1037 — the team tools', () => {
  it('record_work attributes through the session, not the stale pin', async () => {
    const sid = await boundSession();
    const out = await createTestableMcpServer(pinnedToB()).callToolText('hadron_record_work', {
      session: sid, tool: 'github', kind: 'pr', ref: 'acme/repo#7', action: 'opened',
    });
    expect(out).toContain('Recorded');
    expect(out).toContain('Dara');
  });

  it('team_chat_post lands in the SESSION\'s team, and says which team that was', async () => {
    const sid = await boundSession();
    const out = await createTestableMcpServer(pinnedToB()).callToolText('hadron_team_chat_post', {
      session: sid, body: 'which team heard this?',
    });
    expect(out).toContain('Posted team-chat message');
    // The receipt names the team — the signal that was missing when posting as
    // yourself, where the pin alone decides and nothing warns.
    expect(out).toContain(appA.urn);

    const inA = await db.node.count({
      // loc-scope-ok: scoped to one App via the memory relation.
      where: { memory: { appId: appA.id }, loc: { startsWith: 'chats:team:messages:' } },
    });
    const inB = await db.node.count({
      // loc-scope-ok: scoped to one App via the memory relation.
      where: { memory: { appId: appB.id }, loc: { startsWith: 'chats:team:messages:' } },
    });
    expect([inA, inB]).toEqual([1, 0]);
  });

  it('the receipt names the team even when app is passed as a full hrn:app URN (Copilot)', async () => {
    // App.urn stores the BARE <root>:<slug>, so a hand-rolled column match
    // dropped the team name in exactly the case where the caller named an App
    // explicitly. Routed through the shared ref resolver instead.
    const out = await createTestableMcpServer(unpinned()).callToolText('hadron_team_chat_post', {
      asMe: true,
      app: `hrn:app:${appA.urn}`, body: 'posted by full URN',
    });
    expect(out).toContain('Posted team-chat message');
    expect(out).toContain(appA.urn);
  });

  it('team_chat_read follows the session too', async () => {
    const sid = await boundSession();
    await createTestableMcpServer(unpinned()).callToolText('hadron_team_chat_post', {
      session: sid, body: 'posted from team A',
    });
    const out = await createTestableMcpServer(pinnedToB()).callToolText('hadron_team_chat_read', {
      session: sid, sinceSeq: 0,
    });
    expect(out).toContain('posted from team A');
  });

  it('team_work_items derives App scope from a self-describing worker ref (Codex P2)', async () => {
    // The #1037 convention reappearing in a tool that grew a worker argument
    // afterwards — which is how a convention decays one tool at a time. An
    // id/URN names its own App, so advertising id/URN support while resolving
    // scope from the pin returns "No App context" unpinned, or the WRONG App's
    // empty page when pinned elsewhere.
    const sid = await boundSession();
    await createTestableMcpServer(unpinned()).callToolText('hadron_record_work', {
      session: sid, tool: 'github', kind: 'pr', ref: 'acme/repo#9', action: 'opened',
    });
    const dara = await db.worker.findFirstOrThrow({ where: { appId: appA.id } });

    // Unpinned: no ambient scope at all, and no session argument to lean on.
    const unscoped = await createTestableMcpServer(unpinned()).callToolText(
      'hadron_team_work_items', { worker: DARA_URN() },
    );
    expect(unscoped).not.toContain('No App context');
    expect(unscoped).toContain('acme/repo#9');

    // Pinned to the WRONG App: the ref outranks the pin, as it does at bind.
    const misPinned = await createTestableMcpServer(pinnedToB()).callToolText(
      'hadron_team_work_items', { worker: dara.id },
    );
    expect(misPinned).toContain('acme/repo#9');
  });

  it("a teammate's session does not suppress the worker fallback (Codex P2)", async () => {
    // adoptAppFromSession deliberately does nothing for a session that is not
    // the caller's — but the mere PRESENCE of the argument used to suppress the
    // worker fallback, leaving a caller who may read this worklog with "no
    // active App" while holding a ref that names it unambiguously.
    const sid = await boundSession();
    await createTestableMcpServer(unpinned()).callToolText('hadron_record_work', {
      session: sid, tool: 'github', kind: 'pr', ref: 'acme/repo#11', action: 'opened',
    });
    // A session belonging to somebody else entirely.
    const theirs = await db.session.create({
      data: { id: generateId(), userId: outsider.id, appId: appA.id },
    });

    const out = await createTestableMcpServer(unpinned()).callToolText(
      'hadron_team_work_items', { worker: DARA_URN(), session: theirs.id },
    );
    expect(out).not.toContain('No App context');
  });

  it('a STALE pin matching the session does not count as established scope (Codex P2)', async () => {
    // Codex's primary scenario: a long-lived connection pinned to App B whose
    // caller has since LOST membership. The pin still MATCHES the session's App
    // — and matching is not evidence. Reporting success on that basis skipped
    // the participation check and suppressed the worker fallback, so the query
    // ran against an App the caller may no longer read.
    //
    // The caller here is an AppMember ONLY — not an org member — so revoking
    // the membership genuinely removes participation. (The org-member fixture
    // user keeps access through their org role, which is why this needs its
    // own principal.)
    const memberOnly = await db.user.create({
      data: { id: generateId(), githubId: 77199, githubUsername: `ap-mo-${Date.now()}`, roles: ['READER'] },
    });
    await db.appMember.create({ data: { appId: appA.id, userId: memberOnly.id, role: 'member' } });
    const inB = await db.appMember.create({
      data: { appId: appB.id, userId: memberOnly.id, role: 'member' },
    });
    const sessionInB = await db.session.create({
      data: { id: generateId(), userId: memberOnly.id, appId: appB.id },
    });

    // Membership in B is revoked; the connection stays pinned there.
    await db.appMember.delete({
      where: { appId_userId: { appId: inB.appId, userId: inB.userId } },
    });

    const out = await createTestableMcpServer(pinnedToB(memberOnly.id)).callToolText(
      'hadron_team_work_items', { session: sessionInB.id, worker: DARA_URN() },
    );
    // Falls through to the worker's App, which this caller CAN read — rather
    // than refusing under an App whose membership is gone.
    expect(out).not.toMatch(/not authorized|Forbidden/i);
  });

  it('a DATABASE failure while deriving scope from a worker ref propagates', async () => {
    // The third instance of the blanket-catch class in this PR, and the second
    // I wrote while fixing the first. An outage must not be reported as "no
    // active App", which sends the caller to fix their selection while the
    // server is down. Spied on the real client, which is the same instance the
    // MCP closure holds.
    const boom = new Error('connection terminated unexpectedly');
    // findFirst, not findUnique: the URN path inside `resolveWorkerRef` uses
    // findFirst, and that is the call INSIDE the try/catch under test. Spying
    // on findUnique instead made this pass for the wrong reason — the helper's
    // own later findUnique throws outside the catch, so the mutation stayed
    // green. Targeting the wrong call is how a test asserts the right outcome
    // via the wrong mechanism.
    const spy = vi.spyOn(db.worker, 'findFirst').mockRejectedValue(boom as never);
    try {
      // Propagates rather than resolving to text: the scope derivation runs
      // before the tool's own try/catch, so the failure surfaces as a failure.
      // What matters is that it is NOT reported as "no active App", which would
      // send the caller to fix their selection while the server is down.
      // #1789: the fault is the generic envelope (detail to the log), still not "no active App".
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const text = await createTestableMcpServer(unpinned()).callToolText(
        'hadron_team_work_items', { worker: DARA_URN() },
      );
      expect(text).toMatch(/^\[INTERNAL_SERVER_ERROR\] Internal server error\. Request id: /);
      expect(text).not.toMatch(/connection terminated|no active App/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('a bare worker NAME still yields no scope — it needs one rather than providing it', async () => {
    // A name is unique only within an App, so there is nothing to derive scope
    // FROM. Documents the CONTRACT rather than proving the shape check: the ref
    // resolver rejects a name regardless, so this stays green with that check
    // removed. Kept because the contract is what a caller relies on, and worth
    // saying plainly rather than implying a proof it does not carry.
    const out = await createTestableMcpServer(unpinned()).callToolText(
      'hadron_team_work_items', { worker: 'Dara' },
    );
    expect(out).toContain('No App context');
  });

  it('an explicit app argument still wins over the session', async () => {
    // The caller who names an App outranks the one who names a session: both
    // are deliberate, and the more specific statement is the one just made.
    const sid = await boundSession();
    const out = await createTestableMcpServer(unpinned()).callToolText('hadron_team_chat_post', {
      session: sid, app: appB.id, body: 'deliberately elsewhere',
    });
    // The post lands in App B — the explicit argument won. Before spec 049
    // Phase 8 the authorship gate then refused it as "not a session of this
    // App"; item J replaced that pin with the host-memory write check, and
    // this driver may write B's team memory, so the post is ADMITTED and
    // marked as a cross-App post. The precedence rule is what this pins.
    expect(out).toMatch(/^Posted team-chat message #1 in /);
    expect(out).toContain(appB.urn);
    expect(out).toContain('cross-App post');
  });
});
