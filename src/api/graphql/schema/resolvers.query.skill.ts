/**
 * #1177 §3 — the seam: the server judges, the client does I/O.
 *
 * One read surface serving `skill lint`, `skill status` and `skill export`.
 * The client sends what it can see of each file on disk; the server returns a
 * drift CLASS and the lint findings per declared node, plus the rendered body
 * for anything the client is to write.
 *
 * ## Why the class and not the inputs (A4)
 *
 * **The client cannot name a tenth class, so the vocabulary cannot drift from
 * the server's.** Same argument that made kind-specific doors right over one
 * generic door: the surface that can express a thing decides whether the thing
 * stays countable.
 *
 * ## Why a QUERY and not a mutation
 *
 * This is the design decision §7 left to the server, and §3 states the
 * property it has to buy: *"`status` writes nothing, `export` is the only
 * writer, `lint` touches no disk. The server surface should make an accidental
 * write impossible for `status`/`lint` rather than merely unlikely."*
 *
 * A mutation that promises not to write is a promise. A **query** is the
 * guarantee — nothing on this path can write a node, and A9 ("nothing here
 * writes to a node; one-way publishing") becomes structural rather than
 * observed. The only writer in the whole feature is the client's filesystem.
 *
 * ## Why the client sending file content is not a hole
 *
 * It looks like one and is not: the server never reads the caller's disk, it
 * receives what the caller chose to send. **A caller who lies about
 * `fileHash` gets a wrong class for their own file and harms nobody else.**
 *
 * ## Access
 *
 * Through the SHARED gate (`memoryAccessFilter` / `getAccessibleMemoryIds`),
 * never a bespoke one — a hand-rolled admin-or-member check drifts, and this
 * surface returns node CONTENT, which is the thing a read gate exists to
 * protect.
 */
