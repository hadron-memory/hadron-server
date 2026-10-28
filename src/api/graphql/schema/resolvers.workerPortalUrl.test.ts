import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #1026 — `Worker.portalUrl`, the GraphQL half of "worker reads carry the
 * worker's portal URL".
 *
 * The gap this closes: #1008 asks every worker to sign what it publishes with
 * a HYPERLINKED URN, while every role-agent prompt on the same team carries the
 * rule "never hand-build a portal link — copy the URL line a node read prints"
 * (#881). Node reads emitted one; worker reads emitted the URN and no link. So
 * the prompts had to carve out an explicit exception — "this identity link is
 * the ONE portal link you may construct yourself" — which teaches an exception
 * to a rule that exists for a good reason and puts the portal origin in the
 * model's hands rather than the server's. This field is what lets it come out.
 *
 * What this file pins:
 *   - the value is exactly `<portal-origin>/app/u/<Worker.urn>`, from the SAME
 *     composer as `Worker.urn`, so the two can never disagree;
 *   - it is NULL, not a localhost guess, when no portal origin is configured;
 *   - it is NULL when the URN itself is null (an App URN the fixed arity cannot
 *     take) — the two null arms are independent and neither is an error;
 *   - the SDL declares it nullable;
 *   - selecting BOTH url-shaped fields in one query costs ONE App lookup, and
 *     a MUTATION does not reuse a memo over a column `updateApp` can rewrite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const PORTAL = 'https://hadronmemory.com';

let org: { id: string; urn: string };
let app: { id: string; urn: string };
let agent: { id: string };
let worker: { id: string; appId: string; slug: string };

/** A query operation — the shape that enables the App-URN memo. */
const QUERY_INFO = { operation: { operation: 'query' } };
/** A mutation operation — memo deliberately off (updateApp can rewrite urn). */
const MUTATION_INFO = { operation: { operation: 'mutation' } };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'wpu-org', urn: `wpu-${suffix}.com` },
  });
  agent = await db.agent.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:server`,
      name: 'Server Engineer', visibility: 'ORGANIZATION',
    },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` },
  });
  worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Dara', slug: 'dara', role: 'server-engineer' },
  });
});

afterEach(() => {
  process.env.FRONTEND_URL = '';
  vi.restoreAllMocks();
});

function ctx(): Context {
  return { db, userId: 'u1', roles: ['READER'] };
}

describe('Worker.portalUrl (#1026)', () => {
  it('is <origin>/app/u/<the same urn Worker.urn returns>', async () => {
    process.env.FRONTEND_URL = PORTAL;
    const urn = await resolvers.Worker.urn(worker as never, {}, ctx());
    expect(urn).toBe(`hrn:worker:${org.urn}:team:dara`);
    expect(await resolvers.Worker.portalUrl(worker as never, {}, ctx())).toBe(
      `${PORTAL}/app/u/${urn}`,
    );
  });

  it('is null when no portal origin is configured — never a localhost guess', async () => {
    process.env.FRONTEND_URL = '';
    expect(await resolvers.Worker.portalUrl(worker as never, {}, ctx())).toBeNull();
    // The URN is still there: the two facts are independent, and losing the
    // link must not cost the caller the identifier.
    expect(await resolvers.Worker.urn(worker as never, {}, ctx())).toBe(
      `hrn:worker:${org.urn}:team:dara`,
    );
  });

  it('is null when the App URN cannot compose a worker URN, even with a portal configured', async () => {
    process.env.FRONTEND_URL = PORTAL;
    // A legacy App row with no `<root>:<slug>` pair — the #697 backfill's
    // leftover shape. `composeWorkerUrn` throws on it, so there is no URN to
    // build a link from. A gap, not a query failure.
    const legacyApp = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Legacy', urn: 'norootcolon' },
    });
    const legacyWorker = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: legacyApp.id, agentId: agent.id, name: 'Old', slug: 'old' },
    });
    expect(await resolvers.Worker.urn(legacyWorker as never, {}, ctx())).toBeNull();
    expect(await resolvers.Worker.portalUrl(legacyWorker as never, {}, ctx())).toBeNull();
  });

  it('is null when the worker\'s App row is gone', async () => {
    process.env.FRONTEND_URL = PORTAL;
    const orphan = { appId: 'no-such-app', slug: 'ghost' };
    expect(await resolvers.Worker.urn(orphan as never, {}, ctx())).toBeNull();
    expect(await resolvers.Worker.portalUrl(orphan as never, {}, ctx())).toBeNull();
  });

  it('is declared nullable in the SDL (clients must handle the null)', () => {
    expect(typeDefs).toMatch(/^\s*portalUrl: String$/m);
  });

  it('does not emit a link from a malformed FRONTEND_URL', async () => {
    process.env.FRONTEND_URL = 'not a url';
    expect(await resolvers.Worker.portalUrl(worker as never, {}, ctx())).toBeNull();
  });
});

