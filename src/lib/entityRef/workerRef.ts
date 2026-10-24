/**
 * resolveWorkerRef — convert an entity-reference string to a definite Worker ID
 * (#991). A Worker is addressable two ways:
 *   - a bare Worker id (the `Worker.id` column — a cuid), or
 *   - a grammar-v2 URN `hrn:worker:<root>:<app-slug>:<worker-slug>`.
 *
 * Worker has NO `urn` column (like AppRun / Secret / AiServiceConfig) — the URN
 * is COMPUTED from the App's URN plus the worker's stored `slug`. The URN path
 * parses the flat v2 shape, reconstructs the owning App's URN from
 * `<root>:<app-slug>`, resolves it to an App id, and looks the worker up by
 * `(appId, slug)` — the `workers_app_slug_uniq` pair.
 *
 * The leaf atom is the stored slug, never the display name: cor:agt:020:02
 * leaves names unconstrained and PR #979 allows two names to slugify to one
 * token, so a name-keyed URN would not resolve to exactly one worker.
 *
 * RETIRED workers resolve. Retirement never frees a name or a slug
 * (cor:agt:020:02), and history — PR trailers, chat archives — must keep
 * resolving; callers that care about liveness check `retiredAt` themselves, as
 * the session-binding path does.
 *
 * This helper answers IDENTITY only, never authorization: every caller applies
 * its own gate afterwards (the App-membership gate, for the session and
 * mutation paths). A malformed URN and an absent worker are deliberately
 * indistinguishable — no existence oracle.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { isId as isIdFunc } from './shape.js';
import { parseUrnV2, composeUrnV2, composeWorkerUrnV2 } from '../urn.js';
import { AppNotFoundError, WorkerNotFoundError } from './errors.js';
import { resolveAppRef } from './appRef.js';

/**
 * Compose the canonical `hrn:worker:<root>:<app-slug>:<worker-slug>` URN from
 * the App's URN (the stored bare `<root>:<slug>` form) and the worker's slug.
 * Throws if the app URN isn't a simple `<root>:<slug>` pair — worker's arity is
 * fixed by design, exactly like apprun's.
 */
export function composeWorkerUrn(appUrn: string, workerSlug: string): string {
  const firstColon = appUrn.indexOf(':');
  if (firstColon === -1) throw new Error(`Malformed app URN (no root:slug): ${appUrn}`);
  const root = appUrn.slice(0, firstColon);
  const slug = appUrn.slice(firstColon + 1);
  return composeWorkerUrnV2(root, slug, workerSlug);
}

export async function resolveWorkerRef(
  db: Pick<PrismaClient, 'worker' | 'app' | 'urnAlias'>,
  ref: string,
  options?: { scope?: Prisma.WorkerWhereInput; appScope?: Prisma.AppWhereInput },
): Promise<{ id: string }> {
  const trimmed = (ref ?? '').trim();

  if (isIdFunc(trimmed)) {
    const worker = options?.scope
      ? await db.worker.findFirst({ where: { AND: [{ id: trimmed }, options.scope] }, select: { id: true } })
      : await db.worker.findUnique({ where: { id: trimmed }, select: { id: true } });
    if (!worker) throw new WorkerNotFoundError(ref);
    return { id: worker.id };
  }

  // hrn:worker:<root>:<app-slug>:<worker-slug> — greenfield v2-only shape.
  let root: string;
  let appSlug: string;
  let workerSlug: string;
  try {
    const p = parseUrnV2(trimmed);
    if (p.type !== 'worker') throw new WorkerNotFoundError(ref);
    root = p.root;
    [appSlug, workerSlug] = p.segments as [string, string];
  } catch (err) {
    if (err instanceof WorkerNotFoundError) throw err;
    throw new WorkerNotFoundError(ref);
  }

  let appId: string;
  try {
    ({ id: appId } = await resolveAppRef(db, composeUrnV2('app', root, appSlug), { scope: options?.appScope }));
  } catch (err) {
    if (err instanceof AppNotFoundError) throw new WorkerNotFoundError(ref);
    throw err;
  }

  const worker = await db.worker.findFirst({
    where: options?.scope ? { AND: [{ appId, slug: workerSlug }, options.scope] } : { appId, slug: workerSlug },
    select: { id: true },
  });
  if (!worker) throw new WorkerNotFoundError(ref);
  return { id: worker.id };
}
