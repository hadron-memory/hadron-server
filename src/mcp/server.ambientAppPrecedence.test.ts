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
