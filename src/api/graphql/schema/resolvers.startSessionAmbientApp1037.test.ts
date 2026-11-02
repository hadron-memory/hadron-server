/**
 * #1037 — an explicitly-qualified App reference beats connection state, asserted at the startSession resolver.
 * Moved from src/mcp/server.ambientAppPrecedence.test.ts when #3082 turned the MCP team tools off: these four cases
 * never went through MCP (hadron_start_session exposes no appRef), so they stay as resolver-level pins unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import type { GraphQLError } from 'graphql';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let user: { id: string };
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

const DARA_URN = () => `hrn:worker:${org.urn}:team-a:dara`;

describe('#1037 — startSession resolver, explicit App reference', () => {
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
