import { createDecipheriv } from 'crypto';
import { governedSignalsFromMirror } from '../../lib/governedSignals.js';
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
import { loadGraphFromFs } from '../localFs/loadGraphFromFs.js';
import { deriveEdgeLoc } from '../../lib/edgeLoc.js';
import { countCrossMemoryEdgesForNodeDelete } from '../../lib/crossMemoryEdgeDelete.js';
import { db } from '../db/client.js';
import { serializeTags } from '../db/provider.js';
import { getInstallationToken, toHttpsUrl } from './githubApp.js';
import { execGit } from './execGit.js';
import { validateMemorySource } from '../../lib/gitSource.js';
import { enqueueNodeEmbedding } from '../../services/embedding/enqueue.js';
import { acquireLockSet, ancestorLocs, lockAncestorsForCreateMany } from '../../lib/nodeSubtreeLock.js';
import type { Prisma } from '../../generated/prisma/index.js';
import type { Memory, Node, Organization } from '../../generated/prisma/index.js';
import { validateGitBranch } from '../../lib/gitRef.js';
import { lockMemoryForChannelChange } from '../../lib/channels.js';
import { reconcilePendingEdgeCount } from '../../lib/pendingEdgePromotion.js';
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

export class GitSyncEncryptedMemoryError extends Error {
  constructor() {
    super('Git sync cannot write an encrypted memory without its data key.');
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
  const changes = diffNodeChanges(before, update);

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
      revisionContentHash: revisionStateHashRefreshMarker(),
    },
  });
}

/**
 * Sync a memory from GitHub: clone/pull the repo, load nodes from filesystem,
 * and upsert them into the database.
 */
