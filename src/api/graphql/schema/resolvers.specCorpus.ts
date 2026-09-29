// Draft spec corpora (#1447): the server-owned spec-corpus operations.
//
// #1450 — reserveSpecCitation. Contract:
// https://github.com/hadron-memory/hadron-server/issues/1447#issuecomment-5895948862 §4.
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.js';
import { nodeMoveOps, writeNodeCore } from './resolvers.mutation.node.js';
import {
  concealUnreadableDenial,
  isMemoryReadableCached,
  requireMemoryWriteAccess,
  requireOwnerOrOrgRole,
  withoutRequestCaches,
} from './resolvers.helpers.js';
import { isAbstractUnverified } from '../../../lib/contentHash.js';
import {
  STALE_ABSTRACT_BLOCKS_MINT,
  isCitationLoc,
  lintCorpusForMint,
  parseOpenQuestions,
} from '../../../lib/specMint.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { acquireLockSet, ancestorLocs } from '../../../lib/nodeSubtreeLock.js';
import { archiveTombstone } from '../../../lib/tombstoneArchive.js';
import { lockEdgeEndpointMemories } from '../../../lib/edgeEndpointLock.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
import { ensureCurrentNodeRevisionInTransaction } from '../../../lib/nodeRevisionSnapshot.js';
import { isDraftCorpus } from '../../../lib/specCorpus.js';
import { InvalidLocError, validateLoc } from '../../../lib/validateLoc.js';
import {
  SCANNED_FIELDS,
  corpusReferencePattern,
  findCorpusReferences,
  findTextCitations,
  renumberedLoc,
  rewriteCorpusReferences,
  type ScannedField,
} from '../../../lib/specReferences.js';

export const specCorpusMutations = {
  /**
   * Reserve a citation in a DRAFT spec corpus as a PLACEHOLDER: a spec node
   * (`role: 'spec'`, `nodeType: 'info'`) at `loc`, marked by the server-set
   * `Node.isPlaceholder`, never by an empty body. Links can point at it, so
   * backlinks work, and the placeholders still left are the corpus's to-do
   * list; minting refuses while any remain. Writing real content to it through
   * `updateSpecNode` turns it into a real spec at the same citation.
   *
   * It writes through the spec door's own create path (the `spec` governed
   * kind), so every other gate applies unchanged: memory write access (an
   * unreadable memory is concealed as not found), mint-or-refuse at a live loc,
   * Channel address protection. Only a draft corpus accepts a reservation,
   * which is what keeps placeholders out of minted corpora.
   *
   * The draft check reads the memory row FOR SHARE AFTER the node write, inside
   * the same transaction: node then memory is the order moves use (the reverse
   * deadlocks against a merge fold), a concurrent mint's row lock serializes
   * with it, and the check never answers for a memory the caller cannot write.
   *
   * @throws GraphQLError `SPEC_CORPUS_NOT_DRAFT` when the memory is minted.
   */
  reserveSpecCitation: async (
    _: unknown,
    { memoryRef, loc, name }: { memoryRef: string; loc: string; name?: string | null },
    ctx: Context,
  ) => {
    const { id: memoryId } = await resolveMemoryRef(ctx.db, memoryRef);
    // (@codex P2, PR #1452) Authorize BEFORE taking any lock or touching the
    // tombstone, with the same concealment writeNodeCore applies later: an
    // unauthorized caller must not contend for this tenant's locks, and no
    // archive-time error may reveal that a tombstone exists at the loc.
    await concealUnreadableDenial(ctx, memoryId, memoryRef, () => requireMemoryWriteAccess(ctx, memoryId));
    const effects: Array<() => void> = [];
    const reserved = await ctx.db.$transaction(async (tx) => {
      // (@codex P1/P2s, PR #1452) Never REVIVE a deleted node as a placeholder.
      // A revival keeps everything attached to the row (text, payload, edges,
      // vectors, provenance, revision history), and each of those surfaced a
      // leak in turn. Archive the tombstone at `<loc>__deleted-<id>` instead,
      // the convention a move that overwrites a live target already uses, so
      // the placeholder is a FRESH node and the deleted spec keeps its own
      // identity and history on its still-deleted row.
      // (@codex P2, PR #1452) Take the address locks FIRST, in the global
      // order every create/move/overwrite at this loc uses (ancestors, then the
      // loc itself), before touching the tombstone's row. Row-locking the
      // tombstone first would invert against a concurrent writer that holds
      // these advisory locks and waits on that row: a deadlock instead of a
      // typed loc conflict. writeNodeCore's own acquisition below is then a
      // re-entrant no-op.
      // (Chip's QA, PR #1452) The edge-endpoint memory key first, as every edge
      // writer takes it before its address locks: an in-flight edge naming the
      // tombstone then commits before the archive lists edges, and a later one
      // revalidates the endpoint under this key and finds it gone.
      await lockEdgeEndpointMemories(tx, [memoryId]);
      await acquireLockSet(tx, [
        ...ancestorLocs(loc).map((ancestor) => ({ memoryId, loc: ancestor })),
        { memoryId, loc },
      ]);
      const tombstone = await tx.node.findFirst({
        where: { memoryId, loc, deletedAt: { not: null } },
        select: { id: true },
      });
      // (@codex P2, PR #1452) The tombstone's edges go with it: their derived
      // locs would otherwise collide with the placeholder's once it is filled.
      if (tombstone) await archiveTombstone(tx, { id: tombstone.id, loc, memoryId });
      const node = await writeNodeCore(
        {
          memoryId, loc, name: name?.trim() || loc, role: 'spec', nodeType: 'info',
          // Every authored field is stated, not omitted, so the placeholder is
          // empty by construction rather than by relying on a fresh row. The
          // test that pins this compares a reservation over a tombstone to a
          // fresh one column by column.
          content: null, abstract: null, description: null, contentType: null,
          alias: null, tags: [], data: null, properties: null,
          llmModel: null, aiAgent: null, isLink: false, objectType: null,
          edges: [],
        },
        withoutRequestCaches(ctx, tx),
        'create',
        {
          ownsKind: 'spec',
          governedContext: 'node-write',
          concealUnreadable: { entity: 'memory', ref: memoryRef },
          transaction: { tx, pooledDb: ctx.db, afterCommit: (effect) => effects.push(effect) },
        },
      );
      const [memory] = await tx.$queryRaw<Array<{ corpus_draft: boolean }>>`
        SELECT corpus_draft FROM memories WHERE id = ${memoryId} FOR SHARE
      `;
      if (!memory?.corpus_draft) {
        throw new GraphQLError(
          'Only a draft spec corpus can reserve a citation: this memory is minted, where a citation is permanent once written. Create the spec directly instead.',
          { extensions: { code: 'SPEC_CORPUS_NOT_DRAFT', memoryId } },
        );
      }
      // Git provenance is not a node-input field, so it is reset here, in the
      // same write that marks the placeholder (@codex P2, PR #1452): a revived
      // git-synced tombstone would otherwise keep the deleted body's hash and
      // stay owned by the old repo, where sync's cleanup could delete it.
      await tx.node.update({
        where: { id: node.id },
        data: { isPlaceholder: true, contentHash: null, ownerRepo: null },
        select: { id: true },
      });
      // (@codex P1, PR #1452) Soft deletion keeps a node's vectors, and vector
      // search only checks the node's own deleted_at. A revived tombstone would
      // therefore let the placeholder rank for, and chunk search return, the
      // deleted spec's text. A placeholder has no content, so it has no vectors.
      await tx.nodeEmbedding.deleteMany({ where: { nodeId: node.id } });
      // The node as the create door built it (relations included), now marked.
      // …with the values this transaction just reset, not the ones read
      // before it (@codex P2, PR #1452): Node.ownerRepo is client-visible.
      return { ...node, isPlaceholder: true, contentHash: null, ownerRepo: null };
    });
    for (const effect of effects) effect();
    return reserved;
  },
};

