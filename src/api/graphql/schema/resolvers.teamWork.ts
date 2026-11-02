// Team-worklog operations — #947: recordTeamWork + teamWorkItems as platform
// operations (team logic lives server-side; CLI/MCP/portal are thin surfaces —
// the #936/#941/#944 sibling pattern).
//
// The worklog is the AUTHORITATIVE PR↔session join (spec cor:agt:020:03 — the
// provenance chain PR → persona → sessions → transcripts; `Session.prNumber`
// is a latest-wins display convenience, cor:dmo:070:05): an append-only log of
// EXTERNALLY VISIBLE work milestones — a PR opened, a branch pushed, an issue
// closed. The litmus for what belongs (D-2026-08-11-005 / D14): would the
// platform otherwise have no record? Platform calls are already UsageEvents;
// capability declaration is App.agentTools.
//
// Storage (issue #947, decided): NOT a DB entity — a schema-governed
// object-store COLLECTION (`worklog`; cor:api:170 / #725 — an object IS a
// node) in the team App's shared app-class memory, the same home as the team
// chat. Each record is a node with objectType 'worklog' and flat queried
// fields in `properties`:
//   sessionId, workerName + workerId (denormalized one-hop display — the
//   Worker casting, #974/D-2026-08-14-004), tool ('github', …),
//   kind (pr | issue | commit | branch | repo), ref (THE equality-lookup key,
//   canonical spelling per src/lib/workRef.ts), action (free string —
//   opened | merged | claimed | reviewed | closed | pushed | …), at (ISO,
//   server-stamped) — plus optional `detail` JSON for display extras (title,
//   URL), never filtered on.
//
// Records are APPEND-ONLY: no update/delete surface in v1 — a wrong record is
// corrected by a newer one (the ledger posture). Note `properties` are
// deliberately NOT encrypted (nodeCrypto covers content/data only): structured
// records are queryable in SQL by design (#719), and the worklog carries only
// external artifact references, not content.
//
// Enforcement posture (D-2026-08-10-003): the collection schema is declared on
// the memory at bootstrap and THIS surface validates its writes against it —
// the generic node-write surface stays open (off-road writes are legal and,
// once the schema is declared, are themselves held to it by the #725 seam).
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import type { InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import { generateId } from '../../../lib/id.js';
import { lockAncestorsForCreateMany } from '../../../lib/nodeSubtreeLock.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveWorkerRef as resolveWorkerRefId } from '../../../lib/entityRef/workerRef.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { WorkerNotFoundError } from '../../../lib/entityRef/errors.js';
import { hasSchemePrefix } from '../../../lib/urn.js';
import { resolveWorkerIdByNameGated } from './resolvers.worker.js';
import { enforceNodeSchemaOnWrite } from '../../../lib/enforceNodeSchema.js';
import type { MemorySchema, MemorySchemaObjectType } from '../../../lib/memorySchema.js';
import {
  WORK_KINDS,
  type WorkKind,
  normalizeWorkRef,
  parseOwnerlessWorkRef,
  parseWorkRef,
  WorkRefInvalidError,
} from '../../../lib/workRef.js';
import {
  type Context,
  isAppParticipant,
  requireOwnerOrOrgRole,
  requireMemoryManageAccess,
  requireSessionWriteAccess,
  clampListTake,
  resolveAppTeamSpaceMemoryIds,
} from './resolvers.helpers.js';
import { findOrCreateAppClassMemory } from './chat-scope.js';
import { locateTeamAgent } from './resolvers.worker.js';
import { recordNodeUsage, recordNodeWrite } from '../../../lib/usageRecorder.js';
import { preserveHeartbeatIfLapsed, touchSessionIfLive } from '../../../lib/sessionActivity.js';

/** Canonical loc of the worklog collection root in a team App's shared memory. */
export const WORKLOG_LOC = 'worklog';
/** The collection (objectType) worklog records belong to. */
export const WORKLOG_OBJECT_TYPE = 'worklog';
/** Cap on the serialized `detail` bag — display extras, not an artifact store. */
export const WORK_DETAIL_MAX_CHARS = 16_384;
/** Cap on the free-string vocabulary fields (`tool`, `action`). */
export const WORK_TOKEN_MAX_CHARS = 64;

/**
 * The worklog collection schema, declared on the team memory at first write
 * (#725 — from then on EVERY write surface, this one and the generic node
 * surface alike, rejects non-conforming worklog records). `detail` is
 * deliberately undeclared: it is an optional JSON bag the schema field
 * vocabulary (text/number/datetime/boolean/enum) cannot type, and the
 * collection is non-strict, which admits it unvalidated — by design, since it
 * is display-only and never filtered on.
 */
export const WORKLOG_COLLECTION_SCHEMA: MemorySchemaObjectType = {
  description:
    'Append-only team worklog — externally visible work milestones (#947, spec cor:agt:020). ref is the canonical equality-lookup key.',
  fields: {
    sessionId: { type: 'text', required: true },
    workerName: { type: 'text', required: true },
    tool: { type: 'text', required: true },
    kind: { type: 'enum', required: true, values: [...WORK_KINDS] },
    ref: { type: 'text', required: true },
    action: { type: 'text', required: true },
    at: { type: 'datetime', required: true },
    // #1398: optional, event-time snapshot of the model that produced the
    // work — explicit report wins over the session's llmModel; absent on
    // records made before this field existed (read back as null, never
    // backfilled: null means "unknown", not "the worker's current model").
    model: { type: 'text', required: false },
  },
};

/**
 * The pre-#1398 canonical (#974's shape, without `model`) — same convergence
 * rule as the pre-#974 legacy below: a stored declaration that deep-equals a
 * SERVER-written canonical converges in place on the next record, so
 * existing teams gain the optional field without an admin act. A declaration
 * equal to NEITHER canonical is a deployment decision and stays governed —
 * and since the collection is non-strict, `model` still admits unvalidated
 * there, exactly as `detail` always has (adding attribution must not break
 * existing writers).
 */
const PRE_MODEL_WORKLOG_COLLECTION_SCHEMA: MemorySchemaObjectType = {
  description:
    'Append-only team worklog — externally visible work milestones (#947, spec cor:agt:020). ref is the canonical equality-lookup key.',
  fields: {
    sessionId: { type: 'text', required: true },
    workerName: { type: 'text', required: true },
    tool: { type: 'text', required: true },
    kind: { type: 'enum', required: true, values: [...WORK_KINDS] },
    ref: { type: 'text', required: true },
    action: { type: 'text', required: true },
    at: { type: 'datetime', required: true },
  },
};

/**
 * The pre-#974 canonical declaration (shipped by #947/#948), byte-identical
 * except for the `personaName` field the Worker model renamed. A memory whose
 * stored declaration deep-equals THIS shape was written by the server itself,
 * so `ensureWorklogSchema` transparently converges it to the new canonical —
 * otherwise every pre-#974 team memory would refuse all new records
 * (`workerName` fails the stored `personaName: required`) until an org admin
 * discovered updateTeamCollections (PR #978 review — codex P1). A declaration
 * that does NOT equal this shape is a deployment decision and stays governed.
 */
const LEGACY_WORKLOG_COLLECTION_SCHEMA: MemorySchemaObjectType = {
  description:
    'Append-only team worklog — externally visible work milestones (#947, spec cor:agt:020). ref is the canonical equality-lookup key.',
  fields: {
    sessionId: { type: 'text', required: true },
    personaName: { type: 'text', required: true },
    tool: { type: 'text', required: true },
    kind: { type: 'enum', required: true, values: [...WORK_KINDS] },
    ref: { type: 'text', required: true },
    action: { type: 'text', required: true },
    at: { type: 'datetime', required: true },
  },
};

const forbidden = (): GraphQLError =>
  new GraphQLError("You are not authorized to use this App's team worklog.", {
    extensions: { code: 'FORBIDDEN' },
  });

const badInput = (msg: string): GraphQLError =>
  new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });

