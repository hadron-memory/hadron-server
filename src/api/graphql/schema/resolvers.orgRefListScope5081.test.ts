/**
 * #5081 (gap 3) — the organization argument on 21 fields is `orgRef`, hard rename, no alias.
 *
 * Every pin runs through real GraphQL execution (validation, then the field resolver), never `resolvers.Query.*` direct
 * calls: a direct call skips argument validation, which is how #864 shipped a broken `createApp` with every test green.
 *
 * What is pinned, per the issue's Acceptance:
 *  - the declared scalar of `orgRef` (unchanged by the rename: `String` on impersonationSessions, `ID!` on the two exchange
 *    lists and the three signing fields, `ID` on the other fifteen);
 *  - the old name (`orgId` / `org`) is an unknown argument and the resolver is never reached;
 *  - a URN and a PK return the same result for a member;
 *  - the scope is actually applied (a destructure that reads the wrong name gets `undefined` and serves the UNSCOPED union);
 *  - the gate is unchanged, and the refusals that are byte-identical today stay byte-identical (one URN case and one PK case),
 *    while the ones that are NOT identical today (rows 4, 6, 7, and rows 1-2 under `scope`) are pinned as they are.
 *
 * None of the scope or byte-identity pins sets `filter.ownedByMe`: that branch on memories / apps / agents returns before
 * `resolveOrgScope` and never reads `orgRef`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql, parse, validate, type GraphQLNamedType, getNamedType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const schema = buildSchema(typeDefs);

/** field → [root, declared scalar of orgRef, selection], in the issue's row order. */
type Row = { root: 'Query' | 'Mutation'; scalar: string; select: string; extra?: string; oldName: 'orgId' | 'org' };
const FIELDS: Record<string, Row> = {
  findNodes: { root: 'Query', scalar: 'ID', select: '{ total }', extra: 'query: "zzz-5081"', oldName: 'orgId' },
  globalSearch: { root: 'Query', scalar: 'ID', select: '{ total }', extra: 'query: "zzz-5081"', oldName: 'orgId' },
  edges: { root: 'Query', scalar: 'ID', select: '{ total items { id } }', oldName: 'orgId' },
  impersonationSessions: { root: 'Query', scalar: 'String', select: '{ total }', oldName: 'orgId' },
  memories: { root: 'Query', scalar: 'ID', select: '{ total items { id } }', oldName: 'orgId' },
  exchangeConnections: { root: 'Query', scalar: 'ID!', select: '{ id }', oldName: 'orgId' },
  exchangeConnectionsPage: { root: 'Query', scalar: 'ID!', select: '{ total items { id } }', oldName: 'orgId' },
  slackConnections: { root: 'Query', scalar: 'ID', select: '{ total items { id } }', oldName: 'orgId' },
  telegramConnections: { root: 'Query', scalar: 'ID', select: '{ total items { id } }', oldName: 'orgId' },
  mcpServers: { root: 'Query', scalar: 'ID', select: '{ total items { id } }', oldName: 'orgId' },
  homeAssistantInstances: { root: 'Query', scalar: 'ID', select: '{ total items { id } }', oldName: 'orgId' },
  resendSenders: { root: 'Query', scalar: 'ID', select: '{ total items { id } }', oldName: 'orgId' },
  apps: { root: 'Query', scalar: 'ID', select: '{ total items { id } }', oldName: 'orgId' },
  agents: { root: 'Query', scalar: 'ID', select: '{ total items { id } }', oldName: 'orgId' },
  scopes: { root: 'Query', scalar: 'ID', select: '{ total items { id } }', oldName: 'orgId' },
  channels: { root: 'Query', scalar: 'ID', select: '{ total items { id } }', oldName: 'orgId' },
  registerEntries: { root: 'Query', scalar: 'ID', select: '{ total items { id } }', oldName: 'orgId' },
  assets: { root: 'Query', scalar: 'ID', select: '{ total items { id } }', oldName: 'orgId' },
  orgBootPromptSigning: { root: 'Query', scalar: 'ID!', select: '{ required }', oldName: 'org' },
  orgBootPromptSigningPreview: { root: 'Query', scalar: 'ID!', select: '{ total }', oldName: 'org' },
  setOrgBootPromptSigning: { root: 'Mutation', scalar: 'ID!', select: '{ required }', extra: 'required: false', oldName: 'org' },
};
const NAMES = Object.keys(FIELDS);
// Rows 4, 6, 7 answer a typed not-found for an unknown org and FORBIDDEN for a real one today; the signing three conceal.
const NOT_BYTE_IDENTICAL = ['impersonationSessions', 'exchangeConnections', 'exchangeConnectionsPage'];
const SIGNING = ['orgBootPromptSigning', 'orgBootPromptSigningPreview', 'setOrgBootPromptSigning'];
const SCOPE_GATED = NAMES.filter((n) => !NOT_BYTE_IDENTICAL.includes(n) && !SIGNING.includes(n));

