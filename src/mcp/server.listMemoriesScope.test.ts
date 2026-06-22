/**
 * hadron_list_memories: a caller's OWN personal/private memories are discoverable
 * over MCP (the CLI-vs-MCP asymmetry reported in #282), and the active scope is
 * surfaced so a narrow App-Key listing isn't silently mistaken for "no access".
 *
 * Personal/private memories are intentionally absent from getMemoryAccess (it
 * backs getAccessibleMemoryIds, kept personal-free). hadron_list_memories folds in
 * the caller's own ones through the canReadMemory / canWriteToMemory gates, so
 * the listing always matches what hadron_get_node would allow — and an App-Key
 * caller (no userId) never folds any, preserving per-App isolation.
 *
 * Harness: createTestableMcpServer drives the real hadron_list_memories closure with
 * no HTTP transport, mirroring server.memoryData.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'list-scope-org', urn: 'list-scope-org' },
  });
  orgId = org.id;
});

async function createUser(name: string) {
  return db.user.create({ data: { id: generateId(), name } });
}

// A free-standing personal/private memory (spec 034): user-owned, app_id and
// agent both NULL — the shape that was invisible to its own owner over MCP.
async function createFreeStanding(ownerId: string, cls: 'personal' | 'private', name: string) {
  return db.memory.create({
    data: {
      class: cls,
      id: generateId(),
      name,
      urn: `${orgId}:${name}-${generateId()}`,
      organizationId: orgId,
      userId: ownerId,
      appId: null,
      userMemoryOfAgentId: null,
    },
  });
}

function userAuth(userId: string): AuthContext {
  return { userId, roles: [], clientId: `user:${userId}` };
}

describe('hadron_list_memories — own personal memories + scope (#282)', () => {
  it("lists the caller's own free-standing personal memory, tagged read-write", async () => {
    const owner = await createUser('owner');
    const mem = await createFreeStanding(owner.id, 'personal', 'nexus-notes');

    const text = await createTestableMcpServer(userAuth(owner.id)).callToolText('hadron_list_memories', {});

    expect(text).toContain(mem.name);
    expect(text).toMatch(/\(personal, read-write\)/);
  });

  it('lists a free-standing PRIVATE memory for its owner', async () => {
    const owner = await createUser('owner-priv');
    await createFreeStanding(owner.id, 'private', 'secret-notes');

    const text = await createTestableMcpServer(userAuth(owner.id)).callToolText('hadron_list_memories', {});

    expect(text).toContain('secret-notes');
    expect(text).toMatch(/\(private, read-write\)/);
  });

  it("never leaks another user's personal memory, even to an org member with org-read", async () => {
    const owner = await createUser('owner-x');
    const other = await createUser('other-y');
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgId, userId: other.id, role: 'READER' },
    });
    // An org knowledge memory both can read — so `other`'s list is non-empty.
    await db.memory.create({
      data: { class: 'knowledge', id: generateId(), name: 'shared-kn', urn: `${orgId}:shared-kn`, organizationId: orgId },
    });
    await createFreeStanding(owner.id, 'personal', 'owner-only-secret');

    const text = await createTestableMcpServer(userAuth(other.id)).callToolText('hadron_list_memories', {});

    expect(text).toContain('shared-kn'); // org-read works
    expect(text).not.toContain('owner-only-secret'); // but not the other user's personal memory
  });

  it('an App-Key caller folds no personal memories and the scope says App key', async () => {
    const { app } = await createDbAppWithKey(db, 'scope-app', orgId);
    const someUser = await createUser('pers-owner');
    await createFreeStanding(someUser.id, 'personal', 'should-not-appear');

    const auth: AuthContext = { appId: app.id, organizationId: orgId };
    const text = await createTestableMcpServer(auth).callToolText('hadron_list_memories', {});

    expect(text).toContain('Scope: App key');
    expect(text).not.toContain('should-not-appear');
  });

  it('surfaces the no-active-App user scope line', async () => {
    const owner = await createUser('scopey');
    await createFreeStanding(owner.id, 'personal', 'mine');

    const text = await createTestableMcpServer(userAuth(owner.id)).callToolText('hadron_list_memories', {});

    expect(text).toContain('Scope: user');
    expect(text).toContain('no active App');
  });
});
