/**
 * #5202 (follow-up to #725 / #5196, cor:api:170:03). Three residuals of `findObjects` on a STRICT collection:
 * 1. a userless caller (a pure App key, session-bound or not) who can read a PUBLIC knowledge memory gets its schema applied
 *    (the strict refusal and the schema-based cast) as any reader does; a caller who cannot read the memory, and a ref that does
 *    not exist, answer as before; only the one named memory is a public target;
 * 2. an undeclared field under `not` is refused;
 * 3. the query's own refusal comes first: a query that is over a cap in the predicate actually compiled (`match` AND `where`) and
 *    that also names an undeclared field answers BAD_USER_INPUT, not FIELD_NOT_DECLARED.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WHERE_MAX_DEPTH, WHERE_MAX_LEAVES } from '../../../lib/retrieval/nodeWhere.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const Q = (): any => resolvers.Query as any;
const M = (): any => resolvers.Mutation as any;
const outcome = async (p: Promise<any>): Promise<{ ok?: any; error?: any }> => p.then((v) => ({ ok: v }), (e) => ({ error: e }));
const codeOf = (r: { error?: any }) => r.error?.extensions?.code;

const schema = {
  objectTypes: {
    rec: { strict: true, fields: { alpha_f: { type: 'text' }, beta_f: { type: 'number' } } },
  },
};

let adminId: string;
let memId: string; // the admin's own memory, for items 2 and 3
let pub: { id: string };
let orgVisible: { id: string };
let keyCtx: Context;
let sessionCtx: Context;

const mkNode = (memoryId: string, loc: string, properties: Record<string, unknown>) =>
  db.node.create({ data: { id: generateId(), memoryId, loc: `rec:${loc}`, name: loc, objectType: 'rec', properties: properties as never } as never });
const admin = (): Context => ({ db, roles: ['ADMIN'], userId: adminId } as Context);
const find = (memoryRef: string, input: Record<string, unknown>, ctx: Context) => Q().findObjects(null, { memoryRef, ...input }, ctx);

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'fo-org', graphName: 'fo/graph' });
  memId = made.graph.id;
  const a = await db.user.create({ data: { githubId: 5202, githubUsername: 'fo-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: made.org.id, userId: a.id, role: 'ADMIN' } });
  adminId = a.id;
  await M().updateMemory(null, { ref: memId, schema }, admin());
  await mkNode(memId, 'one', { alpha_f: 'a1', beta_f: 1 });

  const suffix = generateId().toLowerCase();
  const orgA = await db.organization.create({ data: { name: 'Reader org', urn: `fo-reader-${suffix}.example` } });
  const orgB = await db.organization.create({ data: { name: 'Owner org', urn: `fo-owner-${suffix}.example` } });
  const { app, appKey } = await createDbAppWithKey(db, 'reader5202', orgA.id);
  const mk = (slug: string, visibility: string) =>
    db.memory.create({ data: { name: slug, urn: `${orgB.urn}:${slug}`, class: 'knowledge', visibility: visibility as never, organizationId: orgB.id, schema: schema as never } });
  pub = await mk('pub', 'PUBLIC');
  orgVisible = await mk('orgvis', 'ORGANIZATION');
  for (const m of [pub, orgVisible]) {
    await mkNode(m.id, 'n9', { alpha_f: 'x', beta_f: 9 });
    await mkNode(m.id, 'n10', { alpha_f: 'y', beta_f: 10 });
  }
  keyCtx = { db, appId: app.id, appKeyId: appKey.id, roles: [] } as unknown as Context;
  const session = await db.session.create({ data: { id: generateId(), appId: app.id } });
  sessionCtx = { db, appId: app.id, sessionId: session.id, roles: [] } as unknown as Context;
});

describe('#5202 item 1: a userless reader of a PUBLIC knowledge memory gets its schema applied', () => {
  it.each([['a pure App key', () => keyCtx], ['a session-bound App key', () => sessionCtx]])(
    '%s: an undeclared match key is FIELD_NOT_DECLARED (red before: it read the rows)',
    async (_n, ctx) => {
      const r = await outcome(find(pub.id, { type: 'rec', match: { nope: 'x' } }, ctx()));
      expect(codeOf(r)).toBe('FIELD_NOT_DECLARED');
      expect(r.error.extensions).toMatchObject({ field: 'nope', objectType: 'rec' });
    },
  );

  it.each([['a pure App key', () => keyCtx], ['a session-bound App key', () => sessionCtx]])(
    '%s: the schema-based cast orders a numeric field as numbers (9 before 10)',
    async (_n, ctx) => {
      const r = await find(pub.id, { type: 'rec', sort: { beta_f: 'asc' } }, ctx());
      expect(r.objects.map((o: { beta_f?: number }) => o.beta_f)).toEqual([9, 10]);
    },
  );

  it('such a caller may already read Memory.schema (the schema read gate admits it, so nothing here widens a disclosure)', async () => {
    for (const ctx of [keyCtx, sessionCtx]) {
      const memory = await Q().memory(null, { ref: pub.id }, ctx);
      expect(memory?.schema).toEqual(schema);
    }
  });

  it('a caller who cannot read the memory answers as before: no refusal and no rows (an ORGANIZATION memory)', async () => {
    for (const ctx of [keyCtx, sessionCtx]) {
      const r = await outcome(find(orgVisible.id, { type: 'rec', match: { nope: 'x' } }, ctx));
      expect(r.error).toBeUndefined(); // not FORBIDDEN, not an internal fault, not the strict refusal: the answer is empty
      expect(r.ok?.objects).toHaveLength(0);
    }
  });

  it('a PUBLIC knowledge memory that belongs to another App is not admitted: no refusal and no rows (the whole predicate decides, not the visibility alone)', async () => {
    const org = await db.organization.findFirstOrThrow({ where: { urn: { startsWith: 'fo-owner-' } } });
    const { app: otherApp } = await createDbAppWithKey(db, 'other5202', org.id);
    const scoped = await db.memory.create({
      data: { name: 'scoped', urn: `${org.urn}:scoped`, class: 'knowledge', visibility: 'PUBLIC', organizationId: org.id, appId: otherApp.id, schema: schema as never },
    });
    await mkNode(scoped.id, 's1', { alpha_f: 'x', beta_f: 1 });
    for (const ctx of [keyCtx, sessionCtx]) {
      const r = await outcome(find(scoped.id, { type: 'rec', match: { nope: 'x' } }, ctx));
      expect(r.error).toBeUndefined();
      expect(r.ok?.objects).toHaveLength(0);
    }
  });

  it('an over-cap predicate on a memory the caller cannot read answers BAD_USER_INPUT, as findNodes did before (validation does not depend on the memory)', async () => {
    const leaves = Array.from({ length: WHERE_MAX_LEAVES + 1 }, () => ({ path: ['alpha_f'], eq: 'x' }));
    for (const ctx of [keyCtx, sessionCtx]) {
      expect(codeOf(await outcome(find(orgVisible.id, { type: 'rec', where: { and: leaves } }, ctx)))).toBe('BAD_USER_INPUT');
    }
  });

  it('a ref that does not exist answers as before: never FIELD_NOT_DECLARED', async () => {
    for (const ctx of [keyCtx, sessionCtx]) {
      const r = await outcome(find(generateId(), { type: 'rec', match: { nope: 'x' } }, ctx));
      expect(codeOf(r)).not.toBe('FIELD_NOT_DECLARED');
    }
  });

  it('a signed-in user is unchanged: the strict refusal on a memory they own', async () => {
    expect(codeOf(await outcome(find(memId, { type: 'rec', match: { nope: 'x' } }, admin())))).toBe('FIELD_NOT_DECLARED');
  });
});

describe('#5202 item 2: an undeclared field under `not` is refused', () => {
  it('names the field under not, and accepts a declared one', async () => {
    const r = await outcome(find(memId, { type: 'rec', where: { not: { path: ['nope'], eq: 'x' } } }, admin()));
    expect(codeOf(r)).toBe('FIELD_NOT_DECLARED');
    expect(r.error.extensions.field).toBe('nope');
    const nested = await outcome(find(memId, { type: 'rec', where: { and: [{ not: { or: [{ path: ['alpha_f'], eq: 'a1' }, { path: ['nope'], eq: 'x' }] } }] } }, admin()));
    expect(codeOf(nested)).toBe('FIELD_NOT_DECLARED');
    expect(codeOf(await outcome(find(memId, { type: 'rec', where: { not: { path: ['alpha_f'], eq: 'zzz' } } }, admin())))).toBeUndefined();
  });
});

describe('#5202 item 3: the query\'s own refusal comes before FIELD_NOT_DECLARED', () => {
  const leaf = (field: string) => ({ path: [field], eq: 'x' });
  // Exactly the max depth on its own (root = 1), valid; one more level once `match` is combined with it.
  const nest = (inner: unknown, levels: number): unknown => (levels === 0 ? inner : { and: [nest(inner, levels - 1)] });
  const deep = (field: string) => nest(leaf(field), WHERE_MAX_DEPTH - 1);

  it('depth over the cap only once `match` and `where` are combined, naming an undeclared field: BAD_USER_INPUT', async () => {
    const alone = await outcome(find(memId, { type: 'rec', where: deep('alpha_f') }, admin()));
    expect(alone.error).toBeUndefined(); // valid on its own
    const r = await outcome(find(memId, { type: 'rec', match: { alpha_f: 'a1' }, where: deep('nope') }, admin()));
    expect(codeOf(r)).toBe('BAD_USER_INPUT');
  });

  it('leaf count over the cap only once combined, naming an undeclared field: BAD_USER_INPUT', async () => {
    const leaves = (n: number, last: string) => Array.from({ length: n }, (_v, i) => leaf(i === n - 1 ? last : 'alpha_f'));
    const alone = await outcome(find(memId, { type: 'rec', where: { and: leaves(WHERE_MAX_LEAVES, 'alpha_f') } }, admin()));
    expect(alone.error).toBeUndefined(); // the max leaf count: valid on its own
    const r = await outcome(find(memId, { type: 'rec', match: { alpha_f: 'a1' }, where: { and: leaves(WHERE_MAX_LEAVES, 'nope') } }, admin()));
    expect(codeOf(r)).toBe('BAD_USER_INPUT');
  });

  it('`match` alone over the leaf cap, naming an undeclared field: BAD_USER_INPUT', async () => {
    const match: Record<string, unknown> = { nope: 'x' };
    for (let i = 0; i < WHERE_MAX_LEAVES; i++) match[`alpha_f${i}`] = 'x';
    const r = await outcome(find(memId, { type: 'rec', match }, admin()));
    expect(codeOf(r)).toBe('BAD_USER_INPUT');
  });

  it('within the caps the undeclared field is still FIELD_NOT_DECLARED', async () => {
    expect(codeOf(await outcome(find(memId, { type: 'rec', match: { alpha_f: 'a1' }, where: leaf('nope') }, admin())))).toBe('FIELD_NOT_DECLARED');
  });
});
