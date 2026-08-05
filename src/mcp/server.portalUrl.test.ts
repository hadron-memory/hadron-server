/**
 * #881 — every node read carries the node's portal URL.
 *
 * The bug this pins shut: nothing in a node projection was a link, so an agent
 * handing a human a link had to CONSTRUCT one from the URN — guessing which of
 * the several accepted URN spellings the `/app/u/<urn>` route actually
 * resolves. The tools accept the legacy `::` forms and prose is written in
 * them, so the guess was routinely wrong (and an `hrn:` href renders as a link
 * that resolves to nothing, so neither side sees a failure).
 *
 * What this file pins:
 *
 *   - `hadron_get_node` emits `URL: <origin>/app/u/<urn>` where `<urn>` is
 *     BYTE-IDENTICAL to the URN the same projection prints — the link and the
 *     printed identifier can never disagree, and the URL always carries the
 *     canonical form the portal route resolves (never a `::` spelling, even
 *     when the CALLER addressed the node in one).
 *   - `hadron_get_nodes` (batch) keeps per-node projection parity
 *     (cor:api:040:01) — one renderer, so it cannot drift.
 *   - `hadron_get_next_node` and non-brief `hadron_find_nodes` carry it too;
 *     `brief: true` does not (brief stays terse, as with the abstract) and
 *     neither does chunk granularity.
 *   - No configured portal origin ⇒ NO `URL:` line anywhere. A link to the
 *     wrong host is worse than no link.
 *
 * Test harness: createTestableMcpServer drives the registered tool callbacks
 * without an HTTP transport, so this exercises the production closure.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

const PORTAL = 'https://hadronmemory.com';
const ORG = 'purl-org';
const MEM = 'purlmem';

let fx: { admin: { id: string }; memory: { id: string; urn: string } };

function adminAuth(): AuthContext {
  return { userId: fx.admin.id, roles: ['ADMIN'], clientId: `user:${fx.admin.id}` };
}

/** The `URL:` value from a projection, or null when the line is absent. */
function urlLine(text: string): string | null {
  return text.match(/^URL: (.+)$/m)?.[1] ?? null;
}

/** The URN line of a single-node projection (line 2, after the bold name). */
function urnLine(text: string): string {
  return text.split('\n')[1]!;
}

