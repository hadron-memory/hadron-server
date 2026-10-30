import { committedSyncReport, failedSyncReport, type SyncReportEntry } from './syncReport.js';
import { GitCommandError } from './execGit.js';
import { stampEmbeddingObligation } from '../../services/embedding/obligation.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, assertNoBootPromptRows, assertNoWorkerSessionBootPromptWrite, boundWorkerId, withSyncCaller } from '../../lib/bootPrompt.js';
import { currentActor } from '../../lib/requestActor.js';
import { assertIncludesWritable, prospectiveNodeId, includeRefusalCode, storedIncludeTags, syncDerivedIncludesEdges } from '../../lib/includes/writeIncludes.js';
import { runAsSystem } from '../../lib/requestActor.js';
import { createDecipheriv } from 'crypto';
import { COMMENT_NODE_TYPE } from '../../lib/comments/index.js';
import { isDecisionFamilyRole } from '../../lib/decisions/index.js';
import { hardDeleteThreadsOfTargets } from '../../lib/comments/lifecycle.js';
import { GraphQLError } from 'graphql';
import { assertPlaceholderKeepsSpecRole, placeholderFillPatch } from '../../lib/specCorpus.js';
import { governedSignalsFromMirror } from '../../lib/governedSignals.js';
import { lockMemoryConfigShared, mergedGovernedState, strictParentRefusingRole } from '../../lib/governedRole.js';
import { authoredContentChanged, clearNodeAuthorship } from '../../lib/nodeAuthorship.js';
import { NodeSchemaViolation, validateNodeAgainstSchema } from '../../lib/validateNodeAgainstSchema.js';
import type { MemorySchema } from '../../lib/memorySchema.js';
// Spec 049 S4 — a Channel's address is skipped and reported, never overwritten from git.
import {
  protectedLocsIn,
  protectedLocCovers,
  protectedDeletionFilter,
} from '../../lib/protectedLoc.js';
import { generateId } from '../../lib/id.js';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { GRAPHS_PATH } from '../../config.js';
import { pathUnderGraphsRoot } from '../localFs/pathUnderGraphsRoot.js';
import { InvalidNodeNameError, loadGraphFromFs, type UnreadableFile } from '../localFs/loadGraphFromFs.js';
import { deriveEdgeLoc } from '../../lib/edgeLoc.js';
import { validateEdgeCondition } from '../../lib/edge-conditions/validator.js';
import { countCrossMemoryEdgesForNodeDelete } from '../../lib/crossMemoryEdgeDelete.js';
import { db } from '../db/client.js';
import { serializeTags } from '../db/provider.js';
import { getInstallationToken, toHttpsUrl } from './githubApp.js';
import { execGit } from './execGit.js';
import { validateMemorySource } from '../../lib/gitSource.js';
import { wakeEmbeddingQueue } from '../../services/embedding/enqueue.js';
import { acquireLockSet, ancestorLocs, lockAncestorsForCreateMany } from '../../lib/nodeSubtreeLock.js';
import { Prisma, type Memory, type Node, type Organization } from '../../generated/prisma/index.js';
import { validateGitBranch } from '../../lib/gitRef.js';
import { withMirrorCheckoutLock } from './mirrorCheckoutLock.js';
import { lockMemoriesForChannelChange } from '../../lib/channels.js';
import { lockMintedSpecsIn, lockMintedSpecUnmarks } from '../../lib/mintedSpecPermanence.js';
import { recordUrnRename } from '../../lib/urnAlias.js';
import { safeNodeUrnV2 } from '../../lib/urnEmit.js';
import { deletePendingEdgesTargetingNodes, reconcilePendingEdgeCount, reconcilePendingEdgeCounts } from '../../lib/pendingEdgePromotion.js';
import { ENCRYPTED_GIT_SYNC_MESSAGE, ENCRYPTED_GIT_SYNC_UNAVAILABLE } from './encryptedGitSync.js';
import {
  buildNodeRevisionSnapshot,
  createNodeRevision,
  diffNodeChanges,
  ensureCurrentNodeRevisionInTransaction,
  revisionStateHashRefreshMarker,
} from '../../lib/nodeRevisionSnapshot.js';