type AppRow = {
  id: string;
  name: string;
  urn: string;
  organizationId: string | null;
  ownerUserId: string | null;
  uninstalledAt: Date | null;
};

/**
 * #947 membership gate — the team-chat gate's sibling, built on the same
 * shared predicate (`isAppParticipant`, #943) so the two cannot drift.
 * May record/read: an AppMember of the team App (any role — participation
 * follows the host memory's audience, cor:acl:030:01), an org member with
 * CONTRIBUTOR+ on the App's org, or the owner of a user-owned App.
 *
 * Principal shapes (findings:auth-appid-credential-vs-selection): a PURE
 * App-key principal is DENIED for `record` and ALLOWED for `read` of its own
 * App's worklog — the documented #947 decision, mirroring the chat: the
 * worklog is the team's provenance ledger and worker work has a human
 * driver by construction (cor:agt:020:03); App-key automation provenance is
 * already recorded as UsageEvents, and the bootstrap path requires a human
 * actor. Widening record to App keys later is additive; retracting it would
 * not be. A hybrid user+selection principal is judged solely on the USER.
 * Impersonation may read but never record, bounded to the support session's
 * SINGLE org before any shortcut (#876 class).
 */
async function requireTeamWorkAccess(
  ctx: Context,
  app: AppRow,
  mode: 'record' | 'read',
): Promise<void> {
  if (ctx.impersonation) {
    if (
      mode === 'record' ||
      app.organizationId === null ||
      app.organizationId !== ctx.impersonation.orgId
    ) {
      throw forbidden();
    }
  }
  if (!ctx.userId) {
    // Pure App-key principal: read-only, and only for its own App.
    if (mode === 'read' && ctx.appId && ctx.appId === app.id) return;
    throw forbidden();
  }
  if (await isAppParticipant(ctx, app)) return;
  throw forbidden();
}

type WorklogRootRow = { id: string; memoryId: string };

/**
 * Find the worklog root among the App's app-class memories. Memory-scoped by
 * construction (findings:unscoped-loc-lookup-crosses-memories): the loc match
 * never leaves this App's own memories. Oldest root wins so the answer is
 * deterministic even if a second `worklog` node was hand-created in another
 * installed agent's shared memory.
 */
async function locateWorklogRoot(ctx: Context, appId: string): Promise<WorklogRootRow | null> {
  const teamSpaceIds = await resolveAppTeamSpaceMemoryIds(ctx.db, appId);
  if (teamSpaceIds.length === 0) return null;
  return ctx.db.node.findFirst({
    // loc-scope-ok: deliberately spans the App's OWN app-class memories (one
    // per installed agent) — the relation filter is the tenant scope (#947).
    // #1031: resolved through the SHARED `resolveAppTeamSpaceMemoryIds` rather
    // than a local predicate. The copy here had drifted — it excluded a
    // Worker's working memory but not a SESSION memory, so a `worklog` node
    // planted in one could make the TEAM ledger resolve into a per-user
    // session scope: the row shape findings:app-class-is-four-row-shapes
    // records as the easiest to miss.
    //
    // The resolver (not a `where`) is what keeps LEGACY pre-#723 spaces
    // working. This locator admitted them before #1031 and `teamWorkItems`
    // never runs the adoption path, so requiring the #723 key would turn an
    // existing legacy ledger into an empty one.
    where: {
      loc: WORKLOG_LOC,
      deletedAt: null,
      memoryId: { in: teamSpaceIds },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, memoryId: true },
  });
}

/**
 * Ensure the memory's property schema declares the `worklog` collection
 * (#725 — this is what turns on server-side conformance for EVERY write
 * surface, the issue's "team init's client-side schema job retires" point).
 * An already-declared `worklog` collection is left untouched — a deployment
 * that tightened it governs this surface too, which is the point of schema
 * governance.
 *
 * The read-merge-write runs under a `FOR UPDATE` row lock on the memory
 * (Codex P2 on PR #948): `Memory.schema` is one JSON column written whole, so
 * an unlocked merge racing an administrator's schema edit would silently drop
 * whichever write lost — this declaration, or the admin's other collections.
 * The lock serializes this merge against any concurrent merge; an admin's
 * whole-column write through updateMemory remains last-write-wins by design
 * (deleting the declaration is then a deliberate act, and the next record's
 * ensure re-declares it).
 */
