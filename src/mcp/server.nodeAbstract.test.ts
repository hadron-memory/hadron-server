/**
 * Spec 031 — Node `abstract` field. Behavioral coverage for the MCP
 * surface: hadron_create_node, hadron_update_node, hadron_get_node (the load-bearing
 * contentScope matrix + Source: abstract-fallback marker), and
 * hadron_validate sparse-rule extension.
 *
 * What this file pins:
 *
 *   - Round-trip: hadron_create_node persists abstract → hadron_get_node with
 *     contentScope='abstract' returns it verbatim.
 *
 *   - The 12-cell contentScope × abstract-state × content-state matrix
 *     per contracts/hadron_get_node.md. Especially:
 *       * default scope is byte-identical to pre-spec for nodes with
 *         abstract IS NULL (SC-004 backstop)
 *       * content fallback fires only under 'content' scope when
 *         content is null/empty AND abstract is non-null
 *       * 'Source: abstract-fallback' meta line appears in that single
 *         cell, nowhere else
 *
 *   - hadron_update_node partial-update semantics: omitted preserves, null
 *     clears, string replaces.
 *
 *   - FR-008 length-cap rejection: > 2000 chars throws
 *     NodeAbstractTooLongError.
 *
 *   - FR-009 (extended): empty-string AND whitespace-only normalize
 *     to NULL via trim-then-check. Intentional leading-whitespace on
 *     a real paragraph persists as-is.
 *
 *   - FR-005 invalid contentScope: rejected (zod enum validation).
 *
 *   - FR-011: hadron_validate sparse-node check considers abstract as
 *     legitimate content (only flags when description AND content AND
 *     abstract are all null).
 *
 * Test harness: createTestableMcpServer drives the registered tool
 * callbacks without an HTTP transport, so we exercise the production
 * closure (auth + access-control + meta-block rendering) directly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

// MCP tools don't write to git in this surface, but other parts of the
// codebase do — pin to a no-op so the test doesn't try to push.
vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

interface Fixture {
  admin: { id: string };
  memory: { id: string; urn: string };
}

let fx: Fixture;

function adminAuth(): AuthContext {
  return { userId: fx.admin.id, roles: ['ADMIN'], clientId: `user:${fx.admin.id}` };
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'abs-org', urn: 'abs-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 9701, githubUsername: 'abs-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });

  const localGqlCtx: Context = { db, roles: ['ADMIN'], userId: admin.id };
  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'absmem' },
    localGqlCtx,
  );

  fx = { admin: { id: admin.id }, memory };
});

// ───── helpers ────────────────────────────────────────────────────────────

const SHORT_ABSTRACT = 'Short paragraph summary.';
const REVISED_ABSTRACT = 'Revised summary.';
const PAPER_ABSTRACT =
  'The original paper proposes a novel approach to X. Key result: Y. Source: archived; only this abstract remains.';

async function addNode(args: {
  loc: string;
  name?: string;
  abstract?: string;
  content?: string;
  description?: string;
  nodeType?: string;
}) {
  const srv = createTestableMcpServer(adminAuth());
  const params: Record<string, unknown> = {
    urn: `abs-org::absmem::${args.loc}`,
    name: args.name ?? `node-${args.loc}`,
  };
  if (args.abstract !== undefined) params.abstract = args.abstract;
  if (args.content !== undefined) params.content = args.content;
  if (args.description !== undefined) params.description = args.description;
  if (args.nodeType !== undefined) params.nodeType = args.nodeType;
  return srv.callToolText('hadron_create_node', params);
}

async function readNode(loc: string, contentScope?: 'content' | 'abstract' | 'all') {
  const srv = createTestableMcpServer(adminAuth());
  const params: Record<string, unknown> = {
    urn: `abs-org::absmem::${loc}`,
  };
  if (contentScope !== undefined) params.contentScope = contentScope;
  return srv.callToolText('hadron_get_node', params);
}

async function updateNode(args: {
  loc: string;
  abstract?: string | null;
  name?: string;
}) {
  const srv = createTestableMcpServer(adminAuth());
  const params: Record<string, unknown> = {
    urn: `abs-org::absmem::${args.loc}`,
  };
  if ('abstract' in args) params.abstract = args.abstract;
  if (args.name !== undefined) params.name = args.name;
  return srv.callToolText('hadron_update_node', params);
}

async function readPersistedAbstract(loc: string): Promise<string | null> {
  const node = await db.node.findFirst({
    where: { loc, memoryId: fx.memory.id, deletedAt: null },
    select: { abstract: true },
  });
  return node?.abstract ?? null;
}

// ───── US1 round-trip (acceptance scenarios 1, 2) ─────────────────────────

describe('US1 round-trip — hadron_create_node / hadron_update_node persist abstract', () => {
  it('US1.1 — hadron_create_node with abstract persists the value', async () => {
    await addNode({ loc: 'rt1', abstract: SHORT_ABSTRACT });
    expect(await readPersistedAbstract('rt1')).toBe(SHORT_ABSTRACT);
  });

  it('US1.2 — hadron_update_node replaces an existing abstract', async () => {
    await addNode({ loc: 'rt2', abstract: 'Original.' });
    await updateNode({ loc: 'rt2', abstract: REVISED_ABSTRACT });
    expect(await readPersistedAbstract('rt2')).toBe(REVISED_ABSTRACT);
  });
});

// ───── contentScope matrix (US1.3–US1.6, US1.10–US1.13) ───────────────────

describe('US1 contentScope matrix — hadron_get_node response shapes', () => {
  it('US1.3 — default scope on a node with content + abstract: meta + --- + content, no abstract surfaced, no Source: marker', async () => {
    await addNode({
      loc: 'm-cb',
      description: 'Auth tokens.',
      abstract: SHORT_ABSTRACT,
      content: 'Full body.',
    });
    const text = await readNode('m-cb'); // omit contentScope
    expect(text).toContain('Full body.');
    expect(text).not.toContain(SHORT_ABSTRACT);
    expect(text).not.toContain('Source: abstract-fallback');
    expect(text).toContain('---'); // separator present
  });

  it('US1.3b — explicit contentScope=content matches the omitted-scope default', async () => {
    await addNode({
      loc: 'm-cb2',
      abstract: SHORT_ABSTRACT,
      content: 'Body B.',
    });
    const omitted = await readNode('m-cb2');
    const explicit = await readNode('m-cb2', 'content');
    expect(omitted).toBe(explicit);
  });

  it("US1.4 — contentScope='abstract' on a node with abstract: meta + abstract, no --- separator, no body", async () => {
    await addNode({
      loc: 'm-a',
      abstract: SHORT_ABSTRACT,
      content: 'Body should not appear.',
    });
    const text = await readNode('m-a', 'abstract');
    expect(text).toContain(SHORT_ABSTRACT);
    expect(text).not.toContain('Body should not appear.');
    expect(text).not.toContain('---');
    expect(text).not.toContain('Source: abstract-fallback');
  });

  it("US1.5 — contentScope='all' with both content + abstract: meta + abstract + --- + content", async () => {
    await addNode({
      loc: 'm-all',
      abstract: SHORT_ABSTRACT,
      content: 'Body C.',
    });
    const text = await readNode('m-all', 'all');
    expect(text).toContain(SHORT_ABSTRACT);
    expect(text).toContain('Body C.');
    expect(text).toContain('---');
    expect(text).not.toContain('Source: abstract-fallback');
    // Abstract must appear before the body separator
    const absPos = text.indexOf(SHORT_ABSTRACT);
    const sepPos = text.indexOf('---');
    const bodyPos = text.indexOf('Body C.');
    expect(absPos).toBeGreaterThan(-1);
    expect(absPos).toBeLessThan(sepPos);
    expect(sepPos).toBeLessThan(bodyPos);
  });

  it('US1.6 — node created without abstract reads back identically across all scopes', async () => {
    await addNode({ loc: 'm-nul', content: 'Only content.' });
    expect(await readPersistedAbstract('m-nul')).toBeNull();

    const defaultText = await readNode('m-nul');
    const contentText = await readNode('m-nul', 'content');
    expect(defaultText).toBe(contentText);
    expect(defaultText).toContain('Only content.');
    expect(defaultText).not.toContain('Source: abstract-fallback');
  });

  it("US1.10 — content-fallback: default scope on a content-less abstract-having node emits Source: abstract-fallback + abstract in body slot", async () => {
    await addNode({
      loc: 'archive-only',
      nodeType: 'abstract',
      abstract: PAPER_ABSTRACT,
      // no content
    });
    const text = await readNode('archive-only'); // default = 'content'
    expect(text).toContain('Source: abstract-fallback');
    expect(text).toContain(PAPER_ABSTRACT);
    expect(text).toContain('---');
    // The marker appears in the meta block, BEFORE the body separator
    const markerPos = text.indexOf('Source: abstract-fallback');
    const sepPos = text.indexOf('---');
    expect(markerPos).toBeGreaterThan(-1);
    expect(markerPos).toBeLessThan(sepPos);
  });

  it("US1.11 — contentScope='abstract' on content-less abstract-having node: meta + abstract, NO Source: marker (asymmetric)", async () => {
    await addNode({ loc: 'a-only', abstract: PAPER_ABSTRACT });
    const text = await readNode('a-only', 'abstract');
    expect(text).toContain(PAPER_ABSTRACT);
    expect(text).not.toContain('Source: abstract-fallback'); // marker only fires under 'content' scope
    expect(text).not.toContain('---');
  });

  it("US1.12 — contentScope='all' on content-less abstract-having node: collapses to meta + abstract, no --- (signals no body)", async () => {
    await addNode({ loc: 'all-no-body', abstract: PAPER_ABSTRACT });
    const text = await readNode('all-no-body', 'all');
    expect(text).toContain(PAPER_ABSTRACT);
    expect(text).not.toContain('---');
    expect(text).not.toContain('Source: abstract-fallback');
  });

  it('US1.13 — sparse node (abstract=NULL, content=NULL) under default scope is byte-identical to pre-spec: meta + --- + empty', async () => {
    await addNode({ loc: 'sparse' });
    const text = await readNode('sparse');
    expect(text).toContain('---');
    expect(text).not.toContain('Source: abstract-fallback');
    // Body slot is empty — the response ends after the separator + blank line
    const sepIdx = text.indexOf('---');
    const body = text.slice(sepIdx).replace(/^---\s*/, '');
    expect(body.trim()).toBe('');
  });

  it("contentScope='abstract' on a null-abstract node returns meta block alone, NO --- separator", async () => {
    await addNode({ loc: 'no-abs', content: 'Only content here.' });
    const text = await readNode('no-abs', 'abstract');
    expect(text).not.toContain('---');
    expect(text).not.toContain('Only content here.');
    expect(text).not.toContain('Source: abstract-fallback');
  });

  it("contentScope='all' on a null-abstract node falls back to content shape (meta + --- + content), no Source: marker", async () => {
    await addNode({ loc: 'all-no-abs', content: 'Body only.' });
    const text = await readNode('all-no-abs', 'all');
    expect(text).toContain('Body only.');
    expect(text).toContain('---');
    expect(text).not.toContain('Source: abstract-fallback');
  });
});