function decryptToken(ciphertext: string): string {
  const key = process.env.HADRON_ENCRYPTION_KEY;
  if (!key) throw new Error('HADRON_ENCRYPTION_KEY env var is required');
  const keyBuf = Buffer.from(key, 'hex');
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// spec 047: `organization` is nullable (a user-owned memory has no org). Git
// sync is org-scoped, so the sync fn returns early when it's null.
export type MemoryWithOrg = Memory & { organization: Organization | null };

class EdgeEndpointPreflightStale extends Error {}
const MAX_EDGE_ENDPOINT_PREFLIGHT_RETRIES = 3;

/**
 * #1411 review (Andi) — a loc swap parked an occupant at `<loc>~displaced-<id>`
 * and nothing later in the run settled it: its own file was deferred or
 * refused, or the cleanup that would have pruned it did not run. Committing
 * would persist a loc `validateLoc` refuses, so the transaction is rolled back
 * and rerun with these rows marked unparkable.
 */
class GitSyncUnsettledParking extends Error {
  constructor(readonly nodeIds: string[]) {
    super(`Git sync parked ${nodeIds.join(', ')} and could not settle them`);
  }
}

/** #1566: an old blank-read sync may have adopted write-branch-only nodes. */
class GitSyncRecoveryReviewRequired extends Error {
  constructor(locs: string[]) {
    super(
      `GIT_SYNC_REVIEW_REQUIRED: ${locs.length} repo-owned node(s) are absent from the default read branch ` +
      `(${locs.slice(0, 20).join(', ')}${locs.length > 20 ? ', …' : ''}). ` +
      'No changes were applied. Review these nodes, then set readBranch explicitly to authorize repo-wins cleanup.',
    );
    this.name = 'GitSyncRecoveryReviewRequired';
  }
}

/**
 * The row left the memory being synced between the preflight lookup and its
 * row lock (a concurrent cross-memory move). Applying the repo's update by id
 * would rewrite a node that now belongs to ANOTHER memory, so the sync aborts
 * and the next run re-plans from fresh reads (@copilot, PR #1339).
 */
export class GitSyncTargetMovedError extends Error {
  constructor(nodeId: string, expectedMemoryId: string) {
    super(`Git sync target ${nodeId} left memory ${expectedMemoryId} while the sync ran; retry the sync.`);
    this.name = 'GitSyncTargetMovedError';
  }
}

/** #1330 — a synced file refused because its role is undeclared under a strict parent. */
export interface SkippedUndeclaredRole {
  loc: string;
  role: string;
  strictParent: string;
  code: 'ROLE_NOT_DECLARED';
}

/** #2040 — a synced file whose include tags are invalid; the file is skipped, its row kept. */
export interface SkippedInvalidInclude {
  loc: string;
  code: string;
  message: string;
}

export function describeSkippedUndeclaredRole(s: SkippedUndeclaredRole): string {
  return `${s.loc} (role "${s.role}", strict parent "${s.strictParent}")`;
}

/**
 * #1330 / #1411 review — the caller-facing report of an on-demand sync. Every
 * file the sync left unapplied is named, or the caller reads a clean sync and
 * never retries: an on-demand sync has no guaranteed follow-up (@codex P2).
 */
export function describeSyncOutcome(result: {
  nodeCount?: number;
  skippedUndeclaredRoles?: SkippedUndeclaredRole[];
  skippedInvalidIncludes?: SkippedInvalidInclude[];
  deferredLateRows?: string[];
  heldMoves?: string[];
}): string {
  const section = (items: string[] | undefined, heading: (n: number) => string): string =>
    items && items.length > 0 ? `\n${heading(items.length)}\n${items.map((i) => `- ${i}`).join('\n')}` : '';
  return (
    `Synced ${result.nodeCount ?? 0} nodes.` +
    section(
      result.skippedUndeclaredRoles?.map(describeSkippedUndeclaredRole),
      (n) => `Skipped ${n} file(s), ROLE_NOT_DECLARED (the role is not declared under a strict parent; declare it or change the file):`,
    ) +
    section(
      result.skippedInvalidIncludes?.map((i) => `${i.loc} (${i.code}: ${i.message})`),
      (n) => `Skipped ${n} file(s) with an invalid include tag (fix the tag; the stored node was kept as it was):`,
    ) +
    section(
      result.deferredLateRows,
      (n) => `Deferred ${n} file(s) whose node changed while this sync ran; sync again to apply them:`,
    ) +
    section(
      result.heldMoves,
      (n) => `Held ${n} move(s) whose destination is still occupied by a node this sync could not move; they land once that node's file syncs:`,
    )
  );
}

/**
 * #1568: a file in the repo could not be loaded (missing or invalid frontmatter,
 * malformed YAML in a node or edge file, a read error) and it sits on the loc
 * of an existing node. Repo-wins cleanup would read
 * that as "removed from the repo" and hard-delete the node, so the whole sync
 * is refused before anything is written, the same posture #1567 takes for a
 * missing name. An unreadable file with no node at its loc is skipped as
 * before: nothing can be lost there, and a repo may hold plain documents.
 */
export class GitSyncUnreadableFileError extends Error {
  constructor(readonly files: ReadonlyArray<UnreadableFile>) {
    const list = files.map((f) => JSON.stringify(f.file)).join(', ');
    super(
      `Git sync cannot read ${list}: the file could not be read or parsed (for example missing or invalid frontmatter, or malformed YAML). ` +
      `${files.length === 1 ? 'It holds an existing node' : 'They hold existing nodes'}, ` +
      'which this sync would otherwise delete. Fix or remove the file; nothing was written.',
    );
    this.name = 'GitSyncUnreadableFileError';
  }
}

export class GitSyncEncryptedMemoryError extends Error {
  constructor() {
    super(ENCRYPTED_GIT_SYNC_MESSAGE);
    this.name = 'GitSyncEncryptedMemoryError';
  }
}

async function assertGitSyncMemoryPlaintext(tx: Prisma.TransactionClient, memoryId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "memories" WHERE "id" = ${memoryId} FOR SHARE`;
  const memory = await tx.memory.findUniqueOrThrow({
    where: { id: memoryId }, select: { isEncrypted: true },
  });
  if (memory.isEncrypted) throw new GitSyncEncryptedMemoryError();
}

/** Apply a Git-owned update without bypassing the live-revision contract. */
export async function updateNodeFromGitSync(
  tx: Prisma.TransactionClient,
  current: Node,
  update: Record<string, unknown>,
  revisionBase: Node | undefined,
  expectedMemoryId: string,
  /**
   * #1348 — fields decided against the LOCKED row rather than the caller's
   * earlier read (the objectType schema check needs the properties the row
   * has at write time, not before the lock).
   */
  extra?: (locked: Node) => Record<string, unknown>,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "nodes" WHERE "id" = ${current.id} FOR UPDATE`;
  const owner = await tx.node.findUnique({ where: { id: current.id }, select: { memoryId: true } });
  if (!owner || owner.memoryId !== expectedMemoryId) {
    throw new GitSyncTargetMovedError(current.id, expectedMemoryId);
  }
  await assertGitSyncMemoryPlaintext(tx, expectedMemoryId);
  // Unrevisioned drift gets its OWN revision before the Git edit's, never
  // folded into it (@codex P1 / @copilot, PR #1339) — the same order as the
  // GraphQL and MCP update paths. A swap base is exempt: its row was
  // reconciled when the swap captured it, and the parked row is a
  // mechanical waypoint, not a committed state.
  if (revisionBase == null) {
    await ensureCurrentNodeRevisionInTransaction(tx, current.id, { expectedMemoryId });
  }
  const locked = await tx.node.findUniqueOrThrow({ where: { id: current.id } });
  // A swap can park this row at a temporary invalid loc earlier in the SAME
  // transaction. History must describe committed states, so diff/snapshot the
  // captured pre-sync row rather than that mechanical waypoint.
  const before = revisionBase ?? locked;
  if (extra) update = { ...update, ...extra(locked) };
  // #1450 (@codex P2, PR #1452): a placeholder stays a spec until it is
  // written. Sync's rule for a file that would break an invariant applies (one
  // bad file must not block the memory, and no nonconforming record is
  // written): the stored role is KEPT, the rest of the file still applies, and
  // the file is reported. Filtered BEFORE the diff (@codex P2, PR #1452): a
  // kept role is not a change, so it must not record a revision.
  if ('role' in update) {
    try {
      assertPlaceholderKeepsSpecRole(locked, { role: update.role as string | null, content: update.content });
    } catch (e) {
      if (!(e instanceof GraphQLError) || e.extensions?.code !== 'SPEC_PLACEHOLDER_ROLE_LOCKED') throw e;
      console.warn(`[syncGraphFromGithub] kept role 'spec' on unwritten placeholder ${locked.loc}: ${e.message}`);
      const { role: _kept, ...rest } = update;
      update = rest;
    }
  }
  // #1468 — a file that drops the spec marker from a minted spec would make
  // it deletable. Same keep-and-report rule as above: the stored tags and role
  // are KEPT, the rest of the file applies, and nothing fails the sync.
  if ('tags' in update || 'role' in update) {
    const unmarked = await lockMintedSpecUnmarks(tx, expectedMemoryId, [{
      id: locked.id,
      tags: 'tags' in update ? (update.tags as string[]) : undefined,
      role: 'role' in update ? (update.role as string | null) : undefined,
    }]);
    if (unmarked.length > 0) {
      console.warn(
        `[syncGraphFromGithub] kept the spec marker on minted spec ${locked.loc}: ` +
          'the file drops it, and a minted spec stays a spec (#1468).',
      );
      const { tags: _keptTags, role: _keptRole, ...rest } = update;
      update = rest;
    }
  }
  // Compare the logical JSON value, not Prisma's persistence-only null sentinel.
  const changes = diffNodeChanges(before, update.data === Prisma.DbNull ? { ...update, data: null } : update);

  if (changes.length > 0) {
    await createNodeRevision(
      tx,
      buildNodeRevisionSnapshot(
        before,
        { userId: null, info: 'system:github-sync' },
        { revLabel: 'Synchronized from GitHub', changes },
      ),
    );
  }

  await tx.node.update({
    where: { id: locked.id },
    data: {
      ...(update as Prisma.NodeUncheckedUpdateInput),
      ...(authoredContentChanged(changes) ? clearNodeAuthorship() : {}),
      // #1450 (@codex P2, PR #1452): filling a reserved citation by editing its
      // mirrored file writes the spec, same as updateSpecNode.
      ...placeholderFillPatch(locked, update.content),
      revisionContentHash: revisionStateHashRefreshMarker(),
    },
  });
}

/**
 * Sync a memory from GitHub: clone/pull the repo, load nodes from filesystem,
 * and upsert them into the database.
 */
const syncGraphFromGithubAsSystem = async (
  graph: MemoryWithOrg,
  edgeEndpointPreflightAttempt = 0,
): Promise<{
  error?: string;
  errorCode?: 'BAD_USER_INPUT' | typeof ENCRYPTED_GIT_SYNC_UNAVAILABLE;
  /** #1789: `error` is an unexpected exception's text (driver, filesystem, git), not a typed refusal; callers must not echo it. */
  fault?: true;
  nodeCount?: number;
  /**
   * #1061 — the nodes this run actually wrote, for a caller that HAS a
   * principal to attribute them to (the `hadron_sync_graph` tool). Deliberately
   * returned rather than recorded here: this function is also driven by the
   * webhook and the startup batch loop, where there is no caller at all, and
   * usage attributed to nobody is worse than usage not recorded. An unattended
   * sync is not somebody's activity.
   */
  writtenNodes?: { id: string; loc: string; memoryId: string }[];
  /** Spec 049 S4 — file locs that overlap a Channel's address; skipped, never written. */
  skippedProtected?: string[];
  /**
   * #1348 — files whose objectType was NOT written because the resulting
   * record would violate the memory's property schema (`loc (objectType):
   * reason`). The node itself is still synced; its stored objectType is kept.
   */
  skippedObjectTypes?: string[];
  /**
   * #1330 — files NOT synced because the role they assign is undeclared under
   * a strict parent rule (`ROLE_NOT_DECLARED`, the same judgement every other
   * write path makes). The file is skipped whole and its existing row, if any,
   * is kept as it was; every other file still syncs.
   */
  skippedUndeclaredRoles?: SkippedUndeclaredRole[];
  /** #2040 — files NOT synced because an include tag is malformed or cycles. */
  skippedInvalidIncludes?: SkippedInvalidInclude[];
  /**
   * #1330 — files left for the next sync because the node they would write
   * arrived after this sync locked its rows (`loc (node <id>)`). Only while
   * the sync holds the rulebook lock.
   */
  deferredLateRows?: string[];
  /**
   * #1411 review — id-first moves NOT applied this sync (`old → new (occupant
   * <id>)`) because the node holding the destination could not be moved out
   * of the way: its own file was deferred or refused, so parking it would
   * have left it at an invalid `~displaced-` loc. The mover keeps its old
   * loc; the move lands on a sync that can settle the occupant.
   */
  heldMoves?: string[];
}> => {
  try {
    const graphName = graph.urn;

    // spec 047: git sync is org-scoped (needs the org's GitHub App). A
    // user-owned memory has no org — surface it as an error so an explicit
    // syncMemory call gets a meaningful message rather than a silent no-op
    // (startup's batch loop guards on `organization` before calling).
    // R206 / cor:sec:040:05: an explicit sync of an encrypted memory fails loudly
    // with the typed code BEFORE the DB-only and no-organization no-ops, so a
    // memory with no source (or no org) never reads as a healthy sync. The row
    // is left untouched: there is nothing to mark ERROR on a memory that has no
    // sync to fail.
    if ((await db.memory.findUnique({ where: { id: graph.id }, select: { isEncrypted: true } }))?.isEncrypted) {
      return { error: ENCRYPTED_GIT_SYNC_MESSAGE, errorCode: ENCRYPTED_GIT_SYNC_UNAVAILABLE };
    }
    if (!graph.organization) {
      return { error: 'Memory has no organization (user-owned memories are not git-synced)' };
    }
    const organization = graph.organization;

    // DB-only mode — skip all git operations
    if (!graph.source) {
      console.log(`[syncGraphFromGithub] "${graphName}" is DB-only — skipping git sync`);
      return {};
    }

    // #561 — re-validate the STORED value, not just the incoming one.
    //
    // `validateMemorySource` runs on createMemory/updateMemory, so it governs
    // every future write and no row already in the table. This function is
    // reached by the startup batch loop, the webhook and `syncMemory` — none of
    // which went through a mutation — so a row persisted before the allowlist
    // existed would still reach git. The transport guard does not cover it
    // either: https is explicitly ALLOWED there, which is exactly what a
    // legacy non-github source would be using (@codex, PR #1142).
    //
    // Checked at the point of USE rather than migrated: a migration fixes the
    // rows that exist on the day it runs, and this holds for a row restored
    // from a backup, seeded, or written by any path added later.
    //
    // Thrown, NOT returned: the catch below is what stamps `syncStatus: ERROR`
    // and `syncError`, and a legacy row nobody can see is a legacy row nobody
    // fixes. An earlier draft returned `{ error }` here — the caller saw the
    // message, the ROW stayed PENDING with a null syncError, and the portal
    // showed a memory that simply never synced. Caught by the test below, not
    // by reading this.
    validateMemorySource(graph.source);

    // Avoid clone/pull work for an encrypted memory. The transaction below
    // repeats this check under a row lock because this preflight can go stale.
    const encryptionState = await db.memory.findUnique({
      where: { id: graph.id }, select: { isEncrypted: true },
    });
    if (encryptionState?.isEncrypted) throw new GitSyncEncryptedMemoryError();

    // Update sync status to SYNCING
    await db.memory.update({
      where: { id: graph.id },
      data: { syncStatus: 'SYNCING', syncError: null },
    }).catch(() => {});

    const slug = graphName.includes(':') ? graphName.split(':').slice(1).join(':') : graphName;
    const localPath = pathUnderGraphsRoot(GRAPHS_PATH, organization.urn, slug);
    const ownerRepo = extractOwnerRepo(graph.source);

    // 1. Get installation token (requires GitHub App installation)
    if (!organization.githubInstallationId) {
      console.warn(
        `[syncGraphFromGithub] "${graphName}" — skipping: organization "${organization.urn}" has no githubInstallationId`,
      );
      return {};
    }

    // Build per-org credentials if available
    const org = organization;
    const credentials = org.githubAppId && org.githubAppPrivateKeyEncrypted
      ? { appId: org.githubAppId, privateKeyPem: decryptToken(org.githubAppPrivateKeyEncrypted) }
      : undefined;

    const token = await getInstallationToken(organization.githubInstallationId, credentials);
    const source = graph.source;
    const cloneUrl = toHttpsUrl(source, token);

    // 2. Clone or pull the repo
    // Mirror writes use this same checkout. Hold their lock through the read:
    // otherwise a writer can switch to the write branch between checkout and
    // loadGraphFromFs, even when the read branch was selected correctly.
    const { graph: fsGraph, edges, skippedInvalidLoc, unreadable, rootNode } = await withMirrorCheckoutLock(graph.id, async () => {
      try {
        await gitSync(cloneUrl, localPath, graph.readBranch ?? undefined);
        // Await the read so finally runs after its async success or failure.
        return await loadGraphFromFs(localPath, graphName, ownerRepo);
      } finally {
        await restoreReadRemote(localPath, source);
      }
    });

    // 4. Upsert all nodes and edges into the database (transactional)
    // Git sync refuses encrypted memories under its authority transaction. Stamp
    // ordinary obligations with each accepted write, then issue ONE post-commit
    // wake: no second plaintext/job list grows with the import size.
    let embeddingWakeNeeded = false;
    // #1061 — accumulated INSIDE the transaction (that is where the surviving
    // row ids are known) but declared outside it so the refs survive the commit
    // and can be returned to the caller.
    const writtenNodes: { id: string; loc: string; memoryId: string }[] = [];
    const skippedProtected: string[] = [];
    const skippedObjectTypes: string[] = [];
    const skippedUndeclaredRoles: SkippedUndeclaredRole[] = [];
    const skippedInvalidIncludes: SkippedInvalidInclude[] = [];
    const deferredLateRows: string[] = [];
    const heldMoves: string[] = [];
    const reportEntries: SyncReportEntry[] = [];
    // #1411 review — occupants a previous attempt parked and could not settle.
    // Grows by a distinct row (one sitting at a file's loc) per retry, so the
    // attempts are bounded by the file count.
    const unparkable = new Set<string>();

    // #1226 / PR #1257 — collect every memory whose node may become an edge
    // endpoint in this transaction BEFORE taking any Channel-memory key. Git
    // edges may target another memory, and incoming PendingEdges may originate
    // in another memory; locking only graph.id lets either writer land after a
    // concurrent Channel reuse has swept the old transcript's edges.
    //
    // The preflight deliberately over-approximates. A file-id remap can turn a
    // raw external id into this graph's own row, and an existing loc row can
    // survive with an id different from the file's frontmatter. Extra memory
    // locks cost one advisory round trip; a missed endpoint memory reopens a
    // deleted-message disclosure.
    const candidateLocs = fsGraph.nodes
      .map((node) => node.loc)
      .filter((loc): loc is string => typeof loc === 'string');
    const rawTargetIds = [...new Set(edges.map((edge) => edge.targetId))];
    const [rawTargets, existingGraphRows] = await Promise.all([
      rawTargetIds.length
        ? db.node.findMany({
            where: { id: { in: rawTargetIds }, deletedAt: null },
            select: { id: true, loc: true, memoryId: true },
          })
        : [],
      candidateLocs.length
        ? db.node.findMany({
            where: { memoryId: graph.id, loc: { in: candidateLocs } },
            select: { id: true },
          })
        : [],
    ]);
    const incomingTargetIds = [...new Set([
      ...fsGraph.nodes.flatMap((node) => node.id ? [node.id] : []),
      ...existingGraphRows.map((row) => row.id),
    ])];
    const incomingPending = incomingTargetIds.length
      ? await db.pendingEdge.findMany({
          where: { targetId: { in: incomingTargetIds } },
          select: { sourceId: true },
        })
      : [];
    const pendingSources = incomingPending.length
      ? await db.node.findMany({
          where: {
            id: { in: [...new Set(incomingPending.map((edge) => edge.sourceId))] },
            deletedAt: null,
          },
          select: { id: true, loc: true, memoryId: true },
        })
      : [];
    const endpointSnapshots = [...new Map(
      [...rawTargets, ...pendingSources].map((node) => [node.id, node]),
    ).values()];
    const edgeEndpointMemoryIds = [...new Set([
      graph.id,
      ...rawTargets.map((node) => node.memoryId),
      ...pendingSources.map((node) => node.memoryId),
    ])].sort();
    const edgeEndpointMemoryIdSet = new Set(edgeEndpointMemoryIds);

    // #449 — source memories whose pending-edge count the cleanup changed,
    // reconciled after commit (the transaction holds the rulebook lock, so it
    // must not wait on other memories' rows).
    let pendingSourceMemories: string[] = [];
    let correctionCheckCompleted = false;
    for (;;) {
    // Every accumulator restarts with the attempt: a rolled-back attempt
    // wrote nothing, so nothing it reported is true.
    embeddingWakeNeeded = false;
    for (const acc of [writtenNodes, skippedProtected, skippedObjectTypes, skippedUndeclaredRoles, skippedInvalidIncludes, deferredLateRows, heldMoves, reportEntries]) {
      acc.length = 0;
    }
    pendingSourceMemories = [];
    correctionCheckCompleted = false;
    try {
      await db.$transaction(async (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => {
      // Hold every endpoint memory key in one stable order for the ENTIRE
      // snapshot-to-cleanup/edge-write interval. This includes graph.id, so it
      // preserves the cleanup-vs-resurrection serialization added earlier.
      await lockMemoriesForChannelChange(tx, edgeEndpointMemoryIds);
      // #664/#752: a git-sync bulk-upserts/moves rows into an EXISTING memory,
      // bypassing the locked create surfaces. Lock the ancestor path of every
      // synced loc (deduped, in resolved-key order) up front so a concurrent non-recursive
      // delete of an ancestor in this memory can't count zero descendants and
      // then miss the rows this sync commits. READ COMMITTED (the tx default) is
      // required so that delete's count sees these rows once the sync commits.
      // Spec 049 S4: a Channel's address is never written from git — a mirror
      // could otherwise overwrite the one record whose authorship is derived
      // (#1047). Skipped and reported, never a failed sync.
      const protectedLocs = await protectedLocsIn(tx, graph.id);
      const isProtected = (loc: string) => protectedLocs.some((p) => protectedLocCovers(p, loc));
      const writableLocs = fsGraph.nodes
        .map((n) => n.loc)
        .filter((l): l is string => typeof l === 'string' && !isProtected(l));

      // Declare the COMPLETE loc-key set before taking any of it. Incoming
      // nodes need ancestor keys for create/delete coordination; every edge
      // source and preflighted external endpoint needs its full path (strict
      // ancestors + exact loc) so a subtree move cannot relocate it after the
      // sync built its id map but before the edge insert.
      await acquireLockSet(tx, [
        ...(rootNode ? [{ memoryId: graph.id, loc: rootNode.loc! }, { memoryId: graph.id, loc: '' }] : []),
        ...writableLocs.flatMap((loc) =>
          ancestorLocs(loc).map((ancestor) => ({ memoryId: graph.id, loc: ancestor })),
        ),
        ...edges.flatMap((edge) =>
          [...ancestorLocs(edge.sourceLoc), edge.sourceLoc].map((loc) => ({ memoryId: graph.id, loc })),
        ),
        ...endpointSnapshots.flatMap((endpoint) =>
          [...ancestorLocs(endpoint.loc), endpoint.loc].map((loc) => ({
            memoryId: endpoint.memoryId,
            loc,
          })),
        ),
        // #1568: hold every unreadable file's loc AND its strict ancestors,
        // the keys createNode (exact + ancestors), create-parent and move
        // (ancestors) take, root included. A top-level move takes no key at
        // all, so the cleanup below also never deletes at these locs.
        ...unreadable.flatMap((f) =>
          [...ancestorLocs(f.loc), f.loc].map((loc) => ({ memoryId: graph.id, loc })),
        ),
      ]);
      // #1568: refuse before any write if an unreadable file sits on a live
      // node, instead of letting repo-wins cleanup hard-delete it.
      if (unreadable.length > 0) {
        // An unreadable root may still occupy the pre-#1228 empty address.
        // Its new derived loc alone cannot vouch for destructive cleanup.
        const legacyUnreadableRoot = unreadable.some((f) => ['README.md', '.hadron/README.md', '.node/node.yaml', '.hadron/.node/node.yaml'].includes(f.file));
        const unreadableLocs = [...unreadable.map((f) => f.loc), ...(legacyUnreadableRoot ? [''] : [])];
        const held = await tx.node.findMany({
          where: { memoryId: graph.id, deletedAt: null, loc: { in: unreadableLocs } },
          select: { loc: true },
        });
        const heldLocs = new Set(held.map((row) => row.loc));
        const blocking = unreadable.filter((f) => heldLocs.has(f.loc) || (legacyUnreadableRoot && heldLocs.has('') && ['README.md', '.hadron/README.md', '.node/node.yaml', '.hadron/.node/node.yaml'].includes(f.file)));
        if (blocking.length > 0) throw new GitSyncUnreadableFileError(blocking);
      }
      await lockAncestorsForCreateMany(
        tx,
        graph.id,
        writableLocs,
      );
      // Moves take their source path before their Memory row lock. Take the
      // Git path set first too, then fence the encryption flag before any
      // NodeRevision or Node write. Holding FOR SHARE while waiting for a
      // move's path would deadlock against its FOR NO KEY UPDATE Memory lock.
      await assertGitSyncMemoryPlaintext(tx, graph.id);
      // Read draft state only after the Memory FOR SHARE fence. Minting cannot
      // flip the corpus out of draft between this check and the node writes.
      // #1348 uses the same fenced read for the property schema.
      const memoryState = await tx.memory.findUniqueOrThrow({
        where: { id: graph.id }, select: { urn: true, schema: true, readBranch: true, readBranchCorrected: true },
      });
      // `graph` was fetched before Git I/O. A branch edit during that window
      // must not authorize cleanup from a tree fetched under the old config.
      if (memoryState.readBranch !== graph.readBranch) {
        throw new Error('Git sync Read branch changed while syncing; retry with the current Memory config.');
      }
      const memorySchema = memoryState.schema as MemorySchema | null;
      // #1228: operator-owned rollout prerequisites, judged before any Node
      // write. Never replace a legacy root via loc fallback or silently park
      // an API node at an invalid address. README owns the slug after repair.
      if (rootNode) {
        if (memoryState.urn !== graph.urn) {
          throw new Error('Git root README memory was renamed while syncing; retry with the current memory.');
        }
        const oldRoot = await tx.node.findUnique({
          where: { loc_memoryId: { loc: '', memoryId: graph.id } },
        });
        if (oldRoot && rootNode.id !== oldRoot.id) {
          throw new Error('Git root README must carry the existing live root id before migration; add its id to frontmatter.');
        }
        const occupant = await tx.node.findUnique({
          where: { loc_memoryId: { loc: rootNode.loc!, memoryId: graph.id } },
        });
        if (occupant && occupant.id !== rootNode.id && occupant.ownerRepo !== ownerRepo) {
          throw new Error('Git root README slug is occupied by an API node; an authorized operator must move it or delete it if redundant before sync.');
        }
      }

      // A move that won before these locks were granted invalidates preflight.
      // Retry the whole collection phase so the endpoint's current memory and
      // path join the stable lock set; never mistake a move for deletion.
      if (endpointSnapshots.length > 0) {
        const currentEndpoints = await tx.node.findMany({
          where: { id: { in: endpointSnapshots.map((node) => node.id) }, deletedAt: null },
          select: { id: true, loc: true, memoryId: true },
        });
        const currentById = new Map(currentEndpoints.map((node) => [node.id, node]));
        const stale = endpointSnapshots.find((snapshot) => {
          const current = currentById.get(snapshot.id);
          return !current || current.memoryId !== snapshot.memoryId || current.loc !== snapshot.loc;
        });
        if (stale) {
          throw new EdgeEndpointPreflightStale(`Edge endpoint ${stale.id} moved after preflight`);
        }
      }
      // #1330 — a file that assigns a role is judged against the memory's
      // strict-sub-role rules under the rulebook lock (`lockMemoryConfigShared`),
      // whose contract is that no transaction waits on a row while holding it:
      // a rule write holds its referenced nodes FOR SHARE and then waits for
      // that lock exclusively. A sync writes many rows, so it takes every row
      // lock in this memory FIRST, in id order, and only then the rulebook lock.
      // Every row it later updates, parks or deletes must be one of these; a
      // row that arrives after the scan is left for the next sync (below).
      // Skipped when no file carries a role, which nothing then needs to judge.
      //
      // `prelockedIds` also BOUNDS the cleanup pass below: a row inserted after
      // this scan is not locked, and deleting it would wait on a row while
      // holding the rulebook lock, a deadlock Anne reproduced (#1411 review).
      // Such a late row survives this sync and is pruned by the next one, the
      // deferrable direction.
      const judgesRoles = fsGraph.nodes.some(
        (n) => !isProtected(n.loc!) && governedSignalsFromMirror(n).role != null,
      );
      let prelockedIds: string[] | null = null;
      if (judgesRoles) {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "nodes" WHERE "memory_id" = ${graph.id} ORDER BY "id" FOR UPDATE`;
        prelockedIds = rows.map((r) => r.id);
        // And this memory's rule rows: deleting a node a rule references fires
        // that rule's ON DELETE SET NULL, a row a rule writer may hold FOR
        // UPDATE while it waits for the rulebook lock. Nodes, then rules, then
        // the rulebook: the order every rule writer takes them in.
        await tx.$queryRaw`
          SELECT r."id" FROM "node_role_rules" r
          JOIN "memory_configs" c ON c."id" = r."config_id"
          WHERE c."memory_id" = ${graph.id}
          ORDER BY r."id" FOR UPDATE OF r`;
        await lockMemoryConfigShared(tx, graph.id);
      }
      // Locs of files refused for their role: nothing of theirs is written,
      // including the edges they declare.
      const refusedRoleLocs = new Set<string>();
      // Rows the scan did not lock, which arrived after it. While the sync holds
      // the rulebook lock it must not wait on one, so a file whose write would
      // touch such a row is DEFERRED to the next sync, which locks it from the
      // start (@codex P2, PR #1411: a root loc has no ancestor lock to keep a
      // concurrent create out). Its edges are deferred with it.
      const prelockedIdSet = prelockedIds ? new Set(prelockedIds) : null;
      const isLateRow = (row: { id: string } | null | undefined): boolean =>
        prelockedIdSet !== null && row != null && !prelockedIdSet.has(row.id);
      const deferredLocs = new Set<string>();

      // #1224 — files whose path cannot be a loc, resolved to the rows they
      // name. @copilot on PR #1229: the cleanup pass keys on the SURVIVING
      // ROW id, and a file's frontmatter id is not that id — the loc-keyed
      // upsert below keeps an existing row's id, a foreign or duplicate id is
      // replaced with a fresh one, and an id-less file has none. Protecting
      // the raw file id would therefore protect nothing while reading as a
      // guarantee, which is the mistake the comment on `rowId` two hundred
      // lines below already warns about.
      //
      // So: resolve, and count what cannot be resolved. An unresolvable skip
      // is a row we cannot vouch for, and the destructive pass is suppressed
      // for the whole run rather than deleting it — there is no way back from
      // a hard delete, and a stale row that lingers until someone fixes a
      // filename is the recoverable direction.
      const skippedRowIds = new Set<string>();
      const unprotectableSkips: string[] = [];
      for (const skipped of skippedInvalidLoc) {
        const row = skipped.nodeId
          ? await tx.node.findUnique({
              where: { id: skipped.nodeId },
              select: { id: true, memoryId: true },
            })
          : null;
        if (row && row.memoryId === graph.id) skippedRowIds.add(row.id);
        else unprotectableSkips.push(skipped.source);
      }

      // #1468 — decide, BEFORE anything is parked, which id-first moves are
      // refused because the loc they target will not be vacated: it holds a
      // minted spec (never parked), a row whose file is unusable (#1224), or
      // a row whose own move is refused — a fixed point, so a chain
      // (A onto B, B onto a minted spec) refuses A too instead of parking B
      // at an invalid address it can then never leave. Judged on the rows as
      // they stand now; a move this refuses lands on a later sync once its
      // target is free. Only the first claimant of a file id is a move.
      const refusedMoverIds = await (async () => {
        const firstClaim = new Map<string, string>();
        // Ids named by files under a protected loc: those files are skipped,
        // so the rows they name do not move this run (Codex on #1475).
        const protectedFileIds = new Set<string>();
        for (const n of fsGraph.nodes) {
          if (!n.id) continue;
          if (isProtected(n.loc!)) protectedFileIds.add(n.id);
          else if (!firstClaim.has(n.id)) firstClaim.set(n.id, n.loc!);
        }
        if (firstClaim.size === 0) return new Set<string>();
        const named = await tx.node.findMany({
          where: { id: { in: [...firstClaim.keys(), ...protectedFileIds] }, memoryId: graph.id },
          select: { id: true, loc: true },
        });
        // A row whose move is refused for its protected SOURCE loc stays too.
        const pinned = named.filter((r) => protectedFileIds.has(r.id) || (firstClaim.has(r.id) && isProtected(r.loc)));
        const movers = named.filter(
          (r) => firstClaim.has(r.id) && r.loc !== firstClaim.get(r.id) && !isProtected(r.loc) && !protectedFileIds.has(r.id),
        );
        if (movers.length === 0) return new Set<string>();
        const occupants = await tx.node.findMany({
          where: { memoryId: graph.id, loc: { in: movers.map((m) => firstClaim.get(m.id)!) } },
          select: { id: true, loc: true },
        });
        const occupantAt = new Map(occupants.map((o) => [o.loc, o.id]));
        const staying = new Set<string>([
          ...skippedRowIds,
          ...pinned.map((r) => r.id),
          // Never a row that arrived after #1330's scan: locking it would wait
          // under the rulebook lock. A move onto one is deferred in the loop.
          ...(await lockMintedSpecsIn(tx, graph.id, occupants.filter((o) => !isLateRow(o)).map((o) => o.id))).map((m) => m.id),
        ]);
        const refused = new Set<string>();
        for (let changed = true; changed;) {
          changed = false;
          for (const m of movers) {
            const occ = occupantAt.get(firstClaim.get(m.id)!);
            if (!refused.has(m.id) && occ && occ !== m.id && (staying.has(occ) || refused.has(occ))) {
              refused.add(m.id);
              changed = true;
            }
          }
        }
        return refused;
      })();

      const upsertedIds: string[] = [];
      // Rows the cleanup pass below must leave alone: a protected file's row
      // is not upserted, and `notIn: upsertedIds` would otherwise hard-delete
      // it — a root deletion cascading its Channel row (Copilot on PR #1165).
      const protectedRowIds = new Set<string>();
      // #1468 (Codex on #1475) — file locs whose id-first move was REFUSED:
      // the row stays at its old loc, so the file's outgoing edges (declared
      // from the new loc) are skipped this run rather than failing the edge
      // phase's endpoint check on every retry. They land with the move.
      const refusedMoveLocs = new Set<string>();
      // File frontmatter ids already claimed in THIS run — a second file
      // carrying the same id (a copied file) must not be treated as a move
      // of the first; it gets a fresh id instead.
      const claimedFileIds = new Set<string>();
      // A loc swap temporarily parks an occupant so the first move can land.
      // Preserve its committed pre-sync state; when its own file is processed,
      // one revision spans original -> final and the parking loc never enters
      // retained history (or consumes a maxRevCount slot).
      const parkedRevisionBases = new Map<string, Node>();
      // A file can move a row directly or first park it while another file
      // claims its loc. Retain the address held before this transaction's
      // writes; parking is a waypoint, never a published address.
      const originalLocs = new Map<string, string>();
      // Edge-endpoint remapping (PR-576 codex review): when a fresh id is
      // minted for a file (foreign-memory or duplicate frontmatter id), the
      // edges loadGraphFromFs captured still carry the file's ORIGINAL id.
      // Sources always resolve by the file's loc (unique per repo); targets
      // resolve by first-claimant file id, falling back to the raw id for
      // legitimate cross-repo references.
      const locToRowId = new Map<string, string>();
      const fileIdToRowId = new Map<string, string>();
      // #1411 review (@codex P2) — frontmatter ids of loc-keyed files this run
      // did NOT apply, with no row an edge could safely target. An edge
      // aimed at one waits for the sync that applies the file: resolving it
      // raw would point at a foreign memory's node (a foreign id), or park a
      // spurious PendingEdge (an unknown id).
      const unappliedFileIds = new Set<string>();
      // The FIRST file carrying a frontmatter id decides where edges aimed at
      // it land, applied or not: a later copy (minted a fresh row) must never
      // take the id over because the first was skipped (#1411 review, @codex
      // P2). An id is "settled" once it is mapped OR waiting.
      const idSettled = (id: string): boolean => fileIdToRowId.has(id) || unappliedFileIds.has(id);

      // #2040 — every file of this run, as if already written: a tag is judged
      // against the graph the sync will leave, so a new file cannot hide a cycle
      // through another new file.
      const includeOverlay = {
        memoryId: graph.id,
        contents: new Map(fsGraph.nodes.filter((n) => n.loc).map((n) => [n.loc!, n.content ?? null] as const)),
      };
      for (const node of fsGraph.nodes) {
        const loc = node.loc!;
        if (isProtected(loc)) {
          // The file is PRESENT but intentionally skipped. Preserve the row it
          // identifies even when the Channel is tombstoned and the deletion
          // filter releases true orphan descendants. Prefer same-memory file
          // identity; fall back to the exact loc for id-less/foreign-id files.
          const byFileId = node.id
            ? await tx.node.findUnique({ where: { id: node.id }, select: { id: true, memoryId: true } })
            : null;
          const protectedRow = byFileId?.memoryId === graph.id
            ? byFileId
            : await tx.node.findUnique({
                where: { loc_memoryId: { loc, memoryId: graph.id } },
                select: { id: true, memoryId: true },
              });
          if (protectedRow) protectedRowIds.add(protectedRow.id);
          skippedProtected.push(loc);
          reportEntries.push({ kind: 'protected', loc, code: 'PROTECTED_LOC' });
          continue;
        }
        const name = node.name!;
        const update = {
          loc,
          name,
          // #2556: spread only present keys; old mirrors must not clear either column.
          ...('nodeType' in node ? { nodeType: node.nodeType } : {}),
          ...('data' in node ? { data: node.data === null ? Prisma.DbNull : node.data as Prisma.InputJsonValue } : {}),
          alias: node.alias ?? null,
          isLink: node.isLink ?? false,
          description: node.description ?? null,
          // Spec 031 — abstract round-trips through the importer. Already
          // normalized (trim-then-check) by loadNodeFromFs before reaching
          // here; just pass through.
          abstract: node.abstract ?? null,
          // Spec 032 — abstractOriginHash round-trips through the importer.
          // loadNodeFromFs runs FR-013 reconcile (match → keep, mismatch →
          // accept-and-warn, missing/non-string → recompute, abstract-null
          // → null). Pass-through preserves the staleness state on disk.
          abstractOriginHash: node.abstractOriginHash ?? null,
          content: node.content ?? null,
          contentHash: node.contentHash ?? null,
          tags: serializeTags(node.tags ?? []) as string[],
          ownerRepo,
          // #1218 — git sync is an OWNING OPERATION: the repo is the source of
          // truth for a mirrored memory, so a file may SET a governed signal
          // (which means a principal with repo write can mark a node
          // `role: 'review'` by committing — not new reach, they already author
          // node content wholesale, but true from here on and worth stating).
          //
          // SPREAD, never `?? null`. `loadNodeFromFs` omits a key the file does
          // not carry, and an omitted key in a Prisma `update` leaves the column
          // ALONE. Writing `role: node.role ?? null` here instead would clear
          // the column on every sync of every mirrored memory, since no file on
          // disk predating this change carries the key — un-governing on a
          // schedule with nothing refused, introduced by the fix for it. On the
          // `create` path below the same absence yields the column default,
          // which is right: a new node whose file declares no signal has none.
          ...governedSignalsFromMirror(node),
        };

        // #2040 — a push cannot be refused, so a file whose include tags are
        // invalid is skipped and named in the result; its row stays as it was.
        {
          const selfRow = await tx.node.findUnique({
            where: { loc_memoryId: { loc, memoryId: graph.id } },
            select: { id: true },
          });
          try {
            await assertIncludesWritable(tx, { id: selfRow?.id ?? prospectiveNodeId(loc), memoryId: graph.id, loc }, update.content, [graph.id], includeOverlay, { includeSystemWrite: true });
          } catch (e) {
            const refusalCode = includeRefusalCode(e);
            if (!refusalCode) throw e;
            skippedInvalidIncludes.push({ loc, code: refusalCode, message: (e as Error).message });
            reportEntries.push({ kind: 'invalid_include', loc, code: refusalCode });
            if (selfRow) skippedRowIds.add(selfRow.id);
            continue;
          }
        }

        // A repo file can restore a server-exported reservation, but only in
        // the state reserveSpecCitation could have created: a blank spec in a
        // draft corpus. Decide inside the write transaction, against the
        // stored role when an older file has no role key. Invalid claims leave
        // the rest of the file syncable and are reported rather than skipped;
        // skipping could feed the destructive mirror cleanup below.
        const placeholderMarkerFor = (existing: Node | null): { isPlaceholder: true } | Record<string, never> => {
          if (node.isPlaceholder !== true) return {};
          const role = 'role' in node ? node.role : existing?.role;
          const specRole = role === 'spec' || (typeof role === 'string' && role.startsWith('spec.'));
          // #1591: a placeholder is an unminted node; draft rights are per node.
          const unminted = existing?.mintedAt == null;
          if (unminted && specRole && !node.content?.trim()) return { isPlaceholder: true };
          console.warn(
            `[syncGraphFromGithub] "${graphName}" loc "${loc}": ignored placeholder marker ` +
            '(requires an unminted node, spec-family role, and blank content)',
          );
          return {};
        };

        // #1348 — the collection discriminator, by the same absent-means-
        // preserve rule: `loadNodeFromFs` yields the key only for a non-blank
        // value (a file never clears it — cor:int:020:01, CLI import #725), so
        // an omitted key leaves a stored objectType alone on update and takes
        // the unset default on create.
        //
        // A present one is written only if the RESULTING record satisfies the
        // memory's property schema (#725: a structured record must satisfy its
        // collection — the invariant every GraphQL/MCP write enforces through
        // validateNodeAgainstSchema). Sync does not restore `properties`, so
        // the record is judged with the properties the row already
        // has (none, for a new node). A violation does NOT fail the sync — one
        // bad file must not block the memory — and does not write a
        // nonconforming record either: the stored objectType is kept and the
        // file is reported in `skippedObjectTypes`, like a protected loc.
        const fileObjectType = 'objectType' in node ? node.objectType : undefined;
        const objectTypeFor = (properties: unknown): { objectType?: string | null } => {
          if (fileObjectType == null) return {};
          if (memorySchema == null) return { objectType: fileObjectType };
          try {
            validateNodeAgainstSchema(memorySchema, fileObjectType, (properties ?? null) as Record<string, unknown> | null);
            return { objectType: fileObjectType };
          } catch (e) {
            if (!(e instanceof NodeSchemaViolation)) throw e;
            skippedObjectTypes.push(`${loc} (${fileObjectType}): ${e.message}`);
            reportEntries.push({ kind: 'object_type_rejected', loc, code: 'OBJECT_TYPE_REJECTED' });
            return {};
          }
        };
        // `byId` and `existingAtLoc` are lookup snapshots. Capture only from
        // the row update's locked, current version, before it writes the file's
        // loc; another writer may have moved the node since that lookup.
        const objectTypeAndOriginalLoc = (locked: Node): { objectType?: string | null } => {
          if (locked.loc !== loc && !originalLocs.has(locked.id)) originalLocs.set(locked.id, locked.loc);
          return objectTypeFor(locked.properties);
        };

        // Identity is ID-FIRST (repo wins): a file that kept its frontmatter
        // id but changed its path is a MOVE of the existing node. The old
        // loc-keyed upsert treated that as a create and crashed the whole
        // memory's sync with P2002 on the id unique. Three id shapes:
        //   - id matches a row in THIS memory → update in place (the move)
        //   - id belongs to ANOTHER memory (file copied across repos) or was
        //     already claimed by an earlier file this run → never steal it;
        //     fall through to the loc-keyed upsert with a fresh id
        //   - no id / unknown id → loc-keyed upsert as before
        // #1330 — git sync is authoring, so a role the file ASSIGNS goes
        // through the strict-sub-role rule like any other write (Holger,
        // 2026-09-27). `prior` is the row the file would write, current under
        // the locks above; a file with no role key assigns nothing. A refused
        // file is skipped and reported, and its row survives the cleanup pass.
        const defer = (late: { id: string; loc?: string }, keep?: { id: string; loc?: string }): true => {
          deferredLateRows.push(`${loc} (node ${late.id})`);
          const fromLoc = keep?.loc ?? late.loc;
          reportEntries.push({ kind: 'deferred', loc, ...(fromLoc && fromLoc !== loc ? { fromLoc } : {}), code: 'ROW_CHANGED' });
          deferredLocs.add(loc);
          if (keep) protectedRowIds.add(keep.id);
          return true;
        };
        const refusesRole = async (prior: Node | null): Promise<boolean> => {
          // #1606 (cor:dmo:110:04) — git sync never writes a comment: a file
          // that lands on a comment's loc is skipped and the comment kept.
          if (prior?.nodeType === COMMENT_NODE_TYPE || node.nodeType === COMMENT_NODE_TYPE) {
            reportEntries.push({ kind: 'protected', loc, code: 'PROTECTED_COMMENT' });
            console.warn(`[syncGraphFromGithub] "${graphName}": skipped ${loc} — it is a comment, written only through the comment path`);
            if (prior) protectedRowIds.add(prior.id);
            refusedRoleLocs.add(loc);
            return true;
          }
          // #2043 — git sync never writes a compiled boot prompt (a compile does):
          // a file landing on one is skipped and the node kept. A worker session's
          // sync that would create or change any boot-prompt node is refused whole
          // (cor:agt:040:11); the server's own webhook/startup syncs carry no worker.
          if (prior?.nodeType === COMPILED_BOOT_PROMPT_NODE_TYPE || node.nodeType === COMPILED_BOOT_PROMPT_NODE_TYPE) {
            reportEntries.push({ kind: 'protected', loc, code: 'PROTECTED_BOOT_PROMPT' });
            console.warn(`[syncGraphFromGithub] "${graphName}": skipped ${loc} — it is a compiled boot prompt, written only by a compile`);
            if (prior) protectedRowIds.add(prior.id);
            refusedRoleLocs.add(loc);
            return true;
          }
          assertNoWorkerSessionBootPromptWrite(prior?.role, governedSignalsFromMirror(node).role ?? undefined, 'import');
          const signals = governedSignalsFromMirror(node);
          // #1641 §3.2 — no mirror ever writes a decision or a decision log:
          // anyone with push access could otherwise forge one. A file that
          // declares the role, or lands on a decision's loc, is skipped.
          if (isDecisionFamilyRole(signals.role) || isDecisionFamilyRole(prior?.role)) {
            reportEntries.push({ kind: 'protected', loc, code: 'PROTECTED_DECISION' });
            console.warn(`[syncGraphFromGithub] "${graphName}": skipped ${loc} — decisions are written only through the decision operations`);
            if (prior) protectedRowIds.add(prior.id);
            refusedRoleLocs.add(loc);
            return true;
          }
          if (signals.role == null) return false;
          // #1411 review (@codex P2): judge the role the write will APPLY. An
          // unwritten placeholder keeps role 'spec' whatever its blank mirror
          // file says (`updateNodeFromGitSync` strips the role, #1450), so
          // that file assigns nothing and must not be refused: refusing it
          // would block the placeholder's other changes (name, tags,
          // abstract) indefinitely. Same predicate, one source of truth.
          try {
            assertPlaceholderKeepsSpecRole(prior, { role: signals.role, content: node.content ?? null });
          } catch (e) {
            if (e instanceof GraphQLError && e.extensions?.code === 'SPEC_PLACEHOLDER_ROLE_LOCKED') return false;
            throw e;
          }
          const strictParent = await strictParentRefusingRole(tx, graph.id, {
            role: signals.role,
            priorRole: prior?.role ?? null,
            runnableAfter: mergedGovernedState(prior, signals).isRunnable,
          });
          if (strictParent === null) return false;
          skippedUndeclaredRoles.push({ loc, role: signals.role, strictParent, code: 'ROLE_NOT_DECLARED' });
          reportEntries.push({ kind: 'undeclared_role', loc, code: 'ROLE_NOT_DECLARED' });
          if (prior) protectedRowIds.add(prior.id);
          refusedRoleLocs.add(loc);
          return true;
        };

        const fileId = node.id && !claimedFileIds.has(node.id) ? node.id : null;
        const byId = fileId
          ? await tx.node.findUnique({ where: { id: fileId } })
          : null;
        if (node.id) claimedFileIds.add(node.id);

        let rowId: string;
        if (byId && byId.memoryId === graph.id) {
          // #1411 review (@codex P2) — an edge aimed at this file resolves to
          // its row by raw id, and its loc is derived from the TARGET's
          // current loc. When this file's MOVE is not applied, that loc is
          // the old one: a later sync that lands the move derives a second
          // edge under the new loc, and nothing removes the first. So a
          // skipped move's incoming edges wait for the sync that applies it,
          // and so do a late row's, which must not be touched under the
          // rulebook lock. A refused file that does not move keeps its loc,
          // so its incoming edges already resolve correctly.
          const incomingEdgesWait = (): void => {
            if (node.id && !idSettled(node.id)) unappliedFileIds.add(node.id);
          };
          // The SOURCE loc of an id-first move is checked too: a file whose
          // new path is free must not drag a node out from under a Channel
          // (Copilot on PR #1165).
          if (byId.loc !== loc && isProtected(byId.loc)) {
            skippedProtected.push(`${byId.loc} → ${loc}`);
            reportEntries.push({ kind: 'protected', loc, fromLoc: byId.loc, code: 'PROTECTED_LOC' });
            protectedRowIds.add(byId.id);
            refusedMoveLocs.add(loc);
            incomingEdgesWait();
            continue;
          }
          if (isLateRow(byId) && defer(byId)) {
            incomingEdgesWait();
            continue;
          }
          if (await refusesRole(byId)) {
            if (byId.loc !== loc) incomingEdgesWait();
            // Not moving: the row keeps its loc and IS the target, so claim
            // the id for it now, before any later copy can.
            else if (node.id && !idSettled(node.id)) fileIdToRowId.set(node.id, byId.id);
            continue;
          }
          if (byId.loc !== loc && refusedMoverIds.has(byId.id)) {
            reportEntries.push({ kind: 'held_move', loc, fromLoc: byId.loc, code: 'DESTINATION_PROTECTED' });
            console.warn(
              `[syncGraphFromGithub] "${graphName}": refusing move of ${byId.id} "${byId.loc}" → "${loc}" — the loc is held by a row that will not move this run (a minted spec keeps its citation, #1468)`,
            );
            protectedRowIds.add(byId.id);
            refusedMoveLocs.add(loc);
            incomingEdgesWait();
            continue;
          }
          if (byId.loc !== loc) {
            // Moving into a loc another row currently holds: repo-wins — the
            // occupant is stale at that loc (it either moves later this run
            // via its own file, or the notIn deletion pass removes it). Park
            // it out of the way so the move can't collide.
            const occupant = await tx.node.findUnique({
              where: { loc_memoryId: { loc, memoryId: graph.id } },
            });
            if (occupant && skippedRowIds.has(occupant.id)) {
            reportEntries.push({ kind: 'held_move', loc, fromLoc: byId.loc, code: 'DESTINATION_PROTECTED' });
              // #1224 / @codex P2 on PR #1229 — the occupant's OWN file was
              // renamed to something unusable this run, so it is not moving
              // out of the way and it is not being deleted either. Parking it
              // would store `<loc>~displaced-<id>`, a loc `validateLoc`
              // REFUSES (`~`) — permanently, since the row is now protected
              // from the cleanup that used to collect it. This guard would
              // have persisted the exact invariant violation the PR exists to
              // stop, introduced BY the guard.
              //
              // So refuse the competing move instead, per @codex's own first
              // remedy: both rows keep valid addresses, and the move lands on
              // the next sync once the bad filename is fixed.
              console.warn(
                `[syncGraphFromGithub] "${graphName}": refusing move of ${byId.id} into "${loc}" — the occupant ${occupant.id} is held by a file whose path is not a valid loc`,
              );
              protectedRowIds.add(byId.id);
              refusedMoveLocs.add(loc);
              incomingEdgesWait();
              continue;
            }
            if (occupant && occupant.id !== byId.id && isLateRow(occupant) && defer(occupant, byId)) {
              incomingEdgesWait();
              continue;
            }
            if (occupant && occupant.id !== byId.id && unparkable.has(occupant.id)) {
              // #1411 review — an earlier attempt parked this occupant and its
              // own file never settled it. Hold the move instead: both rows
              // keep valid addresses, and the mover's edges wait with it.
              heldMoves.push(`${byId.loc} → ${loc} (occupant ${occupant.id})`);
              reportEntries.push({ kind: 'held_move', loc, fromLoc: byId.loc, code: 'MOVE_HELD' });
              protectedRowIds.add(byId.id);
              deferredLocs.add(loc);
              incomingEdgesWait();
              continue;
            }
            if (
              occupant && occupant.id !== byId.id
              && (await lockMintedSpecsIn(tx, graph.id, [occupant.id])).length > 0
            ) {
              reportEntries.push({ kind: 'held_move', loc, fromLoc: byId.loc, code: 'DESTINATION_PROTECTED' });
              // #1468 — a minted spec is never parked. Parking hands its
              // published citation to the incoming node, and whether the
              // spec's own file re-homes it later this run cannot be known
              // here: that file may be skipped (protected or invalid path) or
              // its own move refused, leaving the spec at an invalid address.
              // Refuse the competing move instead (the #1224 remedy above).
              // A swap of two minted specs' citations is therefore refused
              // too: it is a renumbering of published citations.
              console.warn(
                `[syncGraphFromGithub] "${graphName}": refusing move of ${byId.id} into "${loc}" — the occupant ${occupant.loc} is a minted spec, and a minted spec keeps its citation (#1468)`,
              );
              protectedRowIds.add(byId.id);
              refusedMoveLocs.add(loc);
              incomingEdgesWait();
              continue;
            }
            if (occupant && occupant.id !== byId.id) {
              await tx.$queryRaw`SELECT "id" FROM "nodes" WHERE "id" = ${occupant.id} FOR UPDATE`;
              await ensureCurrentNodeRevisionInTransaction(tx, occupant.id, { expectedMemoryId: graph.id });
              const lockedOccupant = await tx.node.findUniqueOrThrow({ where: { id: occupant.id } });
              if (!parkedRevisionBases.has(occupant.id)) {
                parkedRevisionBases.set(occupant.id, lockedOccupant);
              }
              if (!originalLocs.has(occupant.id)) originalLocs.set(occupant.id, lockedOccupant.loc);
              await tx.node.update({
                where: { id: occupant.id },
                data: { loc: `${loc}~displaced-${occupant.id}` },
              });
              console.warn(
                `[syncGraphFromGithub] "${graphName}": move of ${byId.id} to occupied loc "${loc}" displaced node ${occupant.id}`,
              );
            }
            console.log(`[syncGraphFromGithub] "${graphName}": node ${byId.id} moved "${byId.loc}" → "${loc}"`);
          }
          await updateNodeFromGitSync(tx, byId, { ...update, ...placeholderMarkerFor(byId) }, parkedRevisionBases.get(byId.id), graph.id, (locked) =>
            objectTypeAndOriginalLoc(locked),
          );
          parkedRevisionBases.delete(byId.id);
          rowId = byId.id;
        } else {
          if (byId) {
            console.warn(
              `[syncGraphFromGithub] "${graphName}" loc "${loc}": frontmatter id ${node.id} belongs to another memory — minting a fresh id`,
            );
          }
          // Fresh id when the file's id is unusable: owned by another memory
          // (byId) or already claimed by an earlier file this run (!fileId).
          const idUnusable = byId !== null || (!!node.id && fileId === null);
          const createId = idUnusable ? generateId() : (node.id ?? generateId());
          const existingAtLoc = await tx.node.findUnique({
            where: { loc_memoryId: { loc, memoryId: graph.id } },
          });
          // A skipped loc-keyed file still decides where edges aimed at its
          // frontmatter id land (#1411 review, @codex P2). A refused file's
          // row is locked and survives the sync, so it is the target, as a
          // successful sync would have made it. A deferred file's row arrived
          // after the scan and must not be touched under the rulebook lock,
          // and a refused NEW file has no row: their incoming edges wait.
          const skipped = (target: { id: string } | null): true => {
            if (node.id && !idSettled(node.id)) {
              if (target) fileIdToRowId.set(node.id, target.id);
              else unappliedFileIds.add(node.id);
            }
            return true;
          };
          if (isLateRow(existingAtLoc) && defer(existingAtLoc!)) {
            skipped(null);
            continue;
          }
          if (await refusesRole(existingAtLoc)) {
            skipped(existingAtLoc);
            continue;
          }
          if (existingAtLoc) {
            await updateNodeFromGitSync(
              tx,
              existingAtLoc,
              { ...update, ...placeholderMarkerFor(existingAtLoc) },
              parkedRevisionBases.get(existingAtLoc.id),
              graph.id,
              objectTypeAndOriginalLoc,
            );
            parkedRevisionBases.delete(existingAtLoc.id);
            // The SURVIVING id: an update keeps the existing row's id, which
            // may differ from the file's — recording the file id here would
            // make the notIn deletion pass below delete the row we just wrote.
            rowId = existingAtLoc.id;
          } else {
            const row = await tx.node.create({
              data: {
                id: createId,
                memoryId: graph.id,
                ...update,
                ...placeholderMarkerFor(null),
                ...objectTypeFor(null),
                revisionContentHash: revisionStateHashRefreshMarker(),
              },
              select: { id: true },
            });
            rowId = row.id;
          }
        }
        upsertedIds.push(rowId);
        writtenNodes.push({ id: rowId, loc, memoryId: graph.id });
        locToRowId.set(loc, rowId);
        if (node.id && !idSettled(node.id)) fileIdToRowId.set(node.id, rowId);
        const embeddingToken = await stampEmbeddingObligation(tx, rowId, graph.id);
        if (embeddingToken) embeddingWakeNeeded = true;

      }

      // #2040 — derive include edges once every file of this sync is written, so
      // a tag may name a file synced later in the same run.
      for (const written of writtenNodes) {
        const row = await tx.node.findUnique({ where: { id: written.id }, select: { content: true } });
        await syncDerivedIncludesEdges(tx, written, storedIncludeTags(row?.content), [graph.id]);
      }

      // Spec 049 S4: never delete a row under (or above) a Channel's address,
      // whether it was skipped this run or was git-owned before the Channel
      // existed — the reservation outlives the mirror.
      // Built by the shared helper, NOT here: a hand-rolled clause list missed
      // the whole-memory wildcard twice (@copilot, PR #1190) — `loc = '*'`
      // matches nothing, so the NOT excluded nothing and this cleanup deleted
      // the very rows the declaration exists to preserve.
      const deletionFilter = protectedDeletionFilter(protectedLocs);
      if (unprotectableSkips.length > 0) {
        // Fail CLOSED (@copilot's second remedy). At least one file was
        // skipped for an unusable path and names no row we can identify in
        // this memory — its old loc is what would identify it, and a file
        // renamed to an unusable name no longer tells us what that was. The
        // cleanup cannot distinguish that row from a genuinely deleted one,
        // so it does not run: pruning is deferrable, a hard delete is not.
        // The upserts above still applied, so content still syncs.
        console.warn(
          `[syncGraphFromGithub] "${graphName}": destructive cleanup SUPPRESSED — ${unprotectableSkips.length} file(s) have a path that is not a valid loc and carry no id naming a row in this memory: ${unprotectableSkips.join(', ')}`,
        );
      } else {
        // #1468 (Holger: skip and warn, not refuse) — a spec whose file is
        // gone from the repo is NOT pruned from a mint-stamped corpus: minted
        // specs are permanent. It is kept, like a Channel-protected row, and
        // reported; the rest of the cleanup proceeds. Found and locked BEFORE
        // the edge gate below, so a kept spec's cross-memory edges don't refuse
        // a delete that will not happen.
        // #1568 (Codex P1 / Copilot on #1575): never delete at an unreadable
        // file's loc. The refusal above covers rows that existed when it ran;
        // this covers one a concurrent writer put there afterwards, including
        // a top-level move that takes no advisory key the sync could hold.
        const unreadableLocFilter: Prisma.NodeWhereInput = unreadable.length
          ? { loc: { notIn: unreadable.map((f) => f.loc) } }
          : {};
        const candidateIds = (await tx.node.findMany({
          where: {
            ownerRepo,
            memoryId: graph.id,
            id: {
              notIn: [...upsertedIds, ...protectedRowIds, ...skippedRowIds],
              // Same bound as the cleanup below (#1330): locking a row that
              // arrived after the scan would wait under the rulebook lock.
              ...(prelockedIds ? { in: prelockedIds } : {}),
            },
            ...(deletionFilter.notClauses.length
              ? { NOT: { OR: deletionFilter.notClauses as Prisma.NodeWhereInput[] } }
              : {}),
            ...unreadableLocFilter,
          },
          select: { id: true },
        })).map((n) => n.id);
        const keptMintedSpecs = await lockMintedSpecsIn(tx, graph.id, candidateIds);
        if (keptMintedSpecs.length > 0) {
          console.warn(
            `[syncGraphFromGithub] "${graphName}": kept ${keptMintedSpecs.length} minted spec(s) whose file is gone from the repo — minted specs are permanent (restore the file, or supersede the spec): ${keptMintedSpecs.map((k) => k.loc).join(', ')}`,
          );
        }
        const cleanupWhere: Prisma.NodeWhereInput = {
          ownerRepo,
          memoryId: graph.id,
          id: {
            notIn: [...upsertedIds, ...protectedRowIds, ...skippedRowIds, ...keptMintedSpecs.map((k) => k.id)],
            // #1330 — only rows this sync already holds, once it holds the rulebook lock.
            ...(prelockedIds ? { in: prelockedIds } : {}),
          },
          ...(deletionFilter.notClauses.length
            ? { NOT: { OR: deletionFilter.notClauses as Prisma.NodeWhereInput[] } }
            : {}),
          ...unreadableLocFilter,
          // #2043 — repo-wins cleanup never removes a compiled boot prompt, file or no file:
          // only a compile (or a deliberate delete) removes one.
          nodeType: { not: COMPILED_BOOT_PROMPT_NODE_TYPE },
        };
        const pruned = await tx.node.findMany({ where: cleanupWhere, select: { id: true, loc: true } });
        // #2043 (cor:agt:040:11) — nor does a worker session's sync delete a boot-prompt source.
        await assertNoBootPromptRows(tx, pruned.map((n) => n.id), 'import');
        if (memoryState.readBranch == null && !memoryState.readBranchCorrected && pruned.length > 0) {
          // #1566: old blank-read syncs could ingest the write branch and
          // adopt Hadron-created nodes as repo-owned. Boot sync runs before an
          // operator can inspect them. On this memory's FIRST corrected sync,
          // an absent repo-owned row needs human review. Roll back the WHOLE
          // transaction (cor:int:010:01); the outer catch records the coded
          // error. An explicit Read branch is the review/cleanup decision.
          throw new GitSyncRecoveryReviewRequired(pruned.map((node) => node.loc));
        } else {
          const crossMemoryEdges = await countCrossMemoryEdgesForNodeDelete(
            tx,
            graph.id,
            cleanupWhere,
          );
          if (crossMemoryEdges > 0) {
            throw new Error(
              `Git sync cleanup refused: ${crossMemoryEdges} edge(s) bridge nodes selected for hard-delete to another memory. Remove or relocate those edges explicitly first.`,
            );
          }
          // #449 — PendingEdges aimed at the pruned rows: targetId is not a
          // foreign key, so the row cascade never reaches them.
          pendingSourceMemories = await deletePendingEdgesTargetingNodes(tx, pruned.map((n) => n.id));
          // #1606 — a pruned (hard-deleted) target takes its comment threads.
          await hardDeleteThreadsOfTargets(tx, pruned.map((n) => n.id));
          await tx.node.deleteMany({ where: cleanupWhere });
        }
      }
      // A suppressed cleanup cannot prove that an old write-branch import is
      // absent. Keep the first-sync guard pending until a complete pass checks
      // it. An explicit Read branch is itself the operator's release action.
      correctionCheckCompleted = memoryState.readBranch != null || unprotectableSkips.length === 0;

      // #1411 review (Andi) — a parked row is settled by its own file (which
      // deletes it from this map) or pruned by the cleanup above. One that
      // survives both would commit at `<loc>~displaced-<id>`: its file was
      // deferred or refused, or the cleanup was suppressed. Roll back and rerun
      // with it unparkable, so the move that displaced it is held instead.
      if (parkedRevisionBases.size > 0) {
        const unsettled = await tx.node.findMany({
          where: { id: { in: [...parkedRevisionBases.keys()] } },
          select: { id: true },
        });
        if (unsettled.length > 0) throw new GitSyncUnsettledParking(unsettled.map((n) => n.id));
      }

      // #1228: rekey retained incident edges as well as repo-declared edges.
      // The legacy empty root produced trailing/leading empty atoms. Preserve
      // edge identity and custom locs; collisions abort the whole transaction.
      if (rootNode?.id && originalLocs.has(rootNode.id)) {
        const movedRoot = await tx.node.findUnique({ where: { id: rootNode.id } });
        if (movedRoot) {
          const oldLoc = originalLocs.get(rootNode.id)!;
          const incident = await tx.edge.findMany({
            where: { OR: [{ sourceId: movedRoot.id }, { targetId: movedRoot.id }] },
            include: { source: { select: { loc: true } }, target: { select: { loc: true } } },
          });
          for (const edge of incident) {
            const beforeSource = edge.sourceId === movedRoot.id ? oldLoc : edge.source.loc;
            const beforeTarget = edge.targetId === movedRoot.id ? oldLoc : edge.target.loc;
            if (edge.loc === deriveEdgeLoc(beforeSource, edge.name, beforeTarget)) {
              await tx.edge.update({ where: { id: edge.id }, data: {
                loc: deriveEdgeLoc(edge.source.loc, edge.name, edge.target.loc),
              } });
            }
          }
        }
      }

      // cor:urn:030:01 — compare committed pre-sync addresses with surviving
      // final addresses, after cleanup has removed displaced/deleted rows.
      // The memory's URN comes from the row fenced above, not the caller's
      // possibly stale `graph`. An unminted node has no published URN to retain
      // (#1591, per node); its moves are the rule's sole exception. The mirror root has no
      // round-trippable v2 node URN to alias *from*, but a published non-root
      // address still needs an alias when its node moves *into* the root.
      if (originalLocs.size > 0) {
        const survivors = await tx.node.findMany({
          where: { id: { in: [...originalLocs.keys()] }, memoryId: graph.id, deletedAt: null, mintedAt: { not: null } },
          select: { id: true, loc: true },
        });
        for (const row of survivors) {
          const originalLoc = originalLocs.get(row.id)!;
          if (!originalLoc || originalLoc === row.loc) continue;
          await recordUrnRename(tx, {
            entityType: 'NODE',
            entityId: row.id,
            oldUrn: safeNodeUrnV2(memoryState.urn, originalLoc).slice('hrn:node:'.length),
            newUrn: safeNodeUrnV2(memoryState.urn, row.loc).slice('hrn:node:'.length),
            createdBy: 'system:github-sync',
          });
        }
      }

      for (const edge of edges) {
        if (refusedRoleLocs.has(edge.sourceLoc) || deferredLocs.has(edge.sourceLoc) || refusedMoveLocs.has(edge.sourceLoc)) continue;
        if (!fileIdToRowId.has(edge.targetId) && unappliedFileIds.has(edge.targetId)) continue;
        // Resolve endpoints through the remaps: the source is always a file
        // in this repo (by loc); the target prefers this repo's claimant of
        // the referenced id, else stays raw (a cross-repo target).
        const edgeSourceId = locToRowId.get(edge.sourceLoc) ?? edge.sourceId;
        const edgeTargetId = fileIdToRowId.get(edge.targetId) ?? edge.targetId;
        const sourceExists = await tx.node.findUnique({
          where: { id: edgeSourceId, deletedAt: null },
          select: { id: true, loc: true, memoryId: true },
        });
        if (
          !sourceExists ||
          sourceExists.memoryId !== graph.id ||
          sourceExists.loc !== edge.sourceLoc
        ) {
          throw new EdgeEndpointPreflightStale(
            `Edge source ${edgeSourceId} moved away from ${graph.id}:${edge.sourceLoc}`,
          );
        }
        const targetExists = await tx.node.findUnique({
          where: { id: edgeTargetId, deletedAt: null },
          select: { id: true, loc: true, memoryId: true },
        });
        if (targetExists && !edgeEndpointMemoryIdSet.has(targetExists.memoryId)) {
          throw new EdgeEndpointPreflightStale(
            `Edge target ${edgeTargetId} became live in unlocked memory ${targetExists.memoryId}`,
          );
        }
        if (targetExists) {
          // Spec 037: the edge's identity is its loc within the source's
          // memory (= graph.id here; the source came from this repo). Derive
          // it deterministically so re-syncs are idempotent.
          const edgeLoc = deriveEdgeLoc(edge.sourceLoc, edge.name, targetExists.loc);
          const edgeCondition = edge.condition ?? null;
          const edgePriority = edge.priority ?? 0;
          const conditionValidation = validateEdgeCondition(edgeCondition);
          if (!conditionValidation.ok) {
            throw new Error(`Git sync edge loc "${edgeLoc}" has an invalid condition: ${conditionValidation.error.message}`);
          }
          const savedEdge = await tx.edge.upsert({
            where: { loc_memoryId: { loc: edgeLoc, memoryId: graph.id } },
            create: {
              id: generateId(),
              memoryId: graph.id,
              sourceId: edgeSourceId,
              targetId: edgeTargetId,
              loc: edgeLoc,
              name: edge.name,
              description: edge.description ?? null,
              ...(edge.data != null ? { data: edge.data as Prisma.InputJsonValue } : {}),
              isRunnable: edge.isRunnable ?? null,
              ...(edgeCondition !== null ? { condition: edgeCondition as Prisma.InputJsonValue } : {}),
              priority: edgePriority,
            },
            update: {},
          });
          // A loc is an edge's address, not proof that this repo's relationship
          // was saved. An unrelated edge may already own the same derived loc;
          // update:{} then returns that occupant without changing it. Refuse
          // inside the transaction so earlier node/edge writes roll back too.
          // Existing metadata remains untouched, as it did before this guard:
          // API edits are not mirrored to Git (#430), and this create-only
          // importer does not reconcile them on an existing edge.
          if (
            savedEdge.deletedAt !== null ||
            savedEdge.sourceId !== edgeSourceId ||
            savedEdge.targetId !== edgeTargetId ||
            savedEdge.name !== edge.name
          ) {
            throw new Error(`Git sync edge loc "${edgeLoc}" is already occupied by a different edge.`);
          }
          await tx.pendingEdge.deleteMany({
            where: { sourceId: edgeSourceId, targetId: edgeTargetId },
          });
        } else {
          // Target not synced yet — park as a PendingEdge. loc is derived at
          // promotion time (once the target arrives and its loc is known).
          await tx.pendingEdge.upsert({
            where: { sourceId_targetId: { sourceId: edgeSourceId, targetId: edgeTargetId } },
            create: {
              id: generateId(), sourceId: edgeSourceId, targetId: edgeTargetId,
              name: edge.name, description: edge.description ?? null,
              ...(edge.data != null ? { data: edge.data as Prisma.InputJsonValue } : {}),
            },
            update: {
              name: edge.name,
              description: edge.description ?? null,
              data: edge.data != null ? edge.data as Prisma.InputJsonValue : Prisma.DbNull,
            },
          });
        }
        }

        // Process the current repo's edges before promoting older PendingEdges.
        // A parked row may predate metadata storage, or its source file may
        // change metadata in the same commit that adds the target. The edge
        // loop above writes that file's current values and consumes the queue
        // row; remaining rows belong to other repos (or have no current edge).
        // Spec 037: a promoted cross-repo Edge lives in its SOURCE memory.
        for (const targetId of new Set(upsertedIds)) {
          const target = await tx.node.findUnique({
            where: { id: targetId, deletedAt: null },
            select: { loc: true },
          });
          if (!target) continue;
          const pending = await tx.pendingEdge.findMany({
            where: { targetId, deletedAt: null },
          });
          for (const p of pending) {
            const pSrc = await tx.node.findUnique({
              where: { id: p.sourceId, deletedAt: null },
              select: { loc: true, memoryId: true },
            });
            if (pSrc && !edgeEndpointMemoryIdSet.has(pSrc.memoryId)) {
              throw new EdgeEndpointPreflightStale(
                `PendingEdge source ${p.sourceId} became live in unlocked memory ${pSrc.memoryId}`,
              );
            }
            if (pSrc) {
              const pLoc = p.loc ?? deriveEdgeLoc(pSrc.loc, p.name, target.loc);
              const promotedEdge = await tx.edge.upsert({
                where: { loc_memoryId: { loc: pLoc, memoryId: pSrc.memoryId } },
                create: {
                  id: generateId(),
                  memoryId: pSrc.memoryId,
                  sourceId: p.sourceId,
                  targetId: p.targetId,
                  loc: pLoc,
                  name: p.name,
                  description: p.description,
                  ...(p.data != null ? { data: p.data as Prisma.InputJsonValue } : {}),
                },
                update: {},
              });
              // A loc is the edge identity. A no-op upsert can return another
              // relationship already occupying the same loc, so consume only
              // when the returned edge is this live relationship.
              if (
                promotedEdge.deletedAt ||
                promotedEdge.sourceId !== p.sourceId ||
                promotedEdge.targetId !== p.targetId ||
                promotedEdge.name !== p.name
              ) {
                throw new Error(
                  `Pending edge ${p.id} cannot promote: edge loc ${pLoc} is already occupied`,
                );
              }
              await tx.pendingEdge.delete({ where: { id: p.id } });
              // The queue item belongs to its SOURCE memory, which may differ
              // from the Git memory that supplied the target.
              await reconcilePendingEdgeCount(tx, pSrc.memoryId);
            }
          }
        }
        await reconcilePendingEdgeCount(tx, graph.id);
        // #1507: the graph and its outcome commit together. A metadata failure
        // must roll back the graph, never leave a falsely clean old report.
        const recordedAt = new Date();
        await tx.memory.update({
          where: { id: graph.id },
          data: {
            lastSyncedAt: recordedAt, syncStatus: 'OK', syncError: null,
            lastSyncReport: committedSyncReport(reportEntries, recordedAt, skippedInvalidLoc.length > 0),
            ...(correctionCheckCompleted ? { readBranchCorrected: true } : {}),
          },
        });
      });
      break;
    } catch (error) {
      if (error instanceof GitSyncUnsettledParking) {
        const fresh = error.nodeIds.filter((id) => !unparkable.has(id));
        // An unparkable row is never parked, so a repeat means the guard
        // failed; fail loudly rather than loop.
        if (fresh.length === 0) throw error;
        for (const id of fresh) unparkable.add(id);
        continue;
      }
      if (
        error instanceof EdgeEndpointPreflightStale &&
        edgeEndpointPreflightAttempt < MAX_EDGE_ENDPOINT_PREFLIGHT_RETRIES
      ) {
        // A live cross-memory endpoint appeared after preflight. Treating it as
        // absent would strand a resolvable PendingEdge after the target sync's
        // promotion pass already ran. Abort this transaction and rerun the
        // whole preflight so the new endpoint memory joins the stable lock set.
        return syncGraphFromGithub(graph, edgeEndpointPreflightAttempt + 1);
      }
      throw error;
    }
    }

    await reconcilePendingEdgeCounts(db, pendingSourceMemories).catch((err) =>
      console.warn(`[syncGraphFromGithub] "${graphName}": pending-edge count reconcile failed (the periodic repair will fix it):`, err),
    );

    // The transaction is visible before any local selector or optional broker wake.
    if (embeddingWakeNeeded) wakeEmbeddingQueue(db);

    if (skippedProtected.length > 0) {
      console.warn(`Sync of "${graphName}": skipped ${skippedProtected.length} file(s) under a Channel's address: ${skippedProtected.join(', ')}`);
    }
    console.log(`Synced memory "${graphName}": ${fsGraph.nodes.length} nodes, ${edges.length} edges`);
    if (skippedObjectTypes.length > 0) {
      console.warn(
        `Sync of "${graphName}": kept the stored objectType of ${skippedObjectTypes.length} node(s) whose file's value would violate the memory schema: ${skippedObjectTypes.join('; ')}`,
      );
    }
    if (deferredLateRows.length > 0) {
      console.warn(
        `Sync of "${graphName}": deferred ${deferredLateRows.length} file(s) to the next sync, whose node arrived while this one ran: ${deferredLateRows.join('; ')}`,
      );
    }
    if (skippedUndeclaredRoles.length > 0) {
      console.warn(
        `Sync of "${graphName}": skipped ${skippedUndeclaredRoles.length} file(s) whose role is not declared under a strict parent (ROLE_NOT_DECLARED): ${skippedUndeclaredRoles.map(describeSkippedUndeclaredRole).join('; ')}`,
      );
    }
    if (skippedInvalidIncludes.length > 0) {
      console.warn(
        `Sync of "${graphName}": skipped ${skippedInvalidIncludes.length} file(s) with an invalid include tag: ${skippedInvalidIncludes.map((i) => `${i.loc} (${i.code})`).join('; ')}`,
      );
    }
    if (heldMoves.length > 0) {
      console.warn(
        `Sync of "${graphName}": held ${heldMoves.length} move(s) whose destination's occupant could not be moved out of the way this sync: ${heldMoves.join('; ')}`,
      );
    }
    return { nodeCount: fsGraph.nodes.length, writtenNodes, skippedProtected, skippedObjectTypes, skippedUndeclaredRoles, skippedInvalidIncludes, deferredLateRows, heldMoves };
  } catch (error) {
    // Update sync status to ERROR
    await db.memory.update({
      where: { id: graph.id },
      data: { syncStatus: 'ERROR', syncError: (error as Error).message,
        lastSyncReport: failedSyncReport(error instanceof InvalidNodeNameError || error instanceof GitSyncUnreadableFileError ? 'BAD_USER_INPUT' : 'SYNC_FAILED') },
    }).catch(() => {});
    console.error(`Failed to sync memory "${graph.name}":`, error);
    return {
      error: (error as Error).message,
      ...(error instanceof InvalidNodeNameError || error instanceof GitSyncUnreadableFileError
        ? { errorCode: 'BAD_USER_INPUT' as const }
        : error instanceof GitSyncEncryptedMemoryError ? { errorCode: ENCRYPTED_GIT_SYNC_UNAVAILABLE }
          // A git failure's message is fixed and credential-free by design (execGit), so it stays a typed refusal.
          : error instanceof GitCommandError ? {} : { fault: true as const }),
    };
  }
};