import { GraphQLError } from 'graphql';
import { BATCH_READ_MAX_BYTES } from '../../../lib/batchRead.js';
import { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { getAccessibleMemoryIds, memoryAccessFilter } from './resolvers.helpers.js';
import { decryptNodesBatch } from '../../../lib/nodeCrypto.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { safeNodeUrnV2 } from '../../../lib/urnEmit.js';
import { isCiphertext } from '../../../lib/crypto.js';
import { recordNodeUsage, toUsageNodeRefs } from '../../../lib/usageRecorder.js';
import {
  classifyDeclaration,
  classifySkill,
  declaredSkill,
  EXPORTS_KEY,
  HOST_CLAUDE_SKILL,
  LEGACY_TOP_LEVEL_KEYS,
  lintCollisions,
  lintNode,
  pairFileToNode,
  render,
  hash,
  storedName,
  type Finding,
  type FileFacts,
  type NodeFacts,
  type SkillNode,
} from '../../../lib/skilldoc/index.js';

/** The intent decides the ACTION, never the class (§3). */
export type SkillPlanIntent = 'LINT' | 'STATUS' | 'EXPORT';

export interface SkillFileFactsInput {
  dirName: string;
  nodeId?: string | null;
  sourceUrn?: string | null;
  headerHash?: string | null;
  fileHash?: string | null;
  parseFailed?: boolean | null;
  hasExtraFrontmatter?: boolean | null;
}

export interface SkillPlanInput {
  intent: SkillPlanIntent;
  memories?: string[] | null;
  host?: string | null;
  files?: SkillFileFactsInput[] | null;
}

/**
 * The cap on declared nodes one plan may cover.
 *
 * Loud rather than truncating, matching `nodeBatch` (cor:api:040:02): a silent
 * short read here would tell a client its corpus is smaller than it is, and
 * `export --prune` acting on that answer deletes the files for the nodes the
 * read dropped. The one surface where under-reporting is destructive.
 */
const SKILL_PLAN_MAX_NODES = 500;

/**
 * The DISCOVERY predicate: a node carrying any declaration key at all.
 *
 * **Derived from the same constants the reader uses**, never hand-listed — a
 * key added to `LEGACY_TOP_LEVEL_KEYS` becomes discoverable here in the same
 * edit, so it cannot be recognised by one and missed by the other. That
 * asymmetry is worse than not supporting the key: a node the predicate skips
 * is counted in nobody's total, which is an all-clear wider than the read that
 * produced it.
 *
 * Deliberately matches the KEY's existence rather than its shape. A malformed
 * declaration must be SELECTED so `skill-declaration-malformed` can report it;
 * a predicate that required a well-formed object would hide exactly the nodes
 * that rule exists for.
 */
const DECLARATION_KEYS = [EXPORTS_KEY, ...LEGACY_TOP_LEVEL_KEYS];
const DISCOVERY_OR = DECLARATION_KEYS.map((key) => ({
  properties: { path: [key], not: Prisma.DbNull },
}));

/**
 * Aggregate ceiling on the rendered bodies one plan may return (@codex P2, PR
 * #1240).
 *
 * The count cap alone bounds nothing that matters: node content has no
 * storage-size limit, so 500 declared nodes with large bodies is a
 * multi-hundred-megabyte response the process has to decrypt, render and
 * serialize. `nodeBatch` already refuses on bytes (`BATCH_READ_MAX_BYTES`);
 * this is the same ceiling for the same reason.
 *
 * LOUD, not truncating — the same posture as the count cap and for the same
 * reason: a silently short plan tells a client its corpus is smaller than it
 * is, and `--prune` acting on that answer deletes files for the nodes the
 * read dropped.
 */
const SKILL_PLAN_MAX_BODY_BYTES = BATCH_READ_MAX_BYTES;

/** Classes whose §5 action writes a file. */
const WRITES_A_FILE = new Set(['never-exported', 'stale', 'unhashed', 'renamed']);

export const skillQueries = {
  /**
   * Judge a corpus of declared nodes against the files a client found.
   *
   * `memories` scopes the scan; omitted means every memory the caller can
   * read. `files` is what the client saw on disk — empty for `lint`, which
   * touches no disk at all.
   */
  skillPlan: async (
    _: unknown,
    { input }: { input: SkillPlanInput },
    ctx: Context,
  ) => {
    const host = input.host ?? HOST_CLAUDE_SKILL;
    if (host !== HOST_CLAUDE_SKILL) {
      // D10: a second host arrives with its RENDERER, not before it. Refusing
      // is the honest answer — accepting the argument and rendering Claude's
      // shape would hand a caller a file for a host we cannot yet write.
      throw new GraphQLError(
        `skillPlan: host "${host}" has no renderer. Only "${HOST_CLAUDE_SKILL}" is supported today (D10).`,
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }

    // ── Scope, through the shared gate ───────────────────────────────────
    const access = await memoryAccessFilter(ctx);
    let memoryIds: string[] | null = null;
    if (input.memories && input.memories.length > 0) {
      const accessible = await getAccessibleMemoryIds(ctx);
      memoryIds = [];
      for (const ref of [...new Set(input.memories)]) {
        const { id } = await resolveMemoryRef(ctx.db, ref);
        if (accessible !== null && !accessible.includes(id)) {
          // Named rather than silently dropped: a caller who asked for a
          // memory by name and got an empty plan would read it as "nothing
          // declared here", which is the same wrong answer as a short read.
          throw new GraphQLError(`skillPlan: memory "${ref}" is not accessible.`, {
            extensions: { code: 'FORBIDDEN' },
          });
        }
        memoryIds.push(id);
      }
    }

    // ── The declared population ──────────────────────────────────────────
    //
    // Read RAW through Prisma rather than through the single-node resolver:
    // that path compiles Mustache, which would blank a `{{name}}` placeholder
    // out of a body this surface exports VERBATIM (D6) — and
    // `skill-content-has-template` exists to report exactly those
    // placeholders, so reading through the compiling surface would make the
    // rule unable to see its own subject.
    //
    // NOT filtered on `isRunnable`. That looks like a free narrowing and is
    // the opposite: `skill-not-runnable` is a RULE, so a declaration sitting
    // on a node that is not runnable is precisely a case this surface must
    // report — filtering it out would make the corpus look clean by hiding
    // the nodes the rule exists for.
    // Declared is the opt-in (§4.1: "declared, not merely runnable").
    const declaredRows = await ctx.db.node.findMany({
      where: {
        deletedAt: null,
        OR: DISCOVERY_OR,
        ...(memoryIds ? { memoryId: { in: memoryIds } } : {}),
        ...access,
      } as never,
      select: {
        id: true,
        loc: true,
        content: true,
        isRunnable: true,
        properties: true,
        memoryId: true,
        memory: { select: { urn: true } },
      },
      take: SKILL_PLAN_MAX_NODES + 1,
      orderBy: [{ memoryId: 'asc' }, { loc: 'asc' }],
    });
    if (declaredRows.length > SKILL_PLAN_MAX_NODES) {
      throw new GraphQLError(
        `skillPlan: more than ${SKILL_PLAN_MAX_NODES} nodes are in scope. Narrow \`memories\`; this surface does not silently truncate.`,
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
    await decryptNodesBatch(ctx.db, declaredRows);

    // #1177 / @codex P1 on PR #1240 — LOCKED ENCRYPTED CONTENT.
    //
    // `decryptNodesBatch` leaves a node's content as CIPHERTEXT rather than
    // throwing when its encrypted memory has no active session key, so
    // callers can return partial results. Hashing, linting or rendering that
    // blob produces confident nonsense: the lint rules read an `enc:v1…`
    // string as an ordinary body, and an EXPORT plan would hand the client a
    // rendered file containing it — overwriting a perfectly good local skill
    // with ciphertext.
    //
    // §5 already has the class for "listed but unreadable": `unavailable`.
    // A locked memory is the same shape as the visibility gap it was written
    // for, so it reuses it rather than minting a tenth — and `unavailable`
    // outranks every other class, which is exactly right here: nothing below
    // it is knowable.
    const lockedIds = new Set(
      declaredRows.filter((r) => isCiphertext(r.content)).map((r) => r.id),
    );

    const skillNodes = declaredRows
      .map((r) => ({
        // NEVER hand-built. `${memory.urn}:${loc}` looks right and is wrong for
        // a memory stored in a compound or legacy spelling — and this URN is
        // what `render` writes into the provenance header, so a hand-built one
        // would either be refused by the renderer or, worse, written and
        // unresolvable. The emitter answers for both shapes.
        urn: safeNodeUrnV2(r.memory.urn, r.loc),
        loc: r.loc,
        memoryUrn: r.memory.urn,
        isRunnable: r.isRunnable === true,
        content: r.content ?? '',
        properties: r.properties,
        _id: r.id,
      }))
      // A MALFORMED declaration has no Declaration object and must still be
      // reported: the discovery predicate selected it (the key exists), so
      // dropping it here would leave it counted in nobody's total — an
      // all-clear wider than the read that produced it. `declaredSkill`
      // alone is the wrong predicate for exactly this reason.
      .filter((n) => {
        const { declaration, malformed } = classifyDeclaration(n.properties);
        return declaration !== null || malformed.length > 0;
      }) as (SkillNode & { _id: string })[];

    // ── Lint: per node, plus the corpus-wide collision rule ──────────────
    const findingsByUrn = new Map<string, Finding[]>();
    for (const n of skillNodes) {
      // No findings for a locked node. Every rule would be judging ciphertext
      // — `skill-content-empty` false, `skill-content-has-template` false —
      // and a finding asserting something about a body nobody could read is
      // worse than silence.
      findingsByUrn.set(n.urn, lockedIds.has(n._id) ? [] : lintNode(n));
    }
    for (const f of lintCollisions(skillNodes)) {
      findingsByUrn.get(f.urn)?.push(f);
    }
    const collidingUrns = new Set(
      lintCollisions(skillNodes).map((f) => f.urn),
    );

    // ── Classify against what the client saw ─────────────────────────────
    const files = input.files ?? [];
    const nodeFacts: (NodeFacts & { _id: string })[] = skillNodes.map((n) => {
      const declaration = declaredSkill(n.properties);
      const name = declaration ? storedName(declaration) : '';
      return {
        id: (n as SkillNode & { _id: string })._id,
        urn: n.urn,
        declaration,
        nodeHash: hash(n.urn, name, declaration?.description ?? '', n.content),
        collides: collidingUrns.has(n.urn),
        unavailable: lockedIds.has((n as SkillNode & { _id: string })._id),
        _id: (n as SkillNode & { _id: string })._id,
      };
    });

    const fileFor = new Map<string, FileFacts>();
    /** Directory names that paired with a node AND were selected for it. */
    const selectedDirs = new Set<string>();
    // Sorted so the selection is a property of the DATA rather than of the
    // order the client happened to walk its disk in — the same reason the
    // collision report sorts within a group.
    const sortedFiles = [...files].sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));
    for (const f of sortedFiles) {
      const facts: FileFacts = {
        dirName: f.dirName,
        headerHash: f.headerHash ?? '',
        fileHash: f.fileHash ?? '',
        headerId: f.nodeId ?? '',
        headerSource: f.sourceUrn ?? '',
        ...(f.parseFailed ? { parseFailed: true } : {}),
        ...(f.hasExtraFrontmatter ? { hasExtraFrontmatter: true } : {}),
      };
      const paired = pairFileToNode(facts, nodeFacts);
      if (!paired) continue;
      // TWO DIRECTORIES FOR ONE NODE (@codex P2, PR #1240). The naive `set`
      // overwrote, so the node was classified against whichever file happened
      // to come last and the other was silently marked paired — leaving a
      // stale copy live on disk with nothing, ever, telling `--prune` about
      // it. That is the duplicate-directory outcome §4a exists to prevent,
      // arriving through a different door.
      //
      // One node keeps ONE directory: the first by name wins, and every other
      // claimant is reported as an orphan — a file this plan will not
      // maintain, which is what an orphan IS operationally and what `--prune`
      // acts on. The class table does not name this case; reported to @Eli
      // rather than invented as a tenth class.
      if (fileFor.has(paired.urn)) continue;
      fileFor.set(paired.urn, facts);
      selectedDirs.add(f.dirName);
    }

    const entries = nodeFacts.map((nf) => {
      const verdict = classifySkill(nf, fileFor.get(nf.urn) ?? null);
      const findings = findingsByUrn.get(nf.urn) ?? [];
      const name = nf.declaration ? storedName(nf.declaration) : '';

      // A node failing lint is NEVER exported (§5.1 step 2). Structural
      // rather than advisory: the body is simply absent, so a client cannot
      // write a file the server already judged broken even by ignoring the
      // findings it was handed alongside.
      const hasError = findings.some((f) => f.severity === 'error');
      const wantsBody =
        input.intent === 'EXPORT' &&
        verdict.class !== undefined &&
        WRITES_A_FILE.has(verdict.class) &&
        !hasError;

      let renderedBody: string | null = null;
      if (wantsBody) {
        // `render` refuses a source it could not write safely (#1223); a node
        // whose URN trips that is reported as a finding-free entry with no
        // body rather than failing the whole plan for its neighbours.
        try {
          renderedBody = render(name, nf.urn, nf.declaration?.description ?? '', findContent(skillNodes, nf.urn));
        } catch {
          renderedBody = null;
        }
      }

      return {
        urn: nf.urn,
        nodeId: nf.id,
        name,
        class: verdict.class ?? null,
        parseFailure: verdict.parseFailure === true,
        movedFrom: verdict.movedFrom ?? null,
        findings,
        renderedBody,
      };
    });

    const bodyBytes = entries.reduce(
      (n, e) => n + (e.renderedBody ? Buffer.byteLength(e.renderedBody, 'utf8') : 0),
      0,
    );
    if (bodyBytes > SKILL_PLAN_MAX_BODY_BYTES) {
      throw new GraphQLError(
        `skillPlan: the rendered bodies total ${bodyBytes} bytes, over the ${SKILL_PLAN_MAX_BODY_BYTES}-byte ceiling. Narrow \`memories\`, or export in batches; this surface does not silently truncate.`,
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }

    // ── Usage: one read per node whose CONTENT leaves the server (#1061) ──
    //
    // An EXPORT entry with a body hands the caller the node's full content,
    // which is exactly what that contract counts. Recorded only for entries
    // that actually carry one — a plan that returned no body returned no
    // content, and an event naming a node nobody read is the inverse defect.
    const returnedContent = entries
      .filter((e) => e.renderedBody !== null)
      .map((e) => declaredRows.find((r) => r.id === e.nodeId))
      .filter((r): r is NonNullable<typeof r> => r != null);
    if (returnedContent.length > 0) {
      recordNodeUsage(ctx.db, 'read', toUsageNodeRefs(returnedContent), ctx);
    }

    // ── Orphans: files that paired with nothing ──────────────────────────
    const orphans = files
      .filter((f) => !selectedDirs.has(f.dirName))
      .map((f) => ({
        dirName: f.dirName,
        sourceUrn: f.sourceUrn ?? null,
        nodeId: f.nodeId ?? null,
      }));

    return {
      entries,
      orphans,
      // The POSITIVE CONTROL, on the wire. A plan over zero declared nodes and
      // a plan the caller cannot see are the same empty list, and a client
      // that cannot tell them apart reports "nothing to do" for a corpus it
      // was denied. `scanned` is what makes that distinguishable.
      scanned: declaredRows.length,
      declared: skillNodes.length,
    };
  },
};

/** The node body for a urn, read from the already-loaded set. */
function findContent(nodes: SkillNode[], urn: string): string {
  return nodes.find((n) => n.urn === urn)?.content ?? '';
}
