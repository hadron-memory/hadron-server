/**
 * #2309 — `Memory.portalUrl`, `Agent.portalUrl` and `App.portalUrl`: the canonical portal link of each kind, built from the SAME rendered
 * urn the `urn` field returns (never the stored column), nullable like `Node.portalUrl` (#881). Pins:
 *   1  the SDL declares the nullable field on the three types and not on others it was not asked for;
 *   2  with a portal origin, the value is exactly `<origin>/app/u/<urn field>` for a bare stored row, a legacy single-colon row and a
 *      v1 double-colon row (never the stored spelling);
 *   3  an unset or malformed origin is null; no localhost guess;
 *   4  a stored value whose emission throws (the raw bare value is served as `urn`) is null, not a link;
 *   5  a urn holding a character a link cannot carry is null; an empty or missing urn is null, never an empty string;
 *   6  a viewer who cannot read the object never reaches the field (the existing read gate answers first; the field reads nothing itself).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const ORIGIN = 'https://portal.example.test';
type Kind = 'Memory' | 'Agent' | 'App';
const KINDS: Array<[Kind, string]> = [['Memory', 'mem'], ['Agent', 'agent'], ['App', 'app']];
const field = (kind: Kind, name: 'urn' | 'portalUrl') => (resolvers[kind] as unknown as Record<string, (p: { urn?: string | null }) => string | null>)[name];

let saved: string | undefined;
beforeEach(() => { saved = process.env.FRONTEND_URL; process.env.FRONTEND_URL = ORIGIN; });
afterEach(() => { if (saved === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = saved; });

describe('#2309 SDL', () => {
  it('declares a nullable portalUrl on Memory, Agent and App', () => {
    const schema = buildSchema(typeDefs as unknown as string);
    for (const [kind] of KINDS) {
      const f = (schema.getType(kind) as unknown as { getFields: () => Record<string, { type: { toString: () => string } }> }).getFields().portalUrl;
      expect(f, kind).toBeDefined();
      expect(f.type.toString()).toBe('String');
    }
  });
});

describe.each(KINDS)('#2309 %s.portalUrl', (kind) => {
  it.each([
    ['a flat stored row', 'acme.com:dev'],
    ['a legacy single-colon hierarchy', 'acme.com:team:dev'],
    ['a v1 double-colon row', 'acme.com::dev'],
  ])('is <origin>/app/u/<the urn field> for %s, never the stored spelling', (_label, stored) => {
    const urn = field(kind, 'urn')({ urn: stored }) as string;
    expect(urn.startsWith('hrn:')).toBe(true);
    expect(field(kind, 'portalUrl')({ urn: stored })).toBe(`${ORIGIN}/app/u/${urn}`);
    expect(field(kind, 'portalUrl')({ urn: stored })).not.toContain(`/app/u/${stored}`);
  });

  it('is null with no portal origin, and with a malformed one (no localhost guess)', () => {
    delete process.env.FRONTEND_URL;
    expect(field(kind, 'portalUrl')({ urn: 'acme.com:dev' })).toBeNull();
    process.env.FRONTEND_URL = 'not a url';
    expect(field(kind, 'portalUrl')({ urn: 'acme.com:dev' })).toBeNull();
  });

  it('is null, not a link, when emission throws and the raw bare value is served as the urn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const stored = 'acme.com:::';
      expect((field(kind, 'urn')({ urn: stored }) as string).startsWith('hrn:')).toBe(false); // the fixture is the distinct condition
      expect(field(kind, 'portalUrl')({ urn: stored })).toBeNull();
    } finally { warn.mockRestore(); }
  });

  it('is null for a missing or empty urn and for one a link cannot carry', () => {
    expect(field(kind, 'portalUrl')({ urn: '' })).toBeNull();
    expect(field(kind, 'portalUrl')({ urn: null })).toBeNull();
    expect(field(kind, 'portalUrl')({})).toBeNull();
    expect(field(kind, 'portalUrl')({ urn: 'acme.com:de v' })).toBeNull();
  });
});

describe('#2309 read gate', () => {
  it('a caller who cannot read the Memory never reaches the field; a member reads the link of its rendered urn', async () => {
    await cleanDb(db);
    const org = await db.organization.create({ data: { id: generateId(), name: 'pu-org', urn: 'pu-org.example' } });
    const member = await db.user.create({ data: { githubId: 230901, githubUsername: 'pu-member', roles: [] } });
    const outsider = await db.user.create({ data: { githubId: 230902, githubUsername: 'pu-outsider', roles: [] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: member.id, role: 'ADMIN' } });
    const as = (userId: string): Context => ({ db, userId, roles: [] });
    const mem = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'pu-mem' }, as(member.id)) as { id: string; urn: string };
    const read = (userId: string) => (resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<{ urn: string } | null>>).memory(null, { ref: mem.id }, as(userId));
    const seen = await read(member.id);
    expect(seen).not.toBeNull();
    expect(field('Memory', 'portalUrl')(seen as { urn: string })).toBe(`${ORIGIN}/app/u/${field('Memory', 'urn')(seen as { urn: string })}`);
    const blocked = await read(outsider.id).then((v) => v, (e: unknown) => e);
    expect(blocked === null || blocked instanceof Error).toBe(true);
  });
});