// ───── hadron_update_node partial-update semantics (US1.7, US1.8) ──────────────

describe('US1 partial-update semantics — hadron_update_node', () => {
  it('US1.7 — omitting `abstract` preserves the existing value', async () => {
    await addNode({ loc: 'pu1', abstract: SHORT_ABSTRACT });
    await updateNode({ loc: 'pu1', name: 'Renamed' }); // no abstract field
    expect(await readPersistedAbstract('pu1')).toBe(SHORT_ABSTRACT);
  });

  it('US1.8 — explicit `abstract: null` clears the value', async () => {
    await addNode({ loc: 'pu2', abstract: SHORT_ABSTRACT });
    await updateNode({ loc: 'pu2', abstract: null });
    expect(await readPersistedAbstract('pu2')).toBeNull();
  });
});

// ───── invalid contentScope (US1.9) ───────────────────────────────────────

describe('US1 invalid contentScope rejection', () => {
  it("US1.9 — contentScope='something-else' is rejected with allowed-values error", async () => {
    await addNode({ loc: 'iv', abstract: SHORT_ABSTRACT });
    const srv = createTestableMcpServer(adminAuth());
    // hadron_get_node defensively validates the enum and returns the typed
    // error message as the tool result (same convention as hadron_create_node's
    // length-cap path). zod's enum check covers the transport layer.
    const text = await srv.callToolText('hadron_get_node', {
      urn: 'abs-org::absmem::iv',
      contentScope: 'summary',
    });
    expect(text).toContain('Invalid contentScope');
    expect(text).toContain('summary');
    expect(text).toContain("'content' | 'abstract' | 'all'");
  });
});

