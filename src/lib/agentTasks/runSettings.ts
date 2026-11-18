/**
 * #4291 (S14 of the Team on Orca epic, #4229) — family, model and effort are RUN SETTINGS, not what a worker is
 * (decision record hrn:node:hadronmemory.com:hadron-business:decisions:run-settings-are-not-worker-identity; the spec
 * changes are drafted as Proposed in cor:agt:060:04, :06, cor:agt:050:01 and cor:agt:070:08).
 *
 * THREE HOLDERS, one value each:
 *  - the SESSION holds what it runs as (`family`, `llmModel`, `effort`), as it reported them;
 *  - the WORKER holds a record of what its session last reported (`lastUsedFamily`, `lastUsedModel`,
 *    `lastUsedEffort`). The record is a REPORT, not a control: {@link recordRunSettings} copies it from an open session
 *    whenever that session binds or reports, a null never clears it, and it survives the unbind. Nothing else writes it,
 *    so no edit makes a running session adopt a value;
 *  - a TASK may hold its own settings (`run_family`, `run_model` or `run_tier`, `run_effort`), checked at creation by
 *    {@link validateTaskRunSettings}. They say what a start for the task launches. They are not matching requirements.
 *
 * A START (cor:agt:070:08) resolves them in {@link resolveStartSettings}: the task's own setting first, then the
 * worker's record, and for a record that holds nothing at all, the host assignment's launcher profile. The bind then
 * reports what ran, which is how a task's setting becomes the worker's last used (decision 5).
 *
 * All three are self-declared: matching and reporting inputs, never authorization.
 */

import type { Prisma } from '../../generated/prisma/index.js';
import { deriveFamily, normalizeFamily, tierOfAssignedModel, type ModelTier } from './family.js';
import { isHostToken } from '../hostOperations/types.js';

/** The generic effort scale (settled A). NOT_APPLICABLE is report-only: a session or the record may hold it, a task never. */
export const EFFORT_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX', 'UNSET', 'NOT_APPLICABLE'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const isEffortLevel = (v: unknown): v is EffortLevel => typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);

/**
 * The effort a start's `effort` argument names, for a bind that reports none itself: the generic value when the token
 * is one (any case, so a launcher profile's `high` reads HIGH), else null. A profile token outside the scale stays
 * unrecorded rather than being guessed into it.
 */
export function effortFromToken(token: unknown): EffortLevel | null {
  if (typeof token !== 'string') return null;
  const v = token.trim().toUpperCase();
  return isEffortLevel(v) ? v : null;
}

const TIERS: readonly ModelTier[] = ['low', 'mid', 'high'];
const isTier = (v: unknown): v is ModelTier => typeof v === 'string' && (TIERS as readonly string[]).includes(v);
const below = (tier: ModelTier, min: ModelTier): boolean => TIERS.indexOf(tier) < TIERS.indexOf(min);

/**
 * A model a start can carry: the database's launcher-model grammar (`host_launcher_model_ok`,
 * prisma/host-operation-invariants.sql), so nothing resolved here can fail the start's CHECK.
 */
export const launcherModelOk = (m: unknown): m is string => isHostToken(m) && m.length <= 128;
/** A task's exact model: the stricter token a launcher profile takes (no slash, no shell character). */
const TASK_MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A task's own run settings, as stored. Every field is optional; `model` and `tier` never both. */
export type TaskRunSettings = { family: string | null; model: string | null; tier: ModelTier | null; effort: EffortLevel | null };

export const RUN_SETTINGS_REFUSALS = ['BAD_VALUE', 'EFFORT_NOT_A_REQUEST', 'MODEL_AND_TIER', 'MODEL_OUTSIDE_FAMILY', 'FAMILY_EXCLUDED', 'TIER_BELOW_MINIMUM'] as const;
export type RunSettingsRefusal = (typeof RUN_SETTINGS_REFUSALS)[number];

/** A task's run settings refused by their own shape or against the task's requirements; nothing was written. */
export class RunSettingsError extends Error {
  constructor(readonly reason: RunSettingsRefusal, message: string) {
    super(message);
    this.name = 'RunSettingsError';
  }
}

/** The requirements a task's run settings must agree with (cor:agt:060:06); the stored, normalized shape. */
export type RunSettingsRequirements = { familyIn?: readonly string[] | null; familyNotIn?: readonly string[] | null; minTier?: string | null };