beforeEach(async () => {
  await cleanDb(db);
  process.env.FRONTEND_URL = PORTAL;

  const org = await db.organization.create({
    data: { id: generateId(), name: ORG, urn: ORG },
  });
  const admin = await db.user.create({
    data: { githubId: 9881, githubUsername: 'purl-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  const ctx: Context = { db, roles: ['ADMIN'], userId: admin.id };
  const memory = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: MEM }, ctx);

  fx = { admin: { id: admin.id }, memory };
});

afterEach(() => {
  // vitest.config pins FRONTEND_URL off for every other file; restore that.
  process.env.FRONTEND_URL = '';
});

async function addNode(loc: string, extra: Record<string, unknown> = {}) {
  const srv = createTestableMcpServer(adminAuth());
  return srv.callToolText('hadron_create_node', {
    urn: `${ORG}::${MEM}::${loc}`,
    name: `node-${loc}`,
    ...extra,
  });
}

async function getNode(ref: string, params: Record<string, unknown> = {}) {
  const srv = createTestableMcpServer(adminAuth());
  return srv.callToolText('hadron_get_node', { urn: ref, ...params });
}

// ───── hadron_get_node ────────────────────────────────────────────────────

describe('hadron_get_node — URL line', () => {
  it('emits the /app/u/<urn> link built from the projection’s own URN', async () => {
    await addNode('services:academy', { content: 'Body.' });
    const text = await getNode(`${ORG}::${MEM}::services:academy`);

    const urn = urnLine(text);
    expect(urn).toBe(`hrn:node:${ORG}:${MEM}:services:academy`);
    expect(urlLine(text)).toBe(`${PORTAL}/app/u/${urn}`);
  });

  it('sits directly under the ID line (identifiers stay together)', async () => {
    await addNode('placement', { content: 'Body.' });
    const lines = (await getNode(`${ORG}::${MEM}::placement`)).split('\n');
    const idIdx = lines.findIndex((l) => l.startsWith('ID: '));
    expect(idIdx).toBeGreaterThan(-1);
    expect(lines[idIdx + 1]).toMatch(/^URL: https:\/\//);
  });

  it('carries the CANONICAL urn even when the caller addressed the node in the legacy :: form', async () => {
    await addNode('legacy-in', { content: 'Body.' });
    // The `::` spelling the issue describes: accepted on input, but NOT what
    // the portal route resolves — so it must not survive into the link.
    const text = await getNode(`hrn:node:${ORG}::${MEM}::legacy-in`);
    expect(urlLine(text)).toBe(`${PORTAL}/app/u/hrn:node:${ORG}:${MEM}:legacy-in`);
    expect(urlLine(text)).not.toContain('::');
  });

  it('appears under every contentScope (it describes the node, not the payload)', async () => {
    await addNode('scoped', { content: 'Body.', abstract: 'Summary.' });
    for (const contentScope of ['content', 'abstract', 'all'] as const) {
      const text = await getNode(`${ORG}::${MEM}::scoped`, { contentScope });
      expect(urlLine(text)).toBe(`${PORTAL}/app/u/hrn:node:${ORG}:${MEM}:scoped`);
    }
  });

  it('is OMITTED when no portal origin is configured', async () => {
    await addNode('nolink', { content: 'Body.' });
    process.env.FRONTEND_URL = '';
    const text = await getNode(`${ORG}::${MEM}::nolink`);
    expect(urlLine(text)).toBeNull();
    // …and the rest of the projection is untouched.
    expect(text).toContain(`hrn:node:${ORG}:${MEM}:nolink`);
    expect(text).toContain('Body.');
  });

  it('is omitted when FRONTEND_URL is malformed (never a wrong-host link)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await addNode('badbase', { content: 'Body.' });
    process.env.FRONTEND_URL = 'hadronmemory.com'; // no scheme
    expect(urlLine(await getNode(`${ORG}::${MEM}::badbase`))).toBeNull();
  });
});

// ───── hadron_get_nodes (batch) ───────────────────────────────────────────

describe('hadron_get_nodes — per-node parity (cor:api:040:01)', () => {
  it('each batch block carries the same URL line the single read emits', async () => {
    await addNode('batch:a', { content: 'A.' });
    await addNode('batch:b', { content: 'B.' });
    const srv = createTestableMcpServer(adminAuth());
    const batch = await srv.callToolText('hadron_get_nodes', {
      refs: [`${ORG}::${MEM}::batch:a`, `${ORG}::${MEM}::batch:b`],
    });

    for (const loc of ['batch:a', 'batch:b']) {
      expect(batch).toContain(`URL: ${PORTAL}/app/u/hrn:node:${ORG}:${MEM}:${loc}`);
    }
    expect(batch.match(/^URL: /gm)?.length).toBe(2);
  });
});

// ───── hadron_get_next_node ───────────────────────────────────────────────

describe('hadron_get_next_node — URL line', () => {
  it('carries the next sibling’s own link', async () => {
    await addNode('chapters', { nodeType: 'parent' });
    await addNode('chapters:one', { content: 'One.' });
    await addNode('chapters:two', { content: 'Two.' });

    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_get_next_node', {
      parent: `${ORG}::${MEM}::chapters`,
    });
    expect(urlLine(text)).toBe(`${PORTAL}/app/u/${urnLine(text)}`);
    expect(urlLine(text)).toBe(`${PORTAL}/app/u/hrn:node:${ORG}:${MEM}:chapters:one`);
  });
});

// ───── hadron_find_nodes ──────────────────────────────────────────────────

describe('hadron_find_nodes — URL per hit', () => {
  async function find(params: Record<string, unknown>) {
    const srv = createTestableMcpServer(adminAuth());
    return srv.callToolText('hadron_find_nodes', {
      query: 'grading',
      memoryUrn: fx.memory.urn,
      ...params,
    });
  }

  beforeEach(async () => {
    await addNode('srv:acy:090', {
      name: 'Grading rules',
      description: 'How grading works.',
      content: 'grading body',
    });
  });

  it('emits an indented URL under each hit in the default view', async () => {
    const text = await find({});
    expect(text).toContain(`  URL: ${PORTAL}/app/u/hrn:node:${ORG}:${MEM}:srv:acy:090`);
  });

  it('does NOT emit it in brief mode (brief stays terse)', async () => {
    const text = await find({ brief: true });
    expect(text).toContain('srv:acy:090');
    expect(text).not.toContain('URL:');
  });

  it('is omitted when no portal origin is configured', async () => {
    process.env.FRONTEND_URL = '';
    const text = await find({});
    expect(text).toContain('srv:acy:090');
    expect(text).not.toContain('URL:');
  });
});