// ───── FR-008 length cap ──────────────────────────────────────────────────

describe('FR-008 — length-cap rejection', () => {
  it('rejects abstract > 2000 chars on hadron_create_node with a 2000-citing error', async () => {
    const overlong = 'x'.repeat(2001);
    // hadron_create_node surfaces the typed error as a tool-result string (the
    // MCP transport convention) rather than throwing — assert the body.
    const text = await addNode({ loc: 'lc1', abstract: overlong });
    expect(text).toContain('2000');
    expect(text).toContain('2001');
    // No row was created.
    expect(await readPersistedAbstract('lc1')).toBeNull();
    const row = await db.node.findFirst({
      where: { loc: 'lc1', memoryId: fx.memory.id },
    });
    expect(row).toBeNull();
  });

  it('rejects abstract > 2000 chars on hadron_update_node — original value preserved', async () => {
    await addNode({ loc: 'lc2', abstract: 'Original.' });
    const overlong = 'y'.repeat(2001);
    const text = await updateNode({ loc: 'lc2', abstract: overlong });
    expect(text).toContain('2000');
    expect(text).toContain('2001');
    // Original abstract preserved.
    expect(await readPersistedAbstract('lc2')).toBe('Original.');
  });

  it('accepts abstract exactly at the 2000-char cap', async () => {
    const atCap = 'z'.repeat(2000);
    await addNode({ loc: 'lc3', abstract: atCap });
    expect((await readPersistedAbstract('lc3'))?.length).toBe(2000);
  });
});