/**
 * #2527: restore the stored tokenless source under the shared checkout lock on
 * every read exit, including a partial clone. Never replace the primary outcome
 * or log the raw error/URL if restoration fails (same contract as #2396).
 */
async function restoreReadRemote(localPath: string, source: string): Promise<void> {
  try {
    if (!existsSync(join(localPath, '.git'))) return;
    await execGit(['remote', 'set-url', 'origin', source], { cwd: localPath });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.error(
      `[syncGraphFromGithub] Failed to restore the origin URL at ${localPath}; the checkout may still hold an installation token until the next successful restore.`,
      typeof code === 'string' ? code : 'unknown',
    );
  }
}

async function gitSync(cloneUrl: string, localPath: string, readBranch?: string): Promise<void> {
  // #1146: validated BEFORE the clone/pull split, because both arms reach git
  // with this value — `checkout <branch>` on one side and `clone --branch
  // <branch>` on the other. The first version of this guard sat inside the
  // pull arm only, so a fresh clone bypassed it entirely (@copilot, PR #1247):
  // a guard in one branch of an if/else is narrower than the claim it makes.
  if (readBranch) validateGitBranch(readBranch, 'readBranch');

  if (existsSync(join(localPath, '.git'))) {
    // Update remote URL with fresh token before pulling
    await execGit(['remote', 'set-url', 'origin', cloneUrl], { cwd: localPath });
    // A mirror may have left HEAD on the write branch. With no configured
    // readBranch, resolve the remote's CURRENT default rather than trusting
    // the checkout (or a possibly stale local origin/HEAD symbolic ref).
    const branch = readBranch ?? await remoteDefaultBranch(localPath);
    await execGit(['fetch', 'origin'], { cwd: localPath });
    await checkoutReadBranch(localPath, branch);
    await execGit(['merge', '--ff-only', `origin/${branch}`], { cwd: localPath });
  } else {
    mkdirSync(dirname(localPath), { recursive: true });
    const cloneArgs = ['clone'];
    if (readBranch) cloneArgs.push('--branch', readBranch);
    // `--` ends option parsing (#561). Without it a `source` beginning with `-`
    // is read by git as an OPTION rather than a URL, and `--upload-pack=<cmd>`
    // runs `<cmd>` — measured executing on git 2.50.1.
    //
    // Stated precisely, because it does NOT reproduce through this argv today:
    // git then treats `localPath` as the repository, and this branch only runs
    // when `localPath` has no `.git`, so git fails on the missing repository
    // before invoking upload-pack. That is a property of the surrounding
    // control flow, not of the command — it holds until someone reorders the
    // existsSync check or the destination survives a partial clone. `--` makes
    // the argv safe on its own terms, so it cannot be re-opened from a distance.
    cloneArgs.push('--', cloneUrl, localPath);
    await execGit(cloneArgs);
  }
}

