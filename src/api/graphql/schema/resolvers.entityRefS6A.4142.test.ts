/**
 * #4142 (S6, chunk A) — the memory READS take `<entity>Ref`, no alias: `usageEvents` / `usageEventsPage`
 * (`memoryRef`, `nodeRef`), `memoryAssets` (`memoryRef`) and `memoryLocSegments` (`memoryRefs`).
 *
 * Held by these pins, per the gate (comment "CHECKED + cleared by bounded chunks"):
 *   1. SDL: each old name is an unknown argument, each new one is declared with the gate's scalar.
 *   2. Behavior through a real ApolloServer (so argument validation runs): the PK and the URN both resolve,
 *      and the old name is refused by validation.
 *   3. cor:api:140:03 parity, one pin per gate helper (usageEventsWhere, listMemoryAssets,
 *      resolveNodeReadScopeIds): an unreadable memory answers the same for a PK and for a URN, and the same as a
 *      memory that does not exist.
 *   4. The `nodeUsage` deprecation text no longer names a pre-rename argument.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
type Answer = { data: Record<string, unknown> | null; error: { message: string; code: unknown } | null };

async function ask(c: Context, query: string, variables: Record<string, unknown> = {}): Promise<Answer> {
  const res = await server.executeOperation({ query, variables }, { contextValue: c });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  const { data, errors } = res.body.singleResult;
  const e = errors?.[0];
  return { data: (data as Record<string, unknown> | null) ?? null, error: e ? { message: e.message, code: e.extensions?.code } : null };
}

const admin = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-4142a' }) as Context;
const stranger = (): Context => ({ db, roles: [], userId: 'stranger-4142a' }) as Context;

const schema = buildSchema(typeDefs);
const argsOf = (field: string): Map<string, string> =>
  new Map(((schema.getQueryType() as GraphQLObjectType).getFields()[field]?.args ?? []).map(a => [a.name, String(a.type)]));

let M: { id: string; urn: string };
let N: string;

beforeEach(async () => {
  await cleanDb(db);
  M = (await createDbOrgAndGraph(db, { orgName: 'a4142', graphName: 'a4142/m' })).graph as unknown as { id: string; urn: string };
  N = generateId();
  await db.node.create({ data: { id: N, memoryId: M.id, loc: 'ops:alpha', name: 'alpha' } as never });
  // A second readable memory with a different top segment: naming only M must not list it (an empty ref list would).
  const other = (await createDbOrgAndGraph(db, { orgName: 'a4142b', graphName: 'a4142/other' })).graph as unknown as { id: string };
  await db.node.create({ data: { id: generateId(), memoryId: other.id, loc: 'elsewhere:x', name: 'x' } as never });
  await db.usageEvent.create({ data: { id: generateId(), type: 'read', nodeLoc: 'ops:alpha', memoryId: M.id, nodeId: N, userId: null } as never });
});

describe('1. SDL — old names gone, new names declared', () => {
  it.each([
    ['usageEvents', 'memoryId', 'memoryRef', 'ID'],
    ['usageEvents', 'nodeId', 'nodeRef', 'ID'],
    ['usageEventsPage', 'memoryId', 'memoryRef', 'ID'],
    ['usageEventsPage', 'nodeId', 'nodeRef', 'ID'],
    ['memoryAssets', 'memoryId', 'memoryRef', 'ID!'],
    ['memoryLocSegments', 'memoryIds', 'memoryRefs', '[ID!]!'],
  ])('Query.%s drops %s and declares %s: %s', (field, old, next, scalar) => {
    const a = argsOf(field);
    expect(a.has(old), `${field}(${old}) must be an unknown argument`).toBe(false);
    expect(a.get(next)).toBe(scalar);
  });

  it('the nodeUsage deprecation text names no pre-rename argument', () => {
    const f = (schema.getQueryType() as GraphQLObjectType).getFields().nodeUsage;
    const text = `${f.description ?? ''}\n${f.deprecationReason ?? ''}`;
    expect(text).not.toMatch(/usageEvents\(nodeId/);
    expect(text).not.toMatch(/via nodeId|nodeId accepts|memoryId scoping/);
    expect(text).toMatch(/nodeRef/);
    expect(text).toMatch(/memoryRef/);
  });
});

describe('2. behavior — PK and URN both resolve; the old name is refused', () => {
  it.each([['PK', () => M.id], ['URN', () => M.urn]])('usageEvents / usageEventsPage(memoryRef: %s)', async (_n, ref) => {
    const a = await ask(admin(), 'query($m: ID){ a: usageEvents(memoryRef: $m){ id } b: usageEventsPage(memoryRef: $m){ total } }', { m: ref() });
    expect(a.error).toBeNull();
    expect((a.data?.a as unknown[]).length).toBe(1);
    expect((a.data?.b as { total: number }).total).toBe(1);
  });

  it.each([['PK', () => N], ['URN', () => `${M.urn}:ops:alpha`]])('usageEvents / usageEventsPage(nodeRef: %s)', async (_n, ref) => {
    const a = await ask(admin(), 'query($n: ID){ a: usageEvents(nodeRef: $n){ id } b: usageEventsPage(nodeRef: $n){ total } }', { n: ref() });
    expect(a.error).toBeNull();
    expect((a.data?.a as unknown[]).length).toBe(1);
    expect((a.data?.b as { total: number }).total).toBe(1);
  });

  it.each([['PK', () => M.id], ['URN', () => M.urn]])('memoryAssets(memoryRef: %s)', async (_n, ref) => {
    const a = await ask(admin(), 'query($m: ID!){ memoryAssets(memoryRef: $m){ total } }', { m: ref() });
    expect(a.error).toBeNull();
    expect((a.data?.memoryAssets as { total: number }).total).toBe(0);
  });

  it.each([['PK', () => M.id], ['URN', () => M.urn]])('memoryLocSegments(memoryRefs: [%s])', async (_n, ref) => {
    const a = await ask(admin(), 'query($m: [ID!]!){ memoryLocSegments(memoryRefs: $m, parentLoc: ""){ items { segment } } }', { m: [ref()] });
    expect(a.error).toBeNull();
    expect((a.data?.memoryLocSegments as { items: Array<{ segment: string }> }).items.map(i => i.segment)).toEqual(['ops']);
  });

  it.each([
    ['usageEvents(memoryId: $m){ id }', 'ID'],
    ['usageEvents(nodeId: $m){ id }', 'ID'],
    ['usageEventsPage(memoryId: $m){ total }', 'ID'],
    ['usageEventsPage(nodeId: $m){ total }', 'ID'],
    ['memoryAssets(memoryId: $m){ total }', 'ID!'],
    ['memoryLocSegments(memoryIds: [$m], parentLoc: ""){ hasMore }', 'ID!'],
  ])('the old name in %s is rejected by validation', async (sel, scalar) => {
    const a = await ask(admin(), `query($m: ${scalar}){ ${sel} }`, { m: M.id });
    expect(a.error?.message).toMatch(/Unknown argument/);
  });
});

describe('3. cor:api:140:03 parity — a refused PK equals a refused URN equals a missing memory', () => {
  const missingUrn = 'hrn:mem:nowhere.example:does-not-exist';
  // A caller who PASSES the principal gate (a `roles: []` caller is refused FORBIDDEN before any memory is resolved, which would
  // make these pins vacuous: BLIND P2-1) but cannot read M. The refusal is then the memory gate's own.
  const reader = (): Context => ({ db, roles: ['READER'], userId: 'stranger-4142a' }) as Context;
  /** The refusal with the caller's own ref taken out, since the usage gate echoes it (`MEMORY_NOT_FOUND: <ref>`). */
  const redacted = (a: Answer, ref: string): unknown => a.error && { code: a.error.code, message: a.error.message.split(ref).join('<ref>') };

  it('usageEventsWhere (usageEvents, usageEventsPage)', async () => {
    for (const [field, sel] of [['usageEvents', '{ id }'], ['usageEventsPage', '{ total }']] as const) {
      const run = (m: string) => ask(reader(), `query($m: ID){ ${field}(memoryRef: $m)${sel} }`, { m });
      const pk = await run(M.id);
      expect(pk.error?.code, `${field}: the memory gate's refusal, not the principal gate's`).toBe('MEMORY_NOT_FOUND');
      expect(redacted(await run(M.urn), M.urn)).toEqual(redacted(pk, M.id));
      const gone = generateId();
      expect(redacted(await run(gone), gone)).toEqual(redacted(pk, M.id));
      expect(redacted(await run(missingUrn), missingUrn)).toEqual(redacted(pk, M.id));
    }
  });

  it('listMemoryAssets (memoryAssets)', async () => {
    const run = (m: string) => ask(reader(), 'query($m: ID!){ memoryAssets(memoryRef: $m){ total } }', { m });
    const pk = await run(M.id);
    expect(pk.error?.code, 'the memory gate NOT_FOUND, not the principal gate').toBe('NOT_FOUND');
    expect(await run(M.urn)).toEqual(pk);
    expect(await run(generateId())).toEqual(pk);
    expect(await run(missingUrn)).toEqual(pk);
  });

  it('resolveNodeReadScopeIds (memoryLocSegments)', async () => {
    const run = (m: string) => ask(stranger(), 'query($m: [ID!]!){ memoryLocSegments(memoryRefs: $m, parentLoc: ""){ items { segment } hasMore } }', { m: [m] });
    const pk = await run(M.id);
    expect(pk.error, 'resolved without a validation error').toBeNull();
    expect(pk.data?.memoryLocSegments, 'an unreadable memory answers the empty page').toEqual({ items: [], hasMore: false });
    expect(await run(M.urn)).toEqual(pk);
    expect(await run(generateId())).toEqual(pk);
    expect(await run(missingUrn)).toEqual(pk);
  });
});
