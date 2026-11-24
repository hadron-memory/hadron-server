/**
 * #395 (cor:int:020:02, Holger R8/R9): `nodeExport(format: PDF)` prints the node's content always, and the
 * sections the caller names are ADDED after it, in the fixed order Abstract, Data, Properties, Edges, Metadata
 * (Comments is scoped out until Holger answers the spec's Q1), Data and Properties as two-column tables, Edges
 * as a list, an empty section left out. `full` is ignored for a PDF. The PDF service is mocked: what the
 * resolver hands it is the Markdown this slice owns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../lib/pdfClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/pdfClient.js')>()),
  renderMarkdownToPdf: vi.fn(async () => ({ base64: 'UERG', bytes: 3 })),
}));
const { renderMarkdownToPdf } = await import('../../../lib/pdfClient.js');

const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

let memoryId: string;
let readerId: string;
let strangerId: string;
let nodeId: string;
let emptyId: string;
const ctx = (userId = readerId): Context => ({ db, userId, roles: [] });

/** The Markdown the resolver handed the PDF service on its last call. */
const printed = () => {
  const calls = vi.mocked(renderMarkdownToPdf).mock.calls;
  return calls[calls.length - 1]![0] as string;
};
const exportPdf = (args: Record<string, unknown> = {}, id = nodeId, c = ctx()) =>
  Q.nodeExport({}, { id, format: 'PDF', ...args }, c);
/** Index of a section heading in the printed Markdown, so an order can be asserted. */
const at = (heading: string) => printed().indexOf(`## ${heading}`);

beforeEach(async () => {
  await cleanDb(db);
  vi.mocked(renderMarkdownToPdf).mockClear();
  const org = await db.organization.create({ data: { id: generateId(), name: 'Pdf395', urn: 'pdf395' } });
  const reader = await db.user.create({ data: { id: generateId(), handle: 'pdf395-reader' } });
  const stranger = await db.user.create({ data: { id: generateId(), handle: 'pdf395-stranger' } });
  readerId = reader.id;
  strangerId = stranger.id;
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: reader.id, role: 'READER' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'pdf395:kb', name: 'kb', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  memoryId = memory.id;
  const part = await db.node.create({ data: { id: generateId(), memoryId, loc: 'guide:part', name: 'Part', content: 'INCLUDED-PART-TEXT' } });
  const target = await db.node.create({ data: { id: generateId(), memoryId, loc: 'guide:more', name: 'More', tags: [] } });
  const node = await db.node.create({
    data: {
      id: generateId(), memoryId, loc: 'guide:intro', name: 'Intro', description: 'One-liner', alias: 'intro-alias',
      abstract: 'A longer summary.', content: `Body text.\n\n{{> ${part.loc}}}`, tags: ['guide', 'intro'],
      data: { region: 'EU', score: 7 }, properties: { owner: 'ops', tier: 'gold' },
    },
  });
  nodeId = node.id;
  await db.edge.create({
    data: { id: generateId(), memoryId, sourceId: node.id, targetId: target.id, loc: 'guide:intro:next:guide:more', name: 'next', description: 'what follows' },
  });
  const empty = await db.node.create({ data: { id: generateId(), memoryId, loc: 'guide:empty', name: 'Empty one', content: '', tags: [] } });
  emptyId = empty.id;
});

