// Agent ticker templates — #2024 (S8), hrn:node:hadronmemory.com:specs:cor:agt:080:33 (Proposed).
//
// An Agent declares the tickers its workers should have. Casting a worker from the Agent into an App turns every
// live template into a ticker owned by the new worker, with the worker subscribed, in the cast's own transaction
// (a SNAPSHOT: a later template edit or removal reaches only future casts, R96 A). Retiring the worker ends only
// the tickers generated for it. Nothing here touches a ticker that already exists: no adoption by name, no
// fan-out, no backfill (R97 B is #2096's manager-run apply operation).
//
// The functions take a TRANSACTION and never open one, so the cast that owns the transaction (castWorker today,
// the S12 cast tomorrow) composes them under its own lock order:
//
//   authority anchors -> early Agent template lock (shared) -> stop fence -> name -> reportsTo graph -> ticker -> Worker rows
//
// Template writers take the Agent template lock EXCLUSIVE and never an App lock, so the two cannot cycle, and a
// cast either sees a template that committed first or waits for the writer: the lock is what fences the
// "no templates yet" read, which a row lock cannot (there is no row to lock).

import { Prisma } from '../../generated/prisma/index.js';
import { currentActor } from '../requestActor.js';
import { TICKER_NAME_MAX } from './bounds.js';
import { nextFreeTickerSlug } from './tickerSlug.js';
import { templateTickCode } from './tickCode.js';

/** The only template shape that exists; the CHECK on `agent_ticker_templates` refuses any other. */
export const TEMPLATE_SHAPE_VERSION = 1;

/** Separates the template's name from the worker's in a generated ticker's name (cor:agt:080:01 name uniqueness). */
export const GENERATED_NAME_SEPARATOR = ' · ';

export type TemplateRow = Prisma.AgentTickerTemplateGetPayload<Record<string, never>>;

export type TemplateLockMode = 'shared' | 'exclusive';

/**
 * Serialize the template set of one Agent against casts. A writer (create, update, delete) takes it exclusive; a
 * cast takes it shared, so any number of casts run together and none overlaps a template write.
 */
export async function lockAgentTemplates(tx: Prisma.TransactionClient, agentId: string, mode: TemplateLockMode): Promise<void> {
  const key = `agent-ticker-templates:${agentId}`;
  if (mode === 'exclusive') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
}

