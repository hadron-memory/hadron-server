import { stringify } from 'yaml';
import {
  buildNodeFrontmatter,
  buildEdgeFrontmatter,
  type EdgeForGit,
} from '../integrations/github/nodeFrontmatter.js';
import { computeContentHash } from './contentHash.js';

/**
 * Single-node file renderer (#386). Produces the canonical, portable
 * single-node file — byte-identical to `hadron node export <urn>` — plus a
 * presentation variant that includes only selected sections.
 *
 * The canonical path reuses the SAME serializers the git mirror and the CLI's
 * `nodedoc` codec agree on (`buildNodeFrontmatter` + `buildEdgeFrontmatter`,
 * aligned in #387) and `computeContentHash`, so there is one format, not a
 * third copy that can drift. Phase 1 covers MD + JSON; HTML/PDF + asset-URL
 * delivery are deferred (the result shape is forward-compatible).
 */

// PDF is a valid export format at the API boundary, but it is NOT rendered
// here — it is produced by the external hadrontool-pdf service from the
// Markdown renderPdfMarkdown builds (see renderMarkdownToPdf). renderNodeExport
// below handles only the text formats (MD/JSON) and rejects PDF defensively.
export type NodeExportFormat = 'MD' | 'JSON' | 'PDF';
export type NodeExportSection =
  | 'METADATA'
  | 'CONTENT'
  | 'ABSTRACT'
  | 'DATA'
  | 'PROPERTIES'
  | 'EDGES';

export const ALL_SECTIONS: readonly NodeExportSection[] = [
  'METADATA',
  'CONTENT',
  'ABSTRACT',
  'DATA',
  'PROPERTIES',
  'EDGES',
];

/** The node projection the renderer needs. `edges` is already in EdgeForGit
 *  shape (a Prisma edge row with `target` included satisfies it directly). */
export interface ExportNode {
  id: string;
  memoryUrn: string;
  loc: string;
  name: string;
  nodeType?: string | null;
  /** #1340: the collection discriminator (#725). */
  objectType?: string | null;
  alias?: string | null;
  description?: string | null;
  abstract?: string | null;
  abstractOriginHash?: string | null;
  content?: string | null;
  tags: string[];
  seq?: number | null;
  /** #1340: the governed-kind signals. Null is "no opinion", distinct from an
   *  explicit `isRunnable: false`, exactly as the git mirror carries them. */
  role?: string | null;
  isRunnable?: boolean | null;
  data?: unknown;
  properties?: unknown;
  edges: EdgeForGit[];
}

// Which frontmatter / JSON keys belong to which section, for the presentation
// (full=false) filter. Identity + housekeeping live under METADATA; the rest
// map one-to-one.
const FRONTMATTER_KEY_SECTION: Record<string, NodeExportSection> = {
  name: 'METADATA', id: 'METADATA', loc: 'METADATA', memory: 'METADATA',
  alias: 'METADATA', type: 'METADATA', objectType: 'METADATA', description: 'METADATA',
  contentHash: 'METADATA', tags: 'METADATA', seq: 'METADATA',
  role: 'METADATA', runnable: 'METADATA',
  abstract: 'ABSTRACT', abstractOriginHash: 'ABSTRACT',
  data: 'DATA', properties: 'PROPERTIES', nodes: 'EDGES',
};
const JSON_KEY_SECTION: Record<string, NodeExportSection> = {
  id: 'METADATA', memory: 'METADATA', loc: 'METADATA', name: 'METADATA',
  type: 'METADATA', objectType: 'METADATA', alias: 'METADATA', description: 'METADATA',
  contentHash: 'METADATA', tags: 'METADATA', seq: 'METADATA',
  role: 'METADATA', isRunnable: 'METADATA',
  abstract: 'ABSTRACT', abstractOriginHash: 'ABSTRACT',
  data: 'DATA', properties: 'PROPERTIES', content: 'CONTENT', edges: 'EDGES',
};

/**
 * The canonical standalone YAML-frontmatter object, in the CLI's field order:
 * name, id, loc, memory, alias, type, objectType, description, abstract,
 * abstractOriginHash, contentHash, tags, seq, role, runnable, data, properties,
 * nodes. `objectType`/`role`/`runnable` are emitted only when set (#1340 —
 * `runnable: false` is set, and kept). `loc`/`memory` are the two
 * self-describing keys a standalone file carries (injected right after `id`),
 * and `contentHash` is recomputed from the content (`hadron node export`'s rule).
 */
