/**
 * #2868 — a handle held by a User whose `principal_id` is NULL (never minted
 * into the #692 pool) must refuse `updateMyProfile` with the same typed
 * BAD_USER_INPUT a registered owner yields, not a masked INTERNAL_SERVER_ERROR
 * from the `users_handle_lower_uniq` unique violation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { mintPrincipal } from '../../../lib/principal/mintPrincipal.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let actorId: string;
const ctx = (): Context => ({ db, userId: actorId, roles: ['READER'] });

async function snapshot() {
  const u = await db.user.findUniqueOrThrow({ where: { id: actorId } });
  const principals = await db.principal.findMany({ orderBy: { id: 'asc' } });
  return { handle: u.handle, principalId: u.principalId, principals };
}

async function refusal(handle: string) {
  try {
    await resolvers.Mutation.updateMyProfile({}, { handle }, ctx());
  } catch (e: any) {
    return e;
  }
  throw new Error('expected a refusal');
}

beforeEach(async () => {
  await cleanDb(db);
  const actor = await db.user.create({
    data: { id: generateId(), name: 'Actor', handle: 'actor-handle', roles: ['READER'] },
  });
  actorId = actor.id;
});

describe('#2868 updateMyProfile handle collision', () => {
  it('unregistered owner (principal_id NULL): typed BAD_USER_INPUT', async () => {
    await db.user.create({ data: { id: generateId(), name: 'Other', handle: 'taken-handle', roles: ['READER'] } });
    const e = await refusal('taken-handle');
    expect(e.extensions.code).toBe('BAD_USER_INPUT');
    expect(e.message).toBe('The name "taken-handle" is already taken.');
  });

  it('case-normalized collision with an unregistered owner is typed', async () => {
    await db.user.create({ data: { id: generateId(), name: 'Other', handle: 'taken-handle', roles: ['READER'] } });
    const e = await refusal('Taken-Handle');
    expect(e.extensions.code).toBe('BAD_USER_INPUT');
  });

  it('refusal changes no state (handle, principal, pool)', async () => {
    await db.user.create({ data: { id: generateId(), name: 'Other', handle: 'taken-handle', roles: ['READER'] } });
    const before = await snapshot();
    await refusal('taken-handle');
    expect(await snapshot()).toEqual(before);
  });

  it('control: registered owner yields the identical typed refusal', async () => {
    const owner = await db.user.create({ data: { id: generateId(), name: 'Other', handle: 'taken-handle', roles: ['READER'] } });
    const p = await mintPrincipal(db, { kind: 'user', name: 'taken-handle' });
    await db.user.update({ where: { id: owner.id }, data: { principalId: p.id } });
    const e = await refusal('taken-handle');
    expect(e.extensions.code).toBe('BAD_USER_INPUT');
    expect(e.message).toBe('The name "taken-handle" is already taken.');
  });

  it('controls: unused handle renames; own handle (case change) is not a collision', async () => {
    const r = await resolvers.Mutation.updateMyProfile({}, { handle: 'free-handle' }, ctx());
    expect(r.handle).toBe('free-handle');
    const r2 = await resolvers.Mutation.updateMyProfile({}, { handle: 'Free-Handle' }, ctx());
    expect(r2.handle).toBe('free-handle');
  });
});