/** The family a task's settings launch as: the one it names, else the one its exact model implies; null when neither says. */
export function runFamilyOf(run: Pick<TaskRunSettings, 'family' | 'model'> | null | undefined): string | null {
  if (!run) return null;
  return run.family ?? (run.model ? deriveFamily({ llmModel: run.model }) : null);
}

/**
 * The run settings must satisfy the task's own requirements, so a start can never launch what the requirements keep
 * out (spec-review delta 2): the family (named, or implied by the exact model) inside `familyIn` and outside
 * `familyNotIn`; the tier, or the exact model's tier when the mapping places it, not below `minTier`. Throws
 * {@link RunSettingsError}. Called at creation and again when the requirements are edited.
 */
export function checkRunSettingsAgainst(run: TaskRunSettings | null, req: RunSettingsRequirements | null | undefined): void {
  if (!run || !req) return;
  const family = runFamilyOf(run);
  if (family && req.familyIn && !req.familyIn.includes(family)) {
    throw new RunSettingsError('FAMILY_EXCLUDED', `The run settings launch as ${family}, which requirements.familyIn does not allow.`);
  }
  if (family && req.familyNotIn?.includes(family)) {
    throw new RunSettingsError('FAMILY_EXCLUDED', `The run settings launch as ${family}, which requirements.familyNotIn excludes.`);
  }
  if (isTier(req.minTier)) {
    const tier = run.tier ?? (run.model ? tierOfAssignedModel(run.model) : null);
    if (tier && below(tier, req.minTier)) {
      throw new RunSettingsError('TIER_BELOW_MINIMUM', `The run settings launch at tier ${tier}, below requirements.minTier (${req.minTier}).`);
    }
  }
}

/**
 * Validate a task's run settings as given, returning them as they will be stored, or null when none is named. Throws
 * {@link RunSettingsError}; the refusal depends only on the caller's own input.
 */
export function validateTaskRunSettings(input: unknown, req?: RunSettingsRequirements | null): TaskRunSettings | null {
  if (input == null) return null;
  const bad = (message: string) => new RunSettingsError('BAD_VALUE', message);
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('runSettings is an object.');
  const r = input as Record<string, unknown>;
  const unknown = Object.keys(r).filter((k) => !['family', 'model', 'tier', 'effort'].includes(k));
  if (unknown.length) throw bad(`runSettings has no field ${unknown.map((k) => `"${k}"`).join(', ')}.`);
  let family: string | null = null;
  if (r.family != null) {
    family = typeof r.family === 'string' ? normalizeFamily(r.family) : null;
    if (!family) throw bad('runSettings.family is a model family token: letters, digits, ".", "_" or "-", up to 64 characters (e.g. claude, codex, glm).');
  }
  let model: string | null = null;
  if (r.model != null) {
    if (typeof r.model !== 'string' || !TASK_MODEL_TOKEN.test(r.model)) {
      throw bad('runSettings.model is an exact model name: letters, digits, ".", "_" or "-", starting with a letter or digit, at most 128 characters.');
    }
    model = r.model;
  }
  let tier: ModelTier | null = null;
  if (r.tier != null) {
    if (!isTier(r.tier)) throw bad('runSettings.tier is high, mid or low.');
    tier = r.tier;
  }
  let effort: EffortLevel | null = null;
  if (r.effort != null) {
    if (!isEffortLevel(r.effort)) throw bad(`runSettings.effort is one of ${EFFORT_LEVELS.filter((e) => e !== 'NOT_APPLICABLE').join(', ')}.`);
    if (r.effort === 'NOT_APPLICABLE') {
      throw new RunSettingsError('EFFORT_NOT_A_REQUEST', 'NOT_APPLICABLE is what a session reports for a family with no effort control; a task cannot ask for it. Leave effort out, or name UNSET for the family\'s default.');
    }
    effort = r.effort;
  }
  if (model && tier) throw new RunSettingsError('MODEL_AND_TIER', 'Name an exact model or a generic tier, not both.');
  if (model && family) {
    const implied = deriveFamily({ llmModel: model });
    if (implied && implied !== family) {
      throw new RunSettingsError('MODEL_OUTSIDE_FAMILY', `The model ${model} is a ${implied} model, not a ${family} one.`);
    }
  }
  if (!family && !model && !tier && !effort) return null;
  const run = { family, model, tier, effort };
  checkRunSettingsAgainst(run, req);
  return run;
}

