import { withIncludeHistoryTransaction, includeHistoryClient } from '../../../lib/includes/includeHistoryFence.js';
import { liveTxContext } from './authorizedTx.js';
import { liveCaller } from '../../../lib/tickers/liveCaller.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
// Draft spec corpora (#1447): the server-owned spec-corpus operations.
//
// #1450 — reserveSpecCitation. Contract:
// https://github.com/hadron-memory/hadron-server/issues/1447#issuecomment-5895948862 §4.
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import { inMintScope, inMintScopeSql } from '../../../lib/mintScope.js';
import { mirrorNodeMoveToGit, type MovedNodeRef } from '../../../integrations/github/mirrorNodeMove.js';
import type { Context } from './resolvers.js';
import { nodeMoveOps, writeNodeCore } from './resolvers.mutation.node.js';
import {
  concealUnreadableDenial,
  isMemoryReadableCached,
  requireMemoryWriteAccess,
  withoutRequestCaches,
} from './resolvers.helpers.js';
import { isAbstractUnverified } from '../../../lib/contentHash.js';
import {
  STALE_ABSTRACT_BLOCKS_MINT,
  lintCorpusForMint,
  mintLintSelects,
  parseOpenQuestions,
} from '../../../lib/specMint.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { legacyMemoryUrnToCanonical, normalizeUrnForLookup, parseUrnInput, UrnNotQualifiedError, UrnParseError } from '../../../lib/urn.js';
import { emitNodeUrnV2, safeNodeUrnV2 } from '../../../lib/urnEmit.js';
import {
  childKindOf,
  childNumberAt,
  formatSpecNumber,
  nextSpecNumber,
  specLevel,
} from '../../../lib/specAllocation.js';
import { acquireLockSet, ancestorLocs, lockAncestorsForCreate, lockPathForCreateUnder } from '../../../lib/nodeSubtreeLock.js';
import { reserveRootSeqLock } from '../../../lib/nodeSeq.js';
import { archiveTombstone, discoverArchivePlan, validateArchivePlan, withArchivePlanRetries, ArchivePlanExhaustedError } from '../../../lib/tombstoneArchive.js';
import { lockEdgeEndpointMemories } from '../../../lib/edgeEndpointLock.js';
import { pendingEdgeStableTargetId } from '../../../lib/pendingEdgePromotion.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { AmbiguousLegacyUrnError, NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
import { editorFromAuth, reconcileNodeWithIncludeHistory } from '../../../lib/nodeRevisionSnapshot.js';
import { mayMintNodes } from './resolvers.nodeApproval.js';
import { approvalHoldsFor, checkNodeIntegrity, loadApprovedSnapshots } from '../../../lib/nodeApproval.js';
import { COMMENT_NODE_TYPE } from '../../../lib/comments/index.js';
import { NOT_DECISION_FAMILY_WHERE } from '../../../lib/decisions/index.js';
import { unresolvedFeedbackOf, type UnresolvedFeedbackRow } from '../../../lib/comments/summary.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { SubtreeMoveMintedError } from '../../../lib/nodeSubtreeMove.js';
import { InvalidLocError, validateLoc } from '../../../lib/validateLoc.js';
import {
  SCANNED_FIELDS,
  corpusReferencePattern,
  findCorpusReferences,
  findNodeUrnTokens,
  findTextCitations,
  renumberedLoc,
  rewriteCorpusReferences,
  type ScannedField,
} from '../../../lib/specReferences.js';

