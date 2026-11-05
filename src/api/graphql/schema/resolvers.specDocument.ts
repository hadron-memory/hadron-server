/**
 * #1302 (R218; cor:spc:030:01 / cor:spc:030:02) — `Query.specDocument`: a Feature's specs as one ordered
 * document, built once on the server for the CLI and the portal. No MCP tool (cor:acl:130:06), no write,
 * no stored copy, no LLM.
 *
 * Gate order is `loadScannableCorpus`'s: resolve the memory ref, then the shared read gate
 * (`isMemoryReadableCached`) BEFORE any node is read, so an unreadable and a missing memory answer
 * byte for byte alike (cor:api:140:03). Only then does an encrypted memory refuse, so encryption is not
 * disclosed to a caller who cannot read it. There is no per-node read restriction inside a readable memory
 * (Node has no visibility column), so no part is hidden from a reader of the memory; what a caller cannot
 * read are the memories a link or include points at, and those never name themselves (see `linkFor`).
 *
 * Every per-part value is read through the SAME field resolvers `node(...)` uses (`Node.content`,
 * `Node.revision`, `approvalStatus`, `mintStatus`), so a section reports what the node reports, including
 * the reconcile of an out-of-band change. This module adds no call site of `withReconciledNodeRead`.
 */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import { isMemoryReadableCached } from './resolvers.helpers.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
import { sortSiblings } from '../../../lib/siblingOrder.js';
import { portalUrlForUrn } from '../../../lib/portalUrl.js';
import { deserializeTags } from '../../../integrations/db/provider.js';
import {
  renderSpecDocument, wikilinkTargets, inDocumentOrder,
  type ApprovalLine, type DocPart, type LinkResolution,
} from '../../../lib/specDocument/render.js';
import { SPEC_DOCUMENT_MAX_NODES, SPEC_DOCUMENT_MAX_BYTES, SPEC_DOCUMENT_MAX_LINK_TARGETS, SPEC_DOCUMENT_TOO_LARGE } from '../../../lib/specDocument/limits.js';
import { resolveNodeUrnField, typeResolvers } from './resolvers.types.js';
import { nodeApprovalFieldResolvers } from './resolvers.nodeApproval.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';


/** Escapes the LIKE wildcards (and the escape character) so a prefix matches literally. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The render time comes from here, so the golden can fix it. */
export const specDocumentClock: { now: () => Date } = { now: () => new Date() };

/** Reads one chunk at a time: every part costs a reconcile transaction. */
const READ_CHUNK = 10;

type NodeRow = {
  id: string; memoryId: string; loc: string; name: string; seq: number | null; tags: string | string[];
  isPlaceholder: boolean; content: string | null; data?: unknown; nodeType?: string | null; role?: string | null;
} & Record<string, unknown>;

type ApprovalOut = { state: string; approval: { revision?: number | null } | null };
type MintOut = { minted: boolean };

const asField = <R>(fn: unknown) => fn as (p: unknown, a: unknown, c: Context) => Promise<R>;

/** Depth-first citation order below `root`: siblings by `siblingOrder.ts`, a nested part right after its parent. */
function citationOrder(root: NodeRow, nodes: NodeRow[]): NodeRow[] {
  const byLoc = new Map(nodes.map((n) => [n.loc, n]));
  const children = new Map<string, NodeRow[]>();
  for (const n of nodes) {
    if (n.loc === root.loc) continue;
    // Nearest ancestor that is in the document (a missing middle loc must not orphan its children).
    let parent = n.loc.slice(0, n.loc.lastIndexOf(':'));
    while (parent !== root.loc && !byLoc.has(parent)) {
      // A loc outside the root's subtree (never selected today) hangs off the root instead of looping.
      if (!parent.includes(':')) { parent = root.loc; break; }
      parent = parent.slice(0, parent.lastIndexOf(':'));
    }
    children.set(parent, [...(children.get(parent) ?? []), n]);
  }
  const out: NodeRow[] = [];
  const walk = (loc: string) => {
    for (const c of sortSiblings(children.get(loc) ?? [])) { out.push(c); walk(c.loc); }
  };
  walk(root.loc);
  return out;
}

async function inChunks<T, R>(items: readonly T[], fn: (item: T) => Promise<R>, after?: (chunk: R[]) => void): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += READ_CHUNK) {
    const chunk = await Promise.all(items.slice(i, i + READ_CHUNK).map(fn));
    after?.(chunk);
    out.push(...chunk);
  }
  return out;
}