/** The run settings a task row carries, or null when it names none. */
export function taskRunSettingsOf(row: { runFamily?: string | null; runModel?: string | null; runTier?: string | null; runEffort?: string | null } | null | undefined): TaskRunSettings | null {
  if (!row) return null;
  const run: TaskRunSettings = {
    family: normalizeFamily(row.runFamily),
    model: row.runModel ?? null,
    tier: isTier(row.runTier) ? row.runTier : null,
    effort: isEffortLevel(row.runEffort) ? row.runEffort : null,
  };
  return run.family || run.model || run.tier || run.effort ? run : null;
}

/** The worker's record of what its session last reported. All null: nothing was ever reported. */
export type WorkerRunRecord = { family: string | null; model: string | null; effort: EffortLevel | null };
export const recordIsEmpty = (r: WorkerRunRecord): boolean => r.family === null && r.model === null && r.effort === null;
export function workerRunRecordOf(row: { lastUsedFamily?: string | null; lastUsedModel?: string | null; lastUsedEffort?: string | null }): WorkerRunRecord {
  return { family: normalizeFamily(row.lastUsedFamily), model: row.lastUsedModel ?? null, effort: isEffortLevel(row.lastUsedEffort) ? row.lastUsedEffort : null };
}

/**
 * A model goes with a family only when it is not another family's: one the mapping places in a DIFFERENT family is left
 * out, one it cannot place is kept (nothing proves it foreign). The record holds one value each and a null never clears
 * it, so a session that reports only a new family leaves the previous family's model beside it; a start and the matcher
 * read the record's model through this, never raw (#4295 BLIND, Clark F2).
 */
export function modelOfFamily(family: string | null, model: string | null): string | null {
  if (!model) return null;
  const implied = deriveFamily({ llmModel: model });
  return implied && family && implied !== family ? null : model;
}

/** What a host stated for the worker: the family it registered or assigned, and the assignment's launcher profile. */
export type StartSeed = { family: string; model: string | null; effort: string | null };

/** The settings a `worker.start` carries. `model` and `tier` never both; an absent key means "the launcher's default". */
export type StartSettings = { family: string; model?: string; tier?: ModelTier; effort?: string };

/**
 * What the launch would run as when nothing of the task says otherwise: the worker's record, and for a record holding
 * NOTHING AT ALL, the host's seed (the gate's ruling on #4291: the profile seeds only an empty record, never fills in
 * or overwrites part of one). A record with no family still launches as the host's family, since a start must name one.
 */
export function launchBase(record: WorkerRunRecord, seed: StartSeed): { family: string; model: string | null; effort: string | null } {
  if (recordIsEmpty(record)) return { family: seed.family, model: seed.model, effort: seed.effort };
  const family = record.family ?? seed.family;
  return { family, model: modelOfFamily(family, record.model), effort: record.effort };
}

/**
 * cor:agt:070:08 (Proposed, #4291) — the settings of one start, each dimension on its own: the task's setting first,
 * then {@link launchBase}.
 *  - family: the task's, else the one its exact model implies, else the base's.
 *  - model or tier: the task's exact model, or its generic tier (then NO model is sent: the launcher maps the tier);
 *    otherwise the base's model, but only while the family is still the base's (a model belongs to its family) and only
 *    one a start can carry.
 *  - effort: the task's, else the base's. NOT_APPLICABLE is a report, so a start that falls back to it sends UNSET.
 */
export function resolveStartSettings(task: TaskRunSettings | null, record: WorkerRunRecord, seed: StartSeed): StartSettings {
  const base = launchBase(record, seed);
  const family = runFamilyOf(task) ?? base.family;
  const out: StartSettings = { family };
  if (task?.model) out.model = task.model;
  else if (task?.tier) out.tier = task.tier;
  else if (base.model && base.family === family && launcherModelOk(base.model)) out.model = base.model;
  const effort = task?.effort ?? base.effort;
  if (effort) out.effort = effort === 'NOT_APPLICABLE' ? 'UNSET' : effort;
  return out;
}

