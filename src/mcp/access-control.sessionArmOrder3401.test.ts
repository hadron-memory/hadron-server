/**
 * #3401 D3: the MCP read gate's OWN terms, apart from the shared predicate's. The predicate already drops private
 * for a run principal and everything for an impersonation, so with the real predicate those two MCP terms cannot be
 * told apart from it. Here the predicate is replaced by one that admits the session memory unconditionally, so each
 * MCP term stands alone: the #1719 R5a run refusal must come BEFORE the session arm, and an impersonating context
 * must never take that arm.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/auth/sessionScopedMemoryIds.js', () => ({
  sessionScopedMemoryIds: vi.fn(async () => admitted),
}));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAgentSubscription } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { canReadMemory, filterReadableMemoryIds } from './access-control.js';
import type { AuthContext } from '../middleware/auth.js';

let admitted: string[] = [];
let appId: string;
let sessionId: string;
let memoryId: string;

beforeEach(async () => {
  await cleanDb(db);
  const s = generateId().toLowerCase().slice(-8);
  const org = await db.organization.create({ data: { id: generateId(), name: 'o3401', urn: `o3401-${s}.test` } });
  const agentId = (await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` } })).id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'X', urn: `${org.urn}:x` } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  const mia = (await db.user.create({ data: { id: generateId(), externalAppId: appId, externalId: 'mia', identityProvider: 'APP', handle: `mia-${s}` } })).id;
  await createDbAgentSubscription(db, mia, agentId);
  memoryId = (await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:m`, name: 'm', class: 'private', visibility: null,
      userId: mia, createdBy: mia, userMemoryOfAgentId: agentId, appId,
    },
  })).id;
  sessionId = (await db.session.create({ data: { id: generateId(), appId, userId: mia, agentId, memoryId } })).id;
  admitted = [memoryId];
});

const auth = (extra: Partial<AuthContext> = {}) => ({ appId, sessionId, roles: [], ...extra }) as AuthContext;

describe('#3401 D3: the MCP gate\'s own run and impersonation terms', () => {
  it('control: with the stub admitting it, the plain session key reads the private memory', async () => {
    expect(await canReadMemory(db, auth(), memoryId)).toBe(true);
    expect((await filterReadableMemoryIds(db, auth(), [memoryId])).has(memoryId)).toBe(true);
  });

  it('a run principal carrying the App and session is refused private before the session arm (#1719 R5a)', async () => {
    const run = auth({ clientId: `run:${generateId()}` });
    expect(await canReadMemory(db, run, memoryId)).toBe(false);
    expect((await filterReadableMemoryIds(db, run, [memoryId])).has(memoryId)).toBe(false);
  });

  it('an impersonating context never takes the session arm', async () => {
    const imp = auth({ impersonation: { sessionId: generateId(), actorUserId: generateId(), organizationId: generateId() } } as Partial<AuthContext>);
    expect(await canReadMemory(db, imp, memoryId)).toBe(false);
    expect((await filterReadableMemoryIds(db, imp, [memoryId])).has(memoryId)).toBe(false);
  });
});
