/** #2138 §3.5: Agent.usesTasks (default true) is set on create, changed on update, and read back. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let orgId: string, admin: { id: string }, member: { id: string };
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1e6);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'UT', urn: `ut-${n}.example` } })).id;
  admin = await db.user.create({ data: { id: generateId(), githubId: 2_138_000 + n, githubUsername: `ut-a-${n}`, roles: ['READER'] } });
  member = await db.user.create({ data: { id: generateId(), githubId: 3_138_000 + n, githubUsername: `ut-m-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: member.id, role: 'READER' } });
});

describe('Agent.usesTasks', () => {
  it('defaults to true; create can set false; update flips it both ways and omission preserves it', async () => {
    const plain = await M.createAgent({}, { orgId, name: 'Builder' }, ctx(admin.id));
    expect(plain.usesTasks).toBe(true);
    const coord = await M.createAgent({}, { orgId, name: 'Coordinator', usesTasks: false }, ctx(admin.id));
    expect(coord.usesTasks).toBe(false);
    expect((await M.updateAgent({}, { ref: coord.id, description: 'x' }, ctx(admin.id))).usesTasks).toBe(false);
    expect((await M.updateAgent({}, { ref: coord.id, usesTasks: true }, ctx(admin.id))).usesTasks).toBe(true);
    expect((await M.updateAgent({}, { ref: plain.id, usesTasks: false }, ctx(admin.id))).usesTasks).toBe(false);
    expect((await db.agent.findUniqueOrThrow({ where: { id: plain.id } })).usesTasks).toBe(false);
  });

  it('is changed only by whoever may administer the Agent (a plain org member is refused, nothing changes)', async () => {
    const a = await M.createAgent({}, { orgId, name: 'Builder' }, ctx(admin.id));
    await expect(M.updateAgent({}, { ref: a.id, usesTasks: false }, ctx(member.id))).rejects.toThrow();
    expect((await db.agent.findUniqueOrThrow({ where: { id: a.id } })).usesTasks).toBe(true);
  });
});
