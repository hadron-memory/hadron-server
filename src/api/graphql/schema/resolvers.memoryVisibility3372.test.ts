/** #3372 / ruling0207: visibility is class-driven; refuse after access, before writes. */
import { beforeEach, describe, expect, it } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

type MemoryClass = 'system' | 'app' | 'personal' | 'private' | 'knowledge' | 'group';
const M = resolvers.Mutation as any;
const noVisibility = ['system', 'app', 'personal', 'private'] as const;
const allClasses: MemoryClass[] = [...noVisibility, 'knowledge', 'group'];
let orgId: string, ownerId: string, outsiderId: string, readerId: string, appId: string;
const ctx = (userId = ownerId): Context => ({ db, userId, roles: [] });

async function memory(memoryClass: MemoryClass, appScoped = false) {
  return db.memory.create({ data: {
    organizationId: orgId,
    name: `original-${memoryClass}`,
    urn: `visibility3372.example:${memoryClass}${appScoped ? '-scoped' : ''}`,
    class: memoryClass,
    visibility: memoryClass === 'knowledge' ? 'ORGANIZATION' : memoryClass === 'group' ? 'GROUP' : null,
    ...(['personal', 'private'].includes(memoryClass) ? { userId: ownerId } : {}),
    ...(memoryClass === 'app' || appScoped ? { appId } : {}),
  } });
}

async function snapshot(id: string) {
  return {
    row: await db.memory.findUniqueOrThrow({ where: { id } }),
    aliases: await db.urnAlias.findMany({ orderBy: { id: 'asc' } }),
    links: await db.agentMemoryItem.findMany({ orderBy: { id: 'asc' } }),
    grants: await db.appMemoryWriteGrant.findMany({ orderBy: { id: 'asc' } }),
    events: await db.agentTeamEvent.count(),
    revisions: await db.nodeRevision.count(),
  };
}

async function errorOf(args: Record<string, unknown>, caller = ctx()) {
  try {
    await M.updateMemory({}, args, caller);
  } catch (error) {
    return error;
  }
  throw new Error('Expected updateMemory to refuse');
}

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { name: 'Visibility', urn: 'visibility3372.example' } })).id;
  [ownerId, outsiderId, readerId] = await Promise.all(['owner', 'outsider', 'reader'].map(async handle =>
    (await db.user.create({ data: { handle: `visibility3372-${handle}` } })).id));
  await db.orgMember.createMany({ data: [
    { organizationId: orgId, userId: ownerId, role: 'OWNER' },
    { organizationId: orgId, userId: readerId, role: 'READER' },
  ] });
  appId = (await db.app.create({ data: { name: 'Visibility App', urn: 'visibility3372.example:app', organizationId: orgId } })).id;
});

describe('#3372 missing visibility refusal cells', () => {
  it.each(noVisibility.flatMap(memoryClass => ['PUBLIC', 'ORGANIZATION'].map(visibility => ({ memoryClass, visibility }))))(
    '$memoryClass refuses $visibility with its class and BAD_USER_INPUT, before any partial write',
    async ({ memoryClass, visibility }) => {
      const row = await memory(memoryClass);
      const before = await snapshot(row.id);
      const error = await errorOf({ id: row.id, visibility, name: 'must-not-write', urn: 'must-not-rename' });
      expect(error).toBeInstanceOf(GraphQLError);
      expect((error as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
      expect((error as Error).message).toContain(memoryClass);
      expect(await snapshot(row.id)).toEqual(before);
    },
  );

  it.each([false, true])('knowledge refuses explicit null (appScoped=%s), with no partial write', async appScoped => {
    const row = await memory('knowledge', appScoped);
    const before = await snapshot(row.id);
    const error = await errorOf({ id: row.id, visibility: null, name: 'must-not-write', urn: 'must-not-rename' });
    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
    expect((error as Error).message).toContain('knowledge');
    expect(await snapshot(row.id)).toEqual(before);
  });
});

describe('#3372 controls and access precedence', () => {
  it.each(noVisibility)('%s still accepts explicit null', async memoryClass => {
    const row = await memory(memoryClass);
    const result = await M.updateMemory({}, { id: row.id, visibility: null, name: 'allowed' }, ctx());
    expect(result).toMatchObject({ visibility: null, name: 'allowed' });
  });

  it.each(allClasses)('%s omitted visibility preserves its value', async memoryClass => {
    const row = await memory(memoryClass);
    const result = await M.updateMemory({}, { id: row.id, name: 'allowed' }, ctx());
    expect(result).toMatchObject({ visibility: row.visibility, name: 'allowed' });
  });

  it.each([false, true])('knowledge PUBLIC/ORGANIZATION transitions still work (appScoped=%s)', async appScoped => {
    const row = await memory('knowledge', appScoped);
    for (const visibility of ['PUBLIC', 'ORGANIZATION']) {
      expect(await M.updateMemory({}, { id: row.id, visibility }, ctx())).toMatchObject({ visibility });
    }
  });

  it.each([null, 'PUBLIC', 'ORGANIZATION'])('group/%s keeps its existing refusal code', async visibility => {
    const row = await memory('group');
    const before = await snapshot(row.id);
    const error = await errorOf({ id: row.id, visibility });
    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).extensions.code).toBe('INVALID_GROUP_MEMORY_VISIBILITY');
    expect(await snapshot(row.id)).toEqual(before);
  });

  it('knowledge/GROUP and a restated group/GROUP keep their existing behavior', async () => {
    const knowledge = await memory('knowledge');
    const error = await errorOf({ id: knowledge.id, visibility: 'GROUP' });
    expect((error as GraphQLError).extensions.code).toBe('INVALID_GROUP_MEMORY_VISIBILITY');
    const group = await memory('group');
    expect(await M.updateMemory({}, { id: group.id, visibility: 'GROUP' }, ctx())).toMatchObject({ visibility: 'GROUP' });
  });

  it.each(['private', 'knowledge'] as const)('unreadable %s gives the same concealed error before invalid input', async memoryClass => {
    const row = await memory(memoryClass);
    const caller = ctx(outsiderId);
    const before = await snapshot(row.id);
    const omitted = await errorOf({ id: row.id }, caller) as GraphQLError;
    const invalid = await errorOf({ id: row.id, visibility: memoryClass === 'knowledge' ? null : 'PUBLIC' }, caller) as GraphQLError;
    // The resolver throws the typed entity error; GraphQL maps its code on the wire.
    expect(omitted).toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(invalid).toMatchObject({ code: 'MEMORY_NOT_FOUND', message: omitted.message });
    expect(await snapshot(row.id)).toEqual(before);
  });

  it('a reader without manage access gets the same denial before knowledge/null', async () => {
    const row = await memory('knowledge');
    const caller = ctx(readerId);
    const omitted = await errorOf({ id: row.id }, caller) as GraphQLError;
    const invalid = await errorOf({ id: row.id, visibility: null }, caller) as GraphQLError;
    expect(omitted.extensions.code).toBe('FORBIDDEN');
    expect({ message: invalid.message, extensions: invalid.extensions }).toEqual({ message: omitted.message, extensions: omitted.extensions });
  });

  it.each(['personal', 'private'].flatMap(memoryClass => ['PUBLIC', 'ORGANIZATION'].map(visibility => ({ memoryClass, visibility }))))(
    'createMemory still coerces $memoryClass/$visibility to null', async ({ memoryClass, visibility }) => {
      const result = await M.createMemory({}, { orgId, name: `created-${memoryClass}-${visibility}`, memoryClass, visibility }, ctx());
      expect(result).toMatchObject({ class: memoryClass, visibility: null, userId: ownerId });
    },
  );
});
