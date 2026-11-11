/**
 * #3705: a userless, App-less context gets no retired operator privileges.
 * #3924: every pin runs over BOTH ways a context can lack a user. Ordinary
 * `Context` represents a missing user as `undefined` (`userId?: string`); the
 * retired P9 factory cast a literal `userId: null`. A gate that tests
 * `ctx.userId === undefined` instead of `!ctx.userId` would pass the first shape
 * and admit the second, so both are pinned.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { assertMayWriteBootPromptPointer } from '../../../lib/bootPromptPointer.js';
import { getAccessibleMemoryIds, requireMemoryWriteAccess, type Context } from './resolvers.helpers.js';

/**
 * The retired factory's clientId is kept on purpose: it proves the string itself
 * confers nothing now that the waivers keyed on it are gone. A context carrying
 * it must be treated as any other userless, App-less caller.
 */
const RETIRED_CLIENT_ID = 'operator:boot-prompt-conversion:P9';

const shapes: ReadonlyArray<[string, () => Context]> = [
  ['userId undefined (ordinary Context)', () => ({ db, roles: [], clientId: RETIRED_CLIENT_ID })],
  // Test-only: `Context.userId` is `string | undefined`, so the retired null shape
  // needs a cast. scripts/check-null-context.mjs refuses this cast in production code.
  ['userId null (retired factory shape)', () => ({ db, roles: [], clientId: RETIRED_CLIENT_ID, userId: null } as unknown as Context)],
];

let systemMemoryId: string;
let publicId: string;
beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({ data: { id: generateId(), handle: 'retire3705' } });
  const org = await db.organization.create({ data: { id: generateId(), urn: 'retire3705-org', name: 'Retire Org' } });
  const app = await db.app.create({ data: {
    id: generateId(), urn: 'hrn:app:retire3705:app', name: 'Retire App', organizationId: org.id,
  } });
  systemMemoryId = (await db.memory.create({ data: {
    id: generateId(), urn: 'retire3705:system', name: 'System', class: 'system', ownerUserId: user.id,
  } })).id;
  // The one row a userless, App-less caller may read: PUBLIC, App-less, not user-owned (org-owned), live.
  publicId = (await db.memory.create({ data: {
    id: generateId(), urn: 'retire3705:public', name: 'Public', class: 'knowledge', visibility: 'PUBLIC', organizationId: org.id,
  } })).id;
  // PUBLIC rows outside that bound: user-owned, App-scoped, and soft-deleted.
  await db.memory.create({ data: {
    id: generateId(), urn: 'retire3705:public-owned', name: 'Owned', class: 'knowledge', visibility: 'PUBLIC', ownerUserId: user.id,
  } });
  await db.memory.create({ data: {
    id: generateId(), urn: 'retire3705:public-app', name: 'App', class: 'knowledge', visibility: 'PUBLIC', organizationId: org.id, appId: app.id,
  } });
  await db.memory.create({ data: {
    id: generateId(), urn: 'retire3705:public-deleted', name: 'Deleted', class: 'knowledge', visibility: 'PUBLIC', organizationId: org.id, deletedAt: new Date(),
  } });
});

describe.each(shapes)('%s', (_name, principal) => {
  it('read scope is exactly the App-less, not user-owned, live PUBLIC memories', async () => {
    expect(await getAccessibleMemoryIds(principal())).toEqual([publicId]);
  });
  it('refuses a system memory write without a user or App', async () => {
    await expect(requireMemoryWriteAccess(principal(), systemMemoryId)).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
  });
  it('applies the boot-prompt manager gate without a user or App', async () => {
    await expect(assertMayWriteBootPromptPointer(principal(), { field: 'AGENT', agent: {
      id: generateId(), organizationId: null, ownerUserId: null, systemMemoryId,
    } })).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});
