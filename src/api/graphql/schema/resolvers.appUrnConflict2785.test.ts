/**
 * #2785: createApp onto a URN a live App already holds is a typed CONFLICT, not
 * INTERNAL_SERVER_ERROR (cor:api:260:01 masks a plain Error), the same answer
 * #2819 gave createMemory. The refusal is the same whoever holds the URN: no
 * holder fields. A tombstoned App URN is still reclaimed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const orgUrn = 'conflict-2785';
let orgId: string;
let agentId: string;
let userId: string;

const ctx = (): Context => ({ db, userId, roles: ['ADMIN'] });
const create = (name: string) => M.createApp({}, { orgRef: orgId, agentRef: agentId, name }, ctx());

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return { message: e.message, extensions: e.extensions };
  }
  throw new Error('expected a refusal');
};

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: orgUrn, urn: orgUrn } })).id;
  userId = (await db.user.create({ data: { id: generateId(), githubId: 27851, githubUsername: 'a-admin', handle: 'aadmin', roles: ['ADMIN'] } })).id;
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId, role: 'ADMIN' } });
  agentId = (await db.agent.create({
    data: { id: generateId(), organizationId: orgId, urn: `${orgUrn}:helper`, name: 'Helper', visibility: 'ORGANIZATION' },
  })).id;
});

describe('already-existing App URN is CONFLICT (#2785)', () => {
  it('a. createApp onto a live App URN: CONFLICT naming only the URN, nothing created or changed', async () => {
    const first = await create('Probe');
    const before = await db.app.count();
    const row = await db.app.findUniqueOrThrow({ where: { id: first.id } });
    const r = await refusal(create('Probe'));
    expect(r.extensions?.code).toBe('CONFLICT');
    expect(r.message).toBe(`An app with URN "${first.urn}" already exists`);
    expect(await db.app.count()).toBe(before);
    expect(await db.app.findUniqueOrThrow({ where: { id: first.id } })).toEqual(row);
  });

  it('b. oracle: identical answer whether or not the caller can see the holder, no holder fields', async () => {
    const visible = await create('Visible');
    // The hidden holder has no members at all; the visible one was created by the caller.
    const hidden = await db.app.create({
      data: { id: generateId(), name: 'Hidden', urn: `${orgUrn}:hidden`, organization: { connect: { id: orgId } } },
    });
    const v = await refusal(create('Visible'));
    const h = await refusal(create('Hidden'));
    expect(h.extensions).toEqual(v.extensions);
    expect(Object.keys(h.extensions ?? {}).sort()).toEqual(['code']);
    expect(h.message.replace(hidden.urn, 'X')).toBe(v.message.replace(visible.urn, 'X'));
  });

  it('c. control: a soft-deleted App at the URN is still reclaimed', async () => {
    const first = await create('Gone');
    await db.app.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    const again = await create('Gone');
    expect(again.urn).toBe(first.urn);
  });
});
