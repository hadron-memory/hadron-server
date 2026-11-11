/** #3705: a userless, App-less context gets no retired operator privileges. */
import { beforeEach, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { assertMayWriteBootPromptPointer } from '../../../lib/bootPromptPointer.js';
import { getAccessibleMemoryIds, requireMemoryWriteAccess, type Context } from './resolvers.helpers.js';

let memoryId: string;
const principal = (): Context => ({ db, roles: [], clientId: 'operator:boot-prompt-conversion:P9' });
beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({ data: { id: generateId(), handle: 'retire3705' } });
  memoryId = (await db.memory.create({ data: {
    id: generateId(), urn: 'retire3705:system', name: 'System', class: 'system', ownerUserId: user.id,
  } })).id;
});
it('read scope is bounded and excludes another user system memory', async () => {
  const ids = await getAccessibleMemoryIds(principal());
  expect(ids).not.toBeNull();
  expect(ids).not.toContain(memoryId);
});
it('refuses a system memory write without a user or App', async () => {
  await expect(requireMemoryWriteAccess(principal(), memoryId)).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
});
it('applies the boot-prompt manager gate without a user or App', async () => {
  await expect(assertMayWriteBootPromptPointer(principal(), { field: 'AGENT', agent: {
    id: generateId(), organizationId: null, ownerUserId: null, systemMemoryId: memoryId,
  } })).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
});
