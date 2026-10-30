/**
 * #2819: a memory create/clone/extract onto a URN a live memory already holds
 * is a typed CONFLICT, not INTERNAL_SERVER_ERROR (cor:api:260:01 masks a plain
 * Error). The refusal is the same whoever holds the URN: no holder fields.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const orgUrn = 'conflict-2819';
let orgId: string;
let userId: string;
let otherId: string;

const ctx = (): Context => ({ db, userId, roles: ['ADMIN'] });
const M = resolvers.Mutation as any;

/** The refusal exactly as a client would see it: code, message, extensions. */
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return { name: e.name, message: e.message, extensions: e.extensions };
  }
  throw new Error('expected a refusal');
};

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: orgUrn, urn: orgUrn } });
  orgId = org.id;
  const user = await db.user.create({
    data: { id: generateId(), githubId: 28191, githubUsername: 'c-admin', handle: 'cadmin', roles: ['ADMIN'] },
  });
  userId = user.id;
  const other = await db.user.create({
    data: { id: generateId(), githubId: 28192, githubUsername: 'c-other', handle: 'cother', roles: ['READER'] },
  });
  otherId = other.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: otherId, role: 'CONTRIBUTOR' } });
});

describe('already-existing memory URN is CONFLICT (#2819)', () => {
  it('a. createMemory twice in an org: CONFLICT with the unchanged message', async () => {
    await M.createMemory({}, { orgId, name: 'Probe Yed', vectorIndexEnabled: false }, ctx());
    const r = await refusal(M.createMemory({}, { orgId, name: 'Probe Yed', vectorIndexEnabled: false }, ctx()));
    expect(r.extensions?.code).toBe('CONFLICT');
    expect(r.message).toBe(`A memory with URN "${orgUrn}:probe-yed" already exists`);
  });

  it('b. createMemory twice user-owned: CONFLICT', async () => {
    const args = { name: 'Mine', memoryClass: 'private' };
    await M.createMemory({}, args, ctx());
    const r = await refusal(M.createMemory({}, args, ctx()));
    expect(r.extensions?.code).toBe('CONFLICT');
    expect(r.message).toBe('A memory with URN "cadmin:mine" already exists');
  });

  it('c1. cloneMemory onto an existing memory URN: CONFLICT', async () => {
    const src = await M.createMemory({}, { orgId, name: 'src', vectorIndexEnabled: false }, ctx());
    await M.createMemory({}, { orgId, name: 'taken', vectorIndexEnabled: false }, ctx());
    const r = await refusal(M.cloneMemory({}, { ref: src.id, targetUrn: `hrn:mem:${orgUrn}:taken` }, ctx()));
    expect(r.extensions?.code).toBe('CONFLICT');
  });

  it('c2. extractParentNodeToMemory onto an existing memory URN: CONFLICT', async () => {
    const src = await M.createMemory({}, { orgId, name: 'esrc', vectorIndexEnabled: false }, ctx());
    const parent = await db.node.create({
      data: { id: generateId(), memoryId: src.id, loc: 'sec', name: 'Sec', content: 'x' },
    });
    await db.node.create({
      data: { id: generateId(), memoryId: src.id, loc: 'sec:child', name: 'Child', content: 'y' },
    });
    await M.createMemory({}, { orgId, name: 'etaken', vectorIndexEnabled: false }, ctx());
    const r = await refusal(
      M.extractParentNodeToMemory({}, { parentRef: parent.id, targetUrn: `hrn:mem:${orgUrn}:etaken` }, ctx()),
    );
    expect(r.extensions?.code).toBe('CONFLICT');
  });

  it('d. oracle: the response is identical for a holder the caller can see and one they cannot', async () => {
    // The caller is a plain org member; one holder is theirs (visible), the
    // other a group memory they hold no membership in (not visible).
    const asOther = (): Context => ({ db, userId: otherId, roles: ['READER'] });
    await M.createMemory({}, { orgId, name: 'visible', vectorIndexEnabled: false }, asOther());
    await db.memory.create({
      data: {
        id: generateId(), name: 'hidden', urn: `${orgUrn}:hidden`, organizationId: orgId, class: 'group',
      },
    });
    const attempt = (name: string) => M.createMemory({}, { orgId, name, vectorIndexEnabled: false }, asOther());
    const v = await refusal(attempt('visible'));
    const h = await refusal(attempt('hidden'));
    expect(v.extensions?.code).toBe('CONFLICT');
    expect(h.extensions).toEqual(v.extensions);
    expect(Object.keys(h.extensions ?? {}).sort()).toEqual(['code']);
    expect(h.message.replace('hidden', 'X')).toBe(v.message.replace('visible', 'X'));
  });

  it('e. a soft-deleted memory at the URN is still reclaimed', async () => {
    const first = await M.createMemory({}, { orgId, name: 'gone', vectorIndexEnabled: false }, ctx());
    await db.memory.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    const again = await M.createMemory({}, { orgId, name: 'gone', vectorIndexEnabled: false }, ctx());
    expect(again.urn).toBe(`${orgUrn}:gone`);
  });
});
