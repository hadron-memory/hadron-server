/**
 * #556 — `POST /sessions/:id/outcome` requires a credential.
 *
 * It was reachable with none, so possession of a session id was enough to
 * overwrite `outcome`, `outcomeRef` and arbitrary `outcomeMeta`. Session ids
 * travel in the `x-hadron-session` header, in logs and in client state, which
 * makes "knows the id" a weak boundary.
 *
 * ## This restores the design; it does not reverse it
 *
 * The 2026-02-21 usage-data design is usually quoted as "Hadron doesn't care
 * who sends it", which reads as deliberately open. That is a lossy summary of
 * a document which specifies `Authorization: Bearer <api-key>` and says the
 * key "is still required (it's the access control layer)". "Doesn't care who"
 * meant WHICH authenticated client. The credential half was never
 * implemented — the route has had no auth since its first commit.
 *
 * ## What is deliberately absent
 *
 * No per-session ownership check. The design rejects one explicitly, because
 * the reporter is typically a THIRD system — a CRM, a feedback-form store —
 * with no relationship to the session beyond holding its id. The last case
 * below PINS that, so a later "tighten this" change has to be a decision
 * rather than an accident.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';
import { hashUserApiKey, USER_API_KEY_PREFIX } from '../../middleware/auth.js';

let server: Server;
let baseUrl: string;
let contributorJwt: string;
let readerJwt: string;
let staleContributorJwt: string;
let mcpContributorKey: string;
let accountContributorKey: string;
let sessionId: string;
let strangersSessionId: string;

async function report(
  id: string,
  token?: string,
  body: Record<string, unknown> = { outcome: 0.8 },
): Promise<number> {
  const res = await fetch(`${baseUrl}/sessions/${id}/outcome`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return res.status;
}

beforeAll(async () => {
  await cleanDb(db);

  const contributor = await db.user.create({
    data: {
      id: generateId(), handle: 'oc-contrib', githubUsername: 'oc-contrib',
      roles: ['CONTRIBUTOR'],
    },
  });
  contributorJwt = await signJwt({ sub: contributor.id, roles: ['CONTRIBUTOR'] });
  const issueKey = async (scope: 'mcp' | 'account', fill: string): Promise<string> => {
    const rawKey = `${USER_API_KEY_PREFIX}${fill.repeat(64)}`;
    await db.userApiKey.create({
      data: {
        userId: contributor.id,
        keyHash: hashUserApiKey(rawKey),
        keyPreview: rawKey.slice(-4),
        label: `${scope} outcome test`,
        createdBy: contributor.id,
        issuedVia: 'oauth:outcome-test',
        oauthScopes: [scope],
      },
    });
    return rawKey;
  };
  mcpContributorKey = await issueKey('mcp', 'a');
  accountContributorKey = await issueKey('account', 'b');

  // READER is below the documented bar of "contributor or higher".
  const reader = await db.user.create({
    data: { id: generateId(), handle: 'oc-reader', githubUsername: 'oc-reader', roles: ['READER'] },
  });
  readerJwt = await signJwt({ sub: reader.id, roles: ['READER'] });

  // A token claiming CONTRIBUTOR for a user who no longer is one (#1251).
  staleContributorJwt = await signJwt({ sub: reader.id, roles: ['CONTRIBUTOR'] });

  // #1647: the outcome is a session WRITE, so the reporting contributor's own session is the control.
  const session = await db.session.create({
    data: { id: generateId(), type: 'CHATBOT', userId: contributor.id },
  });
  sessionId = session.id;

  // Someone else's session. `Session` has no organizationId — it is scoped by
  // appId / userId — so "not the caller's" is expressed by belonging to a
  // different user.
  const stranger = await db.user.create({
    data: { id: generateId(), handle: 'oc-other', githubUsername: 'oc-other', roles: [] },
  });
  const otherSession = await db.session.create({
    data: { id: generateId(), type: 'CHATBOT', userId: stranger.id },
  });
  strangersSessionId = otherSession.id;

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('#556 — a credential is required', () => {
  it('refuses an anonymous report', async () => {
    expect(await report(sessionId)).toBe(401);
  });

  it('refuses a garbage bearer token', async () => {
    expect(await report(sessionId, 'not-a-real-token')).toBe(401);
  });

  it('refuses a READER who is not behind the session (#1647: the shared write gate, not a role bar)', async () => {
    // Authentication is not authorization. Without this, a gate requiring
    // merely *a* credential would satisfy both cases above.
    expect(await report(sessionId, readerJwt)).toBe(403);
  });

  it('refuses a token that CLAIMS contributor for a user who is not one', async () => {
    // #1251 — the token carries the roles that were true when it was signed,
    // so auth resolution and this gate read the current user row instead.
    // Without this case the choice of source is unasserted, since the
    // contributor fixture matches in both token and row.
    expect(await report(sessionId, staleContributorJwt)).toBe(403);
  });

  it('leaves the session untouched after a refusal', async () => {
    // A refusal that still wrote would be worse than no gate, because the
    // error says it did not.
    await report(sessionId, readerJwt, { outcome: 0.99, outcomeRef: 'should-not-land' });
    const row = await db.session.findUnique({ where: { id: sessionId } });
    expect(row?.outcome).toBeNull();
    expect(row?.outcomeRef).toBeNull();
  });

  it('refuses an mcp-only OAuth user key before it can stamp the session', async () => {
    expect(await report(sessionId, mcpContributorKey, { outcome: 0.77 })).toBe(403);
    expect((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).outcome).toBeNull();
  });
});

describe('#556 — a credentialed reporter still works', () => {
  it('accepts a CONTRIBUTOR and stamps the session', async () => {
    // The control, and the reason every refusal above is a measurement: a
    // route answering 401 unconditionally would satisfy the whole file.
    expect(
      await report(sessionId, contributorJwt, {
        outcome: 0.8,
        outcomeRef: 'f3a9c1d2-feedback-form',
        outcomeMeta: { rating: 4 },
      }),
    ).toBe(200);

    const row = await db.session.findUnique({ where: { id: sessionId } });
    expect(row?.outcome).toBe(0.8);
    expect(row?.outcomeRef).toBe('f3a9c1d2-feedback-form');
  });

  it('#1543 — an outcome report on a lapsed session does not revive it', async () => {
    const longAgo = new Date('2026-01-01T00:00:00.000Z');
    await db.$executeRaw`UPDATE sessions SET started_at = ${longAgo}, updated_at = ${longAgo} WHERE id = ${sessionId}`;
    const before = (await db.session.findUniqueOrThrow({ where: { id: sessionId } })).updatedAt;
    expect(await report(sessionId, contributorJwt, { outcome: 0.5 })).toBe(200);
    const row = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.outcome).toBe(0.5); // the report still lands
    expect(row.updatedAt!.getTime()).toBe(before!.getTime());
  });

  it('accepts an account-scoped OAuth user key', async () => {
    expect(await report(sessionId, accountContributorKey, { outcome: 0.6 })).toBe(200);
    expect((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).outcome).toBe(0.6);
  });

  it('still validates the outcome range', async () => {
    // The pre-existing contract must survive the new gate.
    expect(await report(sessionId, contributorJwt, { outcome: 1.5 })).toBe(400);
    expect(await report(sessionId, contributorJwt, { outcome: 'high' })).toBe(400);
  });

  it('answers 404 for a session that does not exist', async () => {
    // And specifically 404, not the 500 the narrowed catch now returns for
    // everything else — the two used to be indistinguishable.
    expect(await report(generateId(), contributorJwt)).toBe(404);
  });
});

describe('#1647 — cross-session reporting is CLOSED', () => {
  it("refuses a contributor stamping another user's session, and leaves it untouched", async () => {
    // #556 pinned this open (a third system holding only the id). #1647 reversed it on Holger's rulings: the outcome
    // is a session write and goes through the shared write gate (cor:dmo:070:05). The attributed user, or a pure App
    // key for its own App's user-less session, still reports.
    expect(await report(strangersSessionId, contributorJwt, { outcome: 0.5 })).toBe(403);
    expect((await db.session.findUniqueOrThrow({ where: { id: strangersSessionId } })).outcome).toBeNull();
  });
});
