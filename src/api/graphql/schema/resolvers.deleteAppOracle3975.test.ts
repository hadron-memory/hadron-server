/**
 * #3975 — `deleteApp` must not tell a missing App from one the caller is refused on, by id or by URN
 * (cor:dmo:050:21 Built-as-Proposed; cor:api:140:02: authorize before anything a refused caller can tell apart).
 * The reference is `uninstallApp` / `reinstallApp`: one `FORBIDDEN` / `Forbidden` for a missing App and a refused caller.
 * Lifecycle-state refusals (deleted) go only to a caller the gate admits.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles });

async function refusal(p: Promise<unknown>): Promise<{ code: unknown; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as GraphQLError & { code?: string };
    // formatError maps the typed ambiguity error to its wire code later; a direct resolver call carries its name.
    return { code: err.extensions?.code ?? err.code ?? err.name, message: err.message };
  }
  throw new Error('expected a rejection');
}

let n = 0;
const mkUser = (label: string) =>
  db.user.create({ data: { githubId: 9_000_000 + ++n, githubUsername: `da-${label}-${generateId()}`, roles: ['READER'] }, select: { id: true } });

let org: { id: string; urn: string };
let otherOrg: { id: string };
let admin: { id: string }, orgMember: { id: string }, otherAdmin: { id: string }, stranger: { id: string };
let app: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'da-org', urn: `da-${generateId().toLowerCase()}.example` } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'da-other', urn: `dx-${generateId().toLowerCase()}.example` } });
  [admin, orgMember, otherAdmin, stranger] = await Promise.all(['ad', 'me', 'oa', 'st'].map(mkUser));
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgMember.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: otherAdmin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Da', urn: `${org.urn}:da` }, select: { id: true, urn: true } });
});

const row = () => db.app.findUniqueOrThrow({ where: { id: app.id } });
const outsiders = () => [orgMember.id, otherAdmin.id, stranger.id, undefined];

describe('#3975 deleteApp existence oracle', () => {
  it('by id: a missing App and an App the caller is refused on get the uninstallApp refusal, code and message', async () => {
    const reference = await refusal(M.uninstallApp({}, { ref: generateId() }, ctx(stranger.id)));
    for (const who of outsiders()) {
      expect(await refusal(M.deleteApp({}, { ref: generateId() }, ctx(who)))).toEqual(reference);
      expect(await refusal(M.deleteApp({}, { ref: app.id }, ctx(who)))).toEqual(reference);
    }
    expect((await row()).deletedAt).toBeNull();
  });

  it('by URN: a missing URN and a URN the caller is refused on get the same refusal', async () => {
    const reference = await refusal(M.uninstallApp({}, { ref: generateId() }, ctx(stranger.id)));
    const missingUrn = `${org.urn}:nope-${generateId().toLowerCase()}`;
    for (const who of outsiders()) {
      expect(await refusal(M.deleteApp({}, { ref: missingUrn }, ctx(who)))).toEqual(reference);
      expect(await refusal(M.deleteApp({}, { ref: app.urn }, ctx(who)))).toEqual(reference);
    }
    expect((await row()).deletedAt).toBeNull();
  });

  it('the refusal echoes nothing resolved from the ref', async () => {
    const r = await refusal(M.deleteApp({}, { ref: app.urn }, ctx(stranger.id)));
    expect(r.message).toBe('Forbidden');
    expect(JSON.stringify(r)).not.toContain(app.id);
    expect(JSON.stringify(r)).not.toContain(org.id);
  });

  it('an uninstalled App: a refused caller gets the uniform refusal by id, and a URN with no installed holder is uniform and deletes nothing', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    const reference = await refusal(M.uninstallApp({}, { ref: generateId() }, ctx(stranger.id)));
    for (const who of outsiders()) expect(await refusal(M.deleteApp({}, { ref: app.id }, ctx(who)))).toEqual(reference);
    for (const who of [stranger.id, admin.id]) expect(await refusal(M.deleteApp({}, { ref: app.urn }, ctx(who)))).toEqual(reference);
    expect((await row()).deletedAt).toBeNull();
  });

  it('a URN carried by two uninstalled Apps does not tell a refused caller anything', async () => {
    const urn = `${org.urn}:twin`;
    await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'T1', urn, uninstalledAt: new Date() } });
    await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'T2', urn, uninstalledAt: new Date() } });
    const reference = await refusal(M.uninstallApp({}, { ref: generateId() }, ctx(stranger.id)));
    expect(await refusal(M.deleteApp({}, { ref: urn }, ctx(stranger.id)))).toEqual(reference);
  });

  it('a legacy URN carried by two installed Apps is ambiguous to the resolver, and a refused caller still gets the uniform refusal', async () => {
    const legacy = `${org.urn}:legacy`;
    await db.app.update({ where: { id: app.id }, data: { legacyUrn: legacy } });
    await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'L2', urn: `${org.urn}:l2`, legacyUrn: legacy } });
    const reference = await refusal(M.uninstallApp({}, { ref: generateId() }, ctx(stranger.id)));
    for (const who of outsiders()) expect(await refusal(M.deleteApp({}, { ref: legacy }, ctx(who)))).toEqual(reference);
    expect((await row()).deletedAt).toBeNull();
  });

  it('an ambiguous legacy URN: an admin of every claimant is told (and nothing is deleted); an admin of only one gets the uniform refusal', async () => {
    const legacy = `${org.urn}:legacy2`;
    const a = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A1', urn: `${org.urn}:a1`, legacyUrn: legacy } });
    await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A2', urn: `${org.urn}:a2`, legacyUrn: legacy } });
    expect((await refusal(M.deleteApp({}, { ref: legacy }, ctx(admin.id)))).code).toBe('AmbiguousLegacyUrnError');
    expect((await db.app.findUniqueOrThrow({ where: { id: a.id } })).deletedAt).toBeNull();
    // a claimant in another org: the first org's admin is admitted on one claimant only
    const foreign = `${otherOrg.id}`;
    await db.app.create({ data: { id: generateId(), organizationId: foreign, name: 'F', urn: `dx-f-${generateId().toLowerCase()}`, legacyUrn: legacy } });
    const reference = await refusal(M.uninstallApp({}, { ref: generateId() }, ctx(stranger.id)));
    expect(await refusal(M.deleteApp({}, { ref: legacy }, ctx(admin.id)))).toEqual(reference);
    expect(await refusal(M.deleteApp({}, { ref: legacy }, ctx(otherAdmin.id)))).toEqual(reference);
  });

  it('updateApp missing refs still answer APP_NOT_FOUND under #3982 model A', async () => {
    expect((await refusal(M.updateApp({}, { ref: generateId(), name: 'x' }, ctx(admin.id)))).code).toBe('APP_NOT_FOUND');
  });

  it('a deleted App: a refused caller gets the uniform refusal, an admitted caller learns APP_DELETED, after the gate', async () => {
    await M.deleteApp({}, { ref: app.id }, ctx(admin.id));
    const reference = await refusal(M.uninstallApp({}, { ref: generateId() }, ctx(stranger.id)));
    for (const who of outsiders()) expect(await refusal(M.deleteApp({}, { ref: app.id }, ctx(who)))).toEqual(reference);
    expect((await refusal(M.deleteApp({}, { ref: app.id }, ctx(admin.id)))).code).toBe('APP_DELETED');
  });

  it('the admitted caller still deletes, by id and by URN', async () => {
    expect(await M.deleteApp({}, { ref: app.id }, ctx(admin.id))).toBe(true);
    expect((await row()).deletedAt).not.toBeNull();
    const second = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Two', urn: `${org.urn}:two` } });
    expect(await M.deleteApp({}, { ref: second.urn }, ctx(admin.id))).toBe(true);
    expect((await db.app.findUniqueOrThrow({ where: { id: second.id } })).deletedAt).not.toBeNull();
  });
});