/** The live templates of an Agent, in a stable order (name, then id). */
export function liveTemplates(db: Pick<Prisma.TransactionClient, 'agentTickerTemplate'>, agentId: string): Promise<TemplateRow[]> {
  return db.agentTickerTemplate.findMany({
    where: { agentId, deletedAt: null },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
}

/**
 * The name a template's ticker gets for one worker: `<template name> · <worker name>`. A ticker's name is unique
 * among the App's live tickers ignoring case (cor:agt:080:01), so two casts of one Agent into an App must not
 * share the template's name. The template's part is shortened, never the worker's, when the pair would pass the
 * name bound; a worker name that alone cannot fit refuses the cast.
 */
export function generatedTickerName(templateName: string, workerName: string): string {
  const suffix = `${GENERATED_NAME_SEPARATOR}${workerName}`;
  const room = TICKER_NAME_MAX - suffix.length;
  if (room < 1) throw new GeneratedNameTooLongError(workerName);
  return `${templateName.length > room ? templateName.slice(0, room).trimEnd() : templateName}${suffix}`;
}

export class GeneratedNameTooLongError extends Error {
  constructor(readonly workerName: string) {
    super(`The worker name "${workerName}" is too long to name a generated ticker (a ticker name is at most ${TICKER_NAME_MAX} characters).`);
  }
}

export class GeneratedTickerLimitError extends Error {
  constructor(readonly live: number, readonly adding: number, readonly liveCap: number) {
    super(`This App has ${live} live tickers and this cast would add ${adding}; the limit is ${liveCap}.`);
  }
}

/** The Agent stopped being installed in the App (or was removed) while the cast waited for its locks. */
export class GeneratedAgentNotInstalledError extends Error {
  constructor(readonly appId: string) {
    super('The Agent is no longer installed in this App, so nothing was cast.');
  }
}

export class GeneratedTickerNameTakenError extends Error {
  constructor(readonly name: string) {
    super(`This App already has a live ticker named "${name}" (names ignore case).`);
  }
}

/** One planned ticker of a cast: what the template asks for and what the App's floor makes of it (R92). */
export type PlannedTicker = {
  templateId: string;
  templateName: string;
  templateRevision: number;
  tickCode: string;
  name: string;
  requestedCadenceSeconds: number;
  effectiveCadenceSeconds: number;
  quietHours: Prisma.JsonValue | null;
  relevance: string;
  reasons: string[];
};

/**
 * What a cast would create for this Agent in this App, without writing anything: the live templates, each with
 * its generated name and its effective cadence, the larger of the template's and the App's floor (a below-floor
 * template is clamped, not refused, R92). Refuses the whole plan when the App's live cap cannot take every ticker
 * (aggregate, so a cast never lands part of its set) or a generated name is already a live ticker's. The caller holds the App ticker lock when it will write;
 * the preview reads without it and so shows what a cast would do now.
 *
 * Reasons are not re-validated here: a template is validated when written and the CHECK keeps it so.
 */
export async function planGeneratedTickers(
  tx: Prisma.TransactionClient, args: { appId: string; agentId: string; workerName: string; onlyTemplateIds?: ReadonlySet<string> },
): Promise<PlannedTicker[]> {
  // `onlyTemplateIds` is #2096's apply: plan, cap arithmetic and name checks then cover just the missing templates.
  // Omitted (every cast and the preview), it is the whole live set, exactly as before.
  const all = await liveTemplates(tx, args.agentId);
  const templates = args.onlyTemplateIds ? all.filter((t) => args.onlyTemplateIds!.has(t.id)) : all;
  if (templates.length === 0) return [];
  const settings = await tx.app.findUniqueOrThrow({ where: { id: args.appId }, select: { tickerMinCadenceSeconds: true, tickerLiveCap: true } });
  const live = await tx.ticker.count({ where: { appId: args.appId, deletedAt: null } });
  if (live + templates.length > settings.tickerLiveCap) throw new GeneratedTickerLimitError(live, templates.length, settings.tickerLiveCap);
  const plans = templates.map((t) => ({
    templateId: t.id,
    templateName: t.name,
    templateRevision: t.revision,
    tickCode: templateTickCode(t.name),
    name: generatedTickerName(t.name, args.workerName),
    requestedCadenceSeconds: t.cadenceSeconds,
    effectiveCadenceSeconds: Math.max(t.cadenceSeconds, settings.tickerMinCadenceSeconds),
    quietHours: t.quietHours as Prisma.JsonValue | null,
    relevance: t.relevance,
    reasons: t.reasons,
  }));
  // Names are unique among the App's live tickers, ignoring case: against what exists and among the plans.
  const seen = new Set<string>();
  for (const plan of plans) {
    const key = plan.name.toLowerCase();
    const clash = seen.has(key) || (await tx.ticker.findFirst({
      where: { appId: args.appId, deletedAt: null, name: { equals: plan.name, mode: 'insensitive' } },
      select: { id: true },
    })) !== null;
    if (clash) throw new GeneratedTickerNameTakenError(plan.name);
    seen.add(key);
  }
  return plans;
}

/**
 * Create the worker's tickers from the Agent's live templates and subscribe it, inside the caller's transaction.
 * The cast caller has already acquired both advisory resources BEFORE any Worker row, under its authority
 * anchors and early template snapshot. These acquisitions are re-entrant, never new late locks. It plans against
 * the template set held by that snapshot. Any refusal throws
 * and the caller's transaction rolls the whole cast back, name allocation included (no orphan worker, ticker
 * or subscription).
 *
 * Each generated ticker is owned by the new worker (`ownerWorkerId`) and records its template, revision and
 * worker (`sourceTemplateId`, `sourceTemplateRevision`, `generatedForWorkerId`); the caster stays `createdBy`.
 * The subscription is the platform's, made at cast from a template (cor:agt:080:02, :20 as amended by V3); it
 * rests on no subscribe grant and on the caster's own subscribe right, which is why the consent rules that guard
 * subscribing someone else's worker do not apply to a worker that did not exist a moment ago.
 */
export async function instantiateAgentTickerTemplates(
  tx: Prisma.TransactionClient,
  args: { appId: string; agentId: string; worker: { id: string; name: string }; createdBy: string | null },
): Promise<Array<{ tickerId: string; subscriptionId: string; plan: PlannedTicker }>> {
  // The App ticker lock first (the order every ticker write uses), then the Agent's template set.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tickers:${args.appId}`}, 0))`;
  await lockAgentTemplates(tx, args.agentId, 'shared');
  // The installation was read before this transaction and the locks above can wait; re-decide it now, and hold
  // the rows FOR SHARE so an uninstall or Agent removal waits for this cast instead of racing it.
  const installed = await tx.$queryRaw<Array<{ ok: number }>>`
    SELECT 1 AS ok FROM app_agents aa JOIN agents a ON a.id = aa.agent_id
    WHERE aa.app_id = ${args.appId} AND aa.agent_id = ${args.agentId} AND a.deleted_at IS NULL FOR SHARE OF aa, a`;
  if (installed.length === 0) throw new GeneratedAgentNotInstalledError(args.appId);
  const plans = await planGeneratedTickers(tx, { appId: args.appId, agentId: args.agentId, workerName: args.worker.name });
  return writeGeneratedTickers(tx, { appId: args.appId, worker: args.worker, createdBy: args.createdBy, plans });
}

/** Write the planned tickers (each owned by the worker, with its subscription) in the caller's transaction. */
async function writeGeneratedTickers(
  tx: Prisma.TransactionClient,
  args: { appId: string; worker: { id: string; name: string }; createdBy: string | null; plans: PlannedTicker[] },
): Promise<Array<{ tickerId: string; subscriptionId: string; plan: PlannedTicker }>> {
  const actor = currentActor();
  const made: Array<{ tickerId: string; subscriptionId: string; plan: PlannedTicker }> = [];
  for (const plan of args.plans) {
    const slug = await nextFreeTickerSlug(tx, args.appId, plan.name);
    const stamp = {
      createdBy: args.createdBy, createdByWorkerId: actor.workerId, createdByAgentId: actor.agentId,
      updatedBy: args.createdBy, updatedByWorkerId: actor.workerId, updatedByAgentId: actor.agentId,
    };
    const ticker = await tx.ticker.create({
      data: {
        appId: args.appId, name: plan.name, slug, tickCode: plan.tickCode, cadenceSeconds: plan.effectiveCadenceSeconds,
        quietHours: plan.quietHours === null ? Prisma.DbNull : (plan.quietHours as Prisma.InputJsonValue),
        channelIds: [], relevance: plan.relevance, reasons: plan.reasons, enabled: true,
        ownerWorkerId: args.worker.id,
        sourceTemplateId: plan.templateId, sourceTemplateRevision: plan.templateRevision, generatedForWorkerId: args.worker.id,
        ...stamp,
      },
      select: { id: true },
    });
    const subscription = await tx.tickerSubscription.create({
      data: {
        tickerId: ticker.id, workerId: args.worker.id,
        createdBy: args.createdBy, createdByWorkerId: actor.workerId, createdByAgentId: actor.agentId,
      },
      select: { id: true },
    });
    made.push({ tickerId: ticker.id, subscriptionId: subscription.id, plan });
  }
  return made;
}

/**
 * #2096 (R97 B): apply the Agent's CURRENT templates to a worker that already exists, creating only the template
 * tickers it is missing. The caller (a manager-run mutation) holds the App ticker lock and the worker row FOR SHARE
 * and has re-read the worker's liveness. Here: the Agent's template set (shared), the installation re-check, then
 * the idempotence read (a LIVE ticker with this worker + template is present and is never edited, whatever its
 * revision or cadence), and the same plan and write a cast uses, restricted to the missing templates, so the R92
 * clamp and the aggregate cap hold for the call as a whole and any refusal rolls the caller's transaction back.
 */
export async function applyAgentTickerTemplates(
  tx: Prisma.TransactionClient,
  args: { appId: string; agentId: string; worker: { id: string; name: string }; createdBy: string | null },
): Promise<{ created: Array<{ tickerId: string; subscriptionId: string; plan: PlannedTicker }>; alreadyPresent: TemplateRow[] }> {
  await lockAgentTemplates(tx, args.agentId, 'shared');
  const installed = await tx.$queryRaw<Array<{ ok: number }>>`
    SELECT 1 AS ok FROM app_agents aa JOIN agents a ON a.id = aa.agent_id
    WHERE aa.app_id = ${args.appId} AND aa.agent_id = ${args.agentId} AND a.deleted_at IS NULL FOR SHARE OF aa, a`;
  if (installed.length === 0) throw new GeneratedAgentNotInstalledError(args.appId);
  const templates = await liveTemplates(tx, args.agentId);
  const have = new Set(
    (await tx.ticker.findMany({
      where: { generatedForWorkerId: args.worker.id, deletedAt: null, sourceTemplateId: { in: templates.map((t) => t.id) } },
      select: { sourceTemplateId: true },
    })).map((t) => t.sourceTemplateId),
  );
  const missing = new Set(templates.filter((t) => !have.has(t.id)).map((t) => t.id));
  const plans = await planGeneratedTickers(tx, { appId: args.appId, agentId: args.agentId, workerName: args.worker.name, onlyTemplateIds: missing });
  const created = await writeGeneratedTickers(tx, { appId: args.appId, worker: args.worker, createdBy: args.createdBy, plans });
  return { created, alreadyPresent: templates.filter((t) => have.has(t.id)) };
}

/**
 * Retirement: soft-delete ONLY the tickers generated for this worker, ending every live subscription to them
 * with the standard ticker-deleted history. A runtime ticker the worker created, an App ticker, and another
 * worker's generated ticker are never touched. The caller holds the App ticker lock (taken after the graph lock).
 */
export async function endGeneratedTickersForWorker(
  tx: Prisma.TransactionClient,
  args: { workerId: string; deletedBy: string | null },
): Promise<number> {
  const actor = currentActor();
  const now = new Date();
  const doomed = await tx.ticker.findMany({
    where: { generatedForWorkerId: args.workerId, deletedAt: null },
    select: { id: true },
  });
  if (doomed.length === 0) return 0;
  const ids = doomed.map((t) => t.id);
  await tx.tickerSubscription.updateMany({
    where: { tickerId: { in: ids }, endedAt: null },
    data: {
      endedAt: now, endedReason: 'TICKER_DELETED',
      endedBy: args.deletedBy, endedByWorkerId: actor.workerId, endedByAgentId: actor.agentId,
    },
  });
  await tx.ticker.updateMany({
    where: { id: { in: ids }, deletedAt: null },
    data: { deletedAt: now, deletedBy: args.deletedBy, deletedByWorkerId: actor.workerId, deletedByAgentId: actor.agentId },
  });
  return ids.length;
}