async function remoteDefaultBranch(localPath: string): Promise<string> {
  const { stdout } = await execGit(['ls-remote', '--symref', 'origin', 'HEAD'], { cwd: localPath });
  const match = stdout.match(/^ref: refs\/heads\/([^\t\r\n]+)\tHEAD\r?$/m);
  if (!match) throw new Error('Git sync could not resolve the remote default branch; set readBranch explicitly.');
  validateGitBranch(match[1], 'remote default branch');
  return match[1];
}

async function checkoutReadBranch(localPath: string, branch: string): Promise<void> {
  let localExists = true;
  try {
    await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: localPath });
  } catch {
    localExists = false;
  }
  // A failed checkout (dirty tree, lock, etc.) must not be misread as a
  // missing local ref and retried as `checkout -b`.
  if (localExists) await execGit(['checkout', branch], { cwd: localPath });
  else await execGit(['checkout', '-b', branch, `origin/${branch}`], { cwd: localPath });
}

function extractOwnerRepo(gitUrl: string): string {
  const sshMatch = gitUrl.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  const httpsMatch = gitUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return gitUrl;
}

/**
 * #1610: Git sync writes the repository's content, not the requester's, and
 * its revisions name the system editor `system:github-sync`. So it runs as
 * the system even inside a worker's request: node and revision then agree.
 */
export const syncGraphFromGithub: typeof syncGraphFromGithubAsSystem = (...args) =>
  withSyncCaller(boundWorkerId(), () => runAsSystem(() => syncGraphFromGithubAsSystem(...args)));
