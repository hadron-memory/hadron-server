/**
 * URN reuse after a soft delete (createMemory, cloneMemory, extractParentNodeToMemory; hadron-internal#70).
 * A personal/private memory's URN is reused by its owner (cor:dmo:010:04, cor:acl:010:02); any other caller gets
 * the answer a live holder of the URN gets (CONFLICT, the same message). Org-shared memories keep the doors' gates.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const orgUrn = 'urn-reuse-70';
let orgId: string;
let aliceId: string;
let bobId: string;
let adminId: string;
let sourceId: string;
let sourceParentId: string;

const M = resolvers.Mutation as any;
const as = (userId: string, roles: string[] = ['READER']): Context => ({ db, userId, roles }) as Context;

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return { message: e.message, extensions: e.extensions };
  }
  throw new Error('expected a refusal');
};

/** A soft-deleted memory at `<org>:diary` with one node, owned by `userId` (or the org for shared classes). */
async function tombstone(cls: 'personal' | 'private' | 'knowledge', userId: string | null) {
  const id = generateId();
  await db.memory.create({
    data: {
      id, name: 'Diary', urn: `${orgUrn}:diary`, organizationId: orgId, class: cls,
      ...(cls === 'knowledge' ? { appId: null } : { userId }),
      deletedAt: new Date(),
    },
  });
  await db.node.create({ data: { id: generateId(), memoryId: id, loc: 'entry', name: 'Entry', content: 'secret' } });
  return id;
}
const survives = async (id: string) => ({
  memory: await db.memory.count({ where: { id } }),
  nodes: await db.node.count({ where: { memoryId: id } }),
});

const doors: Array<[string, (c: Context) => Promise<unknown>]> = [
  ['createMemory (personal)', (c) => M.createMemory({}, { orgRef: orgId, name: 'Diary', memoryClass: 'personal', vectorIndexEnabled: false }, c)],
  ['createMemory (private)', (c) => M.createMemory({}, { orgRef: orgId, name: 'Diary', memoryClass: 'private', vectorIndexEnabled: false }, c)],
  ['cloneMemory', (c) => M.cloneMemory({}, { ref: sourceId, targetUrn: `hrn:mem:${orgUrn}:diary` }, c)],
  ['extractParentNodeToMemory', (c) => M.extractParentNodeToMemory({}, { parentRef: sourceParentId, targetUrn: `hrn:mem:${orgUrn}:diary` }, c)],
];

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: orgUrn, urn: orgUrn } });
  orgId = org.id;
  const mk = async (n: number, handle: string, roles: any[]) =>
    (await db.user.create({ data: { id: generateId(), githubId: 70000 + n, githubUsername: handle, handle, roles } })).id;
  aliceId = await mk(1, 'alice70', ['READER']);
  bobId = await mk(2, 'bob70', ['READER']);
  adminId = await mk(3, 'admin70', ['ADMIN']);
  for (const [u, role] of [[aliceId, 'CONTRIBUTOR'], [bobId, 'CONTRIBUTOR'], [adminId, 'ADMIN']] as const) {
    await db.orgMember.create({ data: { organizationId: orgId, userId: u, role } });
  }
  // A readable source (org knowledge memory) for the clone and extract doors.
  sourceId = generateId();
  await db.memory.create({ data: { id: sourceId, name: 'src', urn: `${orgUrn}:src`, organizationId: orgId, class: 'knowledge' } });
  sourceParentId = generateId();
  await db.node.create({ data: { id: sourceParentId, memoryId: sourceId, loc: 'sec', name: 'Sec', content: 'x' } });
  await db.node.create({ data: { id: generateId(), memoryId: sourceId, loc: 'sec:child', name: 'Child', content: 'y' } });
});

describe('URN reuse after a soft delete: personal/private memories (hadron-internal#70)', () => {
  for (const cls of ['personal', 'private'] as const) {
    for (const [door, call] of doors) {
      it(`${door}: a caller other than the owner gets the live-holder answer (tombstone class ${cls})`, async () => {
        const id = await tombstone(cls, aliceId);
        const r = await refusal(call(as(bobId, ['ADMIN'])));
        expect(r.extensions?.code).toBe('CONFLICT');
        expect(r.message).toBe(`A memory with URN "${orgUrn}:diary" already exists`);
        expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
      });
    }
  }

  it('the refusal is identical to the one for a LIVE holder of the same URN', async () => {
    const id = await tombstone('personal', aliceId);
    const foreign = await refusal(doors[0]![1](as(bobId)));
    await db.memory.update({ where: { id }, data: { deletedAt: null } });
    const live = await refusal(doors[0]![1](as(bobId)));
    expect(foreign).toEqual(live);
  });

  it('a caller with no user (not the owner) cannot reclaim through clone either', async () => {
    const id = await tombstone('private', aliceId);
    const r = await refusal(doors[2]![1]({ db, userId: undefined, roles: ['ADMIN'] } as unknown as Context));
    expect(r.extensions?.code).toBe('CONFLICT');
    expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
  });

  describe('controls', () => {
    it('the owner reclaims their own personal tombstone through createMemory', async () => {
      const id = await tombstone('personal', aliceId);
      const again = await doors[0]![1](as(aliceId));
      expect((again as any).urn).toBe(`${orgUrn}:diary`);
      expect(await survives(id)).toEqual({ memory: 0, nodes: 0 });
    });

    it('the owner reclaims their own private tombstone through cloneMemory', async () => {
      const id = await tombstone('private', aliceId);
      await doors[2]![1](as(aliceId, ['ADMIN']));
      expect(await db.memory.count({ where: { id } })).toBe(0);
    });

    it('the owner reclaims their own tombstone through extractParentNodeToMemory', async () => {
      const id = await tombstone('personal', aliceId);
      await doors[3]![1](as(aliceId, ['ADMIN']));
      expect(await db.memory.count({ where: { id } })).toBe(0);
    });

    it('an org-shared (knowledge) tombstone is still reclaimed by an org admin at every door', async () => {
      for (const [door, call] of [doors[0]!, doors[2]!, doors[3]!]) {
        const id = await tombstone('knowledge', null);
        const args = door.startsWith('createMemory')
          ? (c: Context) => M.createMemory({}, { orgRef: orgId, name: 'Diary', vectorIndexEnabled: false }, c)
          : call;
        await args(as(adminId, ['ADMIN']));
        expect(await db.memory.count({ where: { id } }), door).toBe(0);
        await db.memory.deleteMany({ where: { urn: `${orgUrn}:diary` } });
      }
    });
  });
});