// ───── FR-009 — empty + whitespace-only normalization ─────────────────────

describe('FR-009 (extended) — trim-then-check normalization', () => {
  it("abstract: '' normalizes to NULL at write time", async () => {
    await addNode({ loc: 'ws1', abstract: '' });
    expect(await readPersistedAbstract('ws1')).toBeNull();
  });

  it("whitespace-only abstract (spaces) normalizes to NULL", async () => {
    await addNode({ loc: 'ws2', abstract: '   ' });
    expect(await readPersistedAbstract('ws2')).toBeNull();
  });

  it("whitespace-only abstract (newlines + tabs) normalizes to NULL", async () => {
    await addNode({ loc: 'ws3', abstract: '\n\n\t \n' });
    expect(await readPersistedAbstract('ws3')).toBeNull();
  });

  it("intentional leading whitespace on a real paragraph persists as-is (not trimmed)", async () => {
    const padded = '  This is a real abstract with leading spaces.';
    await addNode({ loc: 'ws4', abstract: padded });
    expect(await readPersistedAbstract('ws4')).toBe(padded);
  });

  it("hadron_update_node with whitespace-only string clears the abstract", async () => {
    await addNode({ loc: 'ws5', abstract: SHORT_ABSTRACT });
    await updateNode({ loc: 'ws5', abstract: '   ' });
    expect(await readPersistedAbstract('ws5')).toBeNull();
  });
});

// ───── FR-011 — hadron_validate sparse-node rule ───────────────────────────────

describe('FR-011 — hadron_validate sparse-node rule extension', () => {
  async function validate(memoryUrn: string) {
    const srv = createTestableMcpServer(adminAuth());
    return srv.callToolText('hadron_validate', { memoryUrn });
  }

  // #2513: createMemory describes its scaffold root. Keep these assertions
  // focused on each test node so they exercise the sparse rule itself.

  it("flags a sparse node (no description, no content, no abstract) with the new message", async () => {
    await addNode({ loc: 'sp-none' });
    const text = await validate('abs-org::absmem');
    expect(text).toContain('[sparse]');
    expect(text).toContain('sp-none');
    expect(text).toContain('no description, content, or abstract');
  });

  it("does NOT flag a node carrying only an abstract", async () => {
    await addNode({ loc: 'sp-abs', abstract: SHORT_ABSTRACT });
    const text = await validate('abs-org::absmem');
    expect(text).not.toContain('sp-abs');
  });

  it("does NOT flag a node carrying only a description", async () => {
    await addNode({ loc: 'sp-desc', description: 'Just a description.' });
    const text = await validate('abs-org::absmem');
    expect(text).not.toContain('sp-desc');
  });

  it("does NOT flag a node carrying only content", async () => {
    await addNode({ loc: 'sp-con', content: 'Just a body.' });
    const text = await validate('abs-org::absmem');
    expect(text).not.toContain('sp-con');
  });
});
