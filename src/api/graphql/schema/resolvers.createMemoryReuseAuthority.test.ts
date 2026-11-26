/**
 * createMemory's org-anchored personal/private arm, reusing the URN of a soft-deleted org-owned memory
 * (hadron-server-private#47, the class rule of hadron-internal#78): reusing an org-owned memory's URN takes
 * memory.create in that org, the authority createMemory's org-shared arm already takes. A caller's own
 * personal tombstone stays reusable by them alone (hadron-internal#70).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const orgUrn = 'create-reuse-47';
const M = resolvers.Mutation as any;
const as = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let orgId: string;
const user: Record<string, string> = {};

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return { message: e.message, code: e.extensions?.code };
  }
  throw new Error('expected a refusal');
};

async function tombstone(data: { class: 'knowledge' | 'personal'; userId?: string }) {
  const id = generateId();
  await db.memory.create({
    data: { id, name: 'Shared', urn: `${orgUrn}:shared`, organizationId: orgId, deletedAt: new Date(), ...data },
  });
  await db.node.create({ data: { id: generateId(), memoryId: id, loc: 'entry', name: 'Entry', content: 'kept' } });
  return id;
}
const survives = async (id: string) => ({
  memory: await db.memory.count({ where: { id } }),
  nodes: await db.node.count({ where: { memoryId: id } }),
});
const liveAtTarget = () => db.memory.count({ where: { urn: `${orgUrn}:shared`, deletedAt: null } });
const create = (who: string, memoryClass: 'personal' | 'private') =>
  M.createMemory({}, { orgRef: orgId, name: 'Shared', slug: 'shared', memoryClass, vectorIndexEnabled: false }, as(user[who]!));

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: orgUrn, urn: orgUrn } })).id;
  let n = 0;
  for (const [key, role] of [['reader', 'READER'], ['contributor', 'CONTRIBUTOR'], ['admin', 'ADMIN']] as const) {
    n += 1;
    const id = (await db.user.create({ data: { id: generateId(), githubId: 47000 + n, githubUsername: `${key}47`, handle: `${key}47`, roles: ['READER'] } })).id;
    user[key] = id;
    await db.orgMember.create({ data: { organizationId: orgId, userId: id, role } });
  }
});

describe('createMemory personal/private arm: reusing an org-owned URN takes memory.create (hadron-server-private#47)', () => {
  for (const who of ['reader', 'contributor'] as const) {
    for (const cls of ['personal', 'private'] as const) {
      it(`a ${who} creating a ${cls} memory is refused and the soft-deleted org memory survives`, async () => {
        const id = await tombstone({ class: 'knowledge' });
        expect((await refusal(create(who, cls))).code).toBe('FORBIDDEN');
        expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
        expect(await liveAtTarget()).toBe(0);
      });
    }
  }

  describe('controls', () => {
    it('an ADMIN member reuses a soft-deleted org-owned memory for a personal memory', async () => {
      const id = await tombstone({ class: 'knowledge' });
      await create('admin', 'personal');
      expect(await survives(id)).toEqual({ memory: 0, nodes: 0 });
      expect(await liveAtTarget()).toBe(1);
    });
    it('a reader reuses their OWN soft-deleted personal memory (no memory.create needed)', async () => {
      const id = await tombstone({ class: 'personal', userId: user.reader! });
      await create('reader', 'personal');
      expect(await survives(id)).toEqual({ memory: 0, nodes: 0 });
      expect(await liveAtTarget()).toBe(1);
    });
    it('a user-owned create (no org) reuses a soft-deleted memory the caller owns in their own namespace', async () => {
      const id = generateId();
      await db.memory.create({ data: { id, name: 'Mine', urn: 'reader47:mine', ownerUserId: user.reader!, class: 'knowledge', deletedAt: new Date() } });
      await M.createMemory({}, { name: 'Mine', slug: 'mine', memoryClass: 'personal', vectorIndexEnabled: false }, as(user.reader!));
      expect(await survives(id)).toEqual({ memory: 0, nodes: 0 });
      expect(await db.memory.count({ where: { urn: 'reader47:mine', deletedAt: null } })).toBe(1);
    });
    it('a reader creates a personal memory where nothing holds the URN', async () => {
      await create('reader', 'personal');
      expect(await liveAtTarget()).toBe(1);
    });
  });
});
