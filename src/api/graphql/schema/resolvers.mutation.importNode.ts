// importNode (#457, sync v1) — import external content into a node.
// Spec: cor:api:130 (surface contract :01, egress policy :02).
//
// Binding decisions (handoff 2026-07-03 + the 2026-07-01 spec-039 session):
//   - SYNCHRONOUS v1: the url path fetches inline (~30s budget) and returns
//     status STORED. No background job — `jobId` stays null and the
//     FETCH_PENDING status value is reserved so async can arrive later
//     behind the same API shape.
//   - Server-fetched HTML runs Readability (src/lib/articleExtract.ts) and
//     falls back to the whole page when no article is found.
//   - Conflict = UPDATE IN PLACE: delegation to writeNodeCore mode 'upsert'
//     (the internal-callers-only mode) — full write invariants apply
//     (NodeRevision snapshot = undo, encryption, hash, re-embed, git mirror).
//   - taskRef post-import hand-off: implemented #528 — when set, the stored
//     node is handed to that task via a MANUAL AppRun (async). (Supersedes the
//     2026-07-01 D12 deferral.)
//   - No MCP tool in v1 (agent exposure parked with the web-fetch-tool stub).

import { GraphQLError } from 'graphql';
import { splitNodeUrn } from '../../../lib/urn.js';
import { splitWholeNodeUrn } from '../../../lib/splitNodeUrnTolerant.js';
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { fetchWebPage } from '../../../lib/webFetch.js';
import { extractArticle } from '../../../lib/articleExtract.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { assertManualRunAllowed, mintManualRun } from './resolvers.appRun.js';
import { publishRunRequested } from '../../../jobs/appRuns.js';
import { lockInstallAuthorityFirst } from './installMemory.js';
import { type Context, requireMemoryWriteAccess, withoutRequestCaches } from './resolvers.helpers.js';

export interface ImportNodeInput {
  // Target — (memoryId + loc) XOR nodeUrn. The URN may name a
  // not-yet-existing node (import creates it), so it is SPLIT into
  // memory-URN + loc rather than resolved via resolveNodeRef.
  memoryId?: string | null;
  loc?: string | null;
  nodeUrn?: string | null;
  // Source — exactly one of:
  url?: string | null;
  content?: string | null;
  /** Default text/html (unlike createNode's markdown default) — importNode's callers hold captured/fetched HTML. */
  contentType?: string | null;
  name?: string | null;
  nodeType?: string | null;
  properties?: Record<string, unknown> | null;
  // #528 — post-import task run. When `taskRef` is set, the stored node is
  // handed to that task via a MANUAL AppRun (async; poll appRun(ref:)).
  /** Task node to run against the imported node — PK or fully-qualified URN. */
  taskRef?: string | null;
  /** Extra template args merged into the run's eventData. */
  taskArgs?: Record<string, unknown> | null;
  /** App to run under — PK or URN. Falls back to the caller's active App (ctx.appId). */
  appRef?: string | null;
  agentRef?: string | null;
}