async function ensureWorklogSchema(ctx: Context, memoryId: string): Promise<void> {
  // A stored declaration blocks the merge — UNLESS it deep-equals the
  // pre-#974 canonical (server-written, never a deployment decision), which
  // is converged to the Worker-model shape in place. See
  // LEGACY_WORKLOG_COLLECTION_SCHEMA.
  const isDeclared = (schema: MemorySchema | null): boolean => {
    const current = schema?.objectTypes?.[WORKLOG_OBJECT_TYPE];
    if (!current) return false;
    const canonical = stableJson(current);
    // #1398: BOTH server-written pre-shapes converge — the pre-#974 one and
    // the pre-model #974 one. Anything else is a deployment decision.
    return canonical !== stableJson(LEGACY_WORKLOG_COLLECTION_SCHEMA)
      && canonical !== stableJson(PRE_MODEL_WORKLOG_COLLECTION_SCHEMA);
  };
  const row = await ctx.db.memory.findUnique({ where: { id: memoryId }, select: { schema: true } });
  if (isDeclared((row?.schema as unknown as MemorySchema | null) ?? null)) return;
  await ctx.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
    const locked = await tx.memory.findUnique({ where: { id: memoryId }, select: { schema: true } });
    const schema = (locked?.schema as unknown as MemorySchema | null) ?? null;
    if (isDeclared(schema)) return;
    const merged: MemorySchema = {
      ...(schema ?? {}),
      objectTypes: { ...(schema?.objectTypes ?? {}), [WORKLOG_OBJECT_TYPE]: WORKLOG_COLLECTION_SCHEMA },
    };
    await tx.memory.update({
      where: { id: memoryId },
      data: { schema: merged as unknown as InputJsonValue },
    });
  });
}

/**
 * First-write bootstrap: provision the Team Agent's shared app-class memory
 * (idempotent, race-safe — the team chat's home too) and create the `worklog`
 * collection root in it. Race-safe: a concurrent first write loses the root
 * create on `@@unique([loc, memoryId])` (P2002) and re-reads the winner's row.
 * Create-or-RESTORE like the chat bootstrap: a soft-deleted `worklog`
 * tombstone still occupies the unique, so it is revived rather than
 * P2002-looping forever.
 *
 * The Team Agent is located exactly as castWorker does (the roles:
 * branch marker), with the chat's fallback: an App with EXACTLY ONE installed
 * Agent needs no marker to be unambiguous.
 */
async function bootstrapWorklog(ctx: Context, app: AppRow): Promise<WorklogRootRow> {
  let teamAgent: { id: string; name: string; urn: string };
  try {
    teamAgent = await locateTeamAgent(ctx, app.id, null);
  } catch (e) {
    if (!(e instanceof GraphQLError) || e.extensions?.code !== 'TEAM_AGENT_NOT_FOUND') throw e;
    const installed = await ctx.db.appAgent.findMany({
      where: { appId: app.id },
      select: { agent: { select: { id: true, name: true, urn: true, deletedAt: true } } },
    });
    const live = installed.map((r) => r.agent).filter((a) => a && !a.deletedAt);
    if (live.length !== 1) throw e;
    teamAgent = live[0];
  }

  const memoryId = await findOrCreateAppClassMemory({
    appId: app.id,
    appUrn: app.urn,
    appName: app.name,
    agentId: teamAgent.id,
    agentUrn: teamAgent.urn,
    agentName: teamAgent.name,
    organizationId: app.organizationId,
    ownerUserId: app.ownerUserId,
    // record requires a user identity (requireTeamWorkAccess), so this is set.
    actingUserId: ctx.userId!,
    db: ctx.db,
  });

  try {
    await ctx.db.$transaction(async (tx) => {
      // #664/#752: create under the ancestor-path lock so a concurrent
      // non-recursive delete can't orphan the subtree.
      await lockAncestorsForCreateMany(tx, memoryId, [WORKLOG_LOC]);
      const existing = await tx.node.findUnique({
        where: { loc_memoryId: { loc: WORKLOG_LOC, memoryId } },
        select: { id: true, deletedAt: true },
      });
      if (existing) {
        if (existing.deletedAt) {
          await tx.node.update({
            where: { id: existing.id },
            data: { deletedAt: null, deletedBy: null },
          });
        }
        return;
      }
      await tx.node.create({
        data: {
          id: generateId(),
          memoryId,
          loc: WORKLOG_LOC,
          name: 'Worklog',
          nodeType: 'record',
          description: `Team worklog — ${app.name}`,
          createdBy: ctx.userId ?? null,
        },
      });
    });
  } catch (e) {
    // Concurrent first write won the bootstrap race — use its rows.
    const isUniqueViolation =
      typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
    if (!isUniqueViolation) throw e;
  }
  const root = await locateWorklogRoot(ctx, app.id);
  if (!root) throw new Error(`Worklog bootstrap failed for App ${app.id}`);
  return root;
}

/**
 * Converge the memory's `worklog` declaration to the server's canonical
 * definition (hadron-cli#401) — the EXPLICIT counterpart to
 * `ensureWorklogSchema`'s declare-if-absent.
 *
 * Why both exist. The first-write path deliberately leaves an already-declared
 * collection untouched, because an admin who tightened it is exercising schema
 * governance and this surface should be held to it. But a declaration is not
 * always an admin decision: `hadron team init` shipped its own copy of this
 * schema as a client-side constant, and that copy drifted — its `kind` enum
 * predates the `repo` kind, so on any memory bootstrapped by the CLI a
 * `recordTeamWork(kind: "repo")` is refused by a rule nobody chose. Silently
 * overriding the declaration would break real governance; leaving it strands
 * those memories forever. So convergence is its own operation: an explicit act,
 * gated like any other schema edit.
 *
 * Overwrites ONLY the `worklog` entry — every other collection on the memory is
 * preserved. Runs under the same `FOR UPDATE` row lock as the declare path,
 * since `Memory.schema` is one JSON column written whole.
 */