// Draft spec corpora (#1447): the server-owned spec-corpus operations.
//
// #1450 — reserveSpecCitation. Contract:
// https://github.com/hadron-memory/hadron-server/issues/1447#issuecomment-5895948862 §4.

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
   * Channel address protection. Any memory accepts a reservation (#1591): a
   * placeholder is an unminted node, and the mint refuses while one remains.
   * A concurrent mint serializes with it through its fence (the memory row
   * FOR UPDATE conflicts with the node insert's foreign-key lock).
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
    let completed;
    try {
      completed = await withArchivePlanRetries(async (timeout) => {
        const effects: Array<() => void> = [];
        const reserved = await ctx.db.$transaction(async (tx) => {
          let txCtx = withoutRequestCaches(ctx, tx);
          const authorizeAttempt = async () => {
            const current = await liveCaller(ctx, tx);
            if (!current) throw authorizationDenied();
            txCtx = current;
            await concealUnreadableDenial(txCtx, memoryId, memoryRef, () => requireMemoryWriteAccess(txCtx, memoryId));
          };
          await authorizeAttempt();
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
          const archivePlan = await discoverArchivePlan(tx, memoryId, loc);
          await acquireLockSet(tx, [
            ...archivePlan.descendantLocs.map(loc => ({ memoryId, loc })),
            ...ancestorLocs(loc).map((ancestor) => ({ memoryId, loc: ancestor })),
            { memoryId, loc },
          ]);
          await lockAncestorsForCreate(tx, memoryId, loc, { op: 'create' });
          await authorizeAttempt();
          // #443: a ROOT reserve takes the root-allocation key K here, after every explicit lock
          // above and BEFORE the archive's uncommitted edge writes (a K-holder's own suffix inserts
          // edges, so a K-waiter must hold none). writeNodeCore's root allocation consumes this
          // one-use reservation.
          if (!loc.includes(':')) await reserveRootSeqLock(tx, memoryId);
          await validateArchivePlan(tx, archivePlan);
          const tombstone = await tx.node.findFirst({
            where: { memoryId, loc, deletedAt: { not: null } },
            select: { id: true },
          });
          // (@codex P2, PR #1452) The tombstone's edges go with it: their derived
          // locs would otherwise collide with the placeholder's once it is filled.
          if (tombstone) await archiveTombstone(tx, { id: tombstone.id, loc, memoryId }, archivePlan);
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
            txCtx,
            'create',
            {
              ownsKind: 'spec',
              governedContext: 'node-write',
              concealUnreadable: { entity: 'memory', ref: memoryRef },
              transaction: { tx, pooledDb: ctx.db, afterCommit: (effect) => effects.push(effect) },
            },
          );
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
        }, { timeout });
        return { reserved, effects };
      });
    } catch (error) {
      if (error instanceof ArchivePlanExhaustedError) throw new GraphQLError(error.message, { extensions: { code: 'CONFLICT' } });
      throw error;
    }
    for (const effect of completed.effects) effect();
    return completed.reserved;
  },

  /**
   * #1178 — allocate the next citation under `parentLoc` and reserve it, in ONE
   * transaction: mint-or-refuse, server-side, so no client has to read sibling
   * numbers and write the next one (a client cannot make that atomic, and
   * `createNode` overwrites on a collision instead of refusing). The number
   * grammar is `hadron spec new`'s: features in tens (010..990), rules and flows
   * by one (01..99), rule `00` never allocated, `after` lands strictly above it.
   *
   * R216: a number that was ever minted is never handed out again. The floor
   * sits above the highest ever-minted direct child, read from (i) Node rows of
   * any state (live, soft-deleted, or archived `__deleted-<id>`) that carry
   * `mintedAt`, and (ii) the aliases a minted node leaves when it is moved out.
   * Every number whose loc holds a Node row of ANY state is also skipped, so a
   * tombstone is never resurrected and a live draft is never overwritten.
   * Slice 1: a minted node hard-deleted in place leaves no row and no alias, so
   * R216 holds only while one remains (Holger R219 = C); a durable high-water
   * record is a later slice.
   *
   * The write is `reserveSpecCitation`'s: a placeholder spec node through the
   * spec door's create path, with its gates unchanged. Authorization comes
   * first and unreadable memories are concealed as not found, before any lock.
   * The parent-path locks are taken before any read, so concurrent allocators
   * serialize on them instead of racing to a conflict. One attempt, no retry.
   *
   * @throws GraphQLError `SPEC_PARENT_NOT_FOUND`, `SPEC_PARENT_NOT_NUMBERED`,
   * `SPEC_NUMBER_SPACE_EXHAUSTED`.
   */
  allocateSpecNode: async (
    _: unknown,
    { memoryRef, parentLoc, after, name }: { memoryRef: string; parentLoc: string; after?: number | null; name?: string | null },
    ctx: Context,
  ) => {
    const { id: memoryId } = await resolveMemoryRef(ctx.db, memoryRef);
    await concealUnreadableDenial(ctx, memoryId, memoryRef, () => requireMemoryWriteAccess(ctx, memoryId));
    const kind = childKindOf(parentLoc);
    if (!kind) {
      throw new GraphQLError(
        `${parentLoc} cannot take numbered children: pass a module, feature or rule citation ([<product>:]<module>[:<feature>[:<rule>]])`,
        { extensions: { code: 'SPEC_PARENT_NOT_NUMBERED', parentLoc } },
      );
    }
    if (after != null && (!Number.isInteger(after) || after < 0)) {
      throw new GraphQLError('after must be a non-negative integer', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    const level = specLevel(kind);
    const effects: Array<() => void> = [];
    const reserved = await ctx.db.$transaction(async (tx) => {
      let txCtx = withoutRequestCaches(ctx, tx);
      const authorizeAttempt = async () => {
        const current = await liveCaller(ctx, tx);
        if (!current) throw authorizationDenied();
        txCtx = current;
        await concealUnreadableDenial(txCtx, memoryId, memoryRef, () => requireMemoryWriteAccess(txCtx, memoryId));
      };
      await authorizeAttempt();
      // Lock order as reserveSpecCitation: the edge-endpoint memory key, then
      // the address locks (here the parent's path, since the child's loc is not
      // known until the number is read under them).
      await lockEdgeEndpointMemories(tx, [memoryId]);
      await lockPathForCreateUnder(tx, memoryId, parentLoc, { op: 'create' });
      await authorizeAttempt();
      const parent = await tx.node.findFirst({
        where: { memoryId, loc: parentLoc, deletedAt: null },
        select: { id: true },
      });
      if (!parent) {
        throw new GraphQLError(`No node at ${parentLoc} to allocate under`, {
          extensions: { code: 'SPEC_PARENT_NOT_FOUND', parentLoc },
        });
      }
      const prefix = `${parentLoc}:`;
      // Every row of any state under the parent: live, soft-deleted, archived.
      const rows = await tx.node.findMany({
        where: { memoryId, loc: { startsWith: prefix } },
        select: { loc: true, mintedAt: true },
      });
      // A one-segment alpha parent is a flat module only while it has numbered
      // children; one holding alphabetic children is a product root, whose
      // children are chosen module codes, not allocated numbers.
      if (!parentLoc.includes(':') && rows.some((r) => /^[a-z]{3}(:|$|__deleted-)/.test(r.loc.slice(prefix.length)))) {
        throw new GraphQLError(`${parentLoc} is a product root: its children are module codes, not allocated numbers`, {
          extensions: { code: 'SPEC_PARENT_NOT_NUMBERED', parentLoc },
        });
      }
      const taken = new Set<number>();
      let everMinted = 0;
      for (const row of rows) {
        const n = childNumberAt(parentLoc, row.loc, level);
        if (n === null) continue;
        // Only the unarchived loc holds the address; an archived row sits at a
        // different loc and counts toward the floor alone.
        if (!row.loc.includes('__deleted-')) taken.add(n);
        if (row.mintedAt) everMinted = Math.max(everMinted, n);
      }
      // (ii) A minted node moved out leaves an alias at its old address.
      const memory = await tx.memory.findUnique({ where: { id: memoryId }, select: { urn: true } });
      const memoryUrns = new Set<string>(memory?.urn ? [memory.urn] : []);
      const formerMemoryUrns = await tx.urnAlias.findMany({
        where: { entityType: 'MEMORY', entityId: memoryId },
        select: { urn: true },
      });
      for (const alias of formerMemoryUrns) memoryUrns.add(alias.urn);
      for (const memoryUrn of memoryUrns) {
        const aliasPrefix = safeNodeUrnV2(memoryUrn, parentLoc).slice('hrn:node:'.length) + ':';
        const aliases = await tx.urnAlias.findMany({
          where: { entityType: 'NODE', urn: { startsWith: aliasPrefix } },
          select: { urn: true },
        });
        for (const alias of aliases) {
          const n = childNumberAt(parentLoc, `${prefix}${alias.urn.slice(aliasPrefix.length)}`, level);
          if (n !== null) everMinted = Math.max(everMinted, n);
        }
      }
      const n = nextSpecNumber(level, everMinted, taken, after ?? null);
      if (n === null) {
        throw new GraphQLError(`Number space exhausted under ${parentLoc}`, {
          extensions: { code: 'SPEC_NUMBER_SPACE_EXHAUSTED', parentLoc },
        });
      }
      const loc = `${prefix}${formatSpecNumber(level, n)}`;
      const node = await writeNodeCore(
        {
          memoryId, loc, name: name?.trim() || loc, role: 'spec', nodeType: 'info',
          content: null, abstract: null, description: null, contentType: null,
          alias: null, tags: [], data: null, properties: null,
          llmModel: null, aiAgent: null, isLink: false, objectType: null,
          edges: [],
        },
        txCtx,
        'create',
        {
          ownsKind: 'spec',
          governedContext: 'node-write',
          concealUnreadable: { entity: 'memory', ref: memoryRef },
          transaction: { tx, pooledDb: ctx.db, afterCommit: (effect) => effects.push(effect) },
        },
      );
      await tx.node.update({ where: { id: node.id }, data: { isPlaceholder: true }, select: { id: true } });
      return { ...node, isPlaceholder: true };
    });
    for (const effect of effects) effect();
    return reserved;
  },
};

// ─── #1449 — reference scan: backlinks, unresolved references, renumber ────

/** The corpus a scan runs over: readable and plaintext (any memory since #1591). */
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
   * (#1505) The subset of {@link shadowed} that HOLDS each former URN now: the
   * published address. A live node there wins outright, before any alias, as in
   * resolveNodeRef. Historical claimants do not win; they compete.
   */
  publishedHolders: Map<string, string[]>;
  /**
   * (@codex P2, #1453) Other live memories that held the corpus's CURRENT URN
   * in the past. A citation with the current URN resolves to the corpus when
   * it has a live node at the loc (current-live precedence), and otherwise
   * falls through to one of these if IT has that loc, so it is not ours.
   */
  currentUrnHistorical: string[];
  /**
   * (#1505, @codex P1 on #1506) The claimants the caller can NOT read, which
   * {@link shadowed} and {@link currentUrnHistorical} omit. They never decide a
   * citation alone. But the shared resolver still counts them when a readable
   * candidate makes an ambiguity visible (isConcealedNodeRefAmbiguity), so the
   * ambiguity decision must count them too.
   */
  hiddenShadowed: Map<string, string[]>;
  hiddenCurrentUrnHistorical: string[];
  /**
   * (aa503a4c, #1494; #1511) Every memory that historically held a URN,
   * including this corpus and DELETED holders. Used only to translate NODE
   * alias keys: resolveNodeRef follows an old prefix to each holder's current
   * URN. A deleted memory's own rows never compete.
   */
  historicalTranslators: Map<string, string[]>;
  /**
   * (29c2245c, #1494) Former names whose CURRENT holder the caller cannot read.
   * Every citation under such a name is classified the same way, whether or
   * not that holder has a row at the cited loc, so backlinks, renumber and the
   * unresolved report cannot probe it. A reader's resolver lands on that hidden
   * holder, so for #1505 the citation is unresolvable: MISSING, blocking.
   */
  unreadablePublishedUrns: Set<string>;
}

/** A stored Memory URN may still use `org::memory`; scan keys use the resolver's lookup spelling. */
const normalizedMemoryUrn = (urn: string): string =>
  normalizeUrnForLookup(parseUrnInput(urn).value);

/** SQL equality sees both stored spellings, while the resolver treats them as one address. */
const storedMemoryUrnSpellings = (urn: string): string[] => [urn, legacyMemoryUrnToCanonical(urn)];

/**
 * Resolve a corpus for a reference scan. Order matters for disclosure: an
 * unreadable memory answers exactly like a missing one (the shared node-content
 * read gate), and only then is its draft state or encryption revealed.
 *
 * Any memory (#1591: draft rights are per node now). Encrypted corpora are refused: their text is
 * ciphertext at rest, and scanning it needs a decryption path this slice does
 * not add.
 */
async function loadScannableCorpus(ctx: Context, memoryRef: string): Promise<ScannableCorpus> {
  const { id } = await resolveMemoryRef(ctx.db, memoryRef);
  if (!(await isMemoryReadableCached(ctx, id))) throw new MemoryNotFoundError(memoryRef);
  const memory = await ctx.db.memory.findUniqueOrThrow({
    where: { id },
    select: { urn: true, isEncrypted: true },
  });
  if (memory.isEncrypted) {
    throw new GraphQLError('Reference scans do not support encrypted memories.', {
      extensions: { code: 'SPEC_CORPUS_ENCRYPTED_UNSUPPORTED', memoryId: id },
    });
  }
  // A URN the corpus was published under before a rename still names it.
  const aliases = await ctx.db.urnAlias.findMany({
    where: { entityType: 'MEMORY', entityId: id },
    select: { urn: true },
  });
  const currentUrn = normalizedMemoryUrn(memory.urn);
  const urns = [...new Set([memory.urn, ...aliases.map((a) => a.urn)].map(normalizedMemoryUrn))];
  const former = urns.filter((u) => u !== currentUrn);
  const formerSpellings = [...new Set(former.flatMap(storedMemoryUrnSpellings))];
  const shadowed = new Map<string, string[]>();
  const publishedHolders = new Map<string, string[]>();
  const historicalTranslators = new Map<string, string[]>();
  const addTranslator = (urn: string, memoryId: string) =>
    historicalTranslators.set(urn, [...new Set([...(historicalTranslators.get(urn) ?? []), memoryId])]);
  // #1511: the corpus is itself a historical holder of every former name.
  // Its current URN may carry a NODE alias left by an earlier holder; the
  // shared resolver probes that key even when the citation uses a former name.
  for (const urn of former) addTranslator(urn, id);
  if (former.length) {
    const claim = (urn: string, memoryId: string) => shadowed.set(urn, [...new Set([...(shadowed.get(urn) ?? []), memoryId])]);
    // Current holders of a former URN.
    for (const h of await ctx.db.memory.findMany({
      where: { urn: { in: formerSpellings }, deletedAt: null, id: { not: id } },
      select: { id: true, urn: true },
    })) {
      const urn = normalizedMemoryUrn(h.urn);
      claim(urn, h.id);
      publishedHolders.set(urn, [...(publishedHolders.get(urn) ?? []), h.id]);
    }
    // (@codex P2, #1453) Other live memories that held it in the past.
    const historical = await ctx.db.urnAlias.findMany({
      where: { entityType: 'MEMORY', urn: { in: formerSpellings }, entityId: { not: id } },
      select: { urn: true, entityId: true },
    });
    const live = new Set((await ctx.db.memory.findMany({
      where: { id: { in: [...new Set(historical.map((a) => a.entityId))] }, deletedAt: null },
      select: { id: true },
    })).map((m) => m.id));
    for (const a of historical) {
      const urn = normalizedMemoryUrn(a.urn);
      addTranslator(urn, a.entityId);
      if (live.has(a.entityId)) claim(urn, a.entityId);
    }
  }
  const priorHolders = await ctx.db.urnAlias.findMany({
    where: { entityType: 'MEMORY', urn: { in: storedMemoryUrnSpellings(currentUrn) }, entityId: { not: id } },
    select: { entityId: true },
  });
  for (const a of priorHolders) addTranslator(currentUrn, a.entityId);
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
  const unreadablePublishedUrns = new Set<string>();
  for (const [urn, ids] of publishedHolders) {
    if ((await readable(ids)).length !== ids.length) unreadablePublishedUrns.add(urn);
  }
  const hiddenShadowed = new Map<string, string[]>();
  for (const [urn, ids] of shadowed) {
    const visible = await readable(ids);
    const hidden = ids.filter((m) => !visible.includes(m));
    if (hidden.length) hiddenShadowed.set(urn, hidden);
    if (visible.length) shadowed.set(urn, visible);
    else shadowed.delete(urn);
  }
  const visibleCurrentUrnHistorical = await readable(currentUrnHistorical);
  for (const [urn, ids] of publishedHolders) {
    const visible = (shadowed.get(urn) ?? []).filter((m) => ids.includes(m));
    if (visible.length) publishedHolders.set(urn, visible);
    else publishedHolders.delete(urn);
  }
  return {
    id, urn: currentUrn, pattern: corpusReferencePattern(urns), shadowed, publishedHolders,
    currentUrnHistorical: visibleCurrentUrnHistorical,
    hiddenShadowed,
    hiddenCurrentUrnHistorical: currentUrnHistorical.filter((m) => !visibleCurrentUrnHistorical.includes(m)),
    historicalTranslators,
    unreadablePublishedUrns,
  };
}

/**
 * (#1505) A citation of this corpus that a reader could not resolve, for one of
 * two reasons:
 * - the shared resolver refuses its address as ambiguous
 *   (`AmbiguousLegacyUrnError`) while a candidate the caller can see is in
 *   this corpus;
 * - it is written under a former name whose CURRENT holder the caller cannot
 *   read (29c2245c), so a reader's resolver lands on that hidden holder.
 * It is not ours to attribute or rewrite, but a mint must not pass over it
 * either. The unresolved report lists it as MISSING, uniformly, with no probe
 * of hidden rows. A unique symbol, so it can never equal a loc a consumer
 * compares against.
 */
const UNRESOLVABLE_REFERENCE: unique symbol = Symbol('unresolvable spec reference');

/** One resolver candidate for a cited address: its corpus loc (null when in another memory) and whether the caller can read it. */
interface Candidate { loc: string | null; readable: boolean }

/** What a scanned reference resolves to: a corpus loc, another memory (null), or neither ({@link UNRESOLVABLE_REFERENCE}). */
type ReferenceResolution = string | null | typeof UNRESOLVABLE_REFERENCE;

/**
 * Decide which scanned references really point into the corpus, mirroring
 * resolveNodeRef as the CALLER sees it.
 * 1. A live node at the published address wins outright: the corpus's own node
 *    for its current URN, or the current holder's node for a former URN.
 * 2. Otherwise the candidates are the resolver's: live nodes at the loc in
 *    memories that historically held the URN (the corpus among them, for a
 *    former URN), plus live targets of NODE aliases at the address. They are
 *    keyed by node id, so a node counted twice is still one candidate.
 * 3. No candidate: the loc is ours, and reports MISSING if nothing is there.
 *    One candidate: ours if it is in the corpus, else another memory's.
 *    Several: {@link UNRESOLVABLE_REFERENCE} when one is in the corpus, as the
 *    resolver refuses it, else another memory's. The corpus's own candidate is
 *    always readable, so a hidden second candidate still makes it ambiguous.
 *
 * Readability follows the resolver's own concealment rule
 * (isConcealedNodeRefAmbiguity). An unreadable claimant or alias target never
 * decides a citation on its own, so the report is no oracle for it
 * (cor:api:140:03). But once a readable candidate makes the ambiguity visible,
 * the hidden ones count, exactly as they do when a reader resolves the address.
 */
async function referenceAcceptor(
  ctx: Context,
  corpus: ScannableCorpus,
  refs: ReadonlyArray<{ memoryUrn: string; targetLoc: string }>,
  forRewrite = false,
): Promise<(ref: { memoryUrn: string; targetLoc: string }) => ReferenceResolution> {
  const { db } = ctx;
  const claimantsOf = (ref: { memoryUrn: string }): string[] =>
    ref.memoryUrn === corpus.urn ? corpus.currentUrnHistorical : (corpus.shadowed.get(ref.memoryUrn) ?? []);
  const hiddenClaimantsOf = (ref: { memoryUrn: string }): string[] =>
    ref.memoryUrn === corpus.urn ? corpus.hiddenCurrentUrnHistorical : (corpus.hiddenShadowed.get(ref.memoryUrn) ?? []);
  /** Every live claimant, readable or not: the resolver's own candidate source. */
  const allClaimantsOf = (ref: { memoryUrn: string }): string[] => [...claimantsOf(ref), ...hiddenClaimantsOf(ref)];
  const publishedOf = (ref: { memoryUrn: string }): string[] =>
    ref.memoryUrn === corpus.urn ? [corpus.id] : (corpus.publishedHolders.get(ref.memoryUrn) ?? []);
  // A former claimant may have MOVED its node away and left a NODE alias at
  // the cited address. The row lookup below then misses it, but resolveNodeRef
  // still follows it. (48fc896f) The claimant may also have renamed its MEMORY
  // before the move, which stores the NODE alias under that claimant's CURRENT
  // URN while this corpus still cites the former one; match the resolver's
  // translated lookup too. Query each distinct key once. Unreadable claimants
  // are included here, because the resolver follows their aliases too; their
  // candidates count only when the ambiguity is visible anyway (see below).
  const translatorsOf = (ref: { memoryUrn: string }): string[] =>
    [...new Set([...allClaimantsOf(ref), ...(corpus.historicalTranslators.get(ref.memoryUrn) ?? [])])];
  const claimantIds = [...new Set(refs.flatMap((ref) => translatorsOf(ref)))];
  const claimantUrns = new Map<string, string>();
  for (let offset = 0; offset < claimantIds.length; offset += SCAN_PAGE) {
    for (const memory of await db.memory.findMany({
      // Deleted memories included (aa503a4c): they still translate an alias key.
      where: { id: { in: claimantIds.slice(offset, offset + SCAN_PAGE) } },
      select: { id: true, urn: true },
    })) claimantUrns.set(memory.id, normalizedMemoryUrn(memory.urn));
  }
  const aliasKeysByAddress = new Map<string, string[]>();
  for (const ref of refs) {
    const address = `${ref.memoryUrn}:${ref.targetLoc}`;
    const keys = new Set([address]);
    for (const id of translatorsOf(ref)) {
      const currentUrn = claimantUrns.get(id);
      if (currentUrn) keys.add(`${currentUrn}:${ref.targetLoc}`);
    }
    aliasKeysByAddress.set(address, [...keys]);
  }
  const addresses = [...new Set([...aliasKeysByAddress.values()].flat())];
  const aliases: Array<{ urn: string; entityId: string }> = [];
  for (let offset = 0; offset < addresses.length; offset += SCAN_PAGE) {
    aliases.push(...await db.urnAlias.findMany({
      where: { entityType: 'NODE', urn: { in: addresses.slice(offset, offset + SCAN_PAGE) } },
      select: { urn: true, entityId: true },
    }));
  }
  const targetIds = [...new Set(aliases.map((alias) => alias.entityId))];
  const aliasTargets = new Map<string, { memoryId: string; loc: string }>();
  for (let offset = 0; offset < targetIds.length; offset += SCAN_PAGE) {
    for (const target of await db.node.findMany({
      where: { id: { in: targetIds.slice(offset, offset + SCAN_PAGE) }, deletedAt: null, memory: { deletedAt: null } },
      select: { id: true, memoryId: true, loc: true },
    })) aliasTargets.set(target.id, { memoryId: target.memoryId, loc: target.loc });
  }
  // Every live alias target, with its corpus loc (null when it is in another
  // memory) and whether the caller can read it. An alias whose live target
  // moved INTO this corpus is a corpus candidate even when a different memory
  // now holds the old URN. The corpus is readable (loadScannableCorpus gates it).
  const targetInfo = new Map<string, Candidate>();
  for (const [id, target] of aliasTargets) {
    targetInfo.set(id, target.memoryId === corpus.id
      ? { loc: target.loc, readable: true }
      : { loc: null, readable: await isMemoryReadableCached(ctx, target.memoryId) });
  }
  const aliasesByUrn = new Map<string, string[]>();
  for (const alias of aliases) aliasesByUrn.set(alias.urn, [...(aliasesByUrn.get(alias.urn) ?? []), alias.entityId]);
  // Per cited address, every live alias target reached through any of its keys.
  const aliasCandidates = new Map<string, Map<string, Candidate>>();
  for (const [address, keys] of aliasKeysByAddress) {
    const targets = new Map<string, Candidate>();
    for (const key of keys) {
      for (const id of aliasesByUrn.get(key) ?? []) {
        const info = targetInfo.get(id);
        if (info) targets.set(id, info);
      }
    }
    if (targets.size) aliasCandidates.set(address, targets);
  }
  // Live rows at the cited loc: every claimant's, and the corpus's own, for
  // both the current URN (the published address) and a former one (where it
  // is one historical holder among others).
  // The corpus's own row is looked up for EVERY citation (@codex P2 on
  // #1506): with no competitor it is still what confirms a former-name
  // rewrite target, and skipping it would leave a valid citation unrewritten.
  const lookup = new Map<string, { memoryId: string; loc: string }>();
  for (const ref of refs) {
    for (const memoryId of [...allClaimantsOf(ref), corpus.id]) {
      lookup.set(`${memoryId}\u0000${ref.targetLoc}`, { memoryId, loc: ref.targetLoc });
    }
  }
  const live = new Map<string, string>();
  const keys = [...lookup.values()];
  for (let offset = 0; offset < keys.length; offset += SCAN_PAGE) {
    for (const n of await db.node.findMany({
      where: { deletedAt: null, memory: { deletedAt: null }, OR: keys.slice(offset, offset + SCAN_PAGE) },
      select: { id: true, memoryId: true, loc: true },
    })) live.set(`${n.memoryId}\u0000${n.loc}`, n.id);
  }
  return (ref) => {
    // (29c2245c) A current holder of a former name may be hidden. Classify
    // every cited loc under that name the same way, with or without its row,
    // so no surface becomes a foreign-loc probe. #1505: a reader resolves the
    // address to that hidden holder, so it is unresolvable, not "someone
    // else's" -- the mint blocks; backlinks and renumber never take it.
    if (corpus.unreadablePublishedUrns.has(ref.memoryUrn)) return UNRESOLVABLE_REFERENCE;
    const loc = ref.targetLoc;
    const at = (memoryId: string) => live.get(`${memoryId}\u0000${loc}`);
    // 1. The published address wins before any alias.
    if (ref.memoryUrn === corpus.urn && at(corpus.id)) return loc;
    const published = publishedOf(ref);
    if (ref.memoryUrn !== corpus.urn && published.some((m) => at(m))) return null;
    // 2. The resolver's candidates, keyed by node id, readable or not.
    const candidates = new Map<string, Candidate>();
    for (const m of claimantsOf(ref)) {
      const id = !published.includes(m) ? at(m) : undefined;
      if (id) candidates.set(id, { loc: null, readable: true });
    }
    for (const m of hiddenClaimantsOf(ref)) {
      const id = at(m);
      if (id) candidates.set(id, { loc: null, readable: false });
    }
    const own = ref.memoryUrn !== corpus.urn ? at(corpus.id) : undefined;
    if (own) candidates.set(own, { loc, readable: true });
    for (const [id, c] of aliasCandidates.get(`${ref.memoryUrn}:${loc}`) ?? []) candidates.set(id, c);
    // 3. Decide, with the resolver's concealment rule
    // (isConcealedNodeRefAmbiguity, cor:urn:030:01/:02): an ambiguity is
    // visible to this caller iff it can read at least one candidate. Until
    // then, unreadable candidates decide nothing, so the report cannot become
    // an oracle for them. Once one candidate is readable, the resolver already
    // refuses the address to this caller (node(ref:) answers
    // AmbiguousLegacyUrnError), so counting the hidden ones discloses nothing
    // new. Leaving them out would mint a citation no reader can resolve
    // (@codex P1 on #1506).
    const visible = [...candidates.values()].filter((c) => c.readable);
    if (visible.length === 0) {
      // (8eacfc78, #1494) A renumber rewrites a former-name citation only with
      // a CONFIRMED corpus target. Without one, the name may now belong to a
      // hidden published holder; decline uniformly, with or without that
      // holder's row, so a dry run cannot probe foreign child addresses.
      return forRewrite && ref.memoryUrn !== corpus.urn ? null : loc;
    }
    if (candidates.size === 1) return visible[0].loc;
    return visible.some((c) => c.loc !== null) ? UNRESOLVABLE_REFERENCE : null;
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

/** Re-read only rows present before a renumber's move; a new occupant of the freed loc cannot join its rewrite set. */
async function reloadCorpusNodesById(db: Pick<Context['db'], 'node'>, memoryId: string, ids: readonly string[]): Promise<ScannedNode[]> {
  const nodes: ScannedNode[] = [];
  for (let offset = 0; offset < ids.length; offset += SCAN_PAGE) {
    const page = await db.node.findMany({
      where: { memoryId, deletedAt: null, id: { in: ids.slice(offset, offset + SCAN_PAGE) } },
      select: SCANNED_SELECT,
    });
    nodes.push(...page.map(toScannedNode));
  }
  return nodes.sort((a, b) => a.id.localeCompare(b.id));
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
    const accept = await referenceAcceptor(ctx, corpus, scanned);
    const text = scanned.filter((r) => accept(r) === loc).map(fromScan);
    const target = nodes.find((n) => n.loc === loc)
      ?? await ctx.db.node.findFirst({
        where: { memoryId: corpus.id, loc, deletedAt: { not: null } }, select: { id: true },
      });
    // A live edge into a deleted spec still names its old citation. It is a
    // backlink, even though the mint/unresolved scan calls it MISSING.
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
    return unresolvedReferencesIn(ctx, corpus, await loadCorpusNodes(ctx.db, corpus.id));
  },
};

/**
 * The references in a corpus that do not reach a written spec (MISSING or
 * PLACEHOLDER), shared by specUnresolvedReferences and the mint report.
 */
async function unresolvedReferencesIn(
  ctx: Context,
  corpus: ScannableCorpus,
  nodes: ScannedNode[],
): Promise<SpecReferenceOut[]> {
    const { db } = ctx;
    const byLoc = new Map(nodes.map((n) => [n.loc, n]));
    const out: SpecReferenceOut[] = [];
    const scanned = scanReferences(nodes, corpus.pattern);
    const accept = await referenceAcceptor(ctx, corpus, scanned);
    for (const r of scanned) {
      const resolvedLoc = accept(r);
      // (#1505) The shared resolver refuses this address as ambiguous, and one
      // of the candidates it can see is ours. Report it as MISSING so the mint
      // blocks on it, and name it only by the citation already in our own text.
      if (resolvedLoc === UNRESOLVABLE_REFERENCE) {
        out.push({ ...fromScan(r), reason: 'MISSING' });
        continue;
      }
      if (resolvedLoc === null) continue;
      const target = byLoc.get(resolvedLoc);
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
    // (@codex P2, PR #1462) An edge may cross into another readable memory
    // (createEdge admits readable targets), so a placeholder there is an
    // unwritten spec this corpus points at. Only a memory the CALLER can read
    // is consulted: classifying by an unreadable one's rows would make this
    // report an oracle for it (findings:classifying-by-another-memorys-rows-
    // is-an-existence-oracle). Its target is named by node URN, since a loc
    // alone does not say which memory it is in.
    // A soft-deleted target there is as unresolved as one in the corpus
    // (@codex P2, PR #1462): MISSING, behind the same read gate.
    // (@codex P2, PR #1462) An edge into a memory the caller can NOT read
    // (access revoked after it was created) cannot be classified without
    // revealing that tenant's node state, and cannot be vouched for either, so
    // it BLOCKS uniformly, whatever its target's state, named only by the
    // target id this corpus's own edge row already carries.
    const foreign = await db.edge.findMany({
      where: {
        deletedAt: null,
        source: { memoryId: corpus.id, deletedAt: null },
        target: { memoryId: { not: corpus.id } },
      },
      select: {
        name: true, targetId: true, source: { select: { id: true, loc: true } },
        target: { select: { loc: true, memoryId: true, deletedAt: true, isPlaceholder: true, memory: { select: { urn: true } } } },
      },
      orderBy: { id: 'asc' },
    });
    for (const e of foreign) {
      const readable = await isMemoryReadableCached(ctx, e.target.memoryId);
      if (readable && !e.target.deletedAt && !e.target.isPlaceholder) continue;
      out.push({
        kind: 'EDGE', sourceNodeId: e.source.id, sourceLoc: e.source.loc, field: 'edge',
        targetLoc: readable
          ? `hrn:node:${e.target.memory.urn.replace(/^(?:hrn|urn):mem(?:ory)?:/i, '')}:${e.target.loc}`
          : e.targetId,
        text: e.name,
        reason: readable && !e.target.deletedAt ? 'PLACEHOLDER' : 'MISSING',
      });
    }
    // (@codex P2, PR #1462) deleteNode soft-deletes a spec but leaves the
    // edges pointing at it, so a live edge from the corpus to a deleted spec of
    // the corpus is a reference whose target no longer exists.
    const dangling = await db.edge.findMany({
      where: {
        deletedAt: null,
        source: { memoryId: corpus.id, deletedAt: null },
        target: { memoryId: corpus.id, deletedAt: { not: null } },
      },
      select: { name: true, source: { select: { id: true, loc: true } }, target: { select: { loc: true } } },
      orderBy: { id: 'asc' },
    });
    for (const e of dangling) {
      out.push({
        kind: 'EDGE', sourceNodeId: e.source.id, sourceLoc: e.source.loc, field: 'edge',
        targetLoc: e.target.loc, text: e.name, reason: 'MISSING',
      });
    }
    // (@codex P2s, PR #1462) A PendingEdge is an edge not materialized yet,
    // and promotion can materialize it later: an unresolved reference like any
    // other. Its targetId has two DISJOINT encodings (pendingEdgePromotion.ts),
    // and the kind is never inferred from the value or from an id join:
    // - a stable `@node-id:<id>` key is promotion retry work for a known node,
    //   so it is unresolved only while that node is missing, deleted or a
    //   placeholder;
    // - anything else is a reference no node has resolved yet (a loc, a Git
    //   file id, a URN), reported as recorded.
    const pending = await db.pendingEdge.findMany({
      where: { deletedAt: null, source: { memoryId: corpus.id, deletedAt: null } },
      select: { name: true, targetId: true, source: { select: { id: true, loc: true } } },
      orderBy: { id: 'asc' },
    });
    const stableIds = [...new Set(pending.map((p) => pendingEdgeStableTargetId(p.targetId)).filter((id): id is string => id !== null))];
    const stableTargets = new Map(stableIds.length === 0 ? [] : (await db.node.findMany({
      where: { id: { in: stableIds } },
      select: { id: true, loc: true, deletedAt: true, isPlaceholder: true, memoryId: true, memory: { select: { urn: true } } },
    })).map((t) => [t.id, t]));
    for (const p of pending) {
      const stableId = pendingEdgeStableTargetId(p.targetId);
      const target = stableId === null ? undefined : stableTargets.get(stableId);
      // (@codex P1 + P2, PR #1462) A stable key can name a node in ANOTHER
      // memory. One the caller cannot read may not DECIDE anything (whether it
      // reports, or what loc it names, would reveal that tenant's node state),
      // but the pending relationship still exists and can still materialize,
      // so it BLOCKS uniformly: unresolved, reported by its own recorded key.
      if (target && target.memoryId !== corpus.id && !(await isMemoryReadableCached(ctx, target.memoryId))) {
        out.push({
          kind: 'EDGE', sourceNodeId: p.source.id, sourceLoc: p.source.loc, field: 'pendingEdge',
          targetLoc: p.targetId, text: p.name, reason: 'MISSING',
        });
        continue;
      }
      const live = target && !target.deletedAt ? target : undefined;
      if (live && !live.isPlaceholder) continue;
      out.push({
        kind: 'EDGE', sourceNodeId: p.source.id, sourceLoc: p.source.loc, field: 'pendingEdge',
        targetLoc: !target ? p.targetId
          : target.memoryId === corpus.id ? target.loc
          : foreignNodeUrn(target.memory.urn, target.loc),
        text: p.name,
        reason: live ? 'PLACEHOLDER' : 'MISSING',
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
  accept: (ref: { memoryUrn: string; targetLoc: string }) => string | null,
  currentMemoryUrn: string,
) {
  const patch: Partial<Record<ScannedField, string>> = {};
  let count = 0;
  for (const field of SCANNED_FIELDS) {
    const before = n.fields[field];
    if (!before) continue;
    const r = rewriteCorpusReferences(before, pattern, fromLoc, toLoc, accept, currentMemoryUrn);
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
   * edit with revision history. A former memory name is replaced by the
   * corpus's current name so the new loc cannot resolve to a reused holder;
   * the prefix, separator style and any URL around it are kept.
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
    const scannedIds = nodes.map((node) => node.id);
    let movedForMirror: MovedNodeRef[] = [];
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
    // #1591: the same per-node draft-rights rule the mover enforces under its
    // locks, decided here too so a dry run plans only what a real run would
    // do (Atilla, PR #1593). The mover still re-decides it under the locks.
    // Pinned to this corpus and to live rows: a node that moved into another
    // memory since the scan must not lend that memory's loc to the refusal
    // (Atilla, PR #1593). The mover re-decides the moved set under its locks.
    const mintedLocs = (await ctx.db.node.findMany({
      where: { id: { in: movingNodes.map((n) => n.id) }, memoryId: corpus.id, deletedAt: null, mintedAt: { not: null } },
      select: { loc: true },
      orderBy: { loc: 'asc' },
    })).map((n) => n.loc);
    if (mintedLocs.length > 0) {
      const refusal = new SubtreeMoveMintedError(corpus.id, mintedLocs);
      throw new GraphQLError(refusal.message, {
        extensions: { code: 'NODE_MINTED', memoryId: corpus.id, locs: mintedLocs.slice(0, 10), count: mintedLocs.length },
      });
    }

    // (@codex P2, #1453) Decide which references are ours BEFORE the move.
    // When a prior holder of our URN also has a node at fromLoc, our own live
    // node there is what makes those references ours; once it has moved, the
    // prior holder's node would claim them and they would be left unrewritten.
    const resolve = await referenceAcceptor(ctx, corpus, scanReferences(nodes, corpus.pattern), true);
    // (#1505) Only a reference that resolves to a corpus loc is rewritten. An
    // ambiguous one is not ours to pick a target for: the rewriter treats any
    // non-null value as "rewrite", so narrow here.
    const accept = (ref: { memoryUrn: string; targetLoc: string }): string | null => {
      const resolved = resolve(ref);
      return typeof resolved === 'string' ? resolved : null;
    };

    const rewrites: RewriteOut[] = [];
    try {
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
          targetUrn: emitNodeUrnV2(corpus.urn, toLoc),
          // The move's intermediate body can still cite its old subtree. Mirror
          // once after the revisioned rewrites, from the final database state.
          mirrorAfterMove: false,
          // (@codex P1, PR #1453) The draft check above ran before the move's
          // lock; a mint can commit in between. Re-decided under the lock.
          requireUnminted: true,
        });
        movedForMirror = relocated.map((node) => ({ id: node.id, previousLoc: node.previousLoc }));
        nodes = await reloadCorpusNodesById(ctx.db, corpus.id, scannedIds);
        // (@codex P2, #1453) Report exactly what the atomic mover relocated,
        // with the loc each node left, not a reconstruction from a later read.
        moved = relocated
          .map((r) => ({ fromLoc: r.previousLoc, toLoc: r.loc }))
          .sort((a, b) => a.fromLoc.localeCompare(b.fromLoc));
      }

      for (const n of nodes) {
        const plan = planRewrite(n, corpus.pattern, fromLoc, toLoc, accept, corpus.urn);
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

    } finally {
      // The move commits before the per-node rewrites. If a reload or rewrite
      // step throws, still remove the old mirror paths from the committed move.
      // The helper re-reads the latest DB state and never throws to the caller.
      if (movedForMirror.length > 0) {
        void mirrorNodeMoveToGit(ctx.db, {
          srcMemoryId: corpus.id, destMemoryId: corpus.id,
          moved: movedForMirror, clientId: ctx.clientId ?? null,
        });
      }
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
  accept: (ref: { memoryUrn: string; targetLoc: string }) => string | null,
): Promise<{ fields: string[]; count: number; loc: string } | null> {
  let node: ScannedNode | undefined = initial;
  for (let attempt = 1; ; attempt++) {
    // The plan is computed from the row as stored, which may carry raw drift
    // (a write that bypassed revisions). writeNodeCore reconciles that drift
    // into its own revision BEFORE the compare-and-swap, which moves revSeq off
    // the value read here, and a refused write rolls the reconcile back too, so
    // every retry would conflict again. Commit the reconcile on its own first,
    // then read the settled revSeq and plan from that.
    await withIncludeHistoryTransaction(ctx.db, async (history) => {
      const tx = includeHistoryClient(history);
      const fresh = await liveTxContext(ctx, tx);
      await concealUnreadableDenial(fresh, corpus.id, corpus.id, () => requireMemoryWriteAccess(fresh, corpus.id));
      return reconcileNodeWithIncludeHistory(history, node!.id, { expectedMemoryId: corpus.id });
    }, { timeoutMs: 5_000, maxWaitMs: 2_000 });
    node = await loadCorpusNode(ctx.db, corpus.id, initial.id);
    if (!node) return null; // deleted or moved out meanwhile: nothing left to rewrite
    const plan = planRewrite(node, corpus.pattern, fromLoc, toLoc, accept, corpus.urn);
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
type MintFindingKind = 'PLACEHOLDER' | 'UNRESOLVED_REFERENCE' | 'LINT' | 'STALE_ABSTRACT' | 'NOT_APPROVED' | 'TAMPERED' | 'CITES_UNMINTED';

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
  /** #1591 — how many nodes this call minted (0 on a dry run or refusal). */
  mintedCount: number;
  /** #1591 — the locs this call minted, or would mint on a dry run, by loc. */
  mintLocs: string[];
  /** #1612 — the minted nodes in scope again (edited since, or no recorded revision), by loc. */
  remintLocs: string[];
  /** #1612 — how many of the stamped nodes were re-mints; a subset of mintedCount. */
  remintedCount: number;
  /** #1607 — nodes in scope with open discussion: a warning, never a blocker (cor:dmo:110:07). */
  unresolvedFeedback: UnresolvedFeedbackRow[];
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

/**
 * #1591 — mint every live node of a memory in the mint scope, after its checks.
 * `mintMemoryNodes` and the older `mintSpecCorpus` are this one operation.
 *
 * Scope (Holger's #1447 round-3 ruling 2b, widened by #1612, cor:dmo:120:06):
 * the memory's live nodes with no `mintedAt`, plus minted nodes with no
 * recorded revision or changed since ({@link inMintScope}); a re-mint keeps the
 * first mint's time and minter and advances the revision and hash. Findings are reported only for those nodes; a node minted
 * earlier neither blocks nor is linted again, so an existing corpus's legacy
 * issues cannot block minting its new specs. The scans still read the whole
 * memory, because a new spec's citation of a minted one must resolve.
 *
 * Blocks (a real run refuses `SPEC_CORPUS_MINT_BLOCKED` while any hold):
 * a placeholder; a reference to a missing spec or a placeholder; one of the
 * four server lint rules over the citation-shaped nodes; a stale abstract once
 * STALE_ABSTRACT_BLOCKS_MINT is on (#1408); `NOT_APPROVED`, a node whose
 * current revision is not approved (ruling 2c); and `CITES_UNMINTED`, an edge
 * into another memory's node that is not minted yet ("a minted node may not
 * cite an unminted one"). A citation inside the memory cannot be unminted
 * after the mint, since every node in scope is minted together. A TEXT
 * citation of another memory's node is not resolved by the reference scan,
 * so it is not checked here (#1591 follow-up).
 *
 * By any writer of the memory ({@link mayMintNodes}, ruling 2a). The check and
 * the stamp run inside {@link fenceCorpusForMint}, so no write lands between
 * the report and the mint, and each node is stamped with the revision and
 * approval hash the check just accepted. A dry run only reads. Minting
 * protects nothing by itself (#1591 permanence ruling).
 *
 * @throws GraphQLError `SPEC_CORPUS_BUSY` (retryable) when a node of the
 *   memory stays locked by an in-flight write.
 */
/** The canonical node URN naming `loc` in the memory published as `memoryUrn`. */
const foreignNodeUrn = (memoryUrn: string, loc: string) =>
  `hrn:node:${memoryUrn.replace(/^(?:hrn|urn):mem(?:ory)?:/i, '')}:${loc}`;

async function mintMemoryNodes(
  ctx: Context,
  memoryRef: string,
  dryRun: boolean,
): Promise<MintReport> {
  const { id } = await resolveMemoryRef(ctx.db, memoryRef);
  await concealUnreadableDenial(ctx, id, memoryRef, () => mayMintNodes(ctx, id));

  return ctx.db.$transaction(async (tx) => {
    if (dryRun) await tx.$queryRaw`SELECT id FROM memories WHERE id = ${id} FOR NO KEY UPDATE`;
    else await fenceCorpusForMint(tx, id);
    const txCtx = withoutRequestCaches(ctx, tx);
    // Re-authorize under the lock: an org transfer or a lost membership may
    // have committed between the check above and this lock.
    await concealUnreadableDenial(txCtx, id, memoryRef, () => mayMintNodes(txCtx, id));
    // Re-reads encryption under the lock just taken.
    const corpus = await loadScannableCorpus(txCtx, id);
    // #1607 (cor:dmo:110:06, 120:06) — comments are outside minting entirely:
    // not in scope, not linted, never a blocker, never stamped. #1641 — nor
    // decisions and their logs: a decision's evidence is its deciders'
    // approval or signature, never a corpus mint.
    const nodes = await tx.node.findMany({
      where: { memoryId: id, deletedAt: null, nodeType: { not: COMMENT_NODE_TYPE }, AND: [NOT_DECISION_FAMILY_WHERE] },
      orderBy: { loc: 'asc' },
      select: {
        id: true, loc: true, nodeType: true, tags: true, role: true, isPlaceholder: true, revSeq: true,
        name: true, description: true, abstract: true, content: true, abstractOriginHash: true,
        mintedAt: true, mintedRevNo: true, approvedRevNo: true, contentRevSeq: true, approvalHash: true,
      },
    });
    const inScope = nodes.filter(inMintScope);
    const inScopeIds = new Set(inScope.map((n) => n.id));
    const inScopeLocs = new Set(inScope.map((n) => n.loc));
    // The lint scope is exactly the CLI's (`lintSelects`, hadron-cli #708;
    // ruling (a) in team chat #4086): every spec-marked node at ANY loc, plus
    // every citation-shaped node, marked or not, so a spec that lost its tag
    // is still caught. A memory root at a citation-shaped name (`pas`)
    // occupies that citation and is linted like any node there, as the CLI
    // lints it; one at an ordinary name (`specs-draft`) is outside. Linted
    // over the whole memory (duplicate-loc compares across it), reported for
    // the nodes in scope.
    const cited = nodes.filter(mintLintSelects);
    const citedInScope = cited.filter((n) => inScopeIds.has(n.id));

    const blockers: MintFinding[] = [];
    for (const n of inScope) {
      if (n.isPlaceholder) {
        blockers.push({ kind: 'PLACEHOLDER', loc: n.loc, rule: null, message: 'reserved citation with no spec written', targetLoc: null });
      }
    }
    const scanned: ScannedNode[] = nodes.map((n) => ({
      id: n.id, loc: n.loc, isPlaceholder: n.isPlaceholder, revSeq: n.revSeq, role: n.role,
      fields: { name: n.name, description: n.description, abstract: n.abstract, content: n.content },
    }));
    for (const r of await unresolvedReferencesIn(txCtx, corpus, scanned)) {
      if (!inScopeIds.has(r.sourceNodeId)) continue;
      blockers.push({
        kind: 'UNRESOLVED_REFERENCE', loc: r.sourceLoc, rule: r.reason ?? null, targetLoc: r.targetLoc,
        message: r.reason === 'PLACEHOLDER'
          ? `${r.kind === 'EDGE' ? 'edge' : r.field} points at placeholder ${r.targetLoc}`
          : `${r.kind === 'EDGE' ? 'edge' : r.field} cites ${r.targetLoc}, which does not exist`,
      });
    }
    for (const f of lintCorpusForMint(cited)) {
      if (!inScopeLocs.has(f.loc)) continue;
      blockers.push({ kind: 'LINT', loc: f.loc, rule: f.rule, message: f.message, targetLoc: null });
    }
    // An approval that no longer covers the text is TAMPERED, not merely
    // not approved, when the retained evidence says the approved text was
    // altered outside the revision system (cor:dmo:120:05).
    const approvedSnapshots = await loadApprovedSnapshots(tx, inScope);
    for (const n of inScope) {
      if (n.isPlaceholder) continue;
      if (n.approvedRevNo != null && !approvalHoldsFor(n)) {
        const evidence = (approvedSnapshots.get(n.id) ?? [])
          .map((s) => ({ title: s.name, abstract: s.abstract, content: s.content }));
        const live = { title: n.name, abstract: n.abstract, content: n.content };
        if (checkNodeIntegrity(n, live, evidence).state === 'TAMPERED') {
          blockers.push({
            kind: 'TAMPERED', loc: n.loc, rule: null, targetLoc: null,
            message: `revision ${n.approvedRevNo} changed after it was approved, outside the revision system; re-approve it`,
          });
          continue;
        }
      }
      if (approvalHoldsFor(n)) {
        // The approval still covers the text (no content change since it was
        // recorded, #1611), but a write outside the
        // revision system leaves that boundary unchanged: recompute the hash
        // the mint is about to certify (Atilla, PR #1593). The memory is
        // plaintext here (an encrypted one is refused above).
        const actual = computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content });
        if (actual !== n.approvalHash) {
          blockers.push({
            kind: 'TAMPERED', loc: n.loc, rule: null, targetLoc: null,
            message: `revision ${n.revSeq} changed after it was approved, outside the revision system; re-approve it`,
          });
        }
        continue;
      }
      blockers.push({
        kind: 'NOT_APPROVED', loc: n.loc, rule: null, targetLoc: null,
        message: n.approvedRevNo === null
          ? `revision ${n.revSeq} is not approved`
          : `revision ${n.revSeq} is not approved (revision ${n.approvedRevNo} was)`,
      });
    }
    // An edge from a node in scope into another memory's live node that is
    // not minted yet. Only a memory the caller can read is classified (an
    // unreadable target already blocks as MISSING above, uniformly); naming it
    // by URN discloses nothing the edge row and the read gate do not already.
    const foreignTargets = await tx.edge.findMany({
      where: {
        deletedAt: null,
        source: { memoryId: id, deletedAt: null, id: { in: [...inScopeIds] } },
        target: { memoryId: { not: id }, deletedAt: null, isPlaceholder: false, mintedAt: null },
      },
      select: {
        source: { select: { loc: true } },
        target: { select: { loc: true, memoryId: true, memory: { select: { urn: true } } } },
      },
      orderBy: { id: 'asc' },
    });
    for (const e of foreignTargets) {
      if (!(await isMemoryReadableCached(txCtx, e.target.memoryId))) continue;
      const targetUrn = foreignNodeUrn(e.target.memory.urn, e.target.loc);
      blockers.push({
        kind: 'CITES_UNMINTED', loc: e.source.loc, rule: null, targetLoc: targetUrn,
        message: `edge points at ${targetUrn}, which is not minted yet`,
      });
    }
    // #1594 (cor:dmo:120:07, R205) — a text citation or a live pending edge
    // with a stable `@node-id:` target counts like an edge. A target the
    // caller cannot read is skipped with NO finding (not MISSING, unlike the
    // edge above): the mint result must not reveal whether it exists
    // (cor:api:140:03). Every resolver failure is dropped for the same reason.
    const citing = new Map<string, Array<{ sourceLoc: string; what: string }>>();
    const noteCiting = (targetId: string, sourceLoc: string, what: string) => {
      const list = citing.get(targetId) ?? [];
      list.push({ sourceLoc, what });
      citing.set(targetId, list);
    };
    const resolvedByUrn = new Map<string, string | null>();
    for (const n of inScope) {
      for (const field of SCANNED_FIELDS) {
        for (const urn of findNodeUrnTokens(n[field])) {
          let targetId = resolvedByUrn.get(urn);
          if (targetId === undefined) {
            targetId = await resolveNodeRefForCaller(txCtx, urn).then((r) => r.id, (e: unknown) => {
              // Only the resolver's documented "no such citation" refusals are
              // dropped (they must look like nothing is there). Anything else
              // is an infrastructure fault: abort, never mint past a citation
              // we could not check.
              if (e instanceof NodeNotFoundError || e instanceof AmbiguousLegacyUrnError
                || e instanceof UrnNotQualifiedError || e instanceof UrnParseError) return null;
              throw e;
            });
            resolvedByUrn.set(urn, targetId);
          }
          if (targetId !== null) noteCiting(targetId, n.loc, `${field} cites`);
        }
      }
    }
    const scopeLocById = new Map(inScope.map((n) => [n.id, n.loc]));
    const pendingStable = await tx.pendingEdge.findMany({
      where: { deletedAt: null, sourceId: { in: [...inScopeIds] } },
      select: { sourceId: true, targetId: true },
      orderBy: { id: 'asc' },
    });
    for (const p of pendingStable) {
      const stableId = pendingEdgeStableTargetId(p.targetId);
      if (stableId !== null) noteCiting(stableId, scopeLocById.get(p.sourceId) ?? '', 'pending edge points at');
    }
    if (citing.size > 0) {
      const targets = await tx.node.findMany({
        where: { id: { in: [...citing.keys()] }, memoryId: { not: id }, deletedAt: null, isPlaceholder: false, mintedAt: null },
        select: { id: true, loc: true, memoryId: true, memory: { select: { urn: true } } },
        orderBy: { id: 'asc' },
      });
      for (const t of targets) {
        // The RESOLVED node's own memory decides, never the memory the
        // address named: an alias can point anywhere.
        if (!(await isMemoryReadableCached(txCtx, t.memoryId))) continue;
        const targetUrn = foreignNodeUrn(t.memory.urn, t.loc);
        const seen = new Set<string>();
        for (const c of citing.get(t.id) ?? []) {
          const key = `${c.sourceLoc} ${c.what}`;
          if (seen.has(key)) continue;
          seen.add(key);
          blockers.push({
            kind: 'CITES_UNMINTED', loc: c.sourceLoc, rule: null, targetLoc: targetUrn,
            message: `${c.what} ${targetUrn}, which is not minted yet`,
          });
        }
      }
    }
    const staleAbstracts: MintFinding[] = citedInScope
      .filter((n) => isAbstractUnverified(n))
      .map((n) => ({
        kind: 'STALE_ABSTRACT' as const, loc: n.loc, rule: null, targetLoc: null,
        message: 'the abstract was written for an earlier body; re-affirm or rewrite it',
      }));
    if (STALE_ABSTRACT_BLOCKS_MINT) blockers.push(...staleAbstracts);

    const byDecider = new Map<string | null, Array<{ loc: string; question: string }>>();
    for (const n of citedInScope) {
      for (const q of parseOpenQuestions(n.content)) {
        byDecider.set(q.decider, [...(byDecider.get(q.decider) ?? []), { loc: n.loc, question: q.question }]);
      }
    }
    const openQuestions = [...byDecider.entries()]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
      .map(([decider, questions]) => ({ decider, questions }));

    // New nodes and re-mints are reported apart; mintedCount counts both.
    const mintLocs = inScope.filter((n) => n.mintedAt === null).map((n) => n.loc);
    const remintLocs = inScope.filter((n) => n.mintedAt !== null).map((n) => n.loc);
    const report: MintReport = {
      memoryId: id, dryRun, minted: false, blockers,
      staleAbstracts, staleAbstractsBlock: STALE_ABSTRACT_BLOCKS_MINT, openQuestions,
      mintedCount: 0, remintedCount: 0, mintLocs, remintLocs,
      unresolvedFeedback: (await unresolvedFeedbackOf(tx, inScope)).map((f) => ({ ...f, memoryId: id })),
    };
    if (dryRun) return report;
    if (blockers.length > 0) {
      throw new GraphQLError(
        `Minting refused: ${blockers.length} blocking item(s) remain. Run mintMemoryNodes with dryRun: true for the full report.`,
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
    if (inScope.length === 0) return report;
    const now = new Date();
    const minter = editorFromAuth(ctx);
    // Every node in scope passed NOT_APPROVED and TAMPERED under this fence,
    // so each one's approval still covers its current text (no content change
    // since it was recorded, #1611) and its stored hash equals the text being
    // minted: stamp the current revision and that hash.
    const ids = [...inScopeIds];
    const mintedCount = await tx.$executeRaw`
      UPDATE nodes SET
        minted_at = COALESCE(minted_at, ${now}),
        minted_by = CASE WHEN minted_at IS NULL THEN ${minter.userId ?? null}::text ELSE minted_by END,
        minted_by_info = CASE WHEN minted_at IS NULL THEN ${minter.userId ? null : minter.info ?? 'unknown'}::text ELSE minted_by_info END,
        minted_rev_no = rev_seq,
        minted_hash = approval_hash
      WHERE memory_id = ${id} AND deleted_at IS NULL AND ${inMintScopeSql}
        AND id = ANY(${ids}::text[]) AND approved_rev_no >= content_rev_seq AND approval_hash IS NOT NULL`;
    if (mintedCount !== ids.length) {
      // Unreachable under the fence; refuse rather than mint a partial set.
      throw new Error(`Mint stamped ${mintedCount} of ${ids.length} nodes; the memory changed under the fence`);
    }
    // The legacy corpus stamp (#1448), kept for one release as the record of
    // the latest mint; corpus state itself is derived from the nodes.
    await tx.memory.update({
      where: { id },
      data: { corpusDraft: false, corpusMintedAt: now, corpusMintedBy: ctx.userId ?? ctx.clientId ?? null },
    });
    return { ...report, minted: true, mintedCount, remintedCount: remintLocs.length };
  }, { timeout: 120_000 });
}

export const specCorpusMintMutations = {
  /** #1591 — mint every unminted live node of a memory. See {@link mintMemoryNodes}. */
  mintMemoryNodes: (
    _: unknown,
    { memoryRef, dryRun }: { memoryRef: string; dryRun?: boolean | null },
    ctx: Context,
  ): Promise<MintReport> => mintMemoryNodes(ctx, memoryRef, !!dryRun),

  /**
   * #1448, generalized by #1591: the same operation as `mintMemoryNodes`, kept
   * under its original name for the shipped CLI (`hadron spec mint`).
   */
  mintSpecCorpus: (
    _: unknown,
    { memoryRef, dryRun }: { memoryRef: string; dryRun?: boolean | null },
    ctx: Context,
  ): Promise<MintReport> => mintMemoryNodes(ctx, memoryRef, !!dryRun),
};
