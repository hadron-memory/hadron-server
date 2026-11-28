/**
 * #5268 — the wrong-type (shape) refusal of `hadron_get_nodes` names the
 * failing ref by its POSITION in the caller's `refs`, never by its text.
 *
 * Mirrors the GraphQL pin file (resolvers.batchRefIndex5268.test.ts): the two
 * surfaces share one contract, differing only in transport (MCP text results
 * have no extensions, so the position lives in the message alone).
 *
 * Pins:
 *   - The refusal text ends `(the ref at index N)`; the golden refusal wording
 *     before the suffix (`Expected node URN …`) is unchanged.
 *   - N is the 0-based index in the caller's `refs` AS SENT: first occurrence
 *     for a duplicated wrong-type ref, first failing ref in caller order.
 *   - The index is decided in a synchronous pre-pass before any resolution
 *     (#5268 spec-FIT condition): a resolvable URN — or a PK, which skips URN
 *     parsing — around the bad ref changes nothing. MIXED shape input too: a
 *     wrong-type ref is named even when an unqualified ref precedes it. That
 *     is a deliberate precedence change on THIS surface (before #5268 the
 *     split loop reached the unqualified ref first and answered the
 *     no-position 'neither a node id' refusal), made to match nodeBatch,
 *     where the wrong-type screen always won the Promise.all race.
 *   - No echo: the refusal names the URN KIND and the position, not the value.
 *   - The quiet path is untouched (cor:api:040:03): denied/not-found refs keep
 *     reporting through the Unavailable list, with no position anywhere.
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

let admin: { id: string };
let memory: { id: string; urn: string };

function adminAuth(): AuthContext {
  return { userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` };
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'bri-org', urn: 'bri-org' },
  });
  admin = await db.user.create({
    data: { githubId: 9951, githubUsername: 'bri-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  memory = await resolvers.Mutation.createMemory(
    {},
    { orgRef: org.id, name: 'brimem' },
    { db, roles: ['ADMIN'], userId: admin.id } as Context,
  );
});

// createMemory stores the memory urn in legacy single-colon form; the canonical
// org::memory::loc shape is what assertFullyQualifiedUrn accepts.
const MEM_URN = 'bri-org::brimem';
const nodeUrn = (loc: string) => `${MEM_URN}::${loc}`;
/** A URN of the WRONG entity type — the shape error this issue names. */
const wrongType = () => `hrn:mem:${MEM_URN}`;

function batchRead(params: Record<string, unknown>) {
  return createTestableMcpServer(adminAuth()).callToolText('hadron_get_nodes', params);
}

async function addNode(loc: string) {
  await createTestableMcpServer(adminAuth()).callToolText('hadron_create_node', {
    urn: nodeUrn(loc),
    name: `Node-${loc}`,
    content: `${loc} body`,
  });
}

describe('hadron_get_nodes — wrong-type refusal names the failing ref by position (#5268)', () => {
  it('answers text ending (the ref at index N) for the bad ref among good ones', async () => {
    await addNode('one');
    await addNode('two');

    const out = await batchRead({ refs: [nodeUrn('one'), nodeUrn('two'), wrongType()] });

    expect(out).toContain('Expected node URN');
    expect(out).not.toContain('(one of the refs)');
    expect(out.trimEnd()).toMatch(/\(the ref at index 2\)$/);
    // The whole call errors — same loudness as before the position existed.
    expect(out).not.toContain('returned');
  });

  it('a duplicated wrong-type ref is named at its FIRST occurrence', async () => {
    await addNode('one');
    const bad = wrongType();

    const out = await batchRead({ refs: [nodeUrn('one'), bad, nodeUrn('one'), bad] });

    expect(out.trimEnd()).toMatch(/\(the ref at index 1\)$/);
  });

  it('mixed shape: the wrong-type ref is named even when an unqualified ref precedes it', async () => {
    await addNode('one');

    // 'relative-loc' is unqualified and sits first. Pre-#5268 the split loop
    // reached it before the wrong-type ref and answered the no-position
    // 'neither a node id nor a fully-qualified node URN' refusal; the
    // pre-pass now names the wrong-type ref at index 1, matching nodeBatch.
    // The spec-FIT left unqualified refs out of #5268, so an unqualified-only
    // batch keeps the old refusal (pinned in server.batchRead.test.ts).
    const out = await batchRead({ refs: ['relative-loc', wrongType()] });

    expect(out).toContain('Expected node URN');
    expect(out).not.toContain('neither a node id');
    expect(out.trimEnd()).toMatch(/\(the ref at index 1\)$/);
    expect(out).not.toContain('relative-loc');
  });

  it('a resolvable URN or a PK around the bad ref changes nothing — the index is pre-resolution (#5268 FIT)', async () => {
    await addNode('one');
    const rows = await db.node.findMany({ where: { memoryId: memory.id, loc: 'one' } });
    expect(rows.length).toBe(1);

    // Resolvable URN first, bad second.
    const urnFirst = await batchRead({ refs: [nodeUrn('one'), 'hrn:app:bri-org:some-app'] });
    expect(urnFirst.trimEnd()).toMatch(/\(the ref at index 1\)$/);

    // Bad first, resolvable URN second.
    const urnAfter = await batchRead({ refs: ['hrn:app:bri-org:some-app', nodeUrn('one')] });
    expect(urnAfter.trimEnd()).toMatch(/\(the ref at index 0\)$/);

    // A PK (which skips URN parsing) before the bad ref still counts toward
    // the caller's positions.
    const pkFirst = await batchRead({ refs: [rows[0].id, wrongType()] });
    expect(pkFirst.trimEnd()).toMatch(/\(the ref at index 1\)$/);
  });

  it('names no caller-typed text — only the URN kind and the position', async () => {
    await addNode('one');
    const bad = wrongType();

    const out = await batchRead({ refs: [nodeUrn('one'), bad] });

    expect(out).not.toContain(bad);
    expect(out).not.toContain('brimem');
  });
});

describe('hadron_get_nodes — the quiet path is untouched by the position (#5268 FIT condition 1)', () => {
  it('a well-formed ref that names nothing readable stays in Unavailable, no position', async () => {
    await addNode('one');

    const out = await batchRead({ refs: [nodeUrn('one'), nodeUrn('nope')] });

    expect(out).toContain('returned');
    expect(out).toContain('unavailable');
    expect(out).toContain(nodeUrn('nope'));
    expect(out).not.toContain('(the ref at index');
  });
});