/**
 * Order-insensitive JSON comparison key. `Memory.schema` is a jsonb column and
 * Postgres does NOT preserve object key order, so a round-tripped declaration
 * never byte-equals the constant it was written from — comparing with a plain
 * `JSON.stringify` reports a difference on every call, which would make the
 * "idempotent, changed:false" contract a lie and rewrite the column each time.
 * Arrays keep their order (an enum's `values` order is what we wrote).
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function convergeWorklogSchema(
  ctx: Context,
  memoryId: string,
): Promise<boolean> {
  return ctx.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
    const locked = await tx.memory.findUnique({ where: { id: memoryId }, select: { schema: true } });
    const schema = (locked?.schema as unknown as MemorySchema | null) ?? null;
    const current = schema?.objectTypes?.[WORKLOG_OBJECT_TYPE];
    if (stableJson(current) === stableJson(WORKLOG_COLLECTION_SCHEMA)) return false;
    const merged: MemorySchema = {
      ...(schema ?? {}),
      objectTypes: { ...(schema?.objectTypes ?? {}), [WORKLOG_OBJECT_TYPE]: WORKLOG_COLLECTION_SCHEMA },
    };
    await tx.memory.update({
      where: { id: memoryId },
      data: { schema: merged as unknown as InputJsonValue, updatedBy: ctx.userId ?? null },
    });
    return true;
  });
}

/**
 * Resolve + authorize the session a work record attributes: it must exist, be
 * writable by the caller (`requireSessionWriteAccess` semantics,
 * cor:dmo:070:05), and be a session OF the target App (SESSION_NOT_IN_APP —
 * the chat's authorship condition, reachable since #944's SessionInput.appRef).
 *
 * Unlike chat authorship, an ENDED session is ACCEPTED (#947 decision): the
 * worklog's whole point is late attribution — a merge lands after the session
 * ends, and `updateSession` set the precedent ("late attribution is better
 * than none"). The named-identity derivation follows the chat's worker-App
 * pin where a Worker IS claimed (#974, cor:agt:020:05): a worker-bound
 * session's worker must belong to THIS App and not be retired
 * (SESSION_WORKER_NOT_IN_APP / WORKER_RETIRED — a retired or foreign worker
 * refuses rather than reshaping the attribution). An unbound session is fine
 * — the record then displays the attributed human's handle: the worklog
 * records work, not worker speech.
 */
async function resolveWorkSession(
  ctx: Context,
  app: AppRow,
  sessionRef: string,
): Promise<{ sessionId: string; workerName: string; workerId: string | null; llmModel: string | null; sessionUserId: string | null }> {
  const session = await ctx.db.session.findUnique({
    where: { id: sessionRef },
    select: { id: true, appId: true, userId: true, workerId: true, deletedAt: true, llmModel: true, launchOperationId: true, memoryId: true },
  });
  if (!session || session.deletedAt) {
    throw new GraphQLError(`Session "${sessionRef}" not found.`, {
      extensions: { code: 'SESSION_NOT_FOUND' },
    });
  }
  try {
    await requireSessionWriteAccess(ctx, session);
  } catch {
    throw new GraphQLError('You cannot record work against a session you are not attributed to.', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
  if (session.appId !== app.id) {
    throw new GraphQLError(
      `Session "${sessionRef}" is not a session of this App — work cannot be recorded into this team's worklog through it.`,
      { extensions: { code: 'SESSION_NOT_IN_APP', appId: app.id } },
    );
  }
  if (session.workerId) {
    const worker = await ctx.db.worker.findUnique({
      where: { id: session.workerId },
      select: { id: true, appId: true, name: true, retiredAt: true },
    });
    // A missing worker is treated EXACTLY like a foreign one (the PR #948
    // rule, re-keyed) — never as an unbound session: the fall-through would
    // relabel the worker's work as the human driver's, and a claimed identity
    // that no longer exists must refuse, not reshape.
    if (!worker || worker.appId !== app.id) {
      throw new GraphQLError(
        `Session "${sessionRef}" is bound to a worker that does not belong to this App — its work cannot be recorded under that identity here.`,
        { extensions: { code: 'SESSION_WORKER_NOT_IN_APP', appId: app.id } },
      );
    }
    // cor:agt:020:05: a RETIRED worker refuses too — unlike late attribution
    // on an ended session (fine), a retired identity takes no new records.
    //
    // #1053, stated where the next reader will meet it: liveness is NOT checked
    // here and that is durable law, not an omission — "an ended session may be
    // recorded against ... a merge lands after the session ends". The team CHAT
    // refuses the very session this accepts (cor:agt:020:04 condition (c)), and
    // the two are right to disagree: the chat is worker SPEECH, which needs a
    // live speaker, and the worklog is RECORD-KEEPING, whose whole point is
    // that the artifact outlives the stint. Making them agree in either
    // direction invalidates one of the two specs.
    //
    // What this cost, and what was fixed instead: a worker recorded two
    // milestones against a reaped binding, got clean receipts, and had no way
    // to know — so `hadron_record_work` now SAYS the session has ended while
    // still keeping the record. The answer was the missing signal, never a
    // refusal.
    if (worker.retiredAt) {
      throw new GraphQLError(
        `Session "${sessionRef}" is bound to a retired worker — a retired identity takes no new work records.`,
        { extensions: { code: 'WORKER_RETIRED', workerId: worker.id } },
      );
    }
    return { sessionId: session.id, workerName: worker.name, workerId: worker.id, llmModel: session.llmModel, sessionUserId: session.userId };
  }
  if (session.userId) {
    const user = await ctx.db.user.findUnique({
      where: { id: session.userId },
      select: { handle: true },
    });
    if (user?.handle) return { sessionId: session.id, workerName: user.handle, workerId: null, llmModel: session.llmModel, sessionUserId: session.userId };
  }
  return { sessionId: session.id, workerName: app.name, workerId: null, llmModel: session.llmModel, sessionUserId: session.userId };
}

/** GraphQL shape of one worklog record. (Exported — TS4023: a resolver map
 * exported from resolvers.ts cannot use a non-exported interface.) */
export interface TeamWorkItemOut {
  nodeId: string;
  sessionId: string;
  workerName: string;
  workerId: string | null;
  tool: string;
  kind: string;
  ref: string;
  action: string;
  at: Date;
  detail: unknown;
  model: string | null;
}

type WorkRow = { id: string; properties: unknown; createdAt: Date };

/** Project a worklog node onto the GraphQL shape (defensive on off-road rows). */
function projectWorkItem(row: WorkRow): TeamWorkItemOut {
  const p =
    row.properties != null && typeof row.properties === 'object' && !Array.isArray(row.properties)
      ? (row.properties as Record<string, unknown>)
      : {};
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const at = typeof p.at === 'string' && !Number.isNaN(Date.parse(p.at)) ? new Date(p.at) : row.createdAt;
  return {
    nodeId: row.id,
    sessionId: str(p.sessionId),
    // Pre-#974 records carry personaName; read it as the worker name so
    // history keeps rendering (no data migration — issue #974).
    workerName: str(p.workerName) || str(p.personaName),
    workerId: typeof p.workerId === 'string' ? p.workerId : null,
    tool: str(p.tool),
    kind: str(p.kind),
    ref: str(p.ref),
    action: str(p.action),
    at,
    detail: p.detail ?? null,
    // #1398: null on records that predate the field — deliberately NOT
    // backfilled from the worker's current model, so null always means
    // "unknown at record time", never a relabel.
    model: str(p.model) || null,
  };
}

/** Validate + normalize a vocabulary token (`tool` / `action`): non-empty,
 * trimmed, LOWERCASED (case-insensitive equality is the friendlier lookup
 * contract for vocabulary words), length-capped. Free strings by design
 * (#947 implementer decision 3 — documented conventions, the personaRole
 * precedent), so typos are the caller's to avoid. */
function vocabToken(name: 'tool' | 'action', v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw badInput(`${name} must be a non-empty string.`);
  }
  const token = v.trim().toLowerCase();
  if (token.length > WORK_TOKEN_MAX_CHARS) {
    throw badInput(`${name} exceeds ${WORK_TOKEN_MAX_CHARS} characters.`);
  }
  return token;
}

/** Map the lib's WorkRefInvalidError to the typed WORK_REF_INVALID. */
function normalizeOrThrow(ref: string, kind?: WorkKind): string {
  try {
    return normalizeWorkRef(ref, kind);
  } catch (e) {
    if (e instanceof WorkRefInvalidError) {
      throw new GraphQLError(e.message, { extensions: { code: 'WORK_REF_INVALID' } });
    }
    throw e;
  }
}

/**
 * Normalize the `ref` a record stores: github refs go through the canonical
 * grammar (unparseable → WORK_REF_INVALID); other tools have no defined
 * grammar in v1, so their refs are stored verbatim (trimmed).
 */
function normalizeRecordRef(tool: string, ref: unknown, kind: WorkKind): string {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw badInput('ref must be a non-empty string.');
  }
  return tool === 'github' ? normalizeOrThrow(ref.trim(), kind) : ref.trim();
}