export const importNodeMutations = {
  importNode: async (_: unknown, { input }: { input: ImportNodeInput }, ctx: Context) => {
    // ── Source dispatch: exactly one of url | content ──────────────────
    const hasUrl = input.url != null && input.url !== '';
    const hasContent = input.content != null && input.content !== '';
    if (hasUrl === hasContent) {
      throw new GraphQLError('importNode: provide exactly one of `url` or `content`.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // ── Target dispatch: (memoryId + loc) XOR nodeUrn ──────────────────
    // Empty strings normalize to absent across all three selectors so a
    // client serializing unset fields as '' gets the intended
    // BAD_USER_INPUT instead of a downstream URN-qualification error
    // (PR-486 review).
    const memoryIdIn = input.memoryId != null && input.memoryId !== '' ? input.memoryId : null;
    const locIn = input.loc != null && input.loc !== '' ? input.loc : null;
    const hasUrn = input.nodeUrn != null && input.nodeUrn !== '';
    if (hasUrn && (memoryIdIn != null || locIn != null)) {
      throw new GraphQLError(
        'importNode: identify the target by `nodeUrn` OR by `memoryId` + `loc`, not both.',
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
    if (!hasUrn && (memoryIdIn == null || locIn == null)) {
      throw new GraphQLError(
        'importNode: supply `nodeUrn` or both `memoryId` and `loc`.',
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
    let memoryId: string;
    let loc: string;
    if (hasUrn) {
      // splitNodeUrn self-validates qualification (spec 022) and returns the
      // bare memory URN — resolve that to an id here so a bad memory fails
      // before any network fetch.
      const split = splitWholeNodeUrn(input.nodeUrn as string);
      ({ id: memoryId } = await resolveMemoryRef(ctx.db, split.memoryUrn));
      loc = split.loc;
    } else {
      // Resolve here (ID-or-URN dispatch) rather than leaving it to the
      // write core: the name-preservation existence check below needs the
      // definite id, and a bad memory ref should fail before any fetch.
      ({ id: memoryId } = await resolveMemoryRef(ctx.db, memoryIdIn as string));
      loc = locIn as string;
    }

    // ── Authorize BEFORE acquiring content ─────────────────────────────
    // The write core re-checks, but the check must also run pre-fetch: an
    // unauthorized caller must not be able to use importNode as an egress /
    // resource-consumption primitive (a full 30s fetch with redirects) just
    // to be denied at the write (PR-486 review, Codex P1).
    await requireMemoryWriteAccess(ctx, memoryId);

    // ── #528 — validate the post-import task-run preconditions BEFORE the
    // fetch/write, so a bad taskRef / missing App / non-runnable task fails
    // fast without a wasted 30s fetch or an orphaned node (#531 review). The
    // run itself is minted after the write (it needs the stored node's URN).
    let taskRun: {
      entryNodeUrn: string;
      app: { id: string; organizationId: string; agentId: string | null };
      runAsSelf: boolean;
      importedMemoryUrn: string;
    } | null = null;
    if (input.taskRef != null && input.taskRef !== '') {
      const runAppRef = input.appRef ?? ctx.appId;
      if (!runAppRef) {
        throw new GraphQLError(
          'importNode: `taskRef` requires an App — pass `appRef` or call with an App context.',
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
        const { id: taskNodeId } = await resolveNodeRefForCaller(ctx, input.taskRef);
      const taskNode = await ctx.db.node.findUniqueOrThrow({
        where: { id: taskNodeId },
        select: { loc: true, isRunnable: true, memory: { select: { urn: true } } },
      });
      if (!taskNode.isRunnable) {
        throw new GraphQLError('importNode: `taskRef` must be a runnable task node.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      const entryNodeUrn = emitNodeUrnV2(taskNode.memory.urn, taskNode.loc);
      // Attribute the run to the importing user ONLY when the target is
      // owner-only (personal/private) — there the run needs the user's identity
      // to read the imported node and write back. For knowledge/app targets the
      // app can already read it, so run app-only. Resolve the class HERE
      // (pre-write) so the runAsSelf value used by the assert matches the mint
      // (#566 review): otherwise an org admin who isn't an AppMember passes the
      // pre-write check but fails at mint with RELATIONSHIP_MISSING → orphan.
      const importedMemory = await ctx.db.memory.findUniqueOrThrow({
        where: { id: memoryId },
        select: { urn: true, class: true },
      });
      const ownerOnly = importedMemory.class === 'personal' || importedMemory.class === 'private';
      const runAsSelf = ownerOnly && !!ctx.userId;
      // #533 — validate the run's full launch prerequisites (interactive gate
      // #530, App liveness, same-org entry boundary, and the on-behalf-of
      // relationship when runAsSelf) BEFORE the fetch/write, so a denied hand-off
      // never leaves an orphaned imported node. The run is minted after the
      // write (it needs the stored node's URN) via mintManualRun — WITHOUT
      // re-running the gate. mintAppRun's dynamic quota check stays at mint time.
      const app = await assertManualRunAllowed(ctx, { entryNodeUrn, appRef: runAppRef, runAsSelf, agentRef: input.agentRef });
      taskRun = { entryNodeUrn, app, runAsSelf, importedMemoryUrn: importedMemory.urn };
    }

    // ── Acquire content ────────────────────────────────────────────────
    // The url path fetches WITHOUT user credentials — authenticated pages
    // must come through the inline `content` path (issue #457 auth boundary).
    let content: string;
    let contentType: string;
    let extractedTitle: string | undefined;
    if (hasUrl) {
      const fetched = await fetchWebPage(input.url as string);
      const article = extractArticle(fetched.html, fetched.finalUrl);
      content = article?.contentHtml ?? fetched.html;
      extractedTitle = article?.title;
      contentType = 'text/html';
    } else {
      content = input.content as string;
      // Default text/html: the clipper sends captured DOM. text/markdown
      // passes through; anything else is rejected by the write seam. An
      // empty/whitespace contentType counts as unset (PR-486 review).
      contentType = input.contentType?.trim() ? input.contentType : 'text/html';
    }

    // ── Provenance + defaults ──────────────────────────────────────────
    const properties: Record<string, unknown> = { ...(input.properties ?? {}) };
    if (hasUrl && properties.url == null) {
      properties.url = input.url;
    }
    // Name policy: caller → Readability title (url path) → and only when the
    // target doesn't exist yet (a create needs the DB-non-null name), the loc
    // leaf. On a re-import of an existing node with neither, name is omitted
    // so the core's preserve-on-omit keeps the curated name instead of
    // clobbering it with a leaf fallback. The #476 write seam additionally
    // fills properties.title from the converter's extraction.
    let name: string | undefined =
      (input.name != null && input.name !== '' ? input.name : undefined) ?? extractedTitle;
    if (name === undefined) {
      const existing = await ctx.db.node.findUnique({
        where: { loc_memoryId: { loc, memoryId } },
        select: { id: true, deletedAt: true },
      });
      if (!existing || existing.deletedAt) {
        name = loc.split(':').pop() || loc;
      }
    }

    // Default nodeType by source shape: a captured web page is a 'webpage',
    // an imported PDF (a paper, statement, saved article) is plain 'info'
    // (#488). A caller-supplied nodeType always wins.
    const defaultNodeType =
      contentType.trim().toLowerCase() === 'application/pdf' ? 'info' : 'webpage';

    // ── Store (update-in-place on an existing loc) ─────────────────────
    // Mode: 'upsert' whenever a name is available (create-or-replace in one
    // call). When name is OMITTED to preserve an existing node's curated
    // name, use 'update' — Prisma validates the upsert's create payload
    // eagerly, so an upsert without the required `name` column would reject
    // even though only the update branch could run (the same constraint
    // that shaped updateNode in Phase 0).
    const store = (writeCtx: Context, transaction?: NonNullable<Parameters<typeof writeNodeCore>[3]>['transaction']) => writeNodeCore(
      {
        memoryId,
        loc,
        name,
        content,
        contentType,
        nodeType: input.nodeType ?? defaultNodeType,
        properties,
      },
      writeCtx,
      name === undefined ? 'update' : 'upsert',
      { transaction },
    );

    if (!taskRun) {
      const node = await store(ctx);
      return { node, status: 'STORED', jobId: null };
    }

    // #2737 / cor:agt:040:10: mint-time refusals (including boot serving and
    // dynamic quota) must roll back the import, its revision and run together.
    // Keep the pre-fetch assertManualRunAllowed above; never compensate with a
    // delete, which could erase a prior node or another concurrent writer.
    const launch = taskRun;
    const effects: Array<() => void> = [];
    const result = await ctx.db.$transaction(async tx => {
      // The write core's caller-owned transaction follows its normal lock order.
      await lockInstallAuthorityFirst(tx, ctx, memoryId);
      const txCtx = withoutRequestCaches(ctx, tx);
      const node = await store(txCtx, {tx, pooledDb:ctx.db, afterCommit:effect=>effects.push(effect)});
      const importedNodeUrn = emitNodeUrnV2(launch.importedMemoryUrn, node.loc);
      const run = await mintManualRun(txCtx, launch.app, {
        entryNodeUrn: launch.entryNodeUrn,
        eventData: { ...(input.taskArgs ?? {}), importedNodeUrn },
        runAsSelf: launch.runAsSelf,
      }, {publish:false});
      return { node, status: 'FETCH_PENDING', jobId: run.id };
    }, {timeout:30_000});
    // No event, git/embedding wake or run wake escapes a rolled-back import.
    // #2737: persistence has committed. An effect failure must not turn this
    // success into a retryable error or prevent another effect from running.
    for (const effect of effects) {
      try {
        await effect();
      } catch {
        console.error('[import-node] committed node effect failed');
      }
    }
    try {
      await publishRunRequested(ctx.db, result.jobId);
    } catch {
      // Defense at the commit boundary even if the publisher's own catch
      // changes later. PENDING/unpublished runs are recovered by the sweep.
      console.error('[import-node] committed run wake failed; sweep will recover');
    }
    return result;
  },
};