function canonicalFrontmatter(n: ExportNode): Record<string, unknown> {
  const fm = buildNodeFrontmatter(
    {
      id: n.id,
      name: n.name,
      nodeType: n.nodeType,
      objectType: n.objectType,
      alias: n.alias,
      description: n.description,
      abstract: n.abstract,
      abstractOriginHash: n.abstractOriginHash,
      contentHash: computeContentHash(n.content),
      tags: n.tags,
      seq: n.seq,
      role: n.role,
      isRunnable: n.isRunnable,
      data: n.data,
      properties: n.properties,
    },
    n.edges,
  );
  // buildNodeFrontmatter always leads with { name, id, ... }; re-seat loc/memory
  // immediately after id without disturbing the rest of the order.
  const { name, id, ...rest } = fm as { name: unknown; id: unknown } & Record<string, unknown>;
  return { name, id, loc: n.loc, memory: n.memoryUrn, ...rest };
}

function frameMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return body === '' ? '' : `${body}\n`;
  const fmYaml = stringify(frontmatter, { lineWidth: 0 }).trim();
  return `---\n${fmYaml}\n---\n\n${body}\n`;
}

/** Canonical MD — byte-identical to `hadron node export <urn> --format md`. */
export function renderCanonicalMarkdown(n: ExportNode): string {
  return frameMarkdown(canonicalFrontmatter(n), n.content ?? '');
}

/** Presentation MD — only the selected sections (frontmatter keys filtered;
 *  body included only when CONTENT is selected). Not guaranteed round-trippable. */
export function renderSectionedMarkdown(n: ExportNode, sections: Set<NodeExportSection>): string {
  const full = canonicalFrontmatter(n);
  const fm: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(full)) {
    if (sections.has(FRONTMATTER_KEY_SECTION[key])) fm[key] = value;
  }
  const body = sections.has('CONTENT') ? n.content ?? '' : '';
  return frameMarkdown(fm, body);
}

function jsonEdge(e: EdgeForGit): Record<string, unknown> {
  // Field order matches the CLI's nodedoc Edge json tags: targetId, targetLoc,
  // name, loc?, description?, isRunnable?, condition (always, null), priority
  // (always, 0). loc/description omitted when empty; isRunnable omitted when false.
  const o: Record<string, unknown> = {
    targetId: e.target.id,
    targetLoc: e.target.loc ?? '',
    name: e.name ?? '',
  };
  if (e.loc) o.loc = e.loc;
  if (e.description) o.description = e.description;
  if (e.isRunnable) o.isRunnable = true;
  o.condition = e.condition ?? null;
  o.priority = typeof e.priority === 'number' ? e.priority : 0;
  return o;
}

/** The canonical JSON Document object, in the CLI's struct order. All fields
 *  present (empty string / null for absent), `contentHash` recomputed, `type`
 *  blank for the default `info`. #1340: `objectType` is `""` when unset (a
 *  string field, like `alias`); `role`/`isRunnable` are pointer fields in the
 *  CLI's Document, so unset is `null`, and an explicit `false` stays `false`. */
function canonicalJsonDocument(n: ExportNode): Record<string, unknown> {
  const type = n.nodeType && n.nodeType !== 'info' ? n.nodeType : '';
  return {
    id: n.id,
    memory: n.memoryUrn,
    loc: n.loc,
    name: n.name,
    type,
    objectType: n.objectType ?? '',
    alias: n.alias ?? '',
    description: n.description ?? '',
    abstract: n.abstract ?? '',
    abstractOriginHash: n.abstractOriginHash ?? '',
    contentHash: computeContentHash(n.content) ?? '',
    tags: n.tags ?? [],
    seq: n.seq ?? null,
    role: n.role ?? null,
    isRunnable: n.isRunnable ?? null,
    data: n.data ?? null,
    properties: n.properties ?? null,
    content: n.content ?? '',
    edges: n.edges.filter((e) => e && e.target).map(jsonEdge),
  };
}

/** Canonical JSON — byte-identical to `hadron node export <urn> --format json`. */
export function renderCanonicalJson(n: ExportNode): string {
  return JSON.stringify(canonicalJsonDocument(n), null, 2) + '\n';
}

/** Presentation JSON — only the selected sections' fields. */
export function renderSectionedJson(n: ExportNode, sections: Set<NodeExportSection>): string {
  const full = canonicalJsonDocument(n);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(full)) {
    if (sections.has(JSON_KEY_SECTION[key])) out[key] = value;
  }
  return JSON.stringify(out, null, 2) + '\n';
}

/**
 * The fixed order a PDF prints its ADDED sections in, whatever order the caller named them (cor:int:020:02,
 * Holger R9, #395). Comments belongs between Edges and Metadata and is scoped out until the spec's Q1
 * (which comments) is answered, so it is not an enum value and not printed.
 */
const PDF_SECTION_ORDER: readonly NodeExportSection[] = ['ABSTRACT', 'DATA', 'PROPERTIES', 'EDGES', 'METADATA'];