export const teamWorkMutations = {
  /**
   * hadron-cli#401 — (re)declare the server-owned team collections on the team
   * App's shared memory, converging a drifted declaration to canonical.
   *
   * This is what lets `hadron team init`'s client-side schema constant retire
   * for memories that ALREADY carry its (stale) copy: the first-write
   * `ensureWorklogSchema` only declares when absent, on purpose, so it can
   * never override a deployment that tightened the collection deliberately.
   * Convergence therefore has to be asked for.
   *
   * Gate: owner / org ADMIN **on the memory**, the same bar `updateMemory`
   * applies to a schema edit — resolved from the memory row rather than the
   * App so the two cannot drift (this IS a schema edit, it just knows what to
   * write). Deliberately NOT the team-participation gate the rest of this file
   * uses: participation lets you record work, not redefine what a record is.
   */
  updateTeamCollections: async (
    _: unknown,
    { appRef }: { appRef: string },
    ctx: Context,
  ): Promise<{ memoryId: string; collections: string[]; changed: boolean }> => {
    const { id: appId } = await resolveAppRef(ctx.db, appRef);
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
    if (app.uninstalledAt) {
      throw new GraphQLError("Cannot declare collections on an uninstalled App's memory.", {
        extensions: { code: 'APP_UNINSTALLED', appId },
      });
    }
    if (!ctx.userId) {
      throw new GraphQLError('Declaring team collections requires an authenticated user.', {
        extensions: { code: 'UNAUTHENTICATED' },
      });
    }
    // Authorize on the APP before anything is written (Codex P1 on PR #958).
    // The bootstrap below CREATES rows — the App's shared memory and the
    // worklog root — so gating only on the resulting memory would let any
    // authenticated caller provision storage inside another tenant's App and
    // collect a FORBIDDEN afterwards, with the writes already committed. The
    // App's owner is the memory's owner (findOrCreateAppClassMemory inherits
    // it), so this is the same tenancy question asked before the side effect.
    await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
    // The memory exists from App-install time (#951); bootstrap covers Apps
    // created before that, and is idempotent either way.
    const root = (await locateWorklogRoot(ctx, appId)) ?? (await bootstrapWorklog(ctx, app));
    const memory = await ctx.db.memory.findUniqueOrThrow({
      where: { id: root.memoryId },
      select: { id: true, class: true, userId: true, organizationId: true, ownerUserId: true },
    });
    // Re-asked on the memory itself: it is the subject of the schema edit, and
    // this is the exact bar updateMemory applies (kept so the two cannot drift
    // if a memory's owner ever diverges from its App's).
    await requireMemoryManageAccess(ctx, memory);
    const changed = await convergeWorklogSchema(ctx, memory.id);
    return { memoryId: memory.id, collections: [WORKLOG_OBJECT_TYPE], changed };
  },

  /**
   * #947 — record an externally visible work milestone into the team App's
   * worklog: resolve the App (cor:api:140), gate on team participation,
   * resolve + authorize the session, normalize the ref to its ONE canonical
   * spelling, locate (or bootstrap) the worklog collection — declaring its
   * schema on the memory — validate the record against that schema (#725),
   * and append it. `kind: 'pr'` additionally denormalizes the latest-wins
   * `Session.prNumber` display convenience (cor:agt:020:03 — the worklog
   * stays the authoritative join). Append-only: there is no update or delete.
   */
  recordTeamWork: async (
    _: unknown,
    {
      appRef,
      sessionRef,
      tool,
      kind,
      ref,
      action,
      detail,
      model,
    }: {
      appRef: string;
      sessionRef: string;
      tool: string;
      kind: string;
      ref: string;
      action: string;
      detail?: unknown;
      model?: string | null;
    },
    ctx: Context,
  ): Promise<TeamWorkItemOut> => {
    const toolToken = vocabToken('tool', tool);
    const actionToken = vocabToken('action', action);
    if (typeof kind !== 'string' || !(WORK_KINDS as readonly string[]).includes(kind)) {
      throw badInput(`kind must be one of: ${WORK_KINDS.join(', ')}.`);
    }
    const workKind = kind as WorkKind;
    const canonicalRef = normalizeRecordRef(toolToken, ref, workKind);
    if (detail != null) {
      if (typeof detail !== 'object' || Array.isArray(detail)) {
        throw badInput('detail must be a JSON object.');
      }
      if (JSON.stringify(detail).length > WORK_DETAIL_MAX_CHARS) {
        throw badInput(
          `detail exceeds ${WORK_DETAIL_MAX_CHARS} serialized characters — it is a display bag, not an artifact store.`,
        );
      }
    }

    // #1398 — explicit model report: refuse a non-string or an empty/whitespace
    // value rather than silently falling back to the session's model (a typo
    // must not relabel the milestone), and cap it like any stored vocabulary
    // word. NOT verified runtime telemetry — the caller's report.
    let reportedModel: string | null = null;
    if (model != null) {
      if (typeof model !== 'string' || model.trim() === '') {
        throw badInput('model must be a non-empty string when provided (pass null to use the session model).');
      }
      // Refuse over-length LOUDLY, exactly as the tool/action vocabulary does
      // — a silently truncated model id is a wrong attribution (Ella, #1401).
      if (model.trim().length > 120) {
        throw badInput('model exceeds 120 characters — it names a model, not a free-text field.');
      }
      reportedModel = model.trim();
    }

    const { id: appId } = await resolveAppRef(ctx.db, appRef);
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
    if (app.uninstalledAt) {
      throw new GraphQLError("Cannot record work into an uninstalled App's worklog.", {
        extensions: { code: 'APP_UNINSTALLED', appId },
      });
    }
    await requireTeamWorkAccess(ctx, app, 'record');
    const { sessionId, workerName, workerId, llmModel, sessionUserId } = await resolveWorkSession(ctx, app, sessionRef);
    // Computed ONCE and used by both the stored row and the returned item —
    // two independent `??` expressions let a mutant swap precedence in the
    // stored row alone and survive every receipt-only assertion (Ella, #1401).
    // An empty-string session model normalizes to null here too, so the
    // receipt and the read-back can never disagree (Ella nit 3).
    // The 120-char storage bound applies to BOTH sources (Codex P2 on
    // cc13fd64): an over-long SESSION model must not slip past the limit the
    // explicit report is held to. Refusing the record — not truncating —
    // keeps every attribution whole; the caller passes an explicit model.
    let modelAttribution: string | null = null;
    if (reportedModel != null) {
      modelAttribution = reportedModel;
    } else if (llmModel != null && llmModel.trim() !== '') {
      // The bound is enforced on the EXACT persisted value (Chip QA on
      // e5df5b2c): check and store the TRIMMED fallback, so a padded session
      // model can neither exceed the bound nor store its padding.
      const trimmedSessionModel = llmModel.trim();
      if (trimmedSessionModel.length > 120) {
        throw badInput(
          `the session's llmModel exceeds 120 characters — pass an explicit model to attribute this milestone`,
        );
      }
      modelAttribution = trimmedSessionModel;
    }

    const root = (await locateWorklogRoot(ctx, appId)) ?? (await bootstrapWorklog(ctx, app));
    await ensureWorklogSchema(ctx, root.memoryId);

    const at = new Date();
    const properties: Record<string, unknown> = {
      sessionId,
      workerName,
      ...(workerId != null ? { workerId } : {}),
      tool: toolToken,
      kind: workKind,
      ref: canonicalRef,
      action: actionToken,
      at: at.toISOString(),
      ...(detail != null ? { detail } : {}),
      // Event-time snapshot (#1398): explicit report > session's llmModel >
      // absent. Later session/model changes can never relabel this row.
      ...(modelAttribution != null ? { model: modelAttribution } : {}),
    };
    // #725: this surface holds itself to the declared schema — including a
    // deployment-tightened one (an admin-edited worklog declaration governs
    // here too; violations surface as BAD_USER_INPUT).
    await enforceNodeSchemaOnWrite(ctx.db, root.memoryId, WORKLOG_OBJECT_TYPE, properties);

    const recordId = generateId();
    const loc = `${WORKLOG_LOC}:${recordId}`;
    await ctx.db.$transaction(async (tx) => {
      // #664/#752: append under the ancestor-path lock so a concurrent
      // non-recursive delete of the root can't orphan the record.
      await lockAncestorsForCreateMany(tx, root.memoryId, [loc]);
      await tx.node.create({
        data: {
          id: recordId,
          memoryId: root.memoryId,
          loc,
          name: `${workKind} ${actionToken} ${canonicalRef}`,
          nodeType: 'record',
          objectType: WORKLOG_OBJECT_TYPE,
          properties: properties as InputJsonValue,
          createdBy: ctx.userId ?? null,
        },
      });
      // kind:pr convenience (#947, decided lean): denormalize the latest-wins
      // Session.prNumber so `team session log --pr` stays one server call.
      // Display-only (cor:agt:020:03) — the worklog row above is the record.
      // The github canonical spelling carries the number; other tools' verbatim
      // refs are only parsed when they happen to end `#N`.
      if (workKind === 'pr') {
        const numberMatch = /#([1-9][0-9]*)$/.exec(canonicalRef);
        if (numberMatch) {
          // #1543 (Codex P1 on #1553): late attribution to a LAPSED session is
          // allowed, but must not count as driving it. Prisma's @updatedAt
          // would advance the heartbeat column and revive the session, which
          // another driver may already have bound since. Keep the stored
          // updatedAt unless the session is still live.
          await tx.session.update({
            where: { id: sessionId },
            data: {
              prNumber: Number(numberMatch[1]),
              updatedBy: ctx.userId ?? ctx.clientId ?? null,
              ...(await preserveHeartbeatIfLapsed(tx as never, sessionId)),
            },
          });
        }
      }
    });

    // #1061 — a worklog record IS a node, so appending one is a write. Like
    // team-chat posts, this was a high-volume creator that counted for nothing.
    recordNodeWrite(ctx.db, { id: recordId, loc, memoryId: root.memoryId }, ctx);

    // #3078 (cor:agt:020:11 r1, cor:api:240): an accepted record of ANY kind is the worker driving its session, as MCP
    // hadron_record_work's heartbeatSession already counts it. Only AFTER the record committed, so every refusal above
    // (impersonation and a removed caller in requireTeamWorkAccess, the session write gate in resolveWorkSession) has
    // already stopped the act. Only when the caller IS the session's attributed user: the write gate's platform-admin
    // branch admits recording against another user's worker session, and that is not driving it (MCP scopes its touch to
    // `userId: auth.userId` for the same reason). Only a worker-bound session, and only while live: touchSessionIfLive
    // never revives a lapsed or ended one (#1543, cor:agt:020:05 late attribution) and swallows its own errors, so the
    // heartbeat can never fail a committed record.
    if (workerId != null && sessionUserId != null && sessionUserId === ctx.userId) {
      await touchSessionIfLive(ctx.db as never, sessionId, workerId);
    }

    return {
      nodeId: recordId,
      sessionId,
      workerName,
      workerId,
      tool: toolToken,
      kind: workKind,
      ref: canonicalRef,
      action: actionToken,
      at,
      detail: detail ?? null,
      model: modelAttribution,
    };
  },
};

