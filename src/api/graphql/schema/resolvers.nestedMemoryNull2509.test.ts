/**
 * #2509 — Channel.memory, MemoryShare.memory and MemoryMember.memory are entries onto the Memory entity
 * (cor:acl:110): each answers with the memory RECORD only when Query.memory would for the same principal, else
 * null (cor:api:140:03), exactly like Node.memory (#2193). A parent that admitted the row authorized the ROW, not
 * the record, and a preloaded `memory` on the parent authorizes nothing (#474). The fields are nullable so an
 * unreadable record does not null the parent (or its readable siblings) and raises no concealment error.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, graphql, isNonNullType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const r = resolvers as any;
const FIELDS = [
  ['Channel', (id: string, extra: object = {}) => ({ id: 'c', memoryId: id, ...extra })],
  ['MemoryShare', (id: string, extra: object = {}) => ({ memoryId: id, granteeId: 'g', grantorId: 'h', ...extra })],
  ['MemoryMember', (id: string, extra: object = {}) => ({ memoryId: id, userId: 'u', ...extra })],
] as const;

let n: number;
let org: { id: string; urn: string };
const user: Record<string, string> = {};
const mem: Record<string, string> = {};
const ctxFor = (who: string): Context => ({ db, userId: user[who], roles: ['READER'] });
const oracle = async (who: string, id: string) => ((await r.Query.memory(null, { ref: id }, ctxFor(who))) as { id: string } | null)?.id ?? null;

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Nest', urn: `nest2509-${n}.example` }, select: { id: true, urn: true } });
  for (const who of ['owner', 'reader', 'stranger', 'appMember']) {
    user[who] = (await db.user.create({ data: { handle: `n2509-${who}-${n}`, roles: ['READER'] } })).id;
  }
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.owner!, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.reader!, role: 'READER' } });
  const appId = (await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } })).id;
  await db.appMember.create({ data: { appId, userId: user.appMember!, role: 'member' } });
  const make = async (key: string, data: object) => {
    mem[key] = (await db.memory.create({ data: { organizationId: org.id, name: key, urn: `${org.urn}:${key}`, description: `${key} description`, ...data } as never })).id;
  };
  await make('orgOnly', { class: 'knowledge', visibility: 'ORGANIZATION' });
  await make('public', { class: 'knowledge', visibility: 'PUBLIC' });
  await make('appOwned', { class: 'app', appId });
  await make('deleted', { class: 'knowledge', visibility: 'ORGANIZATION', deletedAt: new Date() });
});

describe('the SDL', () => {
  it.each(FIELDS.map(([type]) => type))('%s.memory is nullable', (type) => {
    const field = (buildSchema(typeDefs).getType(type) as any).getFields().memory;
    expect(isNonNullType(field.type)).toBe(false);
  });
});

describe.each(FIELDS)('%s.memory answers as Query.memory does, per principal', (type, parent) => {
  const field = (who: string, memoryId: string, extra: object = {}) => r[type].memory(parent(memoryId, extra), {}, ctxFor(who));

  it.each([
    ['owner', 'orgOnly'], ['reader', 'orgOnly'], ['stranger', 'orgOnly'],
    ['stranger', 'public'], ['owner', 'public'],
    ['appMember', 'appOwned'], ['owner', 'appOwned'], ['stranger', 'appOwned'],
    ['owner', 'deleted'],
  ])('%s reading a %s memory', async (who, key) => {
    const answered = (await field(who!, mem[key!]!)) as { id: string } | null;
    expect(answered?.id ?? null).toBe(await oracle(who!, mem[key!]!));
  });

  it('pins the interesting cases so parity cannot degrade to null == null', async () => {
    expect((await field('reader', mem.orgOnly!))?.id).toBe(mem.orgOnly);
    expect(await field('stranger', mem.orgOnly!)).toBeNull();
    expect((await field('stranger', mem.public!))?.id).toBe(mem.public);
    expect(await field('owner', mem.deleted!)).toBeNull();
    expect(await field('stranger', 'nonexistent-memory-id')).toBeNull();
  });

  it('ignores a preloaded parent memory: it authorizes nothing', async () => {
    const preload = { id: mem.orgOnly, name: 'preloaded', urn: 'x', organizationId: org.id, description: 'leak' };
    expect(await field('stranger', mem.orgOnly!, { memory: preload })).toBeNull();
    // and for a reader the answer is the loaded record, not the truncated preload
    expect(await field('reader', mem.orgOnly!, { memory: preload })).toMatchObject({ id: mem.orgOnly, description: 'orgOnly description' });
  });

  it('a loader failure stays an error and is never read as null', async () => {
    const failing = { ...ctxFor('reader'), db: new Proxy(db, { get: (t, p) => p === 'memory'
      ? { findUnique: () => Promise.reject(new Error('db down')) } : (t as any)[p] }) } as Context;
    await expect(r[type].memory(parent(mem.orgOnly!), {}, failing)).rejects.toThrow('db down');
  });
});

describe('executed through GraphQL: nullability and error handling', () => {
  // The real SDL plus a probe root returning one readable and one unreadable row per type. Every field resolves
  // through the real resolver map, so null placement and error handling are graphql-js's own.
  const schema = buildSchema(`${typeDefs}
    extend type Query { probeChannels: [Channel!]!  probeShares: [MemoryShare!]!  probeMembers: [MemoryMember!]! }`);
  const rowsFor = () => ({
    probeChannels: [{ id: 'a', memoryId: mem.orgOnly, name: 'a' }, { id: 'b', memoryId: mem.orgOnly, name: 'b' }],
    probeShares: [{ memoryId: mem.public }, { memoryId: mem.orgOnly }],
    probeMembers: [{ memoryId: mem.public }, { memoryId: mem.orgOnly }],
  });
  const run = (source: string, context: Context) => graphql({
    schema, source, contextValue: context, rootValue: rowsFor(),
    fieldResolver: (src: any, args, ctx, info) => {
      const custom = r[info.parentType.name]?.[info.fieldName];
      return custom ? custom(src, args, ctx, info) : src?.[info.fieldName];
    },
  });

  it('an unreadable memory is null with no errors; the parent and the readable sibling row are intact', async () => {
    const result = await run('{ probeShares { memory { id } } probeMembers { memory { id } } }', ctxFor('stranger'));
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      probeShares: [{ memory: { id: mem.public } }, { memory: null }],
      probeMembers: [{ memory: { id: mem.public } }, { memory: null }],
    });
  });

  it('a Channel row survives an unreadable host memory', async () => {
    const result = await run('{ probeChannels { id name memory { id } } }', ctxFor('stranger'));
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ probeChannels: [{ id: 'a', name: 'a', memory: null }, { id: 'b', name: 'b', memory: null }] });
  });

  it('a loader failure is reported as an error, not silently null', async () => {
    const failing = { ...ctxFor('reader'), db: new Proxy(db, { get: (t, p) => p === 'memory'
      ? { findUnique: () => Promise.reject(new Error('db down')) } : (t as any)[p] }) } as Context;
    const result = await run('{ probeShares { memory { id } } }', failing);
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(result.errors?.[0]?.path?.slice(0, 1)).toEqual(['probeShares']);
  });
});