// ─── #1449 — reference scan: backlinks, unresolved references, renumber ────

/** The corpus a scan runs over: readable, draft, plaintext. */
interface ScannableCorpus {
  id: string;
  urn: string;
  pattern: RegExp;
  /**
   * Former URNs of this corpus that another LIVE memory also claims, mapped to
   * those memories' ids: the one that holds it now, and any that held it
   * before (its own alias row). A reference written with one of them points at
   * us only if no other claimant has a live node at the cited loc; otherwise
   * it resolves to that memory (live-address precedence) or is ambiguous, as
   * resolveNodeRef treats it. Either way it is not ours.
   */
  shadowed: Map<string, string[]>;
  /**
   * (@codex P2, #1453) Other live memories that held the corpus's CURRENT URN
   * in the past. A citation with the current URN resolves to the corpus when
   * it has a live node at the loc (current-live precedence), and otherwise
   * falls through to one of these if IT has that loc, so it is not ours.
   */
  currentUrnHistorical: string[];
}

/**
 * Resolve a corpus for a reference scan. Order matters for disclosure: an
 * unreadable memory answers exactly like a missing one (the shared node-content
 * read gate), and only then is its draft state or encryption revealed.
 *
 * Draft only (contract §3). Encrypted corpora are refused: their text is
 * ciphertext at rest, and scanning it needs a decryption path this slice does
 * not add.
 */
