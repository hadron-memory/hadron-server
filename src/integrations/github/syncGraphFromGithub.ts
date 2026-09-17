import { createDecipheriv } from 'crypto';
// Spec 049 S4 — a Channel's address is skipped and reported, never overwritten from git.
import { protectedLocsIn, protectedLocCovers } from '../../lib/protectedLoc.js';
import { generateId } from '../../lib/id.js';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { GRAPHS_PATH } from '../../config.js';
import { loadGraphFromFs } from '../localFs/loadGraphFromFs.js';
import { deriveEdgeLoc } from '../../lib/edgeLoc.js';
import { db } from '../db/client.js';
import { serializeTags } from '../db/provider.js';
import { getInstallationToken, toHttpsUrl } from './githubApp.js';
import { execGit } from './execGit.js';
import { validateMemorySource } from '../../lib/gitSource.js';
import { enqueueNodeEmbedding } from '../../services/embedding/enqueue.js';
import { ancestorLocs, lockAncestorsForCreateMany } from '../../lib/nodeSubtreeLock.js';
import type { Prisma } from '../../generated/prisma/index.js';
import type { Memory, Organization } from '../../generated/prisma/index.js';

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

/**
 * Sync a memory from GitHub: clone/pull the repo, load nodes from filesystem,
 * and upsert them into the database.
 */
export const syncGraphFromGithub = async (
  graph: MemoryWithOrg,
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
    const { graph: fsGraph, edges } = await loadGraphFromFs(localPath, graphName, ownerRepo);

    // 4. Upsert all nodes and edges into the database (transactional)
    let pendingEdgeCount = 0;
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
    await db.$transaction(async (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => {
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
      await lockAncestorsForCreateMany(
        tx,
        graph.id,
        fsGraph.nodes
          .map((n) => n.loc)
          .filter((l): l is string => typeof l === 'string' && l !== '' && !isProtected(l)),
      );
      const upsertedIds: string[] = [];
      // Rows the cleanup pass below must leave alone: a protected file's row
      // is not upserted, and `notIn: upsertedIds` would otherwise hard-delete
      // it — a root deletion cascading its Channel row (Copilot on PR #1165).
      const protectedRowIds: string[] = [];
      // File frontmatter ids already claimed in THIS run — a second file
      // carrying the same id (a copied file) must not be treated as a move
      // of the first; it gets a fresh id instead.
      const claimedFileIds = new Set<string>();
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
          ? await tx.node.findUnique({ where: { id: fileId }, select: { id: true, memoryId: true, loc: true } })
          : null;
        if (node.id) claimedFileIds.add(node.id);

        let rowId: string;
        if (byId && byId.memoryId === graph.id) {
          // The SOURCE loc of an id-first move is checked too: a file whose
          // new path is free must not drag a node out from under a Channel
          // (Copilot on PR #1165).
          if (byId.loc !== loc && isProtected(byId.loc)) {
            skippedProtected.push(`${byId.loc} → ${loc}`);
            protectedRowIds.push(byId.id);
            continue;
          }
          if (byId.loc !== loc) {
            // Moving into a loc another row currently holds: repo-wins — the
            // occupant is stale at that loc (it either moves later this run
            // via its own file, or the notIn deletion pass removes it). Park
            // it out of the way so the move can't collide.
            const occupant = await tx.node.findUnique({
              where: { loc_memoryId: { loc, memoryId: graph.id } },
              select: { id: true },
            });
            if (occupant && occupant.id !== byId.id) {
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
          await tx.node.update({ where: { id: byId.id }, data: update });
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
          const row = await tx.node.upsert({
            where: { loc_memoryId: { loc, memoryId: graph.id } },
            create: { id: createId, memoryId: graph.id, ...update },
            update,
            select: { id: true },
          });
          // The SURVIVING id: the update path keeps the existing row's id,
          // which may differ from the file's — recording the file id here
          // would make the notIn deletion pass below delete the row we just
          // updated.
          rowId = row.id;
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
        const pending = await tx.pendingEdge.findMany({ where: { targetId: rowId } });
        for (const p of pending) {
          const pSrc = await tx.node.findUnique({
            where: { id: p.sourceId },
            select: { loc: true, memoryId: true },
          });
          if (pSrc) {
            const pLoc = p.loc ?? deriveEdgeLoc(pSrc.loc, p.name, loc);
            await tx.edge.upsert({
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
          }
          await tx.pendingEdge.delete({ where: { id: p.id } });
        }
      }

      // Spec 049 S4: never delete a row under (or above) a Channel's address,
      // whether it was skipped this run or was git-owned before the Channel
      // existed — the reservation outlives the mirror.
      const protectedLocClauses: Prisma.NodeWhereInput[] = protectedLocs.flatMap((p) => [
        { loc: p.loc },
        { loc: { startsWith: `${p.loc}:` } },
        ...(ancestorLocs(p.loc).length ? [{ loc: { in: ancestorLocs(p.loc) } }] : []),
      ]);
      await tx.node.deleteMany({
        where: {
          ownerRepo,
          memoryId: graph.id,
          id: { notIn: [...upsertedIds, ...protectedRowIds] },
          ...(protectedLocClauses.length ? { NOT: { OR: protectedLocClauses } } : {}),
        },
      });

      for (const edge of edges) {
        // Resolve endpoints through the remaps: the source is always a file
        // in this repo (by loc); the target prefers this repo's claimant of
        // the referenced id, else stays raw (a cross-repo target).
        const edgeSourceId = locToRowId.get(edge.sourceLoc) ?? edge.sourceId;
        const edgeTargetId = fileIdToRowId.get(edge.targetId) ?? edge.targetId;
        const targetExists = await tx.node.findUnique({
          where: { id: edgeTargetId },
          select: { id: true, loc: true },
        });
        if (targetExists) {
          // Spec 037: the edge's identity is its loc within the source's
          // memory (= graph.id here; the source came from this repo). Derive
          // it deterministically so re-syncs are idempotent.
          const edgeLoc = deriveEdgeLoc(edge.sourceLoc, edge.name, targetExists.loc);
          await tx.edge.upsert({
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
          pendingEdgeCount++;
        }
      }
    });

    // 5. Record sync time and status
    await db.memory.update({
      where: { id: graph.id },
      data: { lastSyncedAt: new Date(), syncStatus: 'OK', syncError: null, pendingEdgeCount },
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
    return { nodeCount: fsGraph.nodes.length, writtenNodes, skippedProtected };
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