const approvalLineOf = (a: ApprovalOut): ApprovalLine => {
  const revision = a.approval?.revision ?? null;
  // SUPERSEDED here is the approval state "text changed since approval" (0138), not the retirement tag.
  if (a.state === 'APPROVED') return { state: 'APPROVED', revision };
  if (a.state === 'SUPERSEDED') return { state: 'CHANGED_SINCE_APPROVAL', revision };
  return { state: 'NOT_APPROVED' };
};

export async function specDocumentOf(ctx: Context, memoryRef: string, loc: string) {
  // The gate, in loadScannableCorpus's order, before any node is read.
  const { id: memoryId } = await resolveMemoryRef(ctx.db, memoryRef);
  if (!(await isMemoryReadableCached(ctx, memoryId))) throw new MemoryNotFoundError(memoryRef);
  const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { urn: true, isEncrypted: true } });
  if (memory.isEncrypted) {
    throw new GraphQLError('Spec documents do not support encrypted memories.', {
      extensions: { code: 'SPEC_CORPUS_ENCRYPTED_UNSUPPORTED', memoryId },
    });
  }

  // A deleted spec and a loc never written answer the same.
  const rootRow = await ctx.db.node.findFirst({ where: { memoryId, loc, deletedAt: null } });
  if (!rootRow) throw new NodeNotFoundError(loc);
  // ONE bounded read, so the cap is judged on the rows the document is built from (a count first lets a
  // concurrent insert slip past it). The prefix is escaped: `_` and `%` are LIKE wildcards and legal in a loc.
  const prefix = `${loc}:`;
  const fetched = (await ctx.db.node.findMany({
    where: { memoryId, deletedAt: null, loc: { startsWith: escapeLike(prefix) } },
    take: SPEC_DOCUMENT_MAX_NODES,
  })) as unknown as NodeRow[];
  const rows = fetched;
  const tooLarge = (limit: 'nodes' | 'bytes' | 'links') => new GraphQLError(
    limit === 'nodes' ? `A spec document covers at most ${SPEC_DOCUMENT_MAX_NODES} specs.`
      : limit === 'bytes' ? 'A spec document covers at most 2 MB of specs.'
        : `A spec document resolves at most ${SPEC_DOCUMENT_MAX_LINK_TARGETS} distinct links.`,
    { extensions: { code: SPEC_DOCUMENT_TOO_LARGE, cap: SPEC_DOCUMENT_MAX_NODES, maxBytes: SPEC_DOCUMENT_MAX_BYTES, maxLinkTargets: SPEC_DOCUMENT_MAX_LINK_TARGETS, limit } },
  );
  const bytesOf = (t: string | null | undefined): number => (t ? Buffer.byteLength(t, 'utf8') : 0);
  if (rows.length + 1 > SPEC_DOCUMENT_MAX_NODES) throw tooLarge('nodes');
  let stored = bytesOf(rootRow.content);
  for (const r of rows) stored += bytesOf(r.content);
  if (stored > SPEC_DOCUMENT_MAX_BYTES) throw tooLarge('bytes');
  const root = rootRow as unknown as NodeRow;
  // Document order: the Feature, then the type groups; citation order inside a group.
  const ordered = [root, ...inDocumentOrder(citationOrder(root, [root, ...rows]))];

  // Per-part reads, as `node(...)` would answer this caller.
  let served = 0;
  const reads = await inChunks(ordered, async (n) => {
    const [revision, approval, mint, content] = await Promise.all([
      asField<number>(typeResolvers.Node.revision)(n, {}, ctx),
      asField<ApprovalOut>(nodeApprovalFieldResolvers.Node.approvalStatus)(n, {}, ctx),
      asField<MintOut & Record<string, unknown>>(nodeApprovalFieldResolvers.Node.mintStatus)(n, {}, ctx),
      n.isPlaceholder ? Promise.resolve(null) : asField<string | null>(typeResolvers.Node.content)(n, {}, ctx),
    ]);
    return { n, revision, approval, mint, content, urn: await resolveNodeUrnField(n, ctx) };
  }, (chunk) => {
    // What `entries[].content` serves, includes resolved: counted as each chunk returns, before the next read.
    for (const r of chunk) served += bytesOf(r.content);
    if (served > SPEC_DOCUMENT_MAX_BYTES) throw tooLarge('bytes');
  });

  // Retirement: the `superseded` tag, with pointers from `superseded-by*` edges (readable targets only).
  const retired = reads.filter((r) => deserializeTags(r.n.tags).includes('superseded'));
  const supersededBy = new Map<string, string[]>();
  if (retired.length) {
    const edges = await ctx.db.edge.findMany({
      where: { sourceId: { in: retired.map((r) => r.n.id) }, name: { startsWith: 'superseded-by' }, deletedAt: null },
      select: { sourceId: true, target: { select: { loc: true, seq: true, memoryId: true, deletedAt: true } } },
    });
    const readable = new Map<string, boolean>();
    for (const e of edges) {
      if (e.target.deletedAt) continue;
      if (!readable.has(e.target.memoryId)) readable.set(e.target.memoryId, await isMemoryReadableCached(ctx, e.target.memoryId));
      if (!readable.get(e.target.memoryId)) continue;
      supersededBy.set(e.sourceId, [...(supersededBy.get(e.sourceId) ?? []), JSON.stringify([e.target.seq, e.target.loc])]);
    }
    for (const [k, v] of supersededBy) {
      supersededBy.set(k, sortSiblings(v.map((s) => { const [seq, l] = JSON.parse(s) as [number | null, string]; return { seq, loc: l }; })).map((s) => s.loc));
    }
  }

  const parts: DocPart[] = reads.map((r) => ({
    loc: r.n.loc,
    name: r.n.name,
    body: r.content,
    isPlaceholder: r.n.isPlaceholder,
    superseded: retired.includes(r),
    supersededBy: supersededBy.get(r.n.id) ?? [],
    approval: approvalLineOf(r.approval),
    minted: r.mint.minted,
  }));

  // Links: every wikilink target, once, resolved as this caller.
  const inDoc = new Map(reads.map((r) => [r.n.id, r.n]));
  const targets = new Set<string>();
  for (const p of parts) if (!p.isPlaceholder && p.body) for (const t of wikilinkTargets(p.body)) targets.add(t);
  if (targets.size > SPEC_DOCUMENT_MAX_LINK_TARGETS) throw tooLarge('links');
  const links = new Map<string, LinkResolution>();
  for (const t of targets) links.set(t, await linkFor(ctx, memoryId, t, inDoc, root));

  const renderedAt = specDocumentClock.now();
  const markdown = renderSpecDocument({
    memory: memory.urn.replace(/^@/, '').replace(/::/g, ':'),
    renderedAt,
    feature: parts[0],
    parts: parts.slice(1),
    links,
  });

  if (bytesOf(markdown) > SPEC_DOCUMENT_MAX_BYTES) throw tooLarge('bytes');

  return {
    memoryId,
    loc,
    renderedAt,
    markdown,
    entries: reads.map((r) => ({
      loc: r.n.loc,
      urn: r.urn,
      name: r.n.name,
      revision: r.revision,
      content: r.content,
      isPlaceholder: r.n.isPlaceholder,
      approvalStatus: r.approval,
      mintStatus: r.mint,
    })),
  };
}

