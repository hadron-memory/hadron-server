/**
 * #457 — importNode (sync v1) resolver contract.
 *
 * What this file pins:
 *   - source XOR (url | content) and target XOR (nodeUrn | memoryId+loc).
 *   - content path: HTML→Markdown at the write seam (pdfClient mocked),
 *     text/html default, text/markdown passthrough.
 *   - url path: fetch (mocked) → Readability (mocked) → convert → store;
 *     whole-page fallback when extraction returns null; properties.url
 *     provenance; no user credentials is webFetch's contract, not tested here.
 *   - conflict semantics: UPDATE IN PLACE with a NodeRevision snapshot, and
 *     the curated-name preservation rule on re-import.
 *   - result shape: STORED, node set, jobId null.
 *
 * The egress guard itself is unit-tested in src/lib/webFetch.test.ts;
 * extractArticle in src/lib/articleExtract.test.ts.
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

vi.mock('../../../lib/pdfClient.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  convertHtmlToMarkdown: vi.fn(async (html: string) => ({
    markdown: `md:${html}`,
    title: 'Converter Title',
  })),
  convertPdfToMarkdown: vi.fn(async (pdfBase64: string) => ({
    markdown: `pdfmd:${pdfBase64}`,
    title: 'PDF Title',
    pageCount: 3,
  })),
}));

vi.mock('../../../lib/webFetch.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchWebPage: vi.fn(async (url: string) => ({
    html: `<html><body><p>fetched from ${url}</p></body></html>`,
    finalUrl: url,
  })),
}));

vi.mock('../../../lib/articleExtract.js', () => ({
  extractArticle: vi.fn(() => ({
    contentHtml: '<article>extracted</article>',
    title: 'Readability Title',
  })),
}));

import { fetchWebPage } from '../../../lib/webFetch.js';
import { extractArticle } from '../../../lib/articleExtract.js';
import { convertHtmlToMarkdown, convertPdfToMarkdown } from '../../../lib/pdfClient.js';

let memoryId: string;
let adminId: string;
const MEMORY_URN = 'imp-org::impmem';

function gqlCtx(): Context {
  return { db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` };
}

async function importNode(input: Record<string, unknown>) {
  return resolvers.Mutation.importNode({}, { input: input as never }, gqlCtx());
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
  vi.clearAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'imp-org', urn: 'imp-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 9981, githubUsername: 'imp-admin', roles: ['ADMIN'] },
  });
  adminId = admin.id;
  await db.orgMember.create({
    data: { organizationId: org.id, userId: adminId, role: 'ADMIN' },
  });
  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'impmem' },
    gqlCtx(),
  );
  memoryId = memory.id;
});

// ───── input contract ───────────────────────────────────────────────────────

describe('importNode — input contract', () => {
  it('rejects url AND content', async () => {
    await expectCode(
      importNode({ memoryId, loc: 'x', url: 'https://a.example', content: '<p>b</p>' }),
      'BAD_USER_INPUT',
    );
  });

  it('rejects neither url nor content', async () => {
    await expectCode(importNode({ memoryId, loc: 'x' }), 'BAD_USER_INPUT');
  });

  it('rejects nodeUrn AND memoryId+loc', async () => {
    await expectCode(
      importNode({ nodeUrn: `${MEMORY_URN}::x`, memoryId, loc: 'x', content: '<p>a</p>' }),
      'BAD_USER_INPUT',
    );
  });

  it('rejects a target-less input', async () => {
    await expectCode(importNode({ content: '<p>a</p>' }), 'BAD_USER_INPUT');
  });

  it('rejects loc without memoryId', async () => {
    await expectCode(importNode({ loc: 'x', content: '<p>a</p>' }), 'BAD_USER_INPUT');
  });

  it('treats empty-string selectors as absent (PR-486 review)', async () => {
    await expectCode(importNode({ memoryId: '', loc: '', content: '<p>a</p>' }), 'BAD_USER_INPUT');
    // '' selectors are ABSENT, so nodeUrn alongside them stays valid.
    const res = await importNode({
      nodeUrn: `${MEMORY_URN}::clips:emptysel`,
      memoryId: '',
      loc: '',
      content: '<p>a</p>',
    });
    expect(res.status).toBe('STORED');
  });

  it('an empty-string contentType falls back to the text/html default', async () => {
    const res = await importNode({
      memoryId,
      loc: 'clips:ctdefault',
      content: '<p>c</p>',
      contentType: '',
    });
    expect(res.node.content).toBe('md:<p>c</p>');
  });
});

// ───── authorization ordering (Codex P1) ────────────────────────────────────

describe('importNode — authorization precedes any fetch', () => {
  it('a caller without write access is denied BEFORE fetchWebPage runs', async () => {
    const outsider = await db.user.create({
      data: { githubId: 9982, githubUsername: 'imp-outsider', roles: ['READER'] },
    });
    const outsiderCtx: Context = {
      db,
      roles: ['READER'],
      userId: outsider.id,
      clientId: `user:${outsider.id}`,
    };
    let caught: unknown;
    try {
      await resolvers.Mutation.importNode(
        {},
        { input: { memoryId, loc: 'clips:denied', url: 'https://example.com/x' } as never },
        outsiderCtx,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    // The load-bearing assertion: no egress happened for the denied caller.
    expect(fetchWebPage).not.toHaveBeenCalled();
  });
});

// ───── content path ─────────────────────────────────────────────────────────

describe('importNode — inline content path (sync)', () => {
  it('stores converted HTML with defaults and returns STORED', async () => {
    const res = await importNode({
      memoryId,
      loc: 'clips:one',
      content: '<p>hello</p>',
    });
    expect(res.status).toBe('STORED');
    expect(res.jobId).toBeNull();
    expect(res.node.content).toBe('md:<p>hello</p>');
    expect(res.node.nodeType).toBe('webpage');
    // Converter title fills properties.title (the #476 seam), and the leaf
    // fallback names the fresh node (no caller name, content path).
    expect((res.node.properties as { title?: string }).title).toBe('Converter Title');
    expect(res.node.name).toBe('one');
  });

  it('text/markdown passes through unconverted', async () => {
    const res = await importNode({
      memoryId,
      loc: 'clips:md',
      content: '# already markdown',
      contentType: 'text/markdown',
    });
    expect(res.node.content).toBe('# already markdown');
    expect(convertHtmlToMarkdown).not.toHaveBeenCalled();
  });

  it('application/pdf extracts to Markdown, defaults nodeType to info (#488)', async () => {
    const res = await importNode({
      memoryId,
      loc: 'clips:paper',
      content: 'JVBERi0=', // stand-in base64 (the real decode happens in the tool)
      contentType: 'application/pdf',
    });
    expect(res.status).toBe('STORED');
    expect(convertPdfToMarkdown).toHaveBeenCalledWith('JVBERi0=');
    expect(convertHtmlToMarkdown).not.toHaveBeenCalled();
    expect(res.node.content).toBe('pdfmd:JVBERi0=');
    // PDF imports are plain 'info', not 'webpage'.
    expect(res.node.nodeType).toBe('info');
    // Extracted PDF title fills properties.title.
    expect((res.node.properties as { title?: string }).title).toBe('PDF Title');
  });

  it('a caller-supplied nodeType overrides the application/pdf default', async () => {
    const res = await importNode({
      memoryId,
      loc: 'clips:paper2',
      content: 'JVBERi0=',
      contentType: 'application/pdf',
      nodeType: 'record',
    });
    expect(res.node.nodeType).toBe('record');
  });

  it('accepts a nodeUrn target that does not exist yet', async () => {
    const res = await importNode({
      nodeUrn: `${MEMORY_URN}::clips:via-urn`,
      content: '<p>u</p>',
    });
    expect(res.node.loc).toBe('clips:via-urn');
    expect(res.node.memoryId).toBe(memoryId);
  });
});

// ───── url path ─────────────────────────────────────────────────────────────

describe('importNode — url path (sync v1)', () => {
  it('fetches, extracts, converts, and stores with provenance', async () => {
    const res = await importNode({
      memoryId,
      loc: 'clips:web',
      url: 'https://example.com/article',
    });
    expect(fetchWebPage).toHaveBeenCalledWith('https://example.com/article');
    expect(extractArticle).toHaveBeenCalled();
    // The EXTRACTED article (not the raw page) goes through conversion.
    expect(res.node.content).toBe('md:<article>extracted</article>');
    // Provenance + name from the Readability title.
    expect((res.node.properties as { url?: string }).url).toBe('https://example.com/article');
    expect(res.node.name).toBe('Readability Title');
    expect(res.status).toBe('STORED');
  });

  it('falls back to the whole page when Readability finds no article', async () => {
    vi.mocked(extractArticle).mockReturnValueOnce(null);
    const res = await importNode({ memoryId, loc: 'clips:raw', url: 'https://example.com/x' });
    expect(res.node.content).toBe('md:<html><body><p>fetched from https://example.com/x</p></body></html>');
    // No article title → leaf fallback on a fresh node.
    expect(res.node.name).toBe('raw');
  });

  it('does not overwrite a caller-supplied properties.url', async () => {
    const res = await importNode({
      memoryId,
      loc: 'clips:prov',
      url: 'https://example.com/final',
      properties: { url: 'https://example.com/original-share-link' },
    });
    expect((res.node.properties as { url?: string }).url).toBe(
      'https://example.com/original-share-link',
    );
  });
});

// ───── conflict semantics ───────────────────────────────────────────────────

describe('importNode — update in place (handoff decision 3)', () => {
  it('requires the current author task when re-importing a role-governed node', async () => {
    const task = await db.node.create({
      data: { id: generateId(), memoryId, loc: 'tasks:import', name: 'Import task', isRunnable: true },
    });
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId } });
    await db.nodeRoleRule.create({
      data: { id: generateId(), configId: config.id, role: 'guide', authorTaskId: task.id, authorTaskRequired: true },
    });
    const target = await db.node.create({
      data: { id: generateId(), memoryId, loc: 'clips:governed', name: 'Guide', role: 'guide', content: 'original' },
    });
    const input = { memoryId, loc: target.loc, content: 'replacement', contentType: 'text/markdown' };

    await expectCode(importNode(input), 'AUTHOR_TASK_MISSING');
    await expectCode(importNode({ ...input, authoredWith: { task: task.id, revision: 2 } }), 'AUTHOR_TASK_STALE_REVISION');
    expect((await db.node.findUniqueOrThrow({ where: { id: target.id } })).content).toBe('original');
    expect(await db.nodeRevision.count({ where: { nodeId: target.id } })).toBe(0);

    const stored = await importNode({ ...input, authoredWith: { task: task.id, revision: 1 } });
    expect(stored.node).toMatchObject({ id: target.id, content: 'replacement', authoredByTask: task.id, authoredByRevision: 1 });
  });

  it('re-import overwrites content, snapshots a NodeRevision, preserves the curated name', async () => {
    const created = await resolvers.Mutation.createNode(
      {},
      {
        input: {
          memoryId,
          loc: 'clips:existing',
          name: 'Curated Name',
          content: 'original body',
        } as never,
      },
      gqlCtx(),
    );
    const res = await importNode({
      memoryId,
      loc: 'clips:existing',
      content: '<p>replacement</p>',
    });
    expect(res.node.id).toBe(created.id);
    expect(res.node.content).toBe('md:<p>replacement</p>');
    // No caller name, no Readability title (content path) → preserved.
    expect(res.node.name).toBe('Curated Name');
    // The undo path: prior state snapshotted.
    const versions = await db.nodeRevision.findMany({ where: { nodeId: created.id } });
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions.some((v) => v.content === 'original body')).toBe(true);
  });

  it('a caller-supplied name DOES replace the existing one', async () => {
    await resolvers.Mutation.createNode(
      {},
      { input: { memoryId, loc: 'clips:rename', name: 'Old', content: 'x' } as never },
      gqlCtx(),
    );
    const res = await importNode({
      memoryId,
      loc: 'clips:rename',
      content: '<p>y</p>',
      name: 'New Name',
    });
    expect(res.node.name).toBe('New Name');
  });
});