/** One line of Markdown for a table cell or list value: no newline, and every backslash and pipe escaped, so a value such as `a\\|b` cannot end a cell early. */
function inlineText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return text.replace(/\r?\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** Data and Properties: a two-column table for an object, a fenced block for any other non-empty JSON. */
function jsonSection(heading: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // An empty string is as empty as `{}` or `[]` (0 and false are values and print).
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    // Keys sorted: jsonb stores an object's keys by length, not insertion, so the table's row order must not depend on it.
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length === 0) return null;
    const rows = entries.map(([key, v]) => `| ${inlineText(key)} | ${inlineText(v)} |`);
    return `## ${heading}\n\n| Key | Value |\n| --- | --- |\n${rows.join('\n')}`;
  }
  if (Array.isArray(value) && value.length === 0) return null;
  return `## ${heading}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function pdfSection(n: ExportNode, section: NodeExportSection): string | null {
  switch (section) {
    case 'ABSTRACT':
      return n.abstract && n.abstract.trim() ? `## Abstract\n\n${n.abstract}` : null;
    case 'DATA':
      return jsonSection('Data', n.data);
    case 'PROPERTIES':
      return jsonSection('Properties', n.properties);
    case 'EDGES': {
      // An edge with no resolvable target is left out, like any other empty entry (the resolver has already kept
      // only live targets in readable memories). Only outgoing edges are listed, as in the MD/JSON export.
      const items = n.edges
        .filter((e) => e && e.target)
        .map((e) => {
          const note = e.description ? ` — ${inlineText(e.description)}` : '';
          return `- ${inlineText(e.name || '(edge)')} → ${inlineText(e.target.loc || e.target.id)}${note}`;
        });
      return items.length > 0 ? `## Edges\n\n${items.join('\n')}` : null;
    }
    case 'METADATA': {
      const fields: Array<[string, unknown]> = [
        ['ID', n.id], ['Loc', n.loc], ['Memory', n.memoryUrn],
        ['Type', n.nodeType], ['Object type', n.objectType], ['Alias', n.alias],
        ['Description', n.description],
        ['Tags', n.tags && n.tags.length > 0 ? n.tags.join(', ') : null],
        ['Seq', n.seq], ['Role', n.role],
        ['Runnable', typeof n.isRunnable === 'boolean' ? String(n.isRunnable) : null],
      ];
      const items = fields
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([label, v]) => `- ${label}: ${inlineText(v)}`);
      return items.length > 0 ? `## Metadata\n\n${items.join('\n')}` : null;
    }
    default:
      return null;
  }
}

/**
 * The Markdown a PDF is rendered from (cor:int:020:02 R8/R9, #395). The content is ALWAYS printed (the
 * title as `# <name>` when it is empty, as before), and the sections the caller names are ADDED after it, in
 * {@link PDF_SECTION_ORDER}, each under its own `##` heading; a section with nothing in it is left out, and a
 * section named twice prints once. Unlike the text formats, where the selection is the exact set rendered,
 * naming CONTENT here changes nothing. `full` does not apply: a PDF is never the canonical file.
 */
export function renderPdfMarkdown(n: ExportNode, sections?: readonly NodeExportSection[] | null): string {
  const selected = new Set(sections ?? []);
  const content = n.content && n.content.trim().length > 0 ? n.content : `# ${n.name}`;
  const added = PDF_SECTION_ORDER.filter((section) => selected.has(section))
    .map((section) => pdfSection(n, section))
    .filter((block): block is string => block !== null);
  return [content, ...added].join('\n\n');
}

export interface RenderedExport {
  mimeType: string;
  data: string;
}

/**
 * Render a node to a portable file. `full` → the canonical, round-trippable
 * form (sections ignored); otherwise the selected `sections` (default: all).
 */
export function renderNodeExport(
  n: ExportNode,
  opts: { format: NodeExportFormat; full: boolean; sections?: NodeExportSection[] | null },
): RenderedExport {
  // PDF is produced out-of-process by hadrontool-pdf, not here. Reaching this
  // with PDF is a caller bug (the resolver branches on PDF before calling).
  if (opts.format === 'PDF') {
    throw new Error('renderNodeExport handles MD/JSON only; render PDF via renderMarkdownToPdf');
  }
  // Omitted (null/undefined) → all sections; an explicit [] means "none"
  // (a caller can deliberately request an empty presentation export).
  const sections = new Set(opts.sections ?? ALL_SECTIONS);
  if (opts.format === 'JSON') {
    const data = opts.full ? renderCanonicalJson(n) : renderSectionedJson(n, sections);
    return { mimeType: 'application/json', data };
  }
  const data = opts.full ? renderCanonicalMarkdown(n) : renderSectionedMarkdown(n, sections);
  return { mimeType: 'text/markdown', data };
}
