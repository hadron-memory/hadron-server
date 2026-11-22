/** S5 (#4000): secret uses have their own ticket class, separate from outbound communication. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
let ctx: Context;
let orgId: string;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'S5 tickets', urn: `s5-${generateId()}` } });
  const user = await db.user.create({ data: { email: `${generateId()}@s5.test` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  orgId = org.id;
  ctx = { db, userId: user.id, roles: [] };
});
describe('secret.use action tickets (#4000)', () => {
  it('mints its own class and continues to refuse unregistered classes', async () => {
    await expect(resolvers.Mutation.mintActionTickets({}, { input: { orgRef: orgId, action: 'secret.use', count: 2 } }, ctx)).resolves.toBe(2);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, action: 'secret.use' } })).toBe(2);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, action: 'comm.outbound' } })).toBe(0);
    await expect(resolvers.Mutation.mintActionTickets({}, { input: { orgRef: orgId, action: 'secret.other', count: 1 } }, ctx)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});
