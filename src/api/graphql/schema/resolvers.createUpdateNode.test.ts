/**
 * Spec 039 Phase 0 (D1–D4) — the createNode / updateNode split contract.
 *
 * What this file pins (the resolver-level selector/mode contract; the write
 * core's field semantics — abstract/tags partial updates, encryption, seq —
 * are pinned by node-abstract.test.ts, node-tags-preserve.test.ts, and
 * resolvers.seqAutoAssign.test.ts):
 *
 *   - createNode is create-only: a live (memoryId, loc) collision rejects
 *     with NodeLocConflictError (D1); `id` is a forced create-PK (D2).
 *   - updateNode identifies the target by `id` (PK or fully-qualified node
 *     URN) XOR (memoryId + loc); both, or neither, is BAD_USER_INPUT (D2).
 *   - updateNode never creates: a missing target is NODE_NOT_FOUND (D3).
 *   - updateNode preserves `name` when omitted (D4).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

// #476 — HTML→Markdown conversion is delegated to hadrontool-pdf; mock the
// client so these tests pin the write-seam behavior without the service.
vi.mock('../../../lib/pdfClient.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  convertHtmlToMarkdown: vi.fn(async (html: string) => ({
    markdown: `converted:${html.length}`,
    title: 'Extracted Title',
  })),
  convertPdfToMarkdown: vi.fn(async (pdfBase64: string) => ({
    markdown: `pdf:${pdfBase64.length}`,
    title: 'PDF Title',
    pageCount: 2,
  })),
}));
import { convertHtmlToMarkdown, convertPdfToMarkdown } from '../../../lib/pdfClient.js';

let orgId: string;
let memoryId: string;
let adminId: string;

// Fully-qualified node-URN prefix (org::memory) — the stored memory urn is
// single-colon; node URNs attach the loc with an explicit `::` (spec 027).
const MEMORY_URN = 'cun-org::cunmem';

function gqlCtx(): Context {
  return { db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` };
}

async function createNode(input: Record<string, unknown>) {
  return resolvers.Mutation.createNode(
    {},
    { input: { memoryId, ...input } as never },
    gqlCtx(),
  );
}

async function updateNode(input: Record<string, unknown>) {
  return resolvers.Mutation.updateNode({}, { input: input as never }, gqlCtx());
}

async function expectCode(p: Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(GraphQLError);
  expect((caught as GraphQLError).extensions?.code).toBe(code);
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'cun-org', urn: 'cun-org' },
  });
  orgId = org.id;
  const admin = await db.user.create({
    data: { githubId: 9971, githubUsername: 'cun-admin', roles: ['ADMIN'] },
  });
  adminId = admin.id;
  await db.orgMember.create({
    data: { organizationId: orgId, userId: adminId, role: 'ADMIN' },
  });
  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId, name: 'cunmem' },
    gqlCtx(),
  );
  memoryId = memory.id;
});

// ───── createNode (D1/D2) ──────────────────────────────────────────────────

describe('createNode — create-only semantics', () => {
  it('creates a fresh node', async () => {
    const node = await createNode({ loc: 'a', name: 'A', content: 'body' });
    expect(node.loc).toBe('a');
    expect(node.name).toBe('A');
  });

  it('rejects a live (memoryId, loc) collision with NodeLocConflictError', async () => {
    await createNode({ loc: 'a', name: 'A' });
    await expectCode(createNode({ loc: 'a', name: 'A2' }), 'NodeLocConflictError');
  });

  it('honors a forced create-PK id (D2: only ever a create-id)', async () => {
    const forced = generateId();
    const node = await createNode({ id: forced, loc: 'pk', name: 'PK' });
    expect(node.id).toBe(forced);
  });
});

// ───── updateNode selector contract (D2) ───────────────────────────────────

describe('updateNode — selector contract', () => {
  it('updates by PK id', async () => {
    const created = await createNode({ loc: 'u1', name: 'U1', content: 'v1' });
    const updated = await updateNode({ id: created.id, content: 'v2' });
    expect(updated.id).toBe(created.id);
    expect(updated.content).toBe('v2');
  });

  it('updates by fully-qualified node URN', async () => {
    await createNode({ loc: 'u2', name: 'U2', content: 'v1' });
    const updated = await updateNode({
      id: `${MEMORY_URN}::u2`,
      content: 'v2',
    });
    expect(updated.content).toBe('v2');
    expect(updated.loc).toBe('u2');
  });

  it('updates by (memoryId, loc)', async () => {
    await createNode({ loc: 'u3', name: 'U3', content: 'v1' });
    const updated = await updateNode({ memoryId, loc: 'u3', content: 'v2' });
    expect(updated.content).toBe('v2');
  });

  it('rejects id + (memoryId, loc) together with BAD_USER_INPUT', async () => {
    const created = await createNode({ loc: 'u4', name: 'U4' });
    await expectCode(
      updateNode({ id: created.id, memoryId, loc: 'u4', content: 'x' }),
      'BAD_USER_INPUT',
    );
  });

  it('rejects a selector-less input with BAD_USER_INPUT', async () => {
    await expectCode(updateNode({ content: 'x' }), 'BAD_USER_INPUT');
  });

  it('rejects loc without memoryId with BAD_USER_INPUT', async () => {
    await expectCode(updateNode({ loc: 'u5', content: 'x' }), 'BAD_USER_INPUT');
  });
});

// ───── updateNode never creates (D3) ───────────────────────────────────────

describe('updateNode — never creates', () => {
  it('missing PK target → NODE_NOT_FOUND', async () => {
    await expectCode(
      updateNode({ id: generateId(), content: 'x' }),
      'NODE_NOT_FOUND',
    );
  });

  it('missing URN target → NODE_NOT_FOUND', async () => {
    await expectCode(
      updateNode({ id: `${MEMORY_URN}::nope`, content: 'x' }),
      'NODE_NOT_FOUND',
    );
  });

  it('missing (memoryId, loc) target → NODE_NOT_FOUND, and no row appears', async () => {
    await expectCode(
      updateNode({ memoryId, loc: 'ghost', content: 'x' }),
      'NODE_NOT_FOUND',
    );
    const row = await db.node.findFirst({ where: { memoryId, loc: 'ghost' } });
    expect(row).toBeNull();
  });
});

// ───── name preserve-on-omit (D4) ──────────────────────────────────────────

describe('updateNode — name preserve-on-omit (D4)', () => {
  it('omitting name preserves the existing one', async () => {
    const created = await createNode({ loc: 'n1', name: 'Original', content: 'v1' });
    const updated = await updateNode({ id: created.id, content: 'v2' });
    expect(updated.name).toBe('Original');
  });

  it('supplying name replaces it', async () => {
    const created = await createNode({ loc: 'n2', name: 'Original' });
    const updated = await updateNode({ id: created.id, name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
  });
});


// ---------------------------------------------------------------------------
// #476 — contentType: text/html conversion at the write seam
// ---------------------------------------------------------------------------

describe('updateNode — the id selector is re-checked under the write lock (#1198)', () => {
  // @codex P1 on PR #1198, pre-existing since PR-460 and reproduced before it
  // was fixed. The `id` selector resolves to (memoryId, loc) OUTSIDE any
  // transaction, and everything guarding the write is checked against THAT
  // address — memory write access, the protected-loc gate, the memory's
  // property schema — while the UPDATE keys on the immutable PK. A moveNode
  // committing in between left the two pointing at different memories, and the
  // write landed on the row at its NEW address: authorized against the memory
  // the caller could write, applied in one that was never consulted.
  //
  // Driven at the writeNodeCore seam rather than by racing two resolvers,
  // because the post-move state is exactly what the race produces and a
  // deterministic test pins it without a timing window. The lock is what makes
  // the re-read authoritative; the assertion is that the write is REFUSED and
  // the row is untouched.
  it('REFUSES a write whose target moved to another memory after it was read', async () => {
    const other = await resolvers.Mutation.createMemory(
      {},
      { orgId, name: 'cunmem-dest' },
      gqlCtx(),
    );
    const node = await createNode({ loc: 'doc:one', name: 'before', content: 'ORIG' });

    // The concurrent move, already committed.
    await db.node.update({
      where: { id: node.id },
      data: { memoryId: other.id, loc: 'moved:here' },
    });

    const { writeNodeCore } = await import('./resolvers.mutation.node.js');
    await expectCode(
      writeNodeCore(
        { memoryId, loc: 'doc:one', name: 'AFTER-MOVE' } as never,
        gqlCtx(),
        'update',
        { targetNodeId: node.id },
      ),
      'NODE_WRITE_CONFLICT',
    );

    // The edit did not land — the assertion that separates a refusal from a
    // refusal-shaped log line.
    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.name).toBe('before');
    expect(after.memoryId).toBe(other.id);
  });

  it('still writes when the target has NOT moved — the refusal is not blanket', async () => {
    // The opposite failure: a re-check that refused everything would satisfy
    // the case above and break every id-selector update in the product.
    const node = await createNode({ loc: 'doc:two', name: 'before' });

    await updateNode({ id: node.id, name: 'after' });

    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).name).toBe('after');
  });

  it('a target RENAMED within the same memory is refused too — loc is half the address', async () => {
    // A move inside one memory changes the loc but not the memoryId, so a
    // re-check comparing only the memory would pass here and write to whatever
    // now sits at the resolved address.
    const node = await createNode({ loc: 'doc:three', name: 'before' });
    await db.node.update({ where: { id: node.id }, data: { loc: 'doc:elsewhere' } });

    const { writeNodeCore } = await import('./resolvers.mutation.node.js');
    await expectCode(
      writeNodeCore(
        { memoryId, loc: 'doc:three', name: 'AFTER-MOVE' } as never,
        gqlCtx(),
        'update',
        { targetNodeId: node.id },
      ),
      'NODE_WRITE_CONFLICT',
    );
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).name).toBe('before');
  });
});

describe('#476 — contentType HTML→Markdown conversion', () => {
  it('explicit contentType: null is consumed and stores content as-is (PR-486 Codex P2)', async () => {
    const node = await createNode({
      loc: 'ct:null',
      name: 'CTNull',
      content: '# already markdown',
      contentType: null,
    });
    expect(node.content).toBe('# already markdown');
    expect(convertHtmlToMarkdown).not.toHaveBeenCalled();
  });

  it('text/html content is converted and the extracted title fills properties.title', async () => {
    const node = await createNode({
      memoryId, loc: 'cun:html-1', name: 'Import',
      content: '<h1>Hi</h1>', contentType: 'text/html',
    });
    expect(node.content).toBe('converted:11'); // '<h1>Hi</h1>'.length
    expect((node.properties as Record<string, unknown>)?.title).toBe('Extracted Title');
    expect(convertHtmlToMarkdown).toHaveBeenCalledWith('<h1>Hi</h1>');
    // contentType is consumed, never persisted anywhere on the row.
    const row = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'cun:html-1' } });
    expect(JSON.stringify(row)).not.toContain('text/html');
  });

  it('a caller-supplied properties.title wins over the extracted one', async () => {
    const node = await createNode({
      memoryId, loc: 'cun:html-2', name: 'Import',
      content: '<p>x</p>', contentType: 'text/html',
      properties: { title: 'Mine' },
    });
    expect((node.properties as Record<string, unknown>)?.title).toBe('Mine');
  });

  it('text/markdown (and case-variants) is a stored-as-is no-op', async () => {
    const node = await createNode({
      memoryId, loc: 'cun:md-1', name: 'MD',
      content: '# raw', contentType: 'Text/Markdown',
    });
    expect(node.content).toBe('# raw');
  });

  it('an unsupported contentType rejects with BAD_USER_INPUT', async () => {
    await expect(
      createNode({ memoryId, loc: 'cun:bad-ct', name: 'x', content: 'x', contentType: 'application/json' }),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('application/pdf content is extracted and the PDF title fills properties.title (#488)', async () => {
    vi.mocked(convertHtmlToMarkdown).mockClear();
    const node = await createNode({
      memoryId, loc: 'cun:pdf-1', name: 'Paper',
      content: 'JVBERi0=', contentType: 'application/pdf',
    });
    expect(node.content).toBe('pdf:8'); // 'JVBERi0='.length
    expect((node.properties as Record<string, unknown>)?.title).toBe('PDF Title');
    expect(convertPdfToMarkdown).toHaveBeenCalledWith('JVBERi0=');
    expect(convertHtmlToMarkdown).not.toHaveBeenCalled();
    // contentType is consumed, never persisted anywhere on the row.
    const row = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'cun:pdf-1' } });
    expect(JSON.stringify(row)).not.toContain('application/pdf');
  });

  it('updateNode converts too (same seam)', async () => {
    await createNode({ memoryId, loc: 'cun:html-3', name: 'U', content: 'plain' });
    const updated = await (resolvers.Mutation as any).updateNode(
      {},
      { input: { memoryId, loc: 'cun:html-3', content: '<b>new</b>', contentType: 'text/html' } },
      gqlCtx(),
    );
    expect(updated.content).toBe('converted:10'); // '<b>new</b>'.length
  });

  it('empty/omitted content with text/html is a no-op (no service call)', async () => {
    vi.mocked(convertHtmlToMarkdown).mockClear();
    await createNode({ memoryId, loc: 'cun:html-4', name: 'E', contentType: 'text/html' });
    expect(convertHtmlToMarkdown).not.toHaveBeenCalled();
  });
});