export const syncGraphFromGithub = async (
  graph: MemoryWithOrg,
  edgeEndpointPreflightAttempt = 0,
): Promise<{
  error?: string;
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
}> => {
  try {
    const graphName = graph.urn;

    // spec 047: git sync is org-scoped (needs the org's GitHub App). A
    // user-owned memory has no org — surface it as an error so an explicit
    // syncMemory call gets a meaningful message rather than a silent no-op
    // (startup's batch loop guards on `organization` before calling).
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
    const localPath = join(GRAPHS_PATH, organization.urn, slug);
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
    const cloneUrl = toHttpsUrl(graph.source, token);

    // 2. Clone or pull the repo
    await gitSync(cloneUrl, localPath, graph.readBranch ?? undefined);

    // 3. Load the graph from the filesystem
    const { graph: fsGraph, edges, skippedInvalidLoc } = await loadGraphFromFs(localPath, graphName, ownerRepo);

    // 4. Upsert all nodes and edges into the database (transactional)
    // Spec 033 T029 — defer embedding enqueue until after the transaction
    // commits. The plaintext was loaded from the filesystem by
    // loadNodeFromFs (FR-013 reconcile already ran), so it's safe to use
    // as in-closure plaintext for the prompt-drain embed — matching the
    // GraphQL / MCP write paths so encrypted memories embed correctly at
    // write time without a session key (FR-027).
    const pendingEmbeds: Array<{
      nodeId: string;
      plaintext: { content: string | null; abstract: string | null };
    }> = [];
    // #1061 — accumulated INSIDE the transaction (that is where the surviving
    // row ids are known) but declared outside it so the refs survive the commit
    // and can be returned to the caller.
    const writtenNodes: { id: string; loc: string; memoryId: string }[] = [];
    const skippedProtected: string[] = [];
    const skippedObjectTypes: string[] = [];

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
      .filter((loc): loc is string => typeof loc === 'string' && loc !== '');
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

    try {
      await db.$transaction(async (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => {
      // Hold every endpoint memory key in one stable order for the ENTIRE
      // snapshot-to-cleanup/edge-write interval. This includes graph.id, so it
      // preserves the cleanup-vs-resurrection serialization added earlier.
      for (const memoryId of edgeEndpointMemoryIds) {
        await lockMemoryForChannelChange(tx, memoryId);
      }
      // #664/#752: a git-sync bulk-upserts/moves rows into an EXISTING memory,
      // bypassing the locked create surfaces. Lock the ancestor path of every
      // synced loc (deduped, root→leaf) up front so a concurrent non-recursive
      // delete of an ancestor in this memory can't count zero descendants and
      // then miss the rows this sync commits. READ COMMITTED (the tx default) is
      // required so that delete's count sees these rows once the sync commits.
      // Spec 049 S4: a Channel's address is never written from git — a mirror
      // could otherwise overwrite the one record whose authorship is derived
      // (#1047). Skipped and reported, never a failed sync.
      const protectedLocs = await protectedLocsIn(tx, graph.id);
      const isProtected = (loc: string) => protectedLocs.some((p) => protectedLocCovers(p, loc));
      // #1348 — the property schema a restored objectType must satisfy.
      const memorySchema = ((await tx.memory.findUnique({ where: { id: graph.id }, select: { schema: true } }))
        ?.schema ?? null) as MemorySchema | null;
      const writableLocs = fsGraph.nodes
        .map((n) => n.loc)
        .filter((l): l is string => typeof l === 'string' && l !== '' && !isProtected(l));

      // Declare the COMPLETE loc-key set before taking any of it. Incoming
      // nodes need ancestor keys for create/delete coordination; every edge
      // source and preflighted external endpoint needs its full path (strict
      // ancestors + exact loc) so a subtree move cannot relocate it after the
      // sync built its id map but before the edge insert.
      await acquireLockSet(tx, [
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
      ]);
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

      const upsertedIds: string[] = [];
      // Rows the cleanup pass below must leave alone: a protected file's row
      // is not upserted, and `notIn: upsertedIds` would otherwise hard-delete
      // it — a root deletion cascading its Channel row (Copilot on PR #1165).
      const protectedRowIds = new Set<string>();
      // File frontmatter ids already claimed in THIS run — a second file
      // carrying the same id (a copied file) must not be treated as a move
      // of the first; it gets a fresh id instead.
      const claimedFileIds = new Set<string>();
      // A loc swap temporarily parks an occupant so the first move can land.
      // Preserve its committed pre-sync state; when its own file is processed,
      // one revision spans original -> final and the parking loc never enters
      // retained history (or consumes a maxRevCount slot).
      const parkedRevisionBases = new Map<string, Node>();
      // Edge-endpoint remapping (PR-576 codex review): when a fresh id is
      // minted for a file (foreign-memory or duplicate frontmatter id), the
      // edges loadGraphFromFs captured still carry the file's ORIGINAL id.
      // Sources always resolve by the file's loc (unique per repo); targets
      // resolve by first-claimant file id, falling back to the raw id for
      // legitimate cross-repo references.
      const locToRowId = new Map<string, string>();
      const fileIdToRowId = new Map<string, string>();

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
          continue;
        }
        const name = node.name!;
        const update = {
          loc,
          name,
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

        // #1348 — the collection discriminator, by the same absent-means-
        // preserve rule: `loadNodeFromFs` yields the key only for a non-blank
        // value (a file never clears it — cor:int:020:01, CLI import #725), so
        // an omitted key leaves a stored objectType alone on update and takes
        // the unset default on create.
        //
        // A present one is written only if the RESULTING record satisfies the
        // memory's property schema (#725: a structured record must satisfy its
        // collection — the invariant every GraphQL/MCP write enforces through
        // validateNodeAgainstSchema). Sync restores neither `properties` nor
        // `data`, so the record is judged with the properties the row already
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
            return {};
          }
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
        const fileId = node.id && !claimedFileIds.has(node.id) ? node.id : null;
        const byId = fileId
          ? await tx.node.findUnique({ where: { id: fileId } })
          : null;
        if (node.id) claimedFileIds.add(node.id);

        let rowId: string;
        if (byId && byId.memoryId === graph.id) {
          // The SOURCE loc of an id-first move is checked too: a file whose
          // new path is free must not drag a node out from under a Channel
          // (Copilot on PR #1165).
          if (byId.loc !== loc && isProtected(byId.loc)) {
            skippedProtected.push(`${byId.loc} → ${loc}`);
            protectedRowIds.add(byId.id);
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
              continue;
            }
            if (occupant && occupant.id !== byId.id) {
              await tx.$queryRaw`SELECT "id" FROM "nodes" WHERE "id" = ${occupant.id} FOR UPDATE`;
              await ensureCurrentNodeRevisionInTransaction(tx, occupant.id, { expectedMemoryId: graph.id });
              const lockedOccupant = await tx.node.findUniqueOrThrow({ where: { id: occupant.id } });
              if (!parkedRevisionBases.has(occupant.id)) {
                parkedRevisionBases.set(occupant.id, lockedOccupant);
              }
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
          await updateNodeFromGitSync(tx, byId, update, parkedRevisionBases.get(byId.id), graph.id, (locked) =>
            objectTypeFor(locked.properties),
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
          if (existingAtLoc) {
            await updateNodeFromGitSync(
              tx,
              existingAtLoc,
              update,
              parkedRevisionBases.get(existingAtLoc.id),
              graph.id,
              (locked) => objectTypeFor(locked.properties),
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
        if (node.id && !fileIdToRowId.has(node.id)) fileIdToRowId.set(node.id, rowId);
        pendingEmbeds.push({
          nodeId: rowId,
          plaintext: { content: node.content ?? null, abstract: node.abstract ?? null },
        });

        // Resolve any cross-repo PendingEdges that were waiting for this node.
        // Spec 037: the promoted Edge lives in its SOURCE node's memory (which
        // may differ from this repo's memory for cross-repo edges); derive its
        // loc from the source loc + name + this node's (target) loc.
        const pending = await tx.pendingEdge.findMany({
          where: { targetId: rowId, deletedAt: null },
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
            const pLoc = p.loc ?? deriveEdgeLoc(pSrc.loc, p.name, loc);
            const promotedEdge = await tx.edge.upsert({
              where: { loc_memoryId: { loc: pLoc, memoryId: pSrc.memoryId } },
              create: {
                id: generateId(),
                memoryId: pSrc.memoryId,
                sourceId: p.sourceId,
                targetId: p.targetId,
                loc: pLoc,
                name: p.name,
              },
              update: {},
            });
            // Loc is the edge identity. A no-op upsert can return another
            // relationship already occupying the same loc, so consuming the
            // queue row is safe only when the returned edge is exactly the
            // requested live relationship.
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
            // The queue item belongs to its SOURCE memory, not necessarily to
            // the Git memory that supplied the target. Keep that memory's
            // dashboard projection exact in this same transaction.
            await reconcilePendingEdgeCount(tx, pSrc.memoryId);
          }
        }
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
        const cleanupWhere: Prisma.NodeWhereInput = {
          ownerRepo,
          memoryId: graph.id,
          id: { notIn: [...upsertedIds, ...protectedRowIds, ...skippedRowIds] },
          ...(deletionFilter.notClauses.length
            ? { NOT: { OR: deletionFilter.notClauses as Prisma.NodeWhereInput[] } }
            : {}),
        };
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
        await tx.node.deleteMany({
          // `skippedRowIds` joins the survivors for the same reason
          // `protectedRowIds` does (#1224): a file skipped for an unusable
          // path is absent from `fsGraph.nodes`, so `notIn: upsertedIds`
          // would hard-delete the row it names.
          where: cleanupWhere,
        });
      }

      for (const edge of edges) {
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
              isRunnable: edge.isRunnable ?? null,
            },
            update: {},
          });
          // A loc is an edge's address, not proof that this repo's relationship
          // was saved. An unrelated edge may already own the same derived loc;
          // update:{} then returns that occupant without changing it. Refuse
          // inside the transaction so earlier node/edge writes roll back too.
          if (
            savedEdge.deletedAt !== null ||
            savedEdge.sourceId !== edgeSourceId ||
            savedEdge.targetId !== edgeTargetId ||
            savedEdge.name !== edge.name ||
            savedEdge.description !== (edge.description ?? null) ||
            savedEdge.isRunnable !== (edge.isRunnable ?? null) ||
            savedEdge.condition !== null ||
            savedEdge.priority !== 0 ||
            savedEdge.data !== null
          ) {
            throw new Error(`Git sync edge loc "${edgeLoc}" is already occupied by a different edge state.`);
          }
          await tx.pendingEdge.deleteMany({
            where: { sourceId: edgeSourceId, targetId: edgeTargetId },
          });
        } else {
          // Target not synced yet — park as a PendingEdge. loc is derived at
          // promotion time (once the target arrives and its loc is known).
          await tx.pendingEdge.upsert({
            where: { sourceId_targetId: { sourceId: edgeSourceId, targetId: edgeTargetId } },
            create: { id: generateId(), sourceId: edgeSourceId, targetId: edgeTargetId, name: edge.name },
            update: { name: edge.name },
          });
        }
        }
        await reconcilePendingEdgeCount(tx, graph.id);
      });
    } catch (error) {
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

    // 5. Record sync time and status
    await db.memory.update({
      where: { id: graph.id },
      data: { lastSyncedAt: new Date(), syncStatus: 'OK', syncError: null },
    }).catch(() => {});

    // 6. Spec 033 T029 — enqueue embedding for each upserted node now that
    // the transaction has committed. Fire-and-forget; enqueueNodeEmbedding
    // is a no-op when the memory isn't vector-indexed and is internally
    // catch-all so it can never break the sync.
    for (const e of pendingEmbeds) {
      void enqueueNodeEmbedding(db, {
        nodeId: e.nodeId,
        memoryId: graph.id,
        plaintext: e.plaintext,
      });
    }

    if (skippedProtected.length > 0) {
      console.warn(`Sync of "${graphName}": skipped ${skippedProtected.length} file(s) under a Channel's address: ${skippedProtected.join(', ')}`);
    }
    console.log(`Synced memory "${graphName}": ${fsGraph.nodes.length} nodes, ${edges.length} edges`);
    if (skippedObjectTypes.length > 0) {
      console.warn(
        `Sync of "${graphName}": kept the stored objectType of ${skippedObjectTypes.length} node(s) whose file's value would violate the memory schema: ${skippedObjectTypes.join('; ')}`,
      );
    }
    return { nodeCount: fsGraph.nodes.length, writtenNodes, skippedProtected, skippedObjectTypes };
  } catch (error) {
    // Update sync status to ERROR
    await db.memory.update({
      where: { id: graph.id },
      data: { syncStatus: 'ERROR', syncError: (error as Error).message },
    }).catch(() => {});
    console.error(`Failed to sync memory "${graph.name}":`, error);
    return { error: (error as Error).message };
  }
};

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
    if (readBranch) {
      await execGit(['checkout', readBranch], { cwd: localPath });
    }
    await execGit(['pull', '--ff-only'], { cwd: localPath });
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

function extractOwnerRepo(gitUrl: string): string {
  const sshMatch = gitUrl.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  const httpsMatch = gitUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return gitUrl;
}