async function loadScannableCorpus(ctx: Context, memoryRef: string): Promise<ScannableCorpus> {
  const { id } = await resolveMemoryRef(ctx.db, memoryRef);
  if (!(await isMemoryReadableCached(ctx, id))) throw new MemoryNotFoundError(memoryRef);
  const memory = await ctx.db.memory.findUniqueOrThrow({
    where: { id },
    select: { urn: true, corpusDraft: true, isEncrypted: true },
  });
  if (!isDraftCorpus(memory)) {
    throw new GraphQLError(
      'References are scanned only in a draft spec corpus: a minted corpus keeps its citations permanent.',
      { extensions: { code: 'SPEC_CORPUS_NOT_DRAFT', memoryId: id } },
    );
  }
  if (memory.isEncrypted) {
    throw new GraphQLError('Reference scans do not support encrypted memories yet.', {
      extensions: { code: 'SPEC_CORPUS_ENCRYPTED_UNSUPPORTED', memoryId: id },
    });
  }
  // A URN the corpus was published under before a rename still names it.
  const aliases = await ctx.db.urnAlias.findMany({
    where: { entityType: 'MEMORY', entityId: id },
    select: { urn: true },
  });
  const urns = [memory.urn, ...aliases.map((a) => a.urn)].map((u) => u.replace(/^(?:hrn|urn):mem(?:ory)?:/i, ''));
  const former = urns.filter((u) => u !== memory.urn);
  const shadowed = new Map<string, string[]>();
  if (former.length) {
    const claim = (urn: string, memoryId: string) => shadowed.set(urn, [...new Set([...(shadowed.get(urn) ?? []), memoryId])]);
    // Current holders of a former URN.
    for (const h of await ctx.db.memory.findMany({
      where: { urn: { in: former }, deletedAt: null, id: { not: id } },
      select: { id: true, urn: true },
    })) claim(h.urn, h.id);
    // (@codex P2, #1453) Other live memories that held it in the past.
    const historical = await ctx.db.urnAlias.findMany({
      where: { entityType: 'MEMORY', urn: { in: former }, entityId: { not: id } },
      select: { urn: true, entityId: true },
    });
    const live = new Set((await ctx.db.memory.findMany({
      where: { id: { in: [...new Set(historical.map((a) => a.entityId))] }, deletedAt: null },
      select: { id: true },
    })).map((m) => m.id));
    for (const a of historical) if (live.has(a.entityId)) claim(a.urn.replace(/^(?:hrn|urn):mem(?:ory)?:/i, ''), a.entityId);
  }
  const priorHolders = await ctx.db.urnAlias.findMany({
    where: { entityType: 'MEMORY', urn: memory.urn, entityId: { not: id } },
    select: { entityId: true },
  });
  const currentUrnHistorical = priorHolders.length
    ? (await ctx.db.memory.findMany({
        where: { id: { in: [...new Set(priorHolders.map((a) => a.entityId))] }, deletedAt: null },
        select: { id: true },
      })).map((m) => m.id)
    : [];
  // (@codex P1, #1453) Only claimants the CALLER can read may decide which
  // references are ours. Deciding it from an unreadable memory's nodes would
  // make backlinks and the unresolved report an existence oracle for that
  // tenant (plant a reference, see whether it is claimed). The shared resolver
  // conceals such claimants the same way (isConcealedNodeRefAmbiguity): what
  // the caller cannot read, it cannot resolve to either.
  const readable = async (ids: readonly string[]) => {
    const out: string[] = [];
    for (const m of ids) if (await isMemoryReadableCached(ctx, m)) out.push(m);
    return out;
  };
  for (const [urn, ids] of shadowed) {
    const visible = await readable(ids);
    if (visible.length) shadowed.set(urn, visible);
    else shadowed.delete(urn);
  }
  return {
    id, urn: memory.urn, pattern: corpusReferencePattern(urns), shadowed,
    currentUrnHistorical: await readable(currentUrnHistorical),
  };
}

/**
 * (@codex P2, #1453) Decide which scanned references really point into the
 * corpus: one written with a former URN that another live memory now holds
 * belongs to that memory when it has a live node at the cited loc. One query
 * for the whole scan; the returned predicate is synchronous.
 */
async function referenceAcceptor(
  db: Pick<Context['db'], 'node'>,
  corpus: ScannableCorpus,
  refs: ReadonlyArray<{ memoryUrn: string; targetLoc: string }>,
): Promise<(ref: { memoryUrn: string; targetLoc: string }) => boolean> {
  const claimantsOf = (ref: { memoryUrn: string }): string[] =>
    ref.memoryUrn === corpus.urn ? corpus.currentUrnHistorical : (corpus.shadowed.get(ref.memoryUrn) ?? []);
  const candidates = refs.filter((r) => claimantsOf(r).length > 0);
  if (candidates.length === 0) return () => true;
  const live = await db.node.findMany({
    where: {
      deletedAt: null,
      OR: candidates.flatMap((r) => [
        ...claimantsOf(r).map((memoryId) => ({ memoryId, loc: r.targetLoc })),
        // The corpus's own node wins for its current URN.
        ...(r.memoryUrn === corpus.urn ? [{ memoryId: corpus.id, loc: r.targetLoc }] : []),
      ]),
    },
    select: { memoryId: true, loc: true },
  });
  const taken = new Set(live.map((n) => `${n.memoryId}\u0000${n.loc}`));
  return (ref) => {
    if (ref.memoryUrn === corpus.urn && taken.has(`${corpus.id}\u0000${ref.targetLoc}`)) return true;
    return !claimantsOf(ref).some((m) => taken.has(`${m}\u0000${ref.targetLoc}`));
  };
}

/** One text-field reference found in the corpus. */
interface ScannedReference {
  sourceNodeId: string;
  sourceLoc: string;
  field: ScannedField;
  targetLoc: string;
  urn: string;
  memoryUrn: string;
}

interface ScannedNode {
  id: string;
  loc: string;
  isPlaceholder: boolean;
  revSeq: number;
  role: string | null;
  fields: Record<ScannedField, string | null>;
}

const SCAN_PAGE = 500;

const SCANNED_SELECT = {
  id: true, loc: true, isPlaceholder: true, revSeq: true, role: true,
  name: true, description: true, abstract: true, content: true,
} as const;

