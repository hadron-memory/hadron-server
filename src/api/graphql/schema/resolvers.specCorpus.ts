// Draft spec corpora (#1447): the server-owned spec-corpus operations.
//
// #1450 — reserveSpecCitation. Contract:
// https://github.com/hadron-memory/hadron-server/issues/1447#issuecomment-5895948862 §4.
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.js';
import { nodeMutations, writeNodeCore } from './resolvers.mutation.node.js';
import { concealUnreadableDenial, isMemoryReadableCached, requireMemoryWriteAccess, withoutRequestCaches } from './resolvers.helpers.js';
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
  return { id, urn: memory.urn, pattern: corpusReferencePattern(urns), shadowed };
}

/**
 * (@codex P2, #1453) Decide which scanned references really point into the
 * corpus: one written with a former URN that another live memory now holds
 * belongs to that memory when it has a live node at the cited loc. One query
 * for the whole scan; the returned predicate is synchronous.
 */
async function referenceAcceptor(
  db: Context['db'],
  corpus: ScannableCorpus,
  refs: ReadonlyArray<{ memoryUrn: string; targetLoc: string }>,
): Promise<(ref: { memoryUrn: string; targetLoc: string }) => boolean> {
  const candidates = refs.filter((r) => corpus.shadowed.has(r.memoryUrn));
  if (candidates.length === 0) return () => true;
  const live = await db.node.findMany({
    where: {
      deletedAt: null,
      OR: candidates.flatMap((r) => corpus.shadowed.get(r.memoryUrn)!.map((memoryId) => ({ memoryId, loc: r.targetLoc }))),
    },
    select: { memoryId: true, loc: true },
  });
  const taken = new Set(live.map((n) => `${n.memoryId}\u0000${n.loc}`));
  return (ref) => {
    const claimants = corpus.shadowed.get(ref.memoryUrn);
    return !claimants || !claimants.some((m) => taken.has(`${m}\u0000${ref.targetLoc}`));
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

/** Read every live node of the corpus, a page at a time, in id order. */
async function loadCorpusNodes(db: Context['db'], memoryId: string): Promise<ScannedNode[]> {
  const nodes: ScannedNode[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await db.node.findMany({
      where: { memoryId, deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: SCAN_PAGE,
      select: {
        id: true, loc: true, isPlaceholder: true, revSeq: true, role: true,
        name: true, description: true, abstract: true, content: true,
      },
    });
    for (const n of page) {
      nodes.push({
        id: n.id, loc: n.loc, isPlaceholder: n.isPlaceholder, revSeq: n.revSeq, role: n.role,
        fields: { name: n.name, description: n.description, abstract: n.abstract, content: n.content },
      });
    }
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
async function corpusEdgesTo(db: Context['db'], memoryId: string, targetIds: string[]) {
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
    const nodes = await loadCorpusNodes(ctx.db, corpus.id);
    const byLoc = new Map(nodes.map((n) => [n.loc, n]));
    const out: SpecReferenceOut[] = [];
    const scanned = scanReferences(nodes, corpus.pattern);
    const accept = await referenceAcceptor(ctx.db, corpus, scanned);
    for (const r of scanned) {
      if (!accept(r)) continue;
      const target = byLoc.get(r.targetLoc);
      if (!target) out.push({ ...fromScan(r), reason: 'MISSING' });
      else if (target.isPlaceholder) out.push({ ...fromScan(r), reason: 'PLACEHOLDER' });
    }
    const placeholders = nodes.filter((n) => n.isPlaceholder).map((n) => n.id);
    for (const e of await corpusEdgesTo(ctx.db, corpus.id, placeholders)) {
      out.push({
        kind: 'EDGE', sourceNodeId: e.source.id, sourceLoc: e.source.loc, field: 'edge',
        targetLoc: e.target.loc, text: e.name, reason: 'PLACEHOLDER',
      });
    }
    return out;
  },
};

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

    if (!dryRun) {
      // Fail before any write, rather than after the move.
      await requireMemoryWriteAccess(ctx, corpus.id);
      // (@codex P2, #1453) Move BY ADDRESS, not by stable id: the shared mover
      // revalidates this source under its row lock, so a spec that another
      // request moved since the scan refuses instead of being moved from
      // wherever it now is. In a draft the old address leaves no alias, so a
      // second concurrent renumber of the same spec fails cleanly too.
      const unrelatedUnderTo = new Set(
        nodes
          .filter((n) => (n.loc === toLoc || n.loc.startsWith(`${toLoc}:`)) && !movingNodes.some((m) => m.id === n.id))
          .map((n) => n.id),
      );
      await nodeMutations.moveNode(
        null,
        { sourceRef: `hrn:node:${corpus.urn}:${fromLoc}`, targetUrn: `hrn:node:${corpus.urn}:${toLoc}` },
        ctx,
      );
      nodes = await loadCorpusNodes(ctx.db, corpus.id);
      // Report what actually moved (the mover re-reads the subtree under lock,
      // so it can differ from the plan), mapped back through the same prefix.
      moved = nodes
        .filter((n) => (n.loc === toLoc || n.loc.startsWith(`${toLoc}:`)) && !unrelatedUnderTo.has(n.id))
        .map((n) => ({ fromLoc: `${fromLoc}${n.loc.slice(toLoc.length)}`, toLoc: n.loc }))
        .sort((a, b) => a.fromLoc.localeCompare(b.fromLoc));
    }

    const accept = await referenceAcceptor(ctx.db, corpus, scanReferences(nodes, corpus.pattern));
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

    // Bare-text copies of the moved citations, located in the corpus as it now stands.
    const textCitations = nodes.flatMap((n) =>
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
): Promise<{ fields: string[]; count: number } | null> {
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
    node = (await loadCorpusNodes(ctx.db, corpus.id)).find((n) => n.id === initial.id);
    if (!node) return null; // deleted meanwhile: nothing left to rewrite
    const plan = planRewrite(node, corpus.pattern, fromLoc, toLoc, accept);
    if (!plan) return null; // a concurrent edit already removed the references
    try {
      await writeNodeCore(
        { memoryId: corpus.id, loc: node.loc, ...plan.patch, reason: `renumber ${fromLoc} → ${toLoc}` },
        ctx,
        'update',
        { targetNodeId: node.id, guardRevSeq: node.revSeq, ownsKind: 'spec', governedContext: 'node-write' },
      );
      return { fields: Object.keys(plan.patch), count: plan.count };
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