/** The worker's record, read on the caller's client (inside a start's transaction, under its worker row lock). */
export async function loadWorkerRunRecord(db: Pick<Prisma.TransactionClient, '$queryRaw'>, workerId: string): Promise<WorkerRunRecord> {
  const [row] = await db.$queryRaw<{ lastUsedFamily: string | null; lastUsedModel: string | null; lastUsedEffort: string | null }[]>`
    SELECT last_used_family AS "lastUsedFamily", last_used_model AS "lastUsedModel", last_used_effort::text AS "lastUsedEffort"
    FROM workers WHERE id = ${workerId}`;
  return workerRunRecordOf(row ?? {});
}

/**
 * The record follows the session (decisions 2 and 3, settled C): copy what an OPEN, worker-bound session holds onto its
 * worker's record. A null on the session leaves the record's value (null or omitted never clears), an ended or deleted
 * session moves nothing, and `updated_at` is not touched: this is a report, not an edit of the worker.
 *
 * LOCK ORDER. The caller already holds the WORKER row FOR UPDATE, taken before any session row, as every bind and
 * resume does: the matcher holds the worker row shared and then waits for its session rows, so a writer that held a
 * session row and only then asked for the worker row would deadlock with it.
 */
export async function recordRunSettings(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, sessionId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE workers w
    SET last_used_family = COALESCE(s.family, w.last_used_family),
        last_used_model = COALESCE(s.llm_model, w.last_used_model),
        last_used_effort = COALESCE(s.effort, w.last_used_effort)
    FROM sessions s
    WHERE s.id = ${sessionId} AND s.worker_id = w.id AND s.ended_at IS NULL AND s.deleted_at IS NULL
      AND (s.family IS NOT NULL OR s.llm_model IS NOT NULL OR s.effort IS NOT NULL)`;
}

/**
 * The settings a task's run actually used: its worker assignee's newest open session's, stamped on the task when it
 * starts. Run in the start's own transaction, after the status write. A person's task, or a worker with no open
 * session, stamps nothing. Shown beside the task's own settings, so an override that was not applied is visible
 * (spec-review delta 3: an override is not a requirement for a worker that is already running).
 */
export async function stampAppliedRunSettings(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, taskId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE agent_tasks t
    SET applied_family = s.family, applied_model = s.llm_model, applied_effort = s.effort
    FROM (
      SELECT DISTINCT ON (s.worker_id) s.worker_id, s.family, s.llm_model, s.effort
      FROM sessions s
      WHERE s.worker_id = (SELECT assignee_worker_id FROM agent_tasks WHERE id = ${taskId})
        AND s.ended_at IS NULL AND s.deleted_at IS NULL
      ORDER BY s.worker_id, s.started_at DESC, s.id DESC
    ) s
    WHERE t.id = ${taskId} AND t.assignee_worker_id = s.worker_id`;
}

/**
 * #4301 (cor:agt:050:01, Proposed): a STARTED task that moves to another assignee shows the run it is on now. Run in
 * the reassignment's own transaction, after the assignee write: the previous run's values are cleared, then the stamp
 * is taken from the new assignee's newest open session. A worker with no open session, or a person, leaves it empty
 * ({@link stampAppliedRunSettings} writes nothing then, which is why the clear comes first).
 */
export async function restampAppliedRunSettings(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, taskId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE agent_tasks SET applied_family = NULL, applied_model = NULL, applied_effort = NULL
    WHERE id = ${taskId} AND (applied_family IS NOT NULL OR applied_model IS NOT NULL OR applied_effort IS NOT NULL)`;
  await stampAppliedRunSettings(tx, taskId);
}

/**
 * #4301: a bind fills an EMPTY stamp. The bound worker's STARTED tasks whose three applied values are all null (a
 * task reassigned to it while it had no open session) take this session's values, in the bind's transaction. A stamp
 * that holds any value is never touched here: only a start, a reassignment and a hand-back write over one.
 *
 * LOCK ORDER. The bind holds the worker's per-worker lock (src/lib/agentTasks/workerLock.ts) and the worker row; the
 * task rows are taken after both, the order every task write takes them in.
 */
export async function fillEmptyAppliedRunSettings(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, sessionId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE agent_tasks t
    SET applied_family = s.family, applied_model = s.llm_model, applied_effort = s.effort
    FROM sessions s
    WHERE s.id = ${sessionId} AND s.ended_at IS NULL AND s.deleted_at IS NULL
      AND t.assignee_worker_id = s.worker_id AND t.status = 'started'
      AND t.applied_family IS NULL AND t.applied_model IS NULL AND t.applied_effort IS NULL`;
}
