/**
 * #697 stored alias map on the MCP surface — a memory re-minted onto its flat
 * v2 urn must still be reachable by the urn that addressed it BEFORE.
 *
 * Every MCP memory-scope path funnels through one helper (`resolveMemoryByUrn`),
 * and that helper matched `Memory.urn` only, while `resolveMemoryRef` (the
 * GraphQL/CLI side) had carried the `legacyUrn` fallback since #697. So the
 * moment the backfill re-minted a row, every stored reference to its old urn —
 * a wikilink, an export, a chat log, an agent's own notes — answered "Memory not
 * found" over MCP while resolving fine over GraphQL.
 *
 * Found running the #723 backfill on production: re-minting the team memory
 * `micromentor.org:eng-team:eng-team:shared` to `micromentor.org:eng-team-shared`
 * made `hadron_find_nodes memoryUrn:'<the old urn>'` fail immediately, which is
 * the promise #697 makes to every legacy reference ("accept forever", #239).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

/** The pre-migration (v1, compound) urn a stored reference would carry. */
const LEGACY_URN = 'legacy-org.com:eng-team:eng-team:shared';
/** What the #723 / #697 backfill re-mints it to. */
const V2_URN = 'legacy-org.com:eng-team-shared';

let admin: { id: string };
let memoryId: string;
let orgId: string;

function adminAuth(): AuthContext {
  return { userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'legacy-org', urn: 'legacy-org.com' },
  });
  orgId = org.id;
  admin = await db.user.create({
    data: { githubId: 9701, githubUsername: 'legacy-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  // A row in the post-backfill state: flat urn, old value parked in legacyUrn.
  const memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: V2_URN,
      legacyUrn: LEGACY_URN,
      urnNormalizedAt: new Date(),
      name: 'Eng Team shared',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });
  memoryId = memory.id;
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: memory.id,
      loc: 'chats:team',
      name: 'Team chat',
      nodeType: 'chat',
    },
  });
});

describe('MCP memory-scope resolution honors the #697 legacyUrn alias map', () => {
  it('hadron_find_nodes resolves a memoryUrn that is now the row LEGACY urn', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: '*',
      memoryUrn: LEGACY_URN,
    });
    expect(text).not.toContain('Memory not found');
    expect(text).toContain('chats:team');
  });

  it('the current v2 urn keeps working (control)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: '*',
      memoryUrn: V2_URN,
    });
    expect(text).toContain('chats:team');
  });

  it('hadron_list_nodes resolves the legacy urn too (same helper, 22 call sites)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_list_nodes', { memoryUrn: LEGACY_URN });
    expect(text).not.toContain('Memory not found');
    expect(text).toContain('chats');
  });

  it('a node URN under the CURRENT memory urn reads', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_get_node', {
      urn: `hrn:node:${V2_URN}:chats:team`,
    });
    expect(text).toContain('Team chat');
  });

  // The alias map fixes MEMORY-urn inputs, and deliberately cannot fix a legacy
  // NODE urn whose memory part is COMPOUND: `hrn:node:<a>:<b>:<c>:<loc>` has no
  // positional split between a multi-atom memory slug and a multi-atom loc, so
  // the resolver reads `<a>:<b>` as the memory and never gets far enough to
  // consult any alias. That ambiguity IS the #723 bug — the fix is that the
  // memory no longer HAS a compound urn, not that the old string starts
  // resolving. Pinned so nobody reads the alias map as a promise it can't keep.
  it('a legacy COMPOUND node urn still does not resolve — unchanged, and unfixable by aliasing', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_get_node', {
      urn: `hrn:node:${LEGACY_URN}:chats:team`,
    });
    expect(text).toContain('Memory not found');
  });

  it('an unknown urn is still not found (the fallback widens nothing else)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: '*',
      memoryUrn: 'legacy-org.com:no-such-memory',
    });
    expect(text).toContain('Memory not found or invalid');
  });

  // #697's rule: never silently resolve to one of several claimants.
  it('fails LOUDLY when two live rows claim the same legacyUrn', async () => {
    await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: `${V2_URN}-2`,
        legacyUrn: LEGACY_URN,
        name: 'Impostor',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    const srv = createTestableMcpServer(adminAuth());
    await expect(
      srv.callToolText('hadron_find_nodes', { query: '*', memoryUrn: LEGACY_URN }),
    ).rejects.toThrow(/ambiguous/i);
    // …and the unambiguous row is untouched by the ambiguity.
    expect(await db.memory.count({ where: { id: memoryId } })).toBe(1);
  });
});
