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
let staleAdminJwt: string;

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

  // A token that CLAIMS admin for a user who is not one — the shape a demoted
  // admin's outstanding token has.
  staleAdminJwt = await signJwt({ sub: member.id, roles: ['ADMIN'] });

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
  startupMock.mockResolvedValue('ran');
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

describe('#556 — the claim in the token is not the authority', () => {
  it('refuses a token that claims ADMIN for a user who is not one', async () => {
    // @copilot on PR #1250. `resolveJwt` returns `payload.roles` — the roles
    // that were true when the token was SIGNED — and its liveness check
    // selects only `id`. So a user demoted out of ADMIN kept administering
    // until their token expired: JWT_EXPIRY, 7 days by default, of continued
    // access to a full graph sync.
    //
    // This is the case that discriminates. Every other refusal here passes
    // just as well against the cached claim, because the admin fixture is an
    // admin in BOTH the token and the row — so without this one, the fix is
    // unasserted.
    expect(await reload(staleAdminJwt)).toBe(403);
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

describe('#556 — reload is single-flight', () => {
  it('refuses a concurrent reload instead of starting a second sync', async () => {
    // @copilot on PR #1250. The rate limiter caps admission RATE, not
    // concurrency: ten requests sent AT ONCE all pass a 10/min budget and
    // start ten full syncs, each iterating every memory and awaiting GitHub.
    // Worse than load — concurrent startup() runs write the same local git
    // checkouts.
    // The route no longer holds the flag itself — the OPERATION does — so the
    // concurrency behaviour under test belongs to controller/startup.ts and is
    // asserted there, against both of its callers. What this case pins is that
    // the route TRANSLATES a skipped sync into 409 rather than a cheerful 200.
    let release!: (v: 'ran') => void;
    startupMock.mockImplementation(
      () => new Promise<'ran'>((resolve) => { release = resolve; }),
    );

    const ip = '203.0.113.150';
    const fire = () =>
      fetch(`${baseUrl}/reload`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': ip,
          Authorization: `Bearer ${adminJwt}`,
        },
        signal: AbortSignal.timeout(10_000),
      });

    // First one takes the flag and blocks inside startup().
    const first = fire();
    await new Promise((r) => setTimeout(r, 120));

    // Four more while it is still running. The mocked operation reports
    // 'skipped' for these, the way the real one does.
    startupMock.mockResolvedValue('skipped');
    const rest = await Promise.all([fire(), fire(), fire(), fire()]);
    expect(rest.map((r) => r.status), 'a skipped sync is a 409').toEqual([409, 409, 409, 409]);

    release('ran');
    expect((await first).status).toBe(200);
  });

  it('releases the flag after a sync FAILS, not just after it succeeds', async () => {
    // The `finally` half. Without it one failed sync wedges the endpoint until
    // the process restarts — a self-inflicted outage inside the code written
    // to prevent one, and invisible until the day a sync throws.
    startupMock.mockRejectedValueOnce(new Error('sync blew up'));
    expect(await reload(adminJwt)).toBe(500);

    startupMock.mockResolvedValue('ran');
    expect(await reload(adminJwt), 'the endpoint still works afterwards').toBe(200);
  });
});
