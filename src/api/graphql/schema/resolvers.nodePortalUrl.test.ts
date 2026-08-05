/**
 * #881 — `Node.portalUrl`, the GraphQL half of "node reads carry the node's
 * portal URL". It exists so a GraphQL client (the CLI's `node get`, the
 * portal, an extension) renders a link the server built instead of assembling
 * one from `Node.urn` — the same guessing game that produced broken `/app/u/…`
 * links in the first place.
 *
 * What this pins:
 *   - the value is exactly `<portal-origin>/app/u/<Node.urn>`, derived from the
 *     SAME composer as `Node.urn`, so the two fields can never disagree;
 *   - the field is NULL, not a localhost guess, when the deployment has no
 *     portal origin configured;
 *   - the SDL declares it nullable (a client must handle the null).
 *
 * No DB access: both resolvers read the preloaded `memory.urn` relation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { db } from '../../../integrations/db/client.js';

const PORTAL = 'https://hadronmemory.com';

const node = {
  loc: 'services:academy-active-courses',
  memoryId: 'mem-pk',
  memory: { urn: 'micromentor.org:mmdata' },
};

function ctx(): Context {
  return { db, userId: 'u1', roles: ['READER'] };
}

afterEach(() => {
  process.env.FRONTEND_URL = '';
});

describe('Node.portalUrl', () => {
  it('is <origin>/app/u/<the same urn Node.urn returns>', async () => {
    process.env.FRONTEND_URL = PORTAL;
    const urn = await resolvers.Node.urn(node as never, {}, ctx());
    expect(urn).toBe('hrn:node:micromentor.org:mmdata:services:academy-active-courses');
    expect(await resolvers.Node.portalUrl(node as never, {}, ctx())).toBe(
      `${PORTAL}/app/u/${urn}`,
    );
  });

  it('is null when no portal origin is configured', async () => {
    process.env.FRONTEND_URL = '';
    expect(await resolvers.Node.portalUrl(node as never, {}, ctx())).toBeNull();
  });

  it('is declared nullable in the SDL (clients must handle the null)', () => {
    expect(typeDefs).toMatch(/^\s*portalUrl: String$/m);
  });
});