describe('Worker.portalUrl — the App lookup it shares with Worker.urn (#1026)', () => {
  it('costs ONE App read when a QUERY selects both url-shaped fields', async () => {
    process.env.FRONTEND_URL = PORTAL;
    const c = ctx();
    const spy = vi.spyOn(db.app, 'findUnique');
    // Concurrent, as a GraphQL executor resolves sibling fields — the memo has
    // to be the in-flight PROMISE, not a settled value, or both callers miss.
    const [urn, url] = await Promise.all([
      resolvers.Worker.urn(worker as never, {}, c, QUERY_INFO as never),
      resolvers.Worker.portalUrl(worker as never, {}, c, QUERY_INFO as never),
    ]);
    expect(urn).toBe(`hrn:worker:${org.urn}:team:dara`);
    expect(url).toBe(`${PORTAL}/app/u/${urn}`);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('memoizes across WORKERS of one App, not just across fields of one worker', async () => {
    process.env.FRONTEND_URL = PORTAL;
    const second = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Gil', slug: 'gil' },
    });
    const c = ctx();
    const spy = vi.spyOn(db.app, 'findUnique');
    const urns = await Promise.all([
      resolvers.Worker.urn(worker as never, {}, c, QUERY_INFO as never),
      resolvers.Worker.urn(second as never, {}, c, QUERY_INFO as never),
    ]);
    expect(urns).toEqual([
      `hrn:worker:${org.urn}:team:dara`,
      `hrn:worker:${org.urn}:team:gil`,
    ]);
    // The roster case PR #1000's review caught on this exact lookup: one App
    // read for the page, not one per item up to the 200-item cap.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT memoize in a mutation — updateApp can rewrite App.urn mid-request', async () => {
    process.env.FRONTEND_URL = PORTAL;
    const c = ctx();
    const spy = vi.spyOn(db.app, 'findUnique');
    await resolvers.Worker.urn(worker as never, {}, c, MUTATION_INFO as never);
    await resolvers.Worker.portalUrl(worker as never, {}, c, MUTATION_INFO as never);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a mutation that rewrites App.urn sees the NEW urn on a later read in the same request', async () => {
    process.env.FRONTEND_URL = PORTAL;
    const c = ctx();
    expect(await resolvers.Worker.urn(worker as never, {}, c, MUTATION_INFO as never)).toBe(
      `hrn:worker:${org.urn}:team:dara`,
    );
    await db.app.update({ where: { id: app.id }, data: { urn: `${org.urn}:renamed` } });
    // This is the whole reason the memo is query-scoped: a request-scoped cache
    // over writable data is stale by construction.
    expect(await resolvers.Worker.portalUrl(worker as never, {}, c, MUTATION_INFO as never)).toBe(
      `${PORTAL}/app/u/hrn:worker:${org.urn}:renamed:dara`,
    );
  });

  it('an absent info (the MCP direct-call path) takes the un-memoized branch', async () => {
    process.env.FRONTEND_URL = PORTAL;
    const c = ctx();
    const spy = vi.spyOn(db.app, 'findUnique');
    await resolvers.Worker.urn(worker as never, {}, c);
    await resolvers.Worker.portalUrl(worker as never, {}, c);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
