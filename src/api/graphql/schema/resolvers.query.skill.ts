import { withIncludeHistoryTransaction, includeHistoryClient, type IncludeHistoryTransaction } from '../../../lib/includes/includeHistoryFence.js';
import { liveTxContext, liveReadSnapshotContext } from './authorizedTx.js';
import { resolveNodeContent } from '../../../lib/includes/resolveNodeContent.js';
import { GraphQLError } from 'graphql';
import { createHash } from 'node:crypto';
import { BATCH_READ_MAX_BYTES } from '../../../lib/batchRead.js';
import { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { getAccessibleMemoryIds, memoryAccessFilter, isMemoryReadableCached } from './resolvers.helpers.js';
import { decryptNodesBatch } from '../../../lib/nodeCrypto.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveScopeRef } from '../../../lib/entityRef/scopeRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { assertFullyQualifiedUrn, splitNodeUrn } from '../../../lib/urn.js';
import { safeNodeUrnV2 } from '../../../lib/urnEmit.js';
import { isCiphertext } from '../../../lib/crypto.js';
import { canReadScope, explainScope } from '../../../lib/scopes.js';
import { recordNodeUsage, toUsageNodeRefs } from '../../../lib/usageRecorder.js';
import { reconcileNodeWithIncludeHistory } from '../../../lib/nodeRevisionSnapshot.js';
import {
  classifyDeclaration,
  classifySkill,
  declaredSkill,
  EXPORTS_KEY,
  HOST_CLAUDE_SKILL,
  LEGACY_TOP_LEVEL_KEYS,
  SKILL_HOSTS,
  skillHost,
  requireSkillHost,
  isHostReservedName,
  lintCollisions,
  lintNode,
  pairFileToNode,
  render,
  hash,
  storedName,
  unknownHostKeyFinding,
  unknownHostKeysBounded,
  unknownHostKeysOmittedFinding,
  type Finding,
  type FileFacts,
  type DriftClass,
  type NodeFacts,
  type SkillNode,
} from '../../../lib/skilldoc/index.js';

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

/** The intent decides the ACTION, never the class (§3). */
export type SkillPlanIntent = 'LINT' | 'STATUS' | 'EXPORT';

export interface SkillFileFactsInput {
  dirName: string;
  nodeId?: string | null;
  sourceUrn?: string | null;
  headerHash?: string | null;
  fileHash?: string | null;
  revision?: number | null;
  parseFailed?: boolean | null;
  hasExtraFrontmatter?: boolean | null;
}

export interface SkillPlanInput {
  intent: SkillPlanIntent;
  memories?: string[] | null;
  scopeRef?: string | null;
  host?: string | null;
  files?: SkillFileFactsInput[] | null;
  force?: boolean | null;
}

export interface SelectedSkillFilePlanInput {
  nodes: string[];
  host?: string | null;
  files?: SkillFileFactsInput[] | null;
  force?: boolean | null;
}

export interface SkillSelectionResult {
  ref: string;
  nodeId: string | null;
  action: 'FAIL' | 'SKIP';
  reason: SkillExportReason;
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
/** A selected plan fails loud if its collision census cannot finish within this bound. */
const SKILL_PLAN_MAX_COLLISION_CENSUS_NODES = 50_000;
// The census reads arbitrary JSON, so a row count alone cannot bound its
// transfer or deserialization cost. Check JSON byte size in PostgreSQL before
// fetching each page's properties.
const SKILL_PLAN_MAX_COLLISION_CENSUS_BYTES = 32 * 1024 * 1024;
// Selected metadata has the same arbitrary-JSON risk even when no declaration
// exists for the requested host and the collision census never runs.
const SKILL_PLAN_MAX_SELECTED_PROPERTIES_BYTES = SKILL_PLAN_MAX_COLLISION_CENSUS_BYTES;

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

/**
 * Bounds on the unrecognised-`exports`-key REPORT (#1292): at most this many
 * keys LISTED per node, and none longer than this many UTF-8 bytes.
 *
 * `properties` is arbitrary JSON a writer controls, and the body ceiling above
 * counts only `content`, so an unbounded report let one node carrying a huge
 * `exports` object of tiny keys make every plan build a warning per key, at
 * about 25× the stored size (@codex P1, PR #1296).
 *
 * The bound is on the report, NEVER on the plan (@copilot, PR #1296): the first
 * fix refused the whole plan past a ceiling, which made an unknown key block
 * every valid entry beside it, the one thing cor:agt:030:06 rules out. Nothing
 * is dropped silently either: `keyCount` is the true total, and every key not
 * listed is counted in one summary warning.
 *
 * Worst case, bounded: 500 nodes × 10 keys × (128 bytes listed + a warning).
 * A real node carries one stray key (the `codex` shape), so neither bound is
 * reached by data anyone meant to write.
 */
const SKILL_PLAN_UNRECOGNIZED_KEYS_LISTED = 10;
const SKILL_PLAN_UNRECOGNIZED_KEY_MAX_BYTES = 128;

/** Classes whose §5 action writes a file. */
const WRITES_A_FILE = new Set(['never-exported', 'stale', 'unhashed', 'renamed']);
const FORCEABLE_MISSING_ID_CLASSES = new Set<DriftClass>(['current', 'stale', 'unhashed', 'renamed']);

export type SkillExportAction = 'WRITE' | 'MOVE' | 'REMOVE' | 'SKIP' | 'REFUSE' | 'FAIL';

export interface SkillExportReason {
  code: string;
  message: string;
}

export interface SkillExportPlan {
  action: SkillExportAction;
  preservesExistingFile: boolean;
  reasons: SkillExportReason[];
}

/**
 * Turn the server's class + lint judgment into the export action a client may
 * perform. This is a PLAN, never a claim that local I/O happened: the server
 * cannot see the caller's filesystem after the response.
 *
 * cor:agt:030:01 / :05 make the distinctions load-bearing: a local edit is
 * REFUSED, an over-host-limit declaration is SKIPPED while preserving any
 * installed file, and an unsafe render is a FAILURE with its reason intact.
 */
function buildExportPlan(args: {
  driftClass: DriftClass | null;
  parseFailure: boolean;
  hasFile: boolean;
  targetOccupied: boolean;
  ambiguousFilesystemAlias: boolean;
  unhashedMove: boolean;
  missingProvenanceId: boolean;
  protectsLocalEdit: boolean;
  forceLocalEdit: boolean;
  forceMissingProvenance: boolean;
  forcedAction: 'WRITE' | 'MOVE' | 'REMOVE' | null;
  findings: Finding[];
  renderedBody: string | null;
  renderFailure: string | null;
}): SkillExportPlan {
  const {
    driftClass,
    parseFailure,
    hasFile,
    targetOccupied,
    ambiguousFilesystemAlias,
    unhashedMove,
    missingProvenanceId,
    protectsLocalEdit,
    forceLocalEdit,
    forceMissingProvenance,
    forcedAction,
    findings,
    renderedBody,
    renderFailure,
  } = args;
  const reason = (code: string, message: string): SkillExportReason => ({ code, message });

  if (parseFailure) {
    return {
      action: 'FAIL',
      preservesExistingFile: true,
      reasons: [
        reason(
          'parse-failed',
          'The installed skill file could not be parsed. Repair it or remove it before exporting again; this export leaves it unchanged.',
        ),
      ],
    };
  }

  if (driftClass === 'collision') {
    return {
      action: 'REFUSE',
      preservesExistingFile: true,
      reasons: [
        reason(
          'collision',
          'More than one declared node uses this skill name. The declarations need unique stored names before exporting; this export leaves existing files unchanged.',
        ),
      ],
    };
  }

  if (driftClass === 'unavailable') {
    return {
      action: 'SKIP',
      preservesExistingFile: true,
      reasons: [
        reason(
          'unavailable',
          'The declared node is not readable in this plan, so the export cannot judge or replace its installed file.',
        ),
      ],
    };
  }

  if (protectsLocalEdit && !forceLocalEdit) {
    return {
      action: 'REFUSE',
      preservesExistingFile: true,
      reasons: [
        reason(
          'locally-edited',
          'The installed skill has local edits. This export preserves it; use an explicit one-invocation override only if replacing it is intended.',
        ),
      ],
    };
  }

  const blockingFindings = findings.filter((finding) => finding.severity === 'error');
  // Lint is the export gate even when no write would otherwise be needed, and
  // even when the declaration is disabled. A blocked entry always preserves
  // its installed file; it cannot quietly become a prune instruction.
  if (blockingFindings.length > 0) {
    return {
      action: 'SKIP',
      preservesExistingFile: true,
      reasons: blockingFindings.map((finding) => reason(finding.rule, finding.message)),
    };
  }

  if (driftClass === 'disabled') {
    return {
      action: hasFile ? 'REMOVE' : 'SKIP',
      preservesExistingFile: !hasFile,
      reasons: [
        reason(
          'disabled',
          hasFile
            ? 'The declaration is disabled for this host, so the client should remove its generated file.'
            : 'The declaration is disabled for this host and has no installed file to remove.',
        ),
      ],
    };
  }

  // cor:agt:030:01: a file without the stable node id is paired only through
  // its mutable source URN. Preserve it by default even when its hash is
  // current; an explicit one-invocation override is required to regenerate
  // it or move it to a renamed declaration. Disabled removal is deliberately
  // handled above, after the local-edit guard: disabling generated output is
  // actionable without force, but never erases evidence of a hand edit.
  if (missingProvenanceId && !forceMissingProvenance && !forceLocalEdit) {
    return {
      action: 'SKIP',
      preservesExistingFile: true,
      reasons: [
        reason(
          'missing-node-id',
          'The installed skill has no provenance node id. This export preserves it; use an explicit one-invocation override only if replacing or moving it is intended.',
        ),
      ],
    };
  }

  if (driftClass === 'current' && !forceMissingProvenance) {
    return {
      action: 'SKIP',
      preservesExistingFile: true,
      reasons: [reason('current', 'The installed skill already matches the source node.')],
    };
  }

  // The server cannot know whether the caller's filesystem is case-sensitive.
  // A raw rename that normalizes to the same path would need MOVE on one host
  // and in-place WRITE on another; either universal answer can delete or
  // duplicate a skill. Refuse the ambiguous write and leave the paired source
  // named so the client/user can resolve it with local filesystem knowledge.
  if (ambiguousFilesystemAlias) {
    return {
      action: 'REFUSE',
      preservesExistingFile: true,
      reasons: [
        reason(
          'filesystem-alias-ambiguous',
          'The source and target names may identify the same directory on this filesystem. Resolve the case or Unicode-only rename locally before exporting.',
        ),
      ],
    };
  }

  if (renderFailure !== null) {
    return {
      action: 'FAIL',
      preservesExistingFile: true,
      reasons: [reason('render-failed', renderFailure)],
    };
  }

  // Occupancy matters only when the action writes the destination. A forced
  // REMOVE touches the paired source file and must not be blocked by an
  // unrelated orphan at the declaration's (possibly renamed) target.
  if (targetOccupied && forcedAction !== 'REMOVE') {
    return {
      action: 'REFUSE',
      preservesExistingFile: true,
      reasons: [
        reason(
          'target-occupied',
          'An installed directory already occupies this skill name. This export leaves existing files unchanged.',
        ),
      ],
    };
  }

  if ((forceLocalEdit || forceMissingProvenance) && forcedAction !== null) {
    if (forcedAction !== 'REMOVE' && renderedBody === null) {
      return {
        action: 'FAIL',
        preservesExistingFile: true,
        reasons: [reason('export-action-unresolved', 'The explicit override could not produce a safe replacement body.')],
      };
    }
    return {
      action: forcedAction,
      preservesExistingFile: false,
      reasons: [
        reason(
          forceLocalEdit ? 'locally-edited-override' : 'missing-node-id-override',
          forceLocalEdit
            ? 'This invocation explicitly overrides the local edit; the client may apply the planned replacement, move, or removal.'
            : 'This invocation explicitly overrides the missing provenance node id; the client may apply the planned replacement or move.',
        ),
      ],
    };
  }

  if (driftClass === 'renamed' && renderedBody !== null) {
    return {
      action: 'MOVE',
      preservesExistingFile: false,
      reasons: [reason('renamed', 'The stored skill name changed; write the rendered file at the new name and remove the old generated file.')],
    };
  }

  if (
    (driftClass === 'never-exported' || driftClass === 'stale' || driftClass === 'unhashed') &&
    renderedBody !== null
  ) {
    return {
      action: driftClass === 'unhashed' && unhashedMove ? 'MOVE' : 'WRITE',
      preservesExistingFile: false,
      reasons: [
        reason(
          driftClass,
          driftClass === 'never-exported'
            ? 'No installed skill exists for this declaration.'
            : driftClass === 'stale'
              ? 'The source node changed after the installed skill was generated.'
              : 'The installed skill uses a legacy provenance header and should be regenerated.',
        ),
      ],
    };
  }

  // Defensive and loud: every Classification state is handled above. If a
  // future class is added without an export policy, clients preserve the file
  // and receive a reason instead of guessing an action.
  return {
    action: 'FAIL',
    preservesExistingFile: true,
    reasons: [
      reason(
        'export-action-unresolved',
        `The server could not derive a safe export action for class ${JSON.stringify(driftClass)}.`,
      ),
    ],
  };
}

/** The existing plugin/unscoped plan and the selected individual-file plan share judgment. */
async function planSkills(input: SkillPlanInput, ctx: Context, selectedRefs?: string[]) {
    // Plugin EXPORT is narrowed by a persisted Scope, never by a caller's
    // hand-picked memory IDs (cor:agt:030:03). An explicit [] is still an
    // attempted memory selector and must not silently become an unscoped plan.
    if (input.intent === 'EXPORT' && Object.prototype.hasOwnProperty.call(input, 'memories')) {
      throw new GraphQLError('skillPlan: EXPORT cannot select memories; use scopeRef.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    let requestedScopeRef: string | null = null;
    if (Object.prototype.hasOwnProperty.call(input, 'scopeRef')) {
      if (input.intent !== 'EXPORT') {
        throw new GraphQLError('skillPlan: scopeRef is valid only with EXPORT intent.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      // A supplied null is a failed narrowing request, not omission. Treating
      // it as unscoped would hand an EXPORT every readable task (Chip, #1427).
      if (typeof input.scopeRef !== 'string' || input.scopeRef.trim() === '') {
        throw new GraphQLError('skillPlan: scope unavailable.', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      requestedScopeRef = input.scopeRef;
    }
    if (selectedRefs !== undefined) {
      if (selectedRefs.length === 0 || selectedRefs.length > SKILL_PLAN_MAX_NODES) {
        throw new GraphQLError(`selectedSkillFilePlan: nodes must contain 1–${SKILL_PLAN_MAX_NODES} refs.`, {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      for (const ref of selectedRefs) {
        try {
          if (!isId(ref)) {
            assertFullyQualifiedUrn(ref, 'node');
            if (splitNodeUrn(ref).fragment) throw new Error('Node fragments do not name a skill source.');
          }
        } catch {
          throw new GraphQLError('selectedSkillFilePlan: each node must be an ID or fully qualified node URN.', {
            extensions: { code: 'BAD_USER_INPUT' },
          });
        }
      }
    }
    if (input.force === true && input.intent !== 'EXPORT') {
      throw new GraphQLError('skillPlan: force is valid only with EXPORT intent.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    // #1254: every host in the registry is plannable, one per call. There is
    // one renderer; what differs per host is the declaration it reads (its
    // name, description and enable) and the host's limits, both of which
    // the skilldoc library takes from `host`.
    //
    // An unknown host is REFUSED, never judged as Claude and never answered
    // with an empty plan (hadron-cli#622 matrix, P02). An empty plan would
    // read as "nothing is declared for this host", and a client acting on it
    // with --prune deletes that host's files. `codex`, the spelling the
    // portal first shipped, is the case that makes this concrete.
    const host = input.host ?? HOST_CLAUDE_SKILL;
    if (skillHost(host) === null) {
      throw new GraphQLError(
        `skillPlan: unknown skill host "${host}". Supported hosts: ${SKILL_HOSTS.map((h) => `"${h.key}"`).join(', ')}.`,
        { extensions: { code: 'BAD_USER_INPUT', host, supportedHosts: SKILL_HOSTS.map((h) => h.key) } },
      );
    }

    // ── Scope, through the shared gate ───────────────────────────────────
    const access = await memoryAccessFilter(ctx);
    const selectionResults: SkillSelectionResult[] = [];
    const selectedIdToRef = new Map<string, string>();
    if (selectedRefs !== undefined) {
      const unavailable = new Set<string>();
      for (const ref of selectedRefs) {
        let id: string;
        try {
          ({ id } = await resolveNodeRef(ctx.db, ref));
        } catch (error) {
          if (!(error instanceof NodeNotFoundError)) throw error;
          unavailable.add(ref);
          continue;
        }
        // The resolver above is identity lookup, not an access gate. Apply the
        // same shared predicate as the declared scan, and conceal missing and
        // unreadable refs with one outward result (cor:api:140:03).
        const readable = await ctx.db.node.findFirst({
          where: { id, deletedAt: null, memory: { deletedAt: null }, AND: [access] } as never,
          select: { id: true },
        });
        if (!readable) {
          unavailable.add(ref);
          continue;
        }
        if (!selectedIdToRef.has(id)) selectedIdToRef.set(id, ref);
      }
      for (const ref of unavailable) {
        selectionResults.push({
          ref, nodeId: null, action: 'FAIL',
          reason: { code: 'node-unavailable', message: 'The named task is unavailable.' },
        });
      }
    }
    let memoryIds: string[] | null = null;
    let scopeSelection: {
      id: string;
      name: string;
      readableMemoryCount: number;
      droppedCount: number;
      fingerprint: string;
    } | null = null;
    if (requestedScopeRef !== null) {
      // Scope identity crosses the wire; membership is always re-resolved
      // through the shared Scope gate and canonical materialized access set.
      // The same ordered set and fingerprint applies to every host, which the
      // client compares before writing a multi-host artifact.
      let scopeId: string;
      try {
        ({ id: scopeId } = await resolveScopeRef(ctx.db, requestedScopeRef));
      } catch {
        throw new GraphQLError('skillPlan: scope unavailable.', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      const scope = await ctx.db.scope.findFirst({ where: { id: scopeId, deletedAt: null } });
      if (!scope || !(await canReadScope(ctx, scope))) {
        throw new GraphQLError('skillPlan: scope unavailable.', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      const explained = await explainScope(ctx, scope.id);
      if (explained.memoryIds.length === 0) {
        throw new GraphQLError('skillPlan: scope has no readable memories.', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      memoryIds = explained.memoryIds;
      scopeSelection = {
        id: scope.id,
        name: scope.name,
        readableMemoryCount: memoryIds.length,
        droppedCount: explained.droppedCount,
        fingerprint: createHash('sha256')
          .update(JSON.stringify([scope.id, scope.name, memoryIds, explained.droppedCount]))
          .digest('hex'),
      };
    }
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
    const declaredWhere = {
        deletedAt: null,
        ...(selectedRefs === undefined ? { OR: DISCOVERY_OR } : {}),
        // INTERSECTED, not spread (@copilot, PR #1240). `memoryAccessFilter`
        // returns `{ memoryId: { in: … } }`, so spreading it beside the
        // requested scope made the LAST key win and silently dropped the
        // caller's narrowing: ask for memory A, get every memory you can read.
        // Not a leak — the caller could read them anyway — but a plan wider
        // than the one asked for, which a client running `--prune` against a
        // single memory would act on for files it never meant to touch.
        AND: [
          access,
          ...(memoryIds ? [{ memoryId: { in: memoryIds } }] : []),
          ...(selectedRefs !== undefined ? [{ id: { in: [...selectedIdToRef.keys()] } }, { memory: { deletedAt: null } }] : []),
        ],
    } as never;
    const declaredSelect = {
        id: true,
        loc: true,
        // #1292: only `unrecognized` reads it, so an item for a node with no
        // entry anywhere can still be labelled by name rather than by URN.
        name: true,
        content: true,
        isRunnable: true,
        properties: true,
        memoryId: true,
        memory: { select: { urn: true } },
        revSeq: true,
    } as const;
    const { content: _content, ...declaredMetadataSelect } = declaredSelect;
    const narrowHint = input.intent === 'EXPORT' ? 'Choose a smaller scope' : 'Narrow `memories`';
    const candidateOrder = [{ memoryId: 'asc' }, { loc: 'asc' }] as const;
    const candidates = selectedRefs === undefined
      ? await ctx.db.node.findMany({
          where: declaredWhere,
          select: declaredMetadataSelect,
          take: SKILL_PLAN_MAX_NODES + 1,
          orderBy: [...candidateOrder],
        })
      : await ctx.db.$transaction(async (tx) => {
          // A metadata-only Prisma select still transfers the entire JSON
          // value. Read gated IDs first, check bytes in PostgreSQL, then read
          // properties from the same snapshot so no row can grow past the cap
          // between the check and deserialization.
          const ids = await tx.node.findMany({
            where: declaredWhere,
            select: { id: true },
            take: SKILL_PLAN_MAX_NODES + 1,
            orderBy: [...candidateOrder],
          });
          if (ids.length === 0) return [];
          if (ids.length > SKILL_PLAN_MAX_NODES) {
            throw new GraphQLError(`selectedSkillFilePlan: more than ${SKILL_PLAN_MAX_NODES} nodes are in scope.`, {
              extensions: { code: 'BAD_USER_INPUT' },
            });
          }
          const candidateIds = ids.map((row) => row.id);
          const sizes = await tx.$queryRaw<{ bytes: bigint }[]>`
            SELECT COALESCE(SUM(octet_length(properties::text)), 0)::bigint AS bytes
            FROM nodes WHERE id IN (${Prisma.join(candidateIds)})
          `;
          if ((sizes[0]?.bytes ?? 0n) > BigInt(SKILL_PLAN_MAX_SELECTED_PROPERTIES_BYTES)) {
            throw new GraphQLError('selectedSkillFilePlan: selected task properties exceed the safe byte ceiling.', {
              extensions: { code: 'BAD_USER_INPUT' },
            });
          }
          return tx.node.findMany({
            where: { AND: [declaredWhere, { id: { in: candidateIds } }] } as never,
            select: declaredMetadataSelect,
            orderBy: [...candidateOrder],
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    if (candidates.length > SKILL_PLAN_MAX_NODES) {
      throw new GraphQLError(
        `skillPlan: more than ${SKILL_PLAN_MAX_NODES} nodes are in scope. ${narrowHint}; this surface does not silently truncate.`,
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
    let declaredRows: Prisma.NodeGetPayload<{ select: typeof declaredSelect }>[] = [];
    if (candidates.length > 0) {
      // Unchanged reads size, authorize and project in one read-only RR
      // snapshot. Only drift enters the outer history fence; its RC callback
      // rechecks credentials, authority and expected memory after any wait.
      const liveRows: typeof declaredRows = [];
      let liveMetadataBytes = 0n;
      const candidateMemory = new Map(candidates.map((r) => [r.id, r.memoryId]));
      for (const id of candidates.map((r) => r.id).sort()) {
        const readProjection = async (tx: Prisma.TransactionClient, history?: IncludeHistoryTransaction) => {
          const fresh = await (history ? liveTxContext : liveReadSnapshotContext)(ctx, tx);
          if (!(await isMemoryReadableCached(fresh, candidateMemory.get(id)!))) return null;
          if (selectedRefs !== undefined) {
            // The drift path is RC after the outer fence: hold the row
            // across sizing/projection. The fast path's RR snapshot needs
            // no row lock, including the metadata-only SKIP projection.
            if (history) {
              const locked = await tx.$queryRaw<Array<{ id: string }>>`
                SELECT id FROM nodes WHERE id = ${id} AND memory_id = ${candidateMemory.get(id)!}
                  AND deleted_at IS NULL FOR UPDATE`;
              if (locked.length !== 1) return null;
            }
            // A named task may have no declaration for this host. Recheck
            // access, then bound the live JSON before deserializing it. A
            // writer can enlarge properties after the candidate snapshot;
            // The RR snapshot or slow-path row lock keeps size and fetch coherent.
            const authorized = await tx.node.findFirst({
              where: { AND: [declaredWhere, { id }] } as never,
              select: { id: true },
            });
            if (authorized === null) return null;
            const sizes = await tx.$queryRaw<{ bytes: bigint }[]>`
              SELECT COALESCE(octet_length(properties::text), 0)::bigint AS bytes
              FROM nodes WHERE id = ${id}
            `;
            const nextBytes = liveMetadataBytes + (sizes[0]?.bytes ?? 0n);
            if (nextBytes > BigInt(SKILL_PLAN_MAX_SELECTED_PROPERTIES_BYTES)) {
              throw new GraphQLError('selectedSkillFilePlan: selected task properties exceed the safe byte ceiling.', {
                extensions: { code: 'BAD_USER_INPUT' },
              });
            }
            liveMetadataBytes = nextBytes;
            // The SKIP needs metadata only, even for a very large body.
            const metadata = await tx.node.findFirst({
              where: { AND: [declaredWhere, { id }] } as never,
              select: declaredMetadataSelect,
            });
            if (metadata === null) return null;
            const { declaration, malformed } = classifyDeclaration(metadata.properties, host);
            if (declaration === null && malformed.length === 0) {
              return { ...metadata, content: null };
            }
          }
          // Never reconcile a row that left the memory it was discovered in
          // (@codex P1, PR #1339) — the refetch below would drop it anyway,
          // but only after a revision had been written into another tenant.
          if (history && (await reconcileNodeWithIncludeHistory(history, id, { expectedMemoryId: candidateMemory.get(id)! })) == null) return null;
          return tx.node.findFirst({
            // Reapply BOTH discovery and access/scope predicates after
            // waiting for the lock. The id can move into another tenant's
            // memory while we wait; id-only here would turn the locked
            // refetch into a cross-tenant content read.
            where: { AND: [declaredWhere, { id }] } as never,
            select: declaredSelect,
          });
        };
        const fast = await ctx.db.$transaction(async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          const [row] = await tx.$queryRaw<Array<{ unchanged: boolean }>>`
            SELECT revision_content_hash IS NOT NULL
              AND revision_content_hash = hadron_node_revision_state_hash(n) AS unchanged
            FROM nodes n WHERE id = ${id} AND memory_id = ${candidateMemory.get(id)!}
              AND deleted_at IS NULL`;
          if (!row) return { drift: false as const, value: null };
          if (!row.unchanged) return { drift: true as const };
          return { drift: false as const, value: await readProjection(tx) };
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: 60_000,
          maxWait: 15_000,
        });
        const live = fast.drift
          ? await withIncludeHistoryTransaction(ctx.db,
            (history) => readProjection(includeHistoryClient(history), history),
            { timeoutMs: 60_000, maxWaitMs: 15_000 })
          : fast.value;
        if (live != null) liveRows.push(live);
      }
      declaredRows = liveRows.sort(
        (a, b) => a.memoryId.localeCompare(b.memoryId) || a.loc.localeCompare(b.loc),
      );
    }
    if (selectedRefs !== undefined) {
      const liveIds = new Set(declaredRows.map((r) => r.id));
      for (const [id, ref] of selectedIdToRef) {
        if (!liveIds.has(id)) {
          selectionResults.push({
            ref, nodeId: null, action: 'FAIL',
            reason: { code: 'node-unavailable', message: 'The named task is unavailable.' },
          });
        }
      }
      for (const row of declaredRows) {
        const { declaration, malformed } = classifyDeclaration(row.properties, host);
        if (declaration === null && malformed.length === 0) {
          selectionResults.push({
            ref: selectedIdToRef.get(row.id)!, nodeId: row.id, action: 'SKIP',
            reason: { code: 'host-not-declared', message: 'This task has no declaration for this host; its installed files are unchanged.' },
          });
        }
      }
    }
    // A selected node with no declaration for this host is a reported no-op.
    // Keep it in the scanned population and metadata reports, but its body is
    // outside this export. In particular, it must not consume the decryption
    // work or content-byte budget for the selected host.
    const actionableRows = selectedRefs === undefined
      ? declaredRows
      : declaredRows.filter((row) => {
          const { declaration, malformed } = classifyDeclaration(row.properties, host);
          return declaration !== null || malformed.length > 0;
        });
    await decryptNodesBatch(ctx.db, actionableRows);

    // The byte ceiling belongs HERE, not on the response (@copilot, PR #1240).
    // Capping only the rendered bodies left LINT and STATUS with no byte limit
    // at all — they return no body, and 500 arbitrarily large nodes are still
    // decrypted, hashed and linted first. The cost is paid at load, so the
    // refusal belongs at load, and it applies to every intent.
    const loadedBytes = actionableRows.reduce(
      (n, r) => n + (r.content ? Buffer.byteLength(r.content, 'utf8') : 0),
      0,
    );
    if (loadedBytes > SKILL_PLAN_MAX_BODY_BYTES) {
      throw new GraphQLError(
        `skillPlan: the nodes in scope carry ${loadedBytes} bytes of content, over the ${SKILL_PLAN_MAX_BODY_BYTES}-byte ceiling. ${narrowHint}, or work in batches; this surface does not silently truncate.`,
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }

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
      actionableRows.filter((r) => isCiphertext(r.content)).map((r) => r.id),
    );

    const skillNodes = actionableRows
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
        revSeq: r.revSeq,
        _id: r.id,
      }))
      // A MALFORMED declaration has no Declaration object and must still be
      // reported: the discovery predicate selected it (the key exists), so
      // dropping it here would leave it counted in nobody's total — an
      // all-clear wider than the read that produced it. `declaredSkill`
      // alone is the wrong predicate for exactly this reason.
      .filter((n) => {
        const { declaration, malformed } = classifyDeclaration(n.properties, host);
        return declaration !== null || malformed.length > 0;
    }) as (SkillNode & { _id: string; revSeq: number })[];

    // cor:dmo:150:03 (R9): an export reads like any reader, so its body is the
    // node's text with include tags resolved by the EXPORTER's access; `{{var}}`
    // stays verbatim (mode 'includes'). Lint keeps judging the stored text, and
    // the hash below covers the body actually exported, so a changed include
    // target reads as a stale file rather than an up-to-date one.
    const rowById = new Map(actionableRows.map((r) => [r.id, r]));
    const exportBodies = new Map<string, string>();
    for (const n of skillNodes) {
      const row = rowById.get(n._id);
      if (!row || lockedIds.has(n._id) || !row.content) continue;
      exportBodies.set(n._id, (await resolveNodeContent(ctx, row, { mode: 'includes' })) ?? '');
    }
    const bodyOf = (n: { _id: string; content: string }) => exportBodies.get(n._id) ?? n.content;

    // ── Lint: per node, plus the corpus-wide collision rule ──────────────
    // Keyed by node ID, never URN: two DIFFERENT nodes can emit one URN (the
    // emitter flattens a compound memory), and a URN key made them share a
    // file, a body and findings — a `set` even dropped one twin's lint errors
    // (#1310, @codex P1). The same holds for every per-node map below.
    const findingsById = new Map<string, Finding[]>();
    for (const n of skillNodes) {
      // No findings for a locked node. Every rule would be judging ciphertext
      // — `skill-content-empty` false, `skill-content-has-template` false —
      // and a finding asserting something about a body nobody could read is
      // worse than silence.
      findingsById.set(n._id, lockedIds.has(n._id) ? [] : lintNode(n, host));
    }
    // Per host: one name on a node's Claude and Codex declarations is by
    // design, and two nodes sharing a Codex name collide only for Codex.
    const collisions = selectedRefs === undefined
      ? lintCollisions(skillNodes, host)
      : await selectedFileCollisions(ctx, access, skillNodes, host);
    // A collision finding names its node by URN AND memory (lint sets
    // `memory: node.memoryUrn`). The URN alone can name two nodes; within one
    // memory it cannot, so the pair is exact. Attaching by URN alone handed a
    // twin with a UNIQUE name another node's collision, refusing its export
    // (@copilot, #1310 round 3).
    const collidingIds = new Set<string>();
    for (const f of collisions) {
      for (const n of skillNodes) {
        if (n.urn !== f.urn || n.memoryUrn !== f.memory) continue;
        findingsById.get(n._id)?.push(f);
        collidingIds.add(n._id);
      }
    }

    // ── Classify against what the client saw ─────────────────────────────
    const files = input.files ?? [];
    const nodeFacts: (NodeFacts & { _id: string })[] = skillNodes.map((n) => {
      const declaration = declaredSkill(n.properties, host);
      const name = declaration ? storedName(declaration) : '';
      return {
        id: (n as SkillNode & { _id: string })._id,
        urn: n.urn,
        // Identity for no-id pairing (#1309) — the stored memory URN and loc,
        // not `urn`, which is lossy for a compound memory.
        memoryUrn: n.memoryUrn,
        loc: n.loc,
        declaration,
        // #1235 §4a: the node's id leads the hash, so a file re-pointed at a
        // different node by a header edit reads as locally-edited rather than
        // as stale-and-overwritable.
        nodeHash: hash(
          (n as SkillNode & { _id: string })._id,
          n.urn,
          name,
          declaration?.description ?? '',
          bodyOf(n as SkillNode & { _id: string }),
        ),
        revision: n.revSeq,
        collides: collidingIds.has((n as SkillNode & { _id: string })._id),
        unavailable: lockedIds.has((n as SkillNode & { _id: string })._id),
        _id: (n as SkillNode & { _id: string })._id,
      };
    });

    const fileFor = new Map<string, FileFacts>();
    const duplicateSelectedFiles = new Set<string>();
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
        ...(typeof f.revision === 'number' ? { headerRevision: f.revision } : {}),
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
      // One node keeps ONE directory: the first by name wins. An unscoped
      // plan reports every other claimant as an orphan; narrowed plans skip
      // orphan assessment, so they must REFUSE the in-scope node instead of
      // silently hiding its duplicate. The class table does not name this
      // case; reported to @Eli rather than invented as a tenth class.
      if (fileFor.has(paired.id)) {
        if (selectedRefs !== undefined || scopeSelection !== null) duplicateSelectedFiles.add(paired.id);
        continue;
      }
      fileFor.set(paired.id, facts);
      selectedDirs.add(f.dirName);
    }
    // A plan can be executed on macOS's default case-insensitive filesystem.
    // Plain lowercasing is not Unicode case folding (`ſkill` can alias
    // `skill` while remaining unchanged by toLowerCase). ICU search collation
    // covers those compatibility/case aliases and normalization differences.
    // Base sensitivity is deliberately conservative: an occasional refusal
    // for distinct names is safer than returning a destructive WRITE/MOVE.
    const filesystemNameCollator = new Intl.Collator('und', { usage: 'search', sensitivity: 'base' });
    const filesystemNamesEquivalent = (left: string, right: string): boolean =>
      filesystemNameCollator.compare(left, right) === 0;

    const entries = nodeFacts.map((nf) => {
      const selectedFile = fileFor.get(nf.id) ?? null;
      const verdict = classifySkill(nf, selectedFile);
      const findings = findingsById.get(nf.id) ?? [];
      const name = nf.declaration ? storedName(nf.declaration) : '';
      const selectedOccupiesTarget =
        selectedFile !== null && filesystemNamesEquivalent(selectedFile.dirName, name);
      const ambiguousFilesystemAlias =
        selectedFile !== null && selectedFile.dirName !== name && selectedOccupiesTarget;
      const targetOccupants =
        name === '' ? 0 : files.filter((file) => filesystemNamesEquivalent(file.dirName, name)).length;
      const targetOccupied = targetOccupants > (selectedOccupiesTarget ? 1 : 0);
      // A legacy unhashed file cannot prove that its body stayed unchanged,
      // but extra frontmatter is still direct evidence of a local edit. Keep
      // the historical `unhashed` class while giving it the same overwrite
      // protection and explicit one-invocation override as hashed edits.
      const protectsLocalEdit =
        verdict.class === 'locally-edited' ||
        (selectedFile?.headerHash === '' && selectedFile.hasExtraFrontmatter === true);
      const missingProvenanceId = selectedFile !== null && selectedFile.headerId === '';
      // `force` may override an actionable local edit, but it must never turn
      // an unavailable/colliding source into a renderable one. In particular,
      // an encrypted node without a session key still contains ciphertext.
      const forceEligibleClass =
        verdict.class === 'locally-edited' || verdict.class === 'unhashed' || verdict.class === 'disabled';
      const forceLocalEdit = input.force === true && protectsLocalEdit && forceEligibleClass;
      const forceMissingProvenance =
        input.force === true &&
        missingProvenanceId &&
        !protectsLocalEdit &&
        verdict.class !== undefined &&
        FORCEABLE_MISSING_ID_CLASSES.has(verdict.class);
      const forcedAction = forceLocalEdit || forceMissingProvenance
        ? nf.declaration?.enable !== true
          ? 'REMOVE' as const
          : selectedFile !== null && !filesystemNamesEquivalent(selectedFile.dirName, name)
            ? 'MOVE' as const
            : 'WRITE' as const
        : null;

      // A node failing lint is NEVER exported (§5.1 step 2). Structural
      // rather than advisory: the body is simply absent, so a client cannot
      // write a file the server already judged broken even by ignoring the
      // findings it was handed alongside.
      const hasError = findings.some((f) => f.severity === 'error');
      const wantsBody =
        input.intent === 'EXPORT' &&
        verdict.class !== undefined &&
        ((WRITES_A_FILE.has(verdict.class) && !protectsLocalEdit && !missingProvenanceId) ||
          ((forceLocalEdit || forceMissingProvenance) && forcedAction !== 'REMOVE')) &&
        !hasError &&
        !duplicateSelectedFiles.has(nf.id) &&
        !ambiguousFilesystemAlias &&
        !targetOccupied;

      let renderedBody: string | null = null;
      let renderFailure: string | null = null;
      if (wantsBody) {
        // `render` refuses a source it could not write safely (#1223); a node
        // whose URN trips that is reported as a finding-free entry with no
        // body rather than failing the whole plan for its neighbours.
        try {
          renderedBody = render(
            nf.id,
            name,
            nf.urn,
            nf.declaration?.description ?? '',
            exportBodies.get(nf.id) ?? findContent(skillNodes, nf.id),
            nf.revision,
          );
        } catch (error) {
          renderedBody = null;
          renderFailure =
            error instanceof Error ? error.message : 'The skill renderer failed with a non-Error value.';
        }
      }

      const exportPlan =
        input.intent === 'EXPORT'
          ? duplicateSelectedFiles.has(nf.id)
            ? {
                action: 'REFUSE' as const,
                preservesExistingFile: true,
                reasons: [{
                  code: 'multiple-installed-files',
                  message: 'More than one installed directory names this task. Resolve the duplicates before exporting; this plan changes neither file.',
                }],
              }
            : buildExportPlan({
              driftClass: verdict.class ?? null,
              parseFailure: verdict.parseFailure === true,
              hasFile: selectedFile !== null,
              targetOccupied,
              ambiguousFilesystemAlias,
              unhashedMove:
                verdict.class === 'unhashed' &&
                selectedFile !== null &&
                selectedFile.dirName !== name &&
                !selectedOccupiesTarget,
              missingProvenanceId,
              protectsLocalEdit,
              forceLocalEdit,
              forceMissingProvenance,
              forcedAction,
              findings,
              renderedBody,
              renderFailure,
            })
          : null;

      // The out-of-export report describes the source's export eligibility,
      // independently of the filesystem action. In particular, an installed
      // file can still be current or locally edited while its enabled source
      // is blocked by lint. Only an attempted render can expose a render
      // failure; a protected file never gets rendered speculatively.
      const outOfExportReason =
        input.intent !== 'LINT' && nf.declaration?.enable === true && verdict.class !== 'unavailable'
          ? findings
              .filter((finding) => finding.severity === 'error' && finding.rule !== 'skill-name-collision')
              .map((finding) => finding.message)
              .join('; ') || renderFailure
          : null;

      return {
        urn: nf.urn,
        nodeId: nf.id,
        revision: nf.revision,
        name,
        class: verdict.class ?? null,
        parseFailure: verdict.parseFailure === true,
        // Forced MOVE/REMOVE actions are selected by the planner rather than
        // by classifySkill, so their source directory comes from the paired
        // file. Clients must not have to reproduce server pairing policy to
        // execute the server-owned action.
        movedFrom:
          exportPlan?.action === 'MOVE' || exportPlan?.action === 'REMOVE'
            ? selectedFile?.dirName ?? verdict.movedFrom ?? null
            : exportPlan?.action === 'WRITE' && verdict.class === 'renamed'
              ? null
              : verdict.movedFrom ?? null,
        findings,
        renderedBody,
        exportPlan,
        outOfExportReason,
      };
    });

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

    // ── Unrecognised exports keys (#1292) ────────────────────────────────
    //
    // Over EVERY scanned row, not `skillNodes`: a node declaring only an
    // unknown key has no declaration for this host and so no entry, which is
    // exactly the node this report exists for (a portal cannot find it by
    // scanning page rows, which are capped). Host-independent, so identical
    // in every host's plan. Judges `properties` only, which is never
    // encrypted, so a locked memory's node is still reported truthfully.
    const unrecognized = declaredRows
      .map((r) => {
        // Bounded SELECTION, not sort-then-slice: never sorts the full,
        // writer-controlled key list (@copilot, PR #1296).
        const { total, keys } = unknownHostKeysBounded(
          r.properties,
          SKILL_PLAN_UNRECOGNIZED_KEYS_LISTED,
          SKILL_PLAN_UNRECOGNIZED_KEY_MAX_BYTES,
        );
        if (total === 0) return null;
        const urn = safeNodeUrnV2(r.memory.urn, r.loc);
        const node = {
          urn,
          loc: r.loc,
          memoryUrn: r.memory.urn,
          isRunnable: r.isRunnable === true,
          content: '',
          properties: r.properties,
        };
        // Bounded LISTING, never a refusal and never a silent drop: see
        // SKILL_PLAN_UNRECOGNIZED_KEYS_LISTED.
        const omitted = total - keys.length;
        return {
          urn,
          nodeId: r.id,
          name: r.name,
          memory: r.memory.urn,
          keyCount: total,
          keys,
          findings: [
            ...keys.map((k) => unknownHostKeyFinding(node, k)),
            ...(omitted > 0 ? [unknownHostKeysOmittedFinding(node, omitted)] : []),
          ],
        };
      })
      .filter((u): u is NonNullable<typeof u> => u !== null);

    // ── Orphans: files that paired with nothing ──────────────────────────
    //
    // Never a HOST-RESERVED directory (#1315): that folder is the host's (Claude
    // Code keeps claude.ai-synced skills in `synced/`), so `--prune` — which acts
    // on this list — must not be offered it. Without this the plan said both
    // "preserve" (the reserved-name entry) and "prune" about one directory
    // (@codex P1, PR #1318). Matched by filesystem equivalence, not `toLowerCase`
    // (`isHostReservedName`; @copilot, PR #1318): an alias of the name is the same directory.
    const hostRow = requireSkillHost(host);
    const orphanAssessmentSkipped = selectedRefs !== undefined || scopeSelection !== null;
    const orphans = (orphanAssessmentSkipped ? [] : files)
      .filter((f) => !selectedDirs.has(f.dirName))
      .filter((f) => !isHostReservedName(hostRow, f.dirName))
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
      //
      // TWO numbers, because one of them was quietly wrong (@copilot, PR
      // #1240). Discovery selects any declaration KEY, so a node declaring
      // only another host — or carrying `exports: {}` — is scanned and
      // produces no entry and no finding. Reporting only `scanned` therefore
      // overstated the population this plan judged. Reporting only `judged`
      // would hide that the read saw more. Both, and the gap between them is
      // a fact about the corpus rather than a discrepancy in the report.
      scanned: selectedRefs === undefined
        ? declaredRows.length
        : declaredRows.filter((row) => hasDeclarationKey(row.properties)).length,
      judged: skillNodes.length,
      unrecognized,
      orphanAssessmentSkipped,
      scopeSelection,
      selectionResults,
    };
}

export const skillQueries = {
  /** Existing unscoped and memory-scoped plan; plugin callers stay on this operation. */
  skillPlan: (_: unknown, { input }: { input: SkillPlanInput }, ctx: Context) => planSkills(input, ctx),
  /** Individual installed skill files only; plugin bundles have no node selector. */
  selectedSkillFilePlan: (
    _: unknown,
    { input }: { input: SelectedSkillFilePlanInput },
    ctx: Context,
  ) => planSkills({ intent: 'EXPORT', host: input.host, files: input.files, force: input.force }, ctx, input.nodes),
};

/** The node body for a urn, read from the already-loaded set. */
function findContent(nodes: SkillNode[], id: string): string {
  return nodes.find((n) => (n as SkillNode & { _id: string })._id === id)?.content ?? '';
}

function hasDeclarationKey(properties: unknown): boolean {
  return typeof properties === 'object' && properties !== null && !Array.isArray(properties) &&
    DECLARATION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(properties, key));
}

/**
 * A selected export still competes for names with EVERY readable enabled
 * declaration for its host. This scan is metadata-only and paged to the end;
 * the 500-node/body cap applies to selected content, never to collision proof.
 * A failed page rejects the whole query, so an incomplete census cannot yield
 * an executable WRITE or MOVE.
 */
async function selectedFileCollisions(
  ctx: Context,
  access: Awaited<ReturnType<typeof memoryAccessFilter>>,
  selected: (SkillNode & { _id: string })[],
  host: string,
): Promise<Finding[]> {
  const names = new Set(selected.flatMap((node) => {
    const declaration = declaredSkill(node.properties, host);
    return declaration?.enable === true && storedName(declaration) !== '' ? [declaration.name] : [];
  }));
  if (names.size === 0) return [];

  // Only the fact of a second claimant is needed. Keeping every matching row
  // and calling lintCollisions would make one widely reused name quadratic in
  // both report construction and message size.
  const claimantCounts = new Map([...names].map((name) => [name, 0]));
  const selectedIds = new Set(selected.map((node) => node._id));
  for (const node of selected) {
    const declaration = declaredSkill(node.properties, host);
    if (declaration?.enable === true && names.has(declaration.name)) {
      claimantCounts.set(declaration.name, Math.min(2, (claimantCounts.get(declaration.name) ?? 0) + 1));
    }
  }
  let cursor: string | undefined;
  let scanned = 0;
  let loadedBytes = 0n;
  while (true) {
    // Keep ID discovery, the DB-side byte check and the JSON fetch in one
    // snapshot. Otherwise a row growing between the check and fetch could
    // transfer an unbounded body, or a moved row could bypass the access gate.
    const { pageIds, page } = await ctx.db.$transaction(async (tx) => {
      const ids = await tx.node.findMany({
        where: {
          deletedAt: null,
          OR: DISCOVERY_OR,
          AND: [access, { memory: { deletedAt: null } }],
        } as never,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 200,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (scanned + ids.length > SKILL_PLAN_MAX_COLLISION_CENSUS_NODES) {
        throw new GraphQLError('selectedSkillFilePlan: the collision census is too large to complete safely.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      const pageIds = ids.map((row) => row.id);
      if (pageIds.length === 0) return { pageIds, page: [] as { id: string; properties: Prisma.JsonValue | null }[] };
      const sizes = await tx.$queryRaw<{ bytes: bigint }[]>`
        SELECT COALESCE(SUM(octet_length(properties::text)), 0)::bigint AS bytes
        FROM nodes WHERE id IN (${Prisma.join(pageIds)})
      `;
      loadedBytes += sizes[0]?.bytes ?? 0n;
      if (loadedBytes > BigInt(SKILL_PLAN_MAX_COLLISION_CENSUS_BYTES)) {
        throw new GraphQLError('selectedSkillFilePlan: the collision census properties exceed the safe byte ceiling.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      const page = await tx.node.findMany({
        where: { id: { in: pageIds }, deletedAt: null, AND: [access, { memory: { deletedAt: null } }] } as never,
        select: { id: true, properties: true },
      });
      return { pageIds, page };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    scanned += pageIds.length;
    for (const row of page) {
      if (selectedIds.has(row.id)) continue;
      const declaration = declaredSkill(row.properties, host);
      if (declaration?.enable !== true || !names.has(declaration.name)) continue;
      claimantCounts.set(declaration.name, Math.min(2, (claimantCounts.get(declaration.name) ?? 0) + 1));
    }
    if (pageIds.length < 200) break;
    cursor = pageIds[pageIds.length - 1]!;
  }
  return selected.flatMap((node) => {
    const declaration = declaredSkill(node.properties, host);
    if (declaration?.enable !== true || (claimantCounts.get(declaration.name) ?? 0) < 2) return [];
    return [{
      urn: node.urn,
      memory: node.memoryUrn,
      rule: 'skill-name-collision',
      severity: 'error' as const,
      message: `stores skill name "${declaration.name}", and another readable enabled declaration does too — one name, one skill directory; rename one or supersede the fork`,
    }];
  });
}
