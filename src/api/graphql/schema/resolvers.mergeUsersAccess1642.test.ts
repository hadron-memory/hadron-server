/** #1642 / DU-1: platform authority is checked before account lookup or writes. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from './resolvers.helpers.js';
import { orgMutations } from './resolvers.mutation.org.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { mergeUsers } from '../../../controller/operations/mergeUsers.js';

vi.mock('../../../lib/entityRef/userRef.js', () => ({ resolveUserRef: vi.fn() }));
vi.mock('../../../controller/operations/mergeUsers.js', () => ({ mergeUsers: vi.fn() }));

const lookup = vi.mocked(resolveUserRef);
const consolidate = vi.mocked(mergeUsers);
const request = (roles: Context['roles'], userId?: string) => orgMutations.mergeUsers(
  {}, { input: { source: 'source-ref', target: 'target-ref', consentProof: 'mock-proof' } },
  { db: {} as Context['db'], roles, userId },
);

beforeEach(() => {
  vi.clearAllMocks();
  lookup.mockImplementation(async (_db, ref) => ({ id: ref === 'source-ref' ? 'source-id' : 'target-id' } as Awaited<ReturnType<typeof resolveUserRef>>));
  consolidate.mockResolvedValue({ id: 'target-id' } as Awaited<ReturnType<typeof mergeUsers>>);
});

describe('#1642 mergeUsers containment', () => {
  it.each([{ roles: ['READER'] }, { roles: ['CONTRIBUTOR'] }, { roles: [] }] as { roles: Context['roles'] }[])('refuses platform roles $roles before either lookup', async ({ roles }) => {
    await expect(request(roles, 'caller-id')).rejects.toMatchObject({
      message: 'Forbidden', extensions: { code: 'FORBIDDEN' },
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(consolidate).not.toHaveBeenCalled();
  });

  it('refuses unauthenticated callers with the same typed denial', async () => {
    await expect(request(undefined)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(lookup).not.toHaveBeenCalled();
    expect(consolidate).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'OWNER'] as const)('retains shared platform %s authority', async (role) => {
    await expect(request([role], 'platform-admin-id')).resolves.toMatchObject({ id: 'target-id' });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(consolidate).toHaveBeenCalledWith(expect.anything(), {
      sourceUserId: 'source-id', targetUserId: 'target-id',
      actorUserId: 'platform-admin-id', mergeGlobalRoles: true, consentProof: 'mock-proof',
    });
  });
});
