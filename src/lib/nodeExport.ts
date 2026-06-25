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

export type NodeExportFormat = 'MD' | 'JSON';
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
  alias?: string | null;
  description?: string | null;
  abstract?: string | null;
  abstractOriginHash?: string | null;
  content?: string | null;
  tags: string[];
  seq?: number | null;
  data?: unknown;
  properties?: unknown;
  edges: EdgeForGit[];
}

// Which frontmatter / JSON keys belong to which section, for the presentation
// (full=false) filter. Identity + housekeeping live under METADATA; the rest
// map one-to-one.
const FRONTMATTER_KEY_SECTION: Record<string, NodeExportSection> = {
  name: 'METADATA', id: 'METADATA', loc: 'METADATA', memory: 'METADATA',
  alias: 'METADATA', type: 'METADATA', description: 'METADATA',
  contentHash: 'METADATA', tags: 'METADATA', seq: 'METADATA',
  abstract: 'ABSTRACT', abstractOriginHash: 'ABSTRACT',
  data: 'DATA', properties: 'PROPERTIES', nodes: 'EDGES',
};
const JSON_KEY_SECTION: Record<string, NodeExportSection> = {
  id: 'METADATA', memory: 'METADATA', loc: 'METADATA', name: 'METADATA',
  type: 'METADATA', alias: 'METADATA', description: 'METADATA',
  contentHash: 'METADATA', tags: 'METADATA', seq: 'METADATA',
  abstract: 'ABSTRACT', abstractOriginHash: 'ABSTRACT',
  data: 'DATA', properties: 'PROPERTIES', content: 'CONTENT', edges: 'EDGES',
};

/**
 * The canonical standalone YAML-frontmatter object, in the CLI's field order:
 * name, id, loc, memory, alias, type, description, abstract, abstractOriginHash,
 * contentHash, tags, seq, data, properties, nodes. `loc`/`memory` are the two
 * self-describing keys a standalone file carries (injected right after `id`),
 * and `contentHash` is recomputed from the content (`hadron node export`'s rule).
 */
function canonicalFrontmatter(n: ExportNode): Record<string, unknown> {
  const fm = buildNodeFrontmatter(
    {
      id: n.id,
      name: n.name,
      nodeType: n.nodeType,
      alias: n.alias,
      description: n.description,
      abstract: n.abstract,
      abstractOriginHash: n.abstractOriginHash,
      contentHash: computeContentHash(n.content),
      tags: n.tags,
      seq: n.seq,
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
 *  blank for the default `info`. */
function canonicalJsonDocument(n: ExportNode): Record<string, unknown> {
  const type = n.nodeType && n.nodeType !== 'info' ? n.nodeType : '';
  return {
    id: n.id,
    memory: n.memoryUrn,
    loc: n.loc,
    name: n.name,
    type,
    alias: n.alias ?? '',
    description: n.description ?? '',
    abstract: n.abstract ?? '',
    abstractOriginHash: n.abstractOriginHash ?? '',
    contentHash: computeContentHash(n.content) ?? '',
    tags: n.tags ?? [],
    seq: n.seq ?? null,
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
  const sections = new Set(opts.sections && opts.sections.length ? opts.sections : ALL_SECTIONS);
  if (opts.format === 'JSON') {
    const data = opts.full ? renderCanonicalJson(n) : renderSectionedJson(n, sections);
    return { mimeType: 'application/json', data };
  }
  const data = opts.full ? renderCanonicalMarkdown(n) : renderSectionedMarkdown(n, sections);
  return { mimeType: 'text/markdown', data };
}