export const teamWorkQueries = {
  /**
   * #947 — the provenance read surface: worklog records of a team App, newest
   * first, as a uniform `{ items, total }` page (conventions:
   * uniform-read-surface; limit 0 = count-only). Qualified `ref` is normalized
   * before matching; an ownerless github ref matches every canonical repo
   * whose name ends with its slug, within this App's worklog (#1554). A
   * spelling that fits neither form matches verbatim for non-github tools.
   * `sessionRef` /
   * `tool` / `kind` are equality filters. This is hadron-cli's
   * `team session list --pr <ref>` engine: worklog-by-ref → sessionIds →
   * sessions (with transcripts).
   *
   * Deliberately a DEDICATED query rather than a findObjects projection (#947
   * implementer decision 1): the object store delegates to the generic memory
   * read gate, which does not admit AppMembers of the App — this surface's
   * audience IS the team (the participant gate, like the chat read).
   *
   * Scoped to the CANONICAL worklog root's memory (Copilot on PR #948, the
   * chat reader's shape): writes select one root, so reads must read exactly
   * that worklog — in a multi-agent App, a worklog-typed node in another
   * agent's shared memory is not part of this App's ledger. No root ⇒ the
   * empty page (reads never provision).
   *
   * Ordering is `createdAt` DESC — identical to `at` DESC for every record
   * this surface writes (`at` is server-stamped in the same write); an
   * off-road record's caller-chosen `at` sorts by its insertion time instead.
   */
  teamWorkItems: async (
    _: unknown,
    {
      appRef,
      ref,
      sessionRef,
      workerRef,
      tool,
      kind,
      limit,
      offset,
    }: {
      appRef: string;
      ref?: string | null;
      sessionRef?: string | null;
      workerRef?: string | null;
      tool?: string | null;
      kind?: string | null;
      limit?: number | null;
      offset?: number | null;
    },
    ctx: Context,
  ): Promise<{ items: TeamWorkItemOut[]; total: number }> => {
    if (kind != null && !(WORK_KINDS as readonly string[]).includes(kind)) {
      throw badInput(`kind must be one of: ${WORK_KINDS.join(', ')}.`);
    }
    const { id: appId } = await resolveAppRef(ctx.db, appRef);
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
    await requireTeamWorkAccess(ctx, app, 'read');

    const root = await locateWorklogRoot(ctx, appId);
    if (!root) return { items: [], total: 0 };

    const toolFilter = tool != null && tool.trim() !== '' ? tool.trim().toLowerCase() : undefined;

    // Normalize the ref filter TOOL-AWARELY (Codex P2 + Copilot on PR #948):
    // only github refs are stored canonically, so canonicalizing a non-github
    // tool's filter would break its verbatim contract (a jira "Acme/Proj#12"
    // is stored as typed, but PARSES as the github short form and would be
    // lowercased into never matching). tool 'github' ⇒ match canonical;
    // another tool ⇒ match verbatim; no tool ⇒ match EITHER spelling. A read
    // filter never throws WORK_REF_INVALID — an unmatched spelling is simply
    // an empty page. #1554: an ownerless github spelling is a read-only suffix
    // filter over this App's worklog; it may match several owners. Stored refs
    // remain canonical, and no single repository is inferred.
    const propEq = (key: string, value: string) => ({
      properties: { path: [key], equals: value },
    });
    let refClause: Record<string, unknown> | undefined;
    let ownerless: ReturnType<typeof parseOwnerlessWorkRef> = null;
    let verbatimRef: string | undefined;
    if (ref != null && ref.trim() !== '') {
      const verbatim = ref.trim();
      verbatimRef = verbatim;
      const canonical = parseWorkRef(verbatim)?.ref;
      ownerless = canonical === undefined ? parseOwnerlessWorkRef(verbatim) : null;
      const candidates =
        toolFilter === 'github'
          ? [canonical ?? verbatim]
          : toolFilter !== undefined
            ? [verbatim]
            : [...new Set([canonical, verbatim].filter((c): c is string => c !== undefined))];
      refClause =
        candidates.length === 1
          ? propEq('ref', candidates[0])
          : { OR: candidates.map((c) => propEq('ref', c)) };
    }

    // #1035: filter by WORKER — "what has this worker done", which otherwise
    // needs an N+1 over `sessions(workerRef:)` plus a client-side merge that
    // cannot reproduce this operation's `total` or a stable offset.
    //
    // Resolution accepts the same three forms as `workerRef` everywhere else
    // (id, `hrn:worker:…` URN, or NAME within this App), told apart by SHAPE
    // rather than by trying each in turn — a typo'd URN must not silently
    // search the roster. Scoped to THIS App: a name is unique only within one,
    // and an id or URN naming another App's worker is a caller mistake that
    // should return nothing rather than quietly widen the read.
    //
    // A RETIRED worker still resolves. Retirement ends the casting, not the
    // history, and a worker page for a retired worker is a legitimate read —
    // the same posture `Session.worker` and `resolveUrn` already take. So this
    // deliberately does NOT reuse the bind-time resolution, which refuses
    // WORKER_RETIRED.
    //
    // An unresolvable ref yields an EMPTY page rather than an error, matching
    // the `ref` filter's posture above: a read filter that names nothing is a
    // filter that matches nothing, and erroring would make this surface an
    // existence oracle for another App's roster (cor:agt:020:08).
    let workerIdFilter: string | undefined;
    if (workerRef != null && workerRef.trim() !== '') {
      const trimmed = workerRef.trim();
      let resolved: string | null = null;
      if (isId(trimmed) || hasSchemePrefix(trimmed)) {
        try {
          ({ id: resolved } = await resolveWorkerRefId(ctx.db, trimmed));
        } catch (e) {
          // NARROW catch (review:narrow-catch-blocks; PR #1051 review, Codex +
          // Copilot). `resolveWorkerRefId` reaches the database, so a blanket
          // catch reports an OUTAGE as "no matching worklog records" — an empty
          // page a caller has every reason to believe. Collapsing the expected
          // not-found into an empty page is the contract; hiding that the
          // database is down never is. The same reasoning, and the same
          // comment, as `resolveWorkerIdByNameGated`.
          if (!(e instanceof WorkerNotFoundError)) throw e;
          resolved = null;
        }
      } else {
        resolved = await resolveWorkerIdByNameGated(ctx, appId, trimmed);
      }
      if (resolved) {
        // Confirm the resolved worker belongs to THIS App (PR #1051 review,
        // Codex P2 — restoring a check I had removed on bad reasoning).
        //
        // I argued the root scoping made this redundant: the query is confined
        // to this App's worklog memory, so a foreign worker id "matches nothing
        // by construction". That is wrong. Root scoping constrains the node's
        // MEMORY, not its denormalized `properties.workerId` — and off-road
        // writes into this collection are legal by design (see this file's
        // header), while `workerId` is not even in the declared collection
        // schema, so nothing validates it. A worklog-shaped node in this App
        // naming another App's worker would therefore be returned, breaking
        // the empty-page promise this filter makes.
        //
        // The mutation check that "proved" the guard redundant only proved my
        // test was too weak: it created a foreign worker but no record naming
        // one. A guard that survives a mutation is a guard whose test does not
        // reach it, which is not the same as a guard that cannot fail.
        const owned = await ctx.db.worker.findFirst({
          where: { id: resolved, appId },
          select: { id: true },
        });
        resolved = owned?.id ?? null;
      }
      if (!resolved) return { items: [], total: 0 };
      workerIdFilter = resolved;
    }

    const take = clampListTake(limit);
    const skip = Math.max(0, offset ?? 0);
    if (ownerless && verbatimRef && (toolFilter === undefined || toolFilter === 'github')) {
      // #1554: keep the suffix predicate in BOTH SQL queries. Materializing
      // matching IDs first makes even a count-only read grow with the entire
      // append-only worklog (Codex P2 on #1556). RIGHT is literal: Prisma's
      // JSON string_ends_with uses LIKE, where '_' in a repo is a wildcard.
      // The anchored shape rejects branch tails and malformed off-road refs;
      // the accepted shapes mirror parseWorkRef's owner/repo grammar.
      const ownerRepoShape = '[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+';
      const refShape = ownerless.kinds.includes('pr')
        ? `^${ownerRepoShape}#[1-9][0-9]*$`
        : ownerless.kinds.includes('commit')
          ? `^${ownerRepoShape}@[0-9a-fA-F]{7,40}$`
          : ownerless.kinds.includes('branch')
            ? `^${ownerRepoShape}:[^[:space:]:]+$`
            : `^${ownerRepoShape}$`;
      const scoped = Prisma.sql`
        FROM nodes n
        WHERE n.deleted_at IS NULL
          AND n.object_type = ${WORKLOG_OBJECT_TYPE}
          AND n.memory_id = ${root.memoryId}
          AND (
            n.properties->>'ref' = ${verbatimRef}
            OR (n.properties->>'tool' = 'github'
              AND right(n.properties->>'ref', length(${ownerless.ref})) = ${ownerless.ref}
              AND n.properties->>'ref' ~ ${refShape})
          )
          ${sessionRef != null && sessionRef !== '' ? Prisma.sql`AND n.properties->>'sessionId' = ${sessionRef}` : Prisma.empty}
          ${workerIdFilter !== undefined ? Prisma.sql`AND n.properties->>'workerId' = ${workerIdFilter}` : Prisma.empty}
          ${toolFilter !== undefined ? Prisma.sql`AND n.properties->>'tool' = ${toolFilter}` : Prisma.empty}
          ${kind != null ? Prisma.sql`AND n.properties->>'kind' = ${kind}` : Prisma.empty}
      `;
      const [{ total: rawTotal }] = await ctx.db.$queryRaw<Array<{ total: bigint }>>(
        Prisma.sql`SELECT count(*) AS total ${scoped}`,
      );
      const total = Number(rawTotal);
      if (take === 0) return { items: [], total };
      const rows = await ctx.db.$queryRaw<Array<WorkRow & { loc: string }>>(
        Prisma.sql`SELECT n.id, n.loc, n.properties, n.created_at AS "createdAt"
          ${scoped} ORDER BY n.created_at DESC, n.id DESC
          OFFSET ${skip}::bigint LIMIT ${take}::int`,
      );
      recordNodeUsage(
        ctx.db,
        'read',
        rows.map((r) => ({ id: r.id, loc: r.loc, memoryId: root.memoryId })),
        ctx,
      );
      return { items: rows.map(projectWorkItem), total };
    }

    const where = {
      deletedAt: null,
      objectType: WORKLOG_OBJECT_TYPE,
      memoryId: root.memoryId,
      AND: [
        ...(refClause !== undefined ? [refClause] : []),
        ...(sessionRef != null && sessionRef !== '' ? [propEq('sessionId', sessionRef)] : []),
        // Records from a session that was never worker-bound carry a null
        // workerId and simply do not match — stated so the omission does not
        // read as a bug.
        ...(workerIdFilter !== undefined ? [propEq('workerId', workerIdFilter)] : []),
        ...(toolFilter !== undefined ? [propEq('tool', toolFilter)] : []),
        ...(kind != null ? [propEq('kind', kind)] : []),
      ],
    };

    const total = await ctx.db.node.count({ where });
    if (take === 0) return { items: [], total };
    const rows = await ctx.db.node.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // `loc` rides along for the #1061 usage attribution; the projection
      // itself doesn't use it.
      select: { id: true, loc: true, properties: true, createdAt: true },
      skip,
      take,
    });
    // #1061 — each worklog record returned carries its stored properties, so
    // it is a read. The `take: 0` count probe above returns before this point.
    recordNodeUsage(
      ctx.db,
      'read',
      rows.map((r) => ({ id: r.id, loc: r.loc, memoryId: root.memoryId })),
      ctx,
    );
    return { items: rows.map(projectWorkItem), total };
  },
};
