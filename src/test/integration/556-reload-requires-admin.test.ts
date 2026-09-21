/**
 * #556 — `POST /reload` requires a platform admin.
 *
 * It re-runs `controller.startup()`: a full graph sync of every memory with a
 * source, against the DB and against GitHub. It was reachable with NO
 * credential, so anyone who could reach the server could hold it in a startup
 * loop — DB churn, connection and CPU exhaustion, and outbound git traffic,
 * unauthenticated and free.
 *
 * Authenticated rather than deleted, which is the opposite call to #825's
 * `POST /usage`, and the difference is evidence rather than taste: `/usage`
 * had no callers AND no documented purpose, while `/reload` is described in
 * the README and in hadronmem-core as a CI trigger ("called by CI after a
 * push"). Documented surface with no current caller is surface to gate, not to
 * remove. A CI job can carry a token; an anonymous internet cannot.
 *
 * `controller.startup()` is mocked. These cases are about WHO may reach it,
 * and letting the real one run would sync every seeded memory against GitHub
 * — slow, networked, and nothing to do with the gate.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';

const startupMock = vi.hoisted(() => vi.fn());
vi.mock('../../controller/controller.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../controller/controller.js')>();
  return { ...mod, controller: { ...mod.controller, startup: startupMock } };
});

let server: Server;
let baseUrl: string;
let adminJwt: string;
let memberJwt: string;

beforeAll(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'rl-org', urn: `rl-org-${generateId()}` },
  });

  const admin = await db.user.create({
    data: { id: generateId(), handle: 'rl-admin', githubUsername: 'rl-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  adminJwt = await signJwt({ sub: admin.id, roles: ['ADMIN'] });

  // An ordinary signed-in user (READER — the Role enum has no MEMBER). The
  // interesting negative case: authentication alone must not be enough, or
  // "requires a platform admin" is really "requires an account", which anyone
  // can make.
  const member = await db.user.create({
    data: { id: generateId(), handle: 'rl-member', githubUsername: 'rl-member', roles: [] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: member.id, role: 'READER' },
  });
  memberJwt = await signJwt({ sub: member.id, roles: [] });

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  startupMock.mockReset();
  startupMock.mockResolvedValue(undefined);
});

/** Each call gets its own source address: the route's limiter is 10/min. */
let ipN = 0;
async function reload(token?: string): Promise<number> {
  const res = await fetch(`${baseUrl}/reload`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${(ipN++ % 200) + 1}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  return res.status;
}

describe('#556 — POST /reload is not anonymous', () => {
  it('refuses with no credential at all', async () => {
    expect(await reload()).toBe(403);
    // The assertion that makes this about the SYNC rather than about a status
    // code: a 403 that still ran startup() would have done the damage anyway.
    expect(startupMock, 'the sync must not have run').not.toHaveBeenCalled();
  });

  it('refuses a garbage bearer token', async () => {
    expect(await reload('not-a-real-token')).toBe(403);
    expect(startupMock).not.toHaveBeenCalled();
  });

  it('refuses an ordinary authenticated user', async () => {
    // Authentication is not authorization. Without this case, a gate that
    // merely required *a* token would satisfy the two above — and anyone can
    // get a token.
    expect(await reload(memberJwt)).toBe(403);
    expect(startupMock).not.toHaveBeenCalled();
  });
});

describe('#556 — a platform admin can still use it', () => {
  it('accepts a platform ADMIN and runs the sync', async () => {
    // The control. Every refusal above is only a measurement because this
    // passes: a route that answered 403 unconditionally would satisfy the
    // whole file otherwise, and would also have silently broken the CI
    // trigger the README documents.
    expect(await reload(adminJwt)).toBe(200);
    expect(startupMock, 'the admin path really reaches startup()').toHaveBeenCalledOnce();
  });
});

describe('#556 — the route is rate limited', () => {
  it('cuts off a flood from one source', async () => {
    // Even gated, a stuck script or a leaked admin token should not be able to
    // hold the server in a startup loop.
    const ip = '203.0.113.99';
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) {
      const res = await fetch(`${baseUrl}/reload`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': ip,
          Authorization: `Bearer ${adminJwt}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 200), 'ten get through').toHaveLength(10);
    expect(statuses.slice(10), 'the rest are refused').toEqual([429, 429, 429]);
    expect(startupMock).toHaveBeenCalledTimes(10);
  });
});
