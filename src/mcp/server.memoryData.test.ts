/**
 * Memory.data over MCP — read-only exposure in h-list-memories.
 *
 * The GraphQL read/write contract for the free-form `Memory.data` bag is
 * pinned in resolvers.memoryData.test.ts. This file pins the MCP half: the
 * bag is surfaced read-only on an indented `data:` sub-line in
 * h-list-memories, only when non-null, rendered via JSON.stringify
 * (mirroring h-read-node's `Data: <json>` idiom). MCP has no
 * memory-mutation tool, so there is no write path to cover here — `data` is
 * written via GraphQL createMemory / updateMemory and read back over MCP.
 *
 * Harness: createTestableMcpServer drives the real h-list-memories closure
 * (auth → getMemoryAccess → render) with no HTTP transport. The caller is a
 * bare org member — the same access shape the onboarding e2e exercises.
 *
 * JSONB caveat: Postgres `jsonb` does not preserve key order or whitespace,
 * so the exact rendered string is asserted against the round-tripped
 * `row.data` (which has been through the same normalization), never against
 * the raw input literal.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string };
let member: { id: string };

// Bare org member: no AppMember, no platform roles, no active App. Org
// membership alone confers read over MCP (the onboarding-incident path),
// so h-list-memories surfaces the org's memories.
function memberAuth(): AuthContext {
  return { userId: member.id, roles: [], clientId: `user:${member.id}` };
}

// createMemory / updateMemory authz on the platform/org role, not on the
// MCP caller. Run the mutations through an ADMIN ctx so they pass; the
// access under test is the bare org member's read over MCP.
function gqlCtx(): Context {
  return { db, roles: ['ADMIN'], userId: member.id };
}

// Read the stored bag back so assertions compare against JSONB-normalized
// output (key order / whitespace), exactly what the server renders.
async function storedData(id: string): Promise<unknown> {
  const row = await db.memory.findUniqueOrThrow({ where: { id }, select: { data: true } });
  return row.data;
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'data-org', urn: 'data-org' },
  });
  member = await db.user.create({
    data: { githubId: 9701, githubUsername: 'data-member', roles: [] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: member.id, role: 'READER' },
  });
});

describe('Memory.data over MCP (h-list-memories)', () => {
  it('renders the JSON bag on an indented data: line when set', async () => {
    const payload = { color: 'blue', counts: [1, 2, 3], nested: { ok: true } };
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: org.id, name: 'with-data', data: payload },
      gqlCtx(),
    );

    const text = await createTestableMcpServer(memberAuth()).callToolText('h-list-memories', {});

    expect(text).toContain('with-data');
    // Rendered verbatim via JSON.stringify on its own indented sub-line.
    expect(text).toMatch(/\n {2}data: /);
    expect(text).toContain(`data: ${JSON.stringify(await storedData(mem.id))}`);
  });

  it('omits the data: sub-line for a memory with no data', async () => {
    await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'no-data' }, gqlCtx());

    const text = await createTestableMcpServer(memberAuth()).callToolText('h-list-memories', {});

    expect(text).toContain('no-data');
    // The header line still renders; no `data:` sub-line is emitted. (Regex
    // targets the indented sub-line so it can't false-match a URN/name.)
    expect(text).not.toMatch(/\n {2}data: /);
  });

  it('drops the data: sub-line again after updateMemory clears it (null)', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId: org.id, name: 'clear-later', data: { keep: false } },
      gqlCtx(),
    );

    const before = await createTestableMcpServer(memberAuth()).callToolText('h-list-memories', {});
    expect(before).toMatch(/\n {2}data: /);

    await resolvers.Mutation.updateMemory({}, { id: mem.id, data: null }, gqlCtx());

    const after = await createTestableMcpServer(memberAuth()).callToolText('h-list-memories', {});
    expect(after).toContain('clear-later');
    expect(after).not.toMatch(/\n {2}data: /);
  });

  it('surfaces each memory\'s own bag when several are listed together', async () => {
    const memA = await resolvers.Mutation.createMemory(
      {},
      { orgId: org.id, name: 'mem-a', data: { which: 'a' } },
      gqlCtx(),
    );
    await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'mem-b' }, gqlCtx());

    const text = await createTestableMcpServer(memberAuth()).callToolText('h-list-memories', {});

    expect(text).toContain('mem-a');
    expect(text).toContain(`data: ${JSON.stringify(await storedData(memA.id))}`);
    expect(text).toContain('mem-b');
    // Exactly one data: sub-line total — mem-b (no data) contributes none.
    expect(text.match(/\n {2}data: /g)?.length).toBe(1);
  });
});