/** Project a selected row into the scan's node shape. */
function toScannedNode(n: {
  id: string; loc: string; isPlaceholder: boolean; revSeq: number; role: string | null;
  name: string; description: string | null; abstract: string | null; content: string | null;
}): ScannedNode {
  return {
    id: n.id, loc: n.loc, isPlaceholder: n.isPlaceholder, revSeq: n.revSeq, role: n.role,
    fields: { name: n.name, description: n.description, abstract: n.abstract, content: n.content },
  };
}

/**
 * (@codex P2, #1453) Re-read ONE node for a rewrite attempt, and only while it
 * is still a live node of this corpus. Re-reading the whole corpus per rewrite
 * made a renumber quadratic in a well-linked corpus.
 */
async function loadCorpusNode(db: Pick<Context['db'], 'node'>, memoryId: string, id: string): Promise<ScannedNode | undefined> {
  const n = await db.node.findFirst({ where: { id, memoryId, deletedAt: null }, select: SCANNED_SELECT });
  return n ? toScannedNode(n) : undefined;
}

/** Read every live node of the corpus, a page at a time, in id order. */
async function loadCorpusNodes(db: Pick<Context['db'], 'node'>, memoryId: string): Promise<ScannedNode[]> {
  const nodes: ScannedNode[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await db.node.findMany({
      where: { memoryId, deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: SCAN_PAGE,
      select: SCANNED_SELECT,
    });
    for (const n of page) nodes.push(toScannedNode(n));
    if (page.length < SCAN_PAGE) return nodes;
    cursor = page[page.length - 1].id;
  }
}

function scanReferences(nodes: ScannedNode[], pattern: RegExp): ScannedReference[] {
  const out: ScannedReference[] = [];
  for (const n of nodes) {
    for (const field of SCANNED_FIELDS) {
      for (const ref of findCorpusReferences(n.fields[field], pattern)) {
        out.push({ sourceNodeId: n.id, sourceLoc: n.loc, field, targetLoc: ref.targetLoc, urn: ref.urn, memoryUrn: ref.memoryUrn });
      }
    }
  }
  return out;
}

/** GraphQL projection of a reference. `kind` separates text URNs from real edges. */
type SpecReferenceOut = {
  kind: 'URN' | 'EDGE';
  sourceNodeId: string;
  sourceLoc: string;
  field: string;
  targetLoc: string;
  text: string | null;
  reason?: 'MISSING' | 'PLACEHOLDER';
};

const fromScan = (r: ScannedReference): SpecReferenceOut => ({
  kind: 'URN', sourceNodeId: r.sourceNodeId, sourceLoc: r.sourceLoc, field: r.field, targetLoc: r.targetLoc, text: r.urn,
});

/** Live real edges whose source is a live node of this corpus, pointing at `targetIds`. */
async function corpusEdgesTo(db: Pick<Context['db'], 'edge'>, memoryId: string, targetIds: string[]) {
  if (targetIds.length === 0) return [];
  return db.edge.findMany({
    // (@codex P2, #1453) Edges are soft-deleted: a deleted edge is not a reference.
    where: { targetId: { in: targetIds }, deletedAt: null, source: { memoryId, deletedAt: null } },
    select: { name: true, source: { select: { id: true, loc: true } }, target: { select: { loc: true } } },
    orderBy: { id: 'asc' },
  });
}

export const specCorpusQueries = {
  /**
   * #1449 — what refers to the spec at `loc` in a draft corpus: every node URN
   * pointing at it in the corpus's text (name, description, abstract, content;
   * inside URLs too), plus real edges from corpus nodes. Exact citation, not
   * its descendants. The spec need not exist: a reference to a missing spec is
   * still a backlink.
   */
  specBacklinks: async (_: unknown, { memoryRef, loc }: { memoryRef: string; loc: string }, ctx: Context): Promise<SpecReferenceOut[]> => {
    const corpus = await loadScannableCorpus(ctx, memoryRef);
    const nodes = await loadCorpusNodes(ctx.db, corpus.id);
    const scanned = scanReferences(nodes, corpus.pattern);
    const accept = await referenceAcceptor(ctx.db, corpus, scanned);
    const text = scanned.filter((r) => r.targetLoc === loc && accept(r)).map(fromScan);
    const target = nodes.find((n) => n.loc === loc);
    const edges = target ? await corpusEdgesTo(ctx.db, corpus.id, [target.id]) : [];
    return [
      ...text,
      ...edges.map((e): SpecReferenceOut => ({
        kind: 'EDGE', sourceNodeId: e.source.id, sourceLoc: e.source.loc, field: 'edge', targetLoc: e.target.loc, text: e.name,
      })),
    ];
  },

  /**
   * #1449 — references in a draft corpus that do not reach a written spec: a
   * URN citing a loc with no live node (MISSING), or citing a placeholder, and
   * real edges pointing at a placeholder (PLACEHOLDER). This is the mint
   * report's "unresolved" block.
   */
  specUnresolvedReferences: async (_: unknown, { memoryRef }: { memoryRef: string }, ctx: Context): Promise<SpecReferenceOut[]> => {
    const corpus = await loadScannableCorpus(ctx, memoryRef);
    return unresolvedReferencesIn(ctx.db, corpus, await loadCorpusNodes(ctx.db, corpus.id));
  },
};

/**
 * The references in a corpus that do not reach a written spec (MISSING or
 * PLACEHOLDER), shared by specUnresolvedReferences and the mint report.
 */
async function unresolvedReferencesIn(
  db: Pick<Context['db'], 'node' | 'edge'>,
  corpus: ScannableCorpus,
  nodes: ScannedNode[],
): Promise<SpecReferenceOut[]> {
    const byLoc = new Map(nodes.map((n) => [n.loc, n]));
    const out: SpecReferenceOut[] = [];
    const scanned = scanReferences(nodes, corpus.pattern);
    const accept = await referenceAcceptor(db, corpus, scanned);
    for (const r of scanned) {
      if (!accept(r)) continue;
      const target = byLoc.get(r.targetLoc);
      if (!target) out.push({ ...fromScan(r), reason: 'MISSING' });
      else if (target.isPlaceholder) out.push({ ...fromScan(r), reason: 'PLACEHOLDER' });
    }
    const placeholders = nodes.filter((n) => n.isPlaceholder).map((n) => n.id);
    for (const e of await corpusEdgesTo(db, corpus.id, placeholders)) {
      out.push({
        kind: 'EDGE', sourceNodeId: e.source.id, sourceLoc: e.source.loc, field: 'edge',
        targetLoc: e.target.loc, text: e.name, reason: 'PLACEHOLDER',
      });
    }
    return out;
}

/** How many times a reference rewrite re-reads and retries after a concurrent edit. */
const REWRITE_ATTEMPTS = 3;

type RewriteOut = {
  nodeId: string;
  loc: string;
  fields: string[];
  count: number;
  status: 'PLANNED' | 'REWRITTEN' | 'UNCHANGED' | 'FAILED';
  error: string | null;
};

/** The renumberSpec result (the GraphQL SpecRenumberResult), typed explicitly. */
type SpecRenumberResultOut = {
  dryRun: boolean;
  moved: Array<{ fromLoc: string; toLoc: string }>;
  rewrites: RewriteOut[];
  textCitations: Array<{ sourceNodeId: string; sourceLoc: string; field: ScannedField; citation: string; excerpt: string }>;
};

/** Plan the reference rewrite of one node for a renumber; null when it cites nothing that moves. */
function planRewrite(
  n: ScannedNode,
  pattern: RegExp,
  fromLoc: string,
  toLoc: string,
  accept: (ref: { memoryUrn: string; targetLoc: string }) => boolean,
) {
  const patch: Partial<Record<ScannedField, string>> = {};
  let count = 0;
  for (const field of SCANNED_FIELDS) {
    const before = n.fields[field];
    if (!before) continue;
    const r = rewriteCorpusReferences(before, pattern, fromLoc, toLoc, accept);
    if (r.count > 0) {
      patch[field] = r.text;
      count += r.count;
    }
  }
  return count === 0 ? null : { patch, count };
}

export const specCorpusRenumberMutations = {
  /**
   * #1449 — renumber a spec in a DRAFT corpus: move it and its subtree from
   * `fromLoc` to `toLoc` (no URN alias, since it is a draft), then rewrite
   * every node URN in the corpus that cites the moved specs, each as a normal
   * edit with revision history. Only the loc inside each URN changes; its
   * spelling and any URL around it are kept.
   *
   * A citation written only as TEXT (a link label, a name, prose) cannot be
   * told from other characters, so it is REPORTED with its location and left
   * alone (contract §3).
   *
   * `dryRun` returns the same plan without writing anything. A real run is
   * not one transaction: the move is atomic, then each reference rewrite is
   * its own compare-and-swap edit, re-read and retried on a concurrent write.
   * A rewrite that still fails is reported FAILED with its reason rather than
   * rolling back the move, since a partial rewrite is visible in
   * specUnresolvedReferences and fixable by hand.
   */
  renumberSpec: async (
    _: unknown,
    { memoryRef, fromLoc, toLoc, dryRun }: { memoryRef: string; fromLoc: string; toLoc: string; dryRun?: boolean | null },
    ctx: Context,
  ): Promise<SpecRenumberResultOut> => {
    const corpus = await loadScannableCorpus(ctx, memoryRef);
    for (const loc of [fromLoc, toLoc]) validateLocOrThrow(loc);
    if (fromLoc === toLoc || toLoc.startsWith(`${fromLoc}:`)) {
      throw new GraphQLError(`Cannot renumber "${fromLoc}" to "${toLoc}": the target is the spec itself or inside its subtree.`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    let nodes = await loadCorpusNodes(ctx.db, corpus.id);
    const source = nodes.find((n) => n.loc === fromLoc);
    if (!source) {
      throw new GraphQLError(`No spec at "${fromLoc}" in this corpus.`, {
        extensions: { code: 'NODE_NOT_FOUND', loc: fromLoc, memoryId: corpus.id },
      });
    }
    const movingNodes = nodes.filter((n) => renumberedLoc(n.loc, fromLoc, toLoc) !== null);
    let moved = movingNodes
      .map((n) => ({ fromLoc: n.loc, toLoc: renumberedLoc(n.loc, fromLoc, toLoc)! }))
      .sort((a, b) => a.fromLoc.localeCompare(b.fromLoc));
    // (@codex P2, #1453) Exactly the shared mover's collision rule: a node
    // OUTSIDE the moving set at one of the rebased destination locs, live or a
    // tombstone (the (loc, memoryId) unique index covers both). An unrelated
    // node elsewhere under toLoc is not a collision, and the source itself may
    // sit under toLoc on an upward renumber.
    const occupied = await ctx.db.node.findFirst({
      where: {
        memoryId: corpus.id,
        loc: { in: moved.map((m) => m.toLoc) },
        id: { notIn: movingNodes.map((n) => n.id) },
      },
      select: { loc: true },
    });
    if (occupied) {
      throw new GraphQLError(`Cannot renumber to "${toLoc}": "${occupied.loc}" already exists there.`, {
        extensions: { code: 'NodeLocConflictError', loc: occupied.loc, memoryId: corpus.id },
      });
    }

    // (@codex P2, #1453) Decide which references are ours BEFORE the move.
    // When a prior holder of our URN also has a node at fromLoc, our own live
    // node there is what makes those references ours; once it has moved, the
    // prior holder's node would claim them and they would be left unrewritten.
    const accept = await referenceAcceptor(ctx.db, corpus, scanReferences(nodes, corpus.pattern));

    if (!dryRun) {
      // Fail before any write, rather than after the move.
      await requireMemoryWriteAccess(ctx, corpus.id);
      // (@codex P2s, #1453) Move the SCANNED node, by id, and only while it
      // is still at (corpus, fromLoc): a spec another request moved since the
      // scan refuses rather than being moved from wherever it now is. An
      // address is not enough: when our node has left fromLoc, resolving the
      // address falls through to a memory that historically held our URN,
      // and would move ITS node into this corpus. The mover re-validates the
      // same memory + loc under its row lock.
      const { relocated } = await nodeMoveOps.moveWithResult(ctx, {
        sourceRef: source.id,
        expectedSource: { memoryId: corpus.id, loc: fromLoc },
        targetUrn: `hrn:node:${corpus.urn}:${toLoc}`,
        // (@codex P1, PR #1453) The draft check above ran before the move's
        // lock; a mint can commit in between. Re-decided under the lock.
        requireDraftSource: true,
      });
      nodes = await loadCorpusNodes(ctx.db, corpus.id);
      // (@codex P2, #1453) Report exactly what the atomic mover relocated,
      // with the loc each node left, not a reconstruction from a later read.
      moved = relocated
        .map((r) => ({ fromLoc: r.previousLoc, toLoc: r.loc }))
        .sort((a, b) => a.fromLoc.localeCompare(b.fromLoc));
    }

    const rewrites: RewriteOut[] = [];
    for (const n of nodes) {
      const plan = planRewrite(n, corpus.pattern, fromLoc, toLoc, accept);
      if (!plan) continue;
      const row: RewriteOut = {
        nodeId: n.id, loc: n.loc, fields: Object.keys(plan.patch), count: plan.count,
        status: dryRun ? 'PLANNED' : 'REWRITTEN', error: null,
      };
      if (!dryRun) {
        try {
          // (@codex P2, #1453) Report what was actually written: a concurrent
          // edit can change or remove the references between plan and write.
          const done = await rewriteWithRetry(ctx, corpus, n, fromLoc, toLoc, accept);
          if (done) {
            row.fields = done.fields;
            row.count = done.count;
            // (@codex P2, #1453) where it was written, if it moved meanwhile
            row.loc = done.loc;
          } else {
            row.status = 'UNCHANGED';
            row.fields = [];
            row.count = 0;
          }
        } catch (e) {
          row.status = 'FAILED';
          row.error = e instanceof Error ? e.message : String(e);
        }
      }
      rewrites.push(row);
    }

    // Bare-text copies of the moved citations, located in the corpus as it now
    // stands (@codex P2, #1453): after a real run, re-read once, since a
    // concurrent move or edit may have changed rows since the snapshot.
    const current = dryRun ? nodes : await loadCorpusNodes(ctx.db, corpus.id);
    const textCitations = current.flatMap((n) =>
      SCANNED_FIELDS.flatMap((field) =>
        findTextCitations(n.fields[field], corpus.pattern, fromLoc).map((c) => ({
          sourceNodeId: n.id, sourceLoc: n.loc, field, citation: c.citation, excerpt: c.excerpt,
        })),
      ),
    );

    return { dryRun: !!dryRun, moved, rewrites, textCitations };
  },
};

/**
 * Rewrite one node's references as a guarded edit through the spec door's
 * update path (so a spec, which the generic writer refuses, can be edited), and
 * re-read and retry when a concurrent edit moved its revision on.
 */
async function rewriteWithRetry(
  ctx: Context,
  corpus: ScannableCorpus,
  initial: ScannedNode,
  fromLoc: string,
  toLoc: string,
  accept: (ref: { memoryUrn: string; targetLoc: string }) => boolean,
): Promise<{ fields: string[]; count: number; loc: string } | null> {
  let node: ScannedNode | undefined = initial;
  for (let attempt = 1; ; attempt++) {
    // The plan is computed from the row as stored, which may carry raw drift
    // (a write that bypassed revisions). writeNodeCore reconciles that drift
    // into its own revision BEFORE the compare-and-swap, which moves revSeq off
    // the value read here, and a refused write rolls the reconcile back too, so
    // every retry would conflict again. Commit the reconcile on its own first,
    // then read the settled revSeq and plan from that.
    await ctx.db.$transaction((tx) =>
      ensureCurrentNodeRevisionInTransaction(tx, node!.id, { expectedMemoryId: corpus.id }),
    );
    node = await loadCorpusNode(ctx.db, corpus.id, initial.id);
    if (!node) return null; // deleted or moved out meanwhile: nothing left to rewrite
    const plan = planRewrite(node, corpus.pattern, fromLoc, toLoc, accept);
    if (!plan) return null; // a concurrent edit already removed the references
    try {
      await writeNodeCore(
        { memoryId: corpus.id, loc: node.loc, ...plan.patch, reason: `renumber ${fromLoc} → ${toLoc}` },
        ctx,
        'update',
        { targetNodeId: node.id, guardRevSeq: node.revSeq, ownsKind: 'spec', governedContext: 'node-write' },
      );
      return { fields: Object.keys(plan.patch), count: plan.count, loc: node.loc };
    } catch (e) {
      const conflict = e instanceof GraphQLError && e.extensions?.code === 'NODE_WRITE_CONFLICT';
      if (!conflict || attempt >= REWRITE_ATTEMPTS) throw e;
    }
  }
}

function validateLocOrThrow(loc: string): void {
  try {
    validateLoc(loc);
  } catch (err) {
    if (err instanceof InvalidLocError) {
      throw new GraphQLError(err.message, { extensions: { code: err.name, loc: err.loc, segment: err.segment } });
    }
    throw err;
  }
}

// ─── #1448 — minting: draft → minted, once, one-way ─────────────────────────

/** Why the mint report lists an item. */
type MintFindingKind = 'PLACEHOLDER' | 'UNRESOLVED_REFERENCE' | 'LINT' | 'STALE_ABSTRACT';

type MintFinding = {
  kind: MintFindingKind;
  loc: string;
  rule: string | null;
  message: string;
  targetLoc: string | null;
};

type MintReport = {
  memoryId: string;
  dryRun: boolean;
  minted: boolean;
  blockers: MintFinding[];
  staleAbstracts: MintFinding[];
  staleAbstractsBlock: boolean;
  openQuestions: Array<{ decider: string | null; questions: Array<{ loc: string; question: string }> }>;
};

/** How many blockers a refusal carries in its error extensions (the dry run has them all). */
const MINT_REFUSAL_BLOCKER_CAP = 50;

/**
 * Hold a corpus still for a mint's check-and-flip, WITHOUT relying on writers
 * to cooperate (@codex P2s, PR #1462). The earlier fence was a memory-row lock
 * that conflicted with the FOR SHARE every *cooperating* node write takes, and
 * review found one direct writer after another that takes none (an extraction,
 * a Channel message post). So the fence is the mint's own:
 * - the memory row FOR UPDATE, which conflicts with the FOR KEY SHARE that the
 *   `nodes.memory_id` foreign key takes on every insert or move INTO the
 *   memory, whatever code path issues it;
 * - then every node row of the memory, tombstones included, FOR UPDATE, which
 *   blocks every update, revival or delete of an existing node, and every edge
 *   write naming one as an endpoint (the edge FKs take FOR KEY SHARE on nodes).
 *
 * Memory first waits out cooperating writers, which hold the memory before
 * their node rows. A writer holding a node row while it waits on the memory
 * (a move, an extraction) would be a lock cycle, so the node locks give up
 * after 500ms, under Postgres's default 1s deadlock_timeout, and the mint
 * refuses as retryable rather than a deadlock abort landing on the writer.
 */
async function fenceCorpusForMint(tx: Prisma.TransactionClient, memoryId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
  await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
  try {
    await tx.$queryRaw`SELECT id FROM nodes WHERE memory_id = ${memoryId} ORDER BY id FOR UPDATE`;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && (e.meta as { code?: string } | undefined)?.code === '55P03') {
      throw new GraphQLError('A write to this corpus is in flight, so it cannot be minted this moment. Retry.', {
        extensions: { code: 'SPEC_CORPUS_BUSY', memoryId },
      });
    }
    throw e;
  }
  await tx.$executeRaw`SET LOCAL lock_timeout TO DEFAULT`;
}

export const specCorpusMintMutations = {
  /**
   * #1448 — mint a DRAFT spec corpus: one step for the whole corpus, one-way
   * (contract §5). After minting, today's rules apply unchanged: citations are
   * permanent, moves record URN aliases again, and no placeholder can be
   * reserved. `dryRun` returns the same report without minting.
   *
   * Blocks (and a real run refuses `SPEC_CORPUS_MINT_BLOCKED` while any hold):
   * a placeholder remains; a reference points to a missing spec or a
   * placeholder; a structural lint error (the four server-owned rules, over
   * the citation-shaped nodes); and a stale abstract once
   * STALE_ABSTRACT_BLOCKS_MINT is switched on (#1408). Reported only: stale
   * abstracts while that switch is off, and open questions grouped by who
   * decides.
   *
   * By anyone who can manage the corpus: its owner, or an ADMIN of its org
   * (the updateMemory gate); an unreadable memory answers as not found.
   * A real run checks and flips inside {@link fenceCorpusForMint}, so no write
   * lands between the report and the mint; a dry run only reads.
   *
   * @throws GraphQLError `SPEC_CORPUS_BUSY` (retryable) when a node of the
   *   corpus stays locked by an in-flight write.
   */
  mintSpecCorpus: async (
    _: unknown,
    { memoryRef, dryRun }: { memoryRef: string; dryRun?: boolean | null },
    ctx: Context,
  ): Promise<MintReport> => {
    const { id } = await resolveMemoryRef(ctx.db, memoryRef);
    const owner = await ctx.db.memory.findUniqueOrThrow({
      where: { id }, select: { organizationId: true, ownerUserId: true },
    });
    await concealUnreadableDenial(ctx, id, memoryRef, () => requireOwnerOrOrgRole(ctx, owner, 'ADMIN'));

    return ctx.db.$transaction(async (tx) => {
      if (dryRun) await tx.$queryRaw`SELECT id FROM memories WHERE id = ${id} FOR NO KEY UPDATE`;
      else await fenceCorpusForMint(tx, id);
      const txCtx = withoutRequestCaches(ctx, tx);
      // (@codex P2, PR #1462) Re-authorize under the lock: an org transfer
      // (updateMemory takes this row FOR UPDATE) may have committed between the
      // check above and this lock, and minting is irreversible, so the gate
      // must judge the owner the row has NOW.
      const lockedOwner = await tx.memory.findUniqueOrThrow({
        where: { id }, select: { organizationId: true, ownerUserId: true },
      });
      await concealUnreadableDenial(txCtx, id, memoryRef, () => requireOwnerOrOrgRole(txCtx, lockedOwner, 'ADMIN'));
      // Re-reads the draft flag and encryption under the lock just taken.
      const corpus = await loadScannableCorpus(txCtx, id);
      const nodes = await tx.node.findMany({
        where: { memoryId: id, deletedAt: null },
        orderBy: { loc: 'asc' },
        select: {
          id: true, loc: true, nodeType: true, tags: true, role: true, isPlaceholder: true, revSeq: true,
          name: true, description: true, abstract: true, content: true, abstractOriginHash: true,
        },
      });
      const cited = nodes.filter((n) => isCitationLoc(n.loc));

      const blockers: MintFinding[] = [];
      for (const n of nodes) {
        if (n.isPlaceholder) {
          blockers.push({ kind: 'PLACEHOLDER', loc: n.loc, rule: null, message: 'reserved citation with no spec written', targetLoc: null });
        }
      }
      const scanned: ScannedNode[] = nodes.map((n) => ({
        id: n.id, loc: n.loc, isPlaceholder: n.isPlaceholder, revSeq: n.revSeq, role: n.role,
        fields: { name: n.name, description: n.description, abstract: n.abstract, content: n.content },
      }));
      for (const r of await unresolvedReferencesIn(tx, corpus, scanned)) {
        blockers.push({
          kind: 'UNRESOLVED_REFERENCE', loc: r.sourceLoc, rule: r.reason ?? null, targetLoc: r.targetLoc,
          message: r.reason === 'PLACEHOLDER'
            ? `${r.kind === 'EDGE' ? 'edge' : r.field} points at placeholder ${r.targetLoc}`
            : `${r.field} cites ${r.targetLoc}, which does not exist`,
        });
      }
      for (const f of lintCorpusForMint(cited)) {
        blockers.push({ kind: 'LINT', loc: f.loc, rule: f.rule, message: f.message, targetLoc: null });
      }
      const staleAbstracts: MintFinding[] = cited
        .filter((n) => isAbstractUnverified(n))
        .map((n) => ({
          kind: 'STALE_ABSTRACT' as const, loc: n.loc, rule: null, targetLoc: null,
          message: 'the abstract was written for an earlier body; re-affirm or rewrite it',
        }));
      if (STALE_ABSTRACT_BLOCKS_MINT) blockers.push(...staleAbstracts);

      const byDecider = new Map<string | null, Array<{ loc: string; question: string }>>();
      for (const n of cited) {
        for (const q of parseOpenQuestions(n.content)) {
          byDecider.set(q.decider, [...(byDecider.get(q.decider) ?? []), { loc: n.loc, question: q.question }]);
        }
      }
      const openQuestions = [...byDecider.entries()]
        .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
        .map(([decider, questions]) => ({ decider, questions }));

      const report: MintReport = {
        memoryId: id, dryRun: !!dryRun, minted: false, blockers,
        staleAbstracts, staleAbstractsBlock: STALE_ABSTRACT_BLOCKS_MINT, openQuestions,
      };
      if (dryRun) return report;
      if (blockers.length > 0) {
        throw new GraphQLError(
          `Minting refused: ${blockers.length} blocking item(s) remain. Run mintSpecCorpus with dryRun: true for the full report.`,
          {
            extensions: {
              code: 'SPEC_CORPUS_MINT_BLOCKED',
              memoryId: id,
              blockerCount: blockers.length,
              blockers: blockers.slice(0, MINT_REFUSAL_BLOCKER_CAP),
            },
          },
        );
      }
      await tx.memory.update({
        where: { id },
        data: { corpusDraft: false, corpusMintedAt: new Date(), corpusMintedBy: ctx.userId ?? ctx.clientId ?? null },
      });
      return { ...report, minted: true };
    }, { timeout: 120_000 });
  },
};