/** How one wikilink target shows. Nothing about a target the caller cannot read reaches the output. */
async function linkFor(
  ctx: Context, memoryId: string, target: string, inDoc: Map<string, NodeRow>, root: NodeRow,
): Promise<LinkResolution> {
  let id: string;
  try {
    // The caller's own resolver, concealing an ambiguous claimant the caller cannot read.
    id = (await resolveNodeRefForCaller(ctx, target, memoryId)).id;
  } catch {
    return { kind: 'plain' };
  }
  const part = inDoc.get(id);
  if (part) return part.id === root.id ? { kind: 'feature', loc: part.loc } : { kind: 'part', loc: part.loc, name: part.name };
  const node = await ctx.db.node.findUnique({ where: { id }, select: { id: true, loc: true, name: true, memoryId: true, deletedAt: true } });
  if (!node || node.deletedAt || !(await isMemoryReadableCached(ctx, node.memoryId))) return { kind: 'plain' };
  const url = portalUrlForUrn(await resolveNodeUrnField(node, ctx));
  return url ? { kind: 'external', url, label: node.name || node.loc } : { kind: 'plain' };
}

export const specDocumentQueries = {
  /** #1302 — see the module header. */
  specDocument: (_: unknown, args: { memoryRef: string; loc: string }, ctx: Context) =>
    specDocumentOf(ctx, args.memoryRef, args.loc),
};