describe('#395 a PDF prints the content, and added sections follow it', () => {
  it('names no sections: the content only, the include resolved (as today)', async () => {
    const out = await exportPdf();
    expect(out).toMatchObject({ format: 'PDF', mimeType: 'application/pdf', encoding: 'BASE64', data: 'UERG' });
    expect(printed()).toContain('Body text.');
    expect(printed()).toContain('INCLUDED-PART-TEXT');
    expect(printed()).not.toContain('{{>');
    expect(printed()).not.toMatch(/^## /m);
  });

  it('ABSTRACT adds the abstract after the content', async () => {
    await exportPdf({ sections: ['ABSTRACT'] });
    expect(printed()).toContain('## Abstract');
    expect(printed()).toContain('A longer summary.');
    expect(printed().indexOf('INCLUDED-PART-TEXT')).toBeLessThan(at('Abstract'));
  });

  it('DATA adds a two-column table', async () => {
    await exportPdf({ sections: ['DATA'] });
    expect(printed()).toContain('## Data');
    expect(printed()).toMatch(/\| Key \| Value \|\n\| --- \| --- \|\n\| region \| EU \|\n\| score \| 7 \|/);
  });

  it('PROPERTIES adds a two-column table', async () => {
    await exportPdf({ sections: ['PROPERTIES'] });
    expect(printed()).toContain('## Properties');
    expect(printed()).toMatch(/\| Key \| Value \|\n\| --- \| --- \|\n\| owner \| ops \|\n\| tier \| gold \|/);
  });

  it('EDGES adds a list', async () => {
    await exportPdf({ sections: ['EDGES'] });
    expect(printed()).toContain('## Edges');
    expect(printed()).toMatch(/^- next → guide:more — what follows$/m);
  });

  it('METADATA adds a block (a list under a heading, never YAML frontmatter)', async () => {
    await exportPdf({ sections: ['METADATA'] });
    expect(printed()).toContain('## Metadata');
    expect(printed()).toMatch(/^- Loc: guide:intro$/m);
    expect(printed()).toMatch(/^- Alias: intro-alias$/m);
    expect(printed()).toMatch(/^- Tags: guide, intro$/m);
    expect(printed()).not.toMatch(/^---$/m);
  });

  it('CONTENT is a no-op: the same Markdown as naming nothing', async () => {
    await exportPdf();
    const bare = printed();
    await exportPdf({ sections: ['CONTENT'] });
    expect(printed()).toBe(bare);
  });
});

describe('#395 the fixed order, whatever the caller named', () => {
  it('prints Abstract, Data, Properties, Edges, Metadata for any request order', async () => {
    await exportPdf({ sections: ['METADATA', 'EDGES', 'PROPERTIES', 'DATA', 'ABSTRACT'] });
    const order = ['Abstract', 'Data', 'Properties', 'Edges', 'Metadata'].map(at);
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    await exportPdf({ sections: ['ABSTRACT', 'DATA', 'PROPERTIES', 'EDGES', 'METADATA'] });
    expect(['Abstract', 'Data', 'Properties', 'Edges', 'Metadata'].map(at)).toEqual(order);
  });

  it('a request naming Edges then Abstract prints the abstract first (the spec example)', async () => {
    await exportPdf({ sections: ['EDGES', 'ABSTRACT'] });
    expect(at('Abstract')).toBeGreaterThan(0);
    expect(at('Abstract')).toBeLessThan(at('Edges'));
  });

  it('an added section is ADDED, not an exact set: the content stays when CONTENT is not named', async () => {
    await exportPdf({ sections: ['DATA'] });
    expect(printed()).toContain('Body text.');
    expect(printed()).not.toContain('## Abstract');
    expect(printed()).not.toContain('## Edges');
  });

  it('the same section named twice prints once', async () => {
    await exportPdf({ sections: ['DATA', 'DATA'] });
    expect(printed().match(/^## Data$/gm)).toHaveLength(1);
  });
});

describe('#395 an empty section is left out; the title fallback is intact', () => {
  it('a section with nothing in it prints no heading', async () => {
    const bare = await db.node.create({ data: { id: generateId(), memoryId, loc: 'guide:bare', name: 'Bare', content: 'Only content.', tags: [] } });
    await exportPdf({ sections: ['ABSTRACT', 'DATA', 'PROPERTIES', 'EDGES'] }, bare.id);
    expect(printed()).toBe('Only content.');
  });

  it('empty content and no sections: the # <name> fallback', async () => {
    await exportPdf({}, emptyId);
    expect(printed()).toBe('# Empty one');
  });

  it('empty content with an added section: the fallback title, then the section', async () => {
    await db.node.update({ where: { id: emptyId }, data: { abstract: 'Only an abstract.' } });
    await exportPdf({ sections: ['ABSTRACT'] }, emptyId);
    expect(printed()).toBe('# Empty one\n\n## Abstract\n\nOnly an abstract.');
  });

  it('a Data value that is not an object prints as a fenced JSON block; an empty array is left out', async () => {
    await db.node.update({ where: { id: nodeId }, data: { data: [1, 2], properties: [] } });
    await exportPdf({ sections: ['DATA', 'PROPERTIES'] });
    expect(printed()).toContain('## Data\n\n```json\n[\n  1,\n  2\n]\n```');
    expect(printed()).not.toContain('## Properties');
  });

  it('a cell with a pipe or a newline cannot break the table', async () => {
    await db.node.update({ where: { id: nodeId }, data: { data: { note: 'a|b\nc' } } });
    await exportPdf({ sections: ['DATA'] });
    expect(printed()).toContain('| note | a\\|b c |');
  });
});

describe('#395 `full` is ignored for a PDF; read access is unchanged', () => {
  it('full: true and full: false give the same Markdown', async () => {
    await exportPdf({ sections: ['ABSTRACT', 'DATA'], full: true });
    const asTrue = printed();
    await exportPdf({ sections: ['ABSTRACT', 'DATA'], full: false });
    expect(printed()).toBe(asTrue);
    await exportPdf({ full: true });
    const bareTrue = printed();
    await exportPdf({ full: false });
    expect(printed()).toBe(bareTrue);
  });

  it('a caller who may not read the node gets NOT_FOUND and no PDF is rendered', async () => {
    await expect(exportPdf({ sections: ['ABSTRACT', 'DATA', 'EDGES', 'METADATA'] }, nodeId, ctx(strangerId)))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(renderMarkdownToPdf).not.toHaveBeenCalled();
  });

  it('the schema has no COMMENTS section (scoped out until Q1)', async () => {
    const { typeDefs } = await import('./typeDefs.js');
    const { buildSchema } = await import('graphql');
    const values = (buildSchema(typeDefs).getType('NodeExportSection') as import('graphql').GraphQLEnumType).getValues().map((v) => v.name);
    expect(values).toEqual(['METADATA', 'CONTENT', 'ABSTRACT', 'DATA', 'PROPERTIES', 'EDGES']);
  });
});