const docWith = (name: string, arg: string, value: string) => {
  const f = FIELDS[name];
  const op = f.root === 'Mutation' ? 'mutation' : 'query';
  return `${op} { ${name}(${f.extra ? `${f.extra}, ` : ''}${arg}: ${value}) ${f.select} }`;
};
const lit = (v: string) => JSON.stringify(v);

async function run(source: string, ctx: Context) {
  return graphql({
    schema, source, contextValue: ctx,
    fieldResolver: (parent, args, context, info) => {
      const fields = resolvers[info.parentType.name as keyof typeof resolvers] as Record<string, Function> | undefined;
      const resolver = fields?.[info.fieldName];
      return typeof resolver === 'function' ? resolver(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
    },
  });
}
/** The response as bytes: data and the error's message and code, nothing else. */
const bytes = (r: Awaited<ReturnType<typeof run>>) =>
  JSON.stringify({ data: r.data ?? null, errors: (r.errors ?? []).map((e) => ({ m: e.message, c: e.extensions?.code })) });

describe('#5081 — the declared scalar and the old name (schema only)', () => {
  it.each(NAMES)('%s declares orgRef with its scalar and no old name', (name) => {
    const f = FIELDS[name];
    const root = (f.root === 'Query' ? schema.getQueryType() : schema.getMutationType())!;
    const args = root.getFields()[name].args;
    const orgRef = args.find((a) => a.name === 'orgRef');
    expect(orgRef, `${name}.orgRef`).toBeDefined();
    expect(String(orgRef!.type)).toBe(f.scalar);
    expect(args.map((a) => a.name)).not.toContain(f.oldName);
    expect(args.map((a) => a.name)).not.toContain('orgId');
    expect(args.map((a) => a.name)).not.toContain('org');
    expect(getNamedType(orgRef!.type)).toBeDefined();
  });

  it.each(NAMES)('%s: a document sending the old name fails validation as an unknown argument', (name) => {
    const f = FIELDS[name];
    const errors = validate(schema, parse(docWith(name, f.oldName, '"x"')));
    expect(errors.map((e) => e.message)).toEqual(
      expect.arrayContaining([expect.stringContaining(`Unknown argument "${f.oldName}" on field "${f.root}.${name}"`)]),
    );
  });

  it('the resolver is never reached with the old name', async () => {
    const r = await run(docWith('apps', 'orgId', '"x"'), { db, userId: 'nobody', roles: ['ADMIN'] } as Context);
    expect(r.data).toBeUndefined();
    expect(r.errors?.[0].message).toContain('Unknown argument "orgId"');
  });
});

describe('#5081 — behaviour through real GraphQL', () => {
  let orgA: { id: string; urn: string };
  let orgB: { id: string; urn: string };
  let both: { id: string }; // ADMIN of A and of B
  let readerA: { id: string }; // READER of A only
  let stranger: { id: string }; // member of neither
  let platform: { id: string }; // platform admin, member of neither
  let appA: { id: string };
  let appB: { id: string };
  let agentA: { id: string };
  let agentB: { id: string };
  let memA: { id: string };
  let memB: { id: string };

  const ctx = (userId: string, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles }) as Context;

  beforeEach(async () => {
    await cleanDb(db);
    const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    orgA = await db.organization.create({ data: { id: generateId(), name: 'o5081-a', urn: `o5081-a-${t}` } });
    orgB = await db.organization.create({ data: { id: generateId(), name: 'o5081-b', urn: `o5081-b-${t}` } });
    const user = (n: number, h: string, roles: any = ['READER']) =>
      db.user.create({ data: { id: generateId(), githubId: 508100 + n, githubUsername: `${h}-${t}`, roles } });
    both = await user(1, 'both');
    readerA = await user(2, 'reader');
    stranger = await user(3, 'stranger');
    platform = await user(4, 'platform', ['ADMIN']);
    const member = (orgId: string, userId: string, role: any) => db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId, role } });
    await member(orgA.id, both.id, 'ADMIN');
    await member(orgB.id, both.id, 'ADMIN');
    await member(orgA.id, readerA.id, 'READER');
    agentA = await db.agent.create({ data: { id: generateId(), organizationId: orgA.id, name: 'ag-a', urn: `${orgA.urn}:ag`, visibility: 'ORGANIZATION' } });
    agentB = await db.agent.create({ data: { id: generateId(), organizationId: orgB.id, name: 'ag-b', urn: `${orgB.urn}:ag`, visibility: 'ORGANIZATION' } });
    appA = await db.app.create({ data: { id: generateId(), organizationId: orgA.id, name: 'app-a', urn: `${orgA.urn}:app` } });
    appB = await db.app.create({ data: { id: generateId(), organizationId: orgB.id, name: 'app-b', urn: `${orgB.urn}:app` } });
    const mem = (o: { id: string; urn: string }, slug: string) =>
      db.memory.create({ data: { id: generateId(), organizationId: o.id, urn: `${o.urn}:${slug}`, name: slug, class: 'knowledge', visibility: 'ORGANIZATION' } });
    memA = await mem(orgA, 'ma');
    memB = await mem(orgB, 'mb');
  });

  const ids = (r: Awaited<ReturnType<typeof run>>, field: string): string[] =>
    ((r.data as any)?.[field]?.items ?? []).map((i: any) => i.id).sort();

  describe('a URN and a PK return the same result for a member', () => {
    it.each(NAMES)('%s', async (name) => {
      const c = ctx(both.id);
      const urn = await run(docWith(name, 'orgRef', lit(orgA.urn)), c);
      const pk = await run(docWith(name, 'orgRef', lit(orgA.id)), c);
      expect(urn.errors, `${name} by URN`).toBeUndefined();
      expect(pk.errors, `${name} by PK`).toBeUndefined();
      expect(bytes(urn)).toBe(bytes(pk));
    });
  });

  describe('the scope is actually applied (the main risk of the rename)', () => {
    it.each([
      ['apps', () => [appA.id], () => [appB.id]],
      ['agents', () => [agentA.id], () => [agentB.id]],
      ['memories', () => [memA.id], () => [memB.id]],
    ] as const)('%s: a caller of two orgs who passes orgRef A gets no row of B', async (name, inA, inB) => {
      const c = ctx(both.id);
      const scopedA = await run(docWith(name, 'orgRef', lit(orgA.urn)), c);
      expect(scopedA.errors).toBeUndefined();
      const got = ids(scopedA, name);
      for (const id of inA()) expect(got).toContain(id);
      for (const id of inB()) expect(got).not.toContain(id);
      const scopedB = await run(docWith(name, 'orgRef', lit(orgB.id)), c);
      for (const id of inA()) expect(ids(scopedB, name)).not.toContain(id);
      for (const id of inB()) expect(ids(scopedB, name)).toContain(id);
    });

    it.each(['apps', 'agents'])('%s: a platform admin who passes an org they are not a member of gets an empty page, not every row', async (name) => {
      const c = ctx(platform.id, ['ADMIN']);
      const unscoped = await run(`query { ${name} { total } }`, c);
      expect((unscoped.data as any)[name].total).toBeGreaterThan(0); // the reach the rename must not leak into a scoped call
      for (const ref of [orgA.urn, orgB.id]) {
        const r = await run(docWith(name, 'orgRef', lit(ref)), c);
        expect(r.errors).toBeUndefined();
        expect((r.data as any)[name]).toEqual({ total: 0, items: [] });
      }
    });

    it('findNodes and globalSearch under scope:"global" apply the org (scope-lens path)', async () => {
      await db.node.create({ data: { id: generateId(), memoryId: memA.id, loc: 'n-a', name: 'zzz-5081 in A', content: 'zzz-5081' } as any });
      await db.node.create({ data: { id: generateId(), memoryId: memB.id, loc: 'n-b', name: 'zzz-5081 in B', content: 'zzz-5081' } as any });
      const c = ctx(both.id);
      const nodes = `{ hits { node { memoryId } } }`;
      const f = await run(`query { findNodes(query: "zzz-5081", scope: "global", orgRef: ${lit(orgA.urn)}) ${nodes} }`, c);
      expect(f.errors).toBeUndefined();
      const memIds = (f.data as any).findNodes.hits.map((h: any) => h.node.memoryId);
      expect(memIds).toContain(memA.id);
      expect(memIds).not.toContain(memB.id);
      const g = await run(`query { globalSearch(query: "zzz-5081", scope: "global", orgRef: ${lit(orgA.urn)}) { hits { __typename } total } }`, c);
      expect(g.errors).toBeUndefined();
      expect((g.data as any).globalSearch.total).toBeGreaterThan(0);
    });
  });

  describe('the gate is unchanged', () => {
    it.each(SCOPE_GATED)('%s: a non-member and a platform admin with no membership get an empty result (no admin bypass)', async (name) => {
      for (const c of [ctx(stranger.id), ctx(platform.id, ['ADMIN'])]) {
        const r = await run(docWith(name, 'orgRef', lit(orgA.urn)), c);
        expect(r.errors, name).toBeUndefined();
        expect((r.data as any)[name].total, name).toBe(0);
      }
    });

    it('exchangeConnections and exchangeConnectionsPage: a plain member (not ADMIN) is FORBIDDEN', async () => {
      for (const name of ['exchangeConnections', 'exchangeConnectionsPage']) {
        const r = await run(docWith(name, 'orgRef', lit(orgA.urn)), ctx(readerA.id));
        expect(r.errors?.[0].extensions?.code, name).toBe('FORBIDDEN');
      }
    });

    it('impersonationSessions: a member who is not ADMIN/OWNER is FORBIDDEN; a non-admin must name an org; a platform admin may omit it', async () => {
      const forbidden = await run(docWith('impersonationSessions', 'orgRef', lit(orgA.urn)), ctx(readerA.id));
      expect(forbidden.errors?.[0].extensions?.code).toBe('FORBIDDEN');
      const omitted = await run('query { impersonationSessions { total } }', ctx(readerA.id));
      expect(omitted.errors?.[0].message).toMatch(/orgRef is required/);
      const admin = await run('query { impersonationSessions { total } }', ctx(platform.id, ['ADMIN']));
      expect(admin.errors).toBeUndefined();
    });

    it.each(SIGNING)('%s: audience unchanged (ADMIN passes, a reader is FORBIDDEN)', async (name) => {
      const ok = await run(docWith(name, 'orgRef', lit(orgA.urn)), ctx(both.id));
      expect(ok.errors).toBeUndefined();
      const no = await run(docWith(name, 'orgRef', lit(orgA.urn)), ctx(readerA.id));
      expect(no.errors?.[0].extensions?.code).toBe('FORBIDDEN');
    });
  });

  describe('byte-identical refusals where the doors already have them (one URN case, one PK case)', () => {
    const unknownUrn = () => `no-such-org-${generateId()}`;
    const unknownPk = () => generateId();

    it.each(SCOPE_GATED)('%s: an unknown orgRef and a real org the caller is not a member of answer the same bytes', async (name) => {
      const c = ctx(stranger.id);
      const realUrn = bytes(await run(docWith(name, 'orgRef', lit(orgA.urn)), c));
      const missingUrn = bytes(await run(docWith(name, 'orgRef', lit(unknownUrn())), c));
      expect(missingUrn).toBe(realUrn);
      const realPk = bytes(await run(docWith(name, 'orgRef', lit(orgA.id)), c));
      const missingPk = bytes(await run(docWith(name, 'orgRef', lit(unknownPk())), c));
      expect(missingPk).toBe(realPk);
    });

    it.each(SIGNING)('%s: an unknown orgRef is the byte-identical FORBIDDEN of a non-member', async (name) => {
      const c = ctx(stranger.id);
      const realUrn = bytes(await run(docWith(name, 'orgRef', lit(orgA.urn)), c));
      const realPk = bytes(await run(docWith(name, 'orgRef', lit(orgA.id)), c));
      expect(bytes(await run(docWith(name, 'orgRef', lit(unknownUrn())), c))).toBe(realUrn);
      expect(bytes(await run(docWith(name, 'orgRef', lit(unknownPk())), c))).toBe(realPk);
      expect(JSON.parse(realUrn).errors[0].c).toBe('FORBIDDEN');
    });

    it.each(NOT_BYTE_IDENTICAL)('%s: NOT byte-identical today (typed not-found vs FORBIDDEN) — pinned as it is, not fixed here', async (name) => {
      const c = ctx(readerA.id);
      const real = await run(docWith(name, 'orgRef', lit(orgB.urn)), c); // a real org the caller is not (admin of)
      const missing = await run(docWith(name, 'orgRef', lit(unknownUrn())), c);
      expect(real.errors?.[0].extensions?.code).toBe('FORBIDDEN');
      expect(missing.errors?.[0].extensions?.code).not.toBe('FORBIDDEN');
      expect(bytes(missing)).not.toBe(bytes(real));
    });

    it.each(['findNodes', 'globalSearch'])('%s with scope:"global": unknown and non-member orgRef differ today (ORG_REQUIRED memberOrgIds) — pinned, URN and PK', async (name) => {
      const withScope = (ref: string) =>
        `query { ${name}(query: "zzz-5081", scope: "global", orgRef: ${lit(ref)}) { total } }`;
      // `both` is a member of A and B, so use a caller of ONE org against the other for the real non-member case.
      const one = ctx(readerA.id);
      for (const [real, unknown] of [[orgB.urn, `no-such-${generateId()}`], [orgB.id, generateId()]]) {
        const rReal = await run(withScope(real), one);
        const rUnknown = await run(withScope(unknown), one);
        expect(rReal.errors?.[0].extensions?.code).toBe('ORG_REQUIRED');
        expect(rUnknown.errors?.[0].extensions?.code).toBe('ORG_REQUIRED');
        expect(rReal.errors?.[0].extensions?.memberOrgIds).toEqual([orgA.id]);
        expect(rUnknown.errors?.[0].extensions?.memberOrgIds).toEqual([]);
      }
    });
  });
});
