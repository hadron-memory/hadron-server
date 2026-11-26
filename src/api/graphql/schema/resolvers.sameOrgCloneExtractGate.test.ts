/**
 * Target-org membership and role gate of cloneMemory and extractParentNodeToMemory (hadron-internal#78): an
 * authenticated, live, non-READER member of the target org on every arm, checked before any URN collision; reusing
 * an org-owned memory's URN also takes memory.create, the authority createMemory's org-shared reuse takes. Composes with the owner rule of #70.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const orgUrn = 'same-org-gate-78';
const M = resolvers.Mutation as any;
const as = (userId: string, roles: string[] = ['READER']): Context => ({ db, userId, roles }) as Context;

let orgId: string;
const user: Record<string, string> = {};
const src: Record<string, { mem: string; parent: string }> = {};

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return { message: e.message, code: e.extensions?.code };
  }
  throw new Error('expected a refusal');
};

async function orgTombstone() {
  const id = generateId();
  await db.memory.create({
    data: { id, name: 'Shared', urn: `${orgUrn}:shared`, organizationId: orgId, class: 'knowledge', deletedAt: new Date() },
  });
  await db.node.create({ data: { id: generateId(), memoryId: id, loc: 'entry', name: 'Entry', content: 'kept' } });
  return id;
}
const survives = async (id: string) => ({
  memory: await db.memory.count({ where: { id } }),
  nodes: await db.node.count({ where: { memoryId: id } }),
});
const liveAtTarget = () => db.memory.count({ where: { urn: `${orgUrn}:shared`, deletedAt: null } });

const clone = (who: string) =>
  M.cloneMemory({}, { ref: src[who]!.mem, targetUrn: `hrn:mem:${orgUrn}:shared` }, as(user[who]!));
const extract = (who: string) =>
  M.extractParentNodeToMemory({}, { parentRef: src[who]!.parent, targetUrn: `hrn:mem:${orgUrn}:shared` }, as(user[who]!));

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: orgUrn, urn: orgUrn } });
  orgId = org.id;
  const people: Array<[string, string, boolean]> = [
    ['reader', 'READER', true],
    ['contributor', 'CONTRIBUTOR', true],
    ['removed', 'CONTRIBUTOR', false],
    ['admin', 'ADMIN', true],
    ['outsider', 'ADMIN', false],
  ];
  let n = 0;
  for (const [key, role, live] of people) {
    n += 1;
    const id = (await db.user.create({ data: { id: generateId(), githubId: 78000 + n, githubUsername: `${key}78`, handle: `${key}78`, roles: key === 'outsider' ? ['ADMIN'] : ['READER'] } })).id;
    user[key] = id;
    if (key !== 'outsider') {
      await db.orgMember.create({ data: { organizationId: orgId, userId: id, role: role as any, ...(live ? {} : { deletedAt: new Date() }) } });
    }
    // Each caller's OWN personal source in the org: readable by them, so the source gate alone passes.
    const mem = generateId();
    await db.memory.create({ data: { id: mem, name: `own ${key}`, urn: `${orgUrn}:own-${key}`, organizationId: orgId, class: 'personal', userId: id } });
    const parent = generateId();
    await db.node.create({ data: { id: parent, memoryId: mem, loc: 'sec', name: 'Sec', content: 'x' } });
    await db.node.create({ data: { id: generateId(), memoryId: mem, loc: 'sec:child', name: 'Child', content: 'y' } });
    src[key] = { mem, parent };
  }
});

describe('same-org clone and extract require a live non-reader membership (hadron-internal#78)', () => {
  for (const who of ['reader', 'removed'] as const) {
    it(`cloneMemory: a ${who} member is refused and the soft-deleted org memory survives`, async () => {
      const id = await orgTombstone();
      expect((await refusal(clone(who))).code).toBe('FORBIDDEN');
      expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
    });
    it(`cloneMemory: a ${who} member cannot create a memory in the org either`, async () => {
      expect((await refusal(clone(who))).code).toBe('FORBIDDEN');
      expect(await liveAtTarget()).toBe(0);
    });
  }

  it('extractParentNodeToMemory: a reader is refused and the soft-deleted org memory survives', async () => {
    const id = await orgTombstone();
    expect((await refusal(extract('reader'))).code).toBe('FORBIDDEN');
    expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
    expect(await liveAtTarget()).toBe(0);
  });
  it('extractParentNodeToMemory: a removed member is refused and the memory survives', async () => {
    const id = await orgTombstone();
    expect((await refusal(extract('removed'))).code).toBe('FORBIDDEN');
    expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
  });
  it('a caller with no identity is refused before the target is touched', async () => {
    const id = await orgTombstone();
    const r = await refusal(M.cloneMemory({}, { ref: src.contributor!.mem, targetUrn: `hrn:mem:${orgUrn}:shared` }, { db, userId: undefined, roles: ['ADMIN'] } as unknown as Context));
    expect(r.message).toBe('Unauthenticated'); // the door's identity check (hadron-internal#77) answers first
    expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
  });

  for (const [name, door] of [['cloneMemory', clone], ['extractParentNodeToMemory', extract]] as const) {
    it(`${name}: a CONTRIBUTOR is refused reuse of a soft-deleted org-owned memory (memory.create, as createMemory)`, async () => {
      const id = await orgTombstone();
      expect((await refusal(door('contributor'))).code).toBe('FORBIDDEN');
      expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
      expect(await liveAtTarget()).toBe(0);
    });
  }
  it('extractParentNodeToMemory: a caller with no user is refused', async () => {
    const id = await orgTombstone();
    const r = await refusal(M.extractParentNodeToMemory({}, { parentRef: src.contributor!.parent, targetUrn: `hrn:mem:${orgUrn}:shared` }, { db, userId: undefined, roles: ['ADMIN'] } as unknown as Context));
    expect(r.message).toBe('Unauthenticated'); // the door's identity check (hadron-internal#77) answers first
    expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
  });
  it('a platform ADMIN with no membership in the org is refused on both arms (no global-role bypass)', async () => {
    const id = await orgTombstone();
    const c = await refusal(clone('outsider'));
    expect(c.code).toBe('FORBIDDEN');
    expect(c.message).toMatch(/non-reader membership/);
    const e = await refusal(extract('outsider'));
    expect(e.code).toBe('FORBIDDEN');
    expect(e.message).toMatch(/non-reader membership/);
    expect(await survives(id)).toEqual({ memory: 1, nodes: 1 });
  });
  it('extractParentNodeToMemory: the refusal to a READER names the non-reader requirement', async () => {
    const e = await refusal(extract('reader'));
    expect(e.message).toMatch(/non-reader/);
  });

  describe('controls', () => {
    it('a contributing member clones into the same org (no collision)', async () => {
      await clone('contributor');
      expect(await liveAtTarget()).toBe(1);
    });
    it('a contributing member extracts into the same org (no collision)', async () => {
      await extract('contributor');
      expect(await liveAtTarget()).toBe(1);
    });
    it('an ADMIN member reuses a soft-deleted org-shared memory through clone', async () => {
      const a = await orgTombstone();
      await clone('admin');
      expect(await survives(a)).toEqual({ memory: 0, nodes: 0 });
      expect(await liveAtTarget()).toBe(1);
    });
    it('an ADMIN member reuses a soft-deleted org-shared memory through extract', async () => {
      const a = await orgTombstone();
      await extract('admin');
      expect(await survives(a)).toEqual({ memory: 0, nodes: 0 });
      expect(await liveAtTarget()).toBe(1);
    });
  });
});
