/**
 * resolveAppRunRef — convert an entity-reference string to a definite AppRun ID
 * (#696). An AppRun is addressable two ways:
 *   - a bare AppRun id (the `AppRun.id` column — a UUIDv7 hex), or
 *   - a greenfield grammar-v2 URN `hrn:apprun:<root>:<app>:<run-id>`.
 *
 * AppRun has NO `urn` column (like Secret / AiServiceConfig) — the URN is
 * computed. The URN path parses the flat v2 shape, reconstructs the owning
 * App's URN from `<root>:<app>`, resolves it to an App id, and looks the run up
 * by `(appId, id)`. "current" / "latest" / "previous" run are QUERIES that
 * resolve to a concrete run URN — never magic run-ids in URN space
 * (cor:urn:010:02).
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId as isIdFunc } from './shape.js';
import { parseUrnV2, composeUrnV2, composeAppRunUrnV2 } from '../urn.js';
import { AppNotFoundError, AppRunNotFoundError } from './errors.js';
import { resolveAppRef } from './appRef.js';

/**
 * Compose the canonical `hrn:apprun:<root>:<app>:<run-id>` URN from the run's
 * App URN (the stored bare `<root>:<slug>` form) and run id. Throws if the app
 * URN isn't a simple `<root>:<slug>` pair (an atom-shaped slug) — apprun's arity
 * is fixed by design.
 */
export function composeAppRunUrn(appUrn: string, runId: string): string {
  const firstColon = appUrn.indexOf(':');
  if (firstColon === -1) throw new Error(`Malformed app URN (no root:slug): ${appUrn}`);
  const root = appUrn.slice(0, firstColon);
  const slug = appUrn.slice(firstColon + 1);
  return composeAppRunUrnV2(root, slug, runId);
}

export async function resolveAppRunRef(
  db: Pick<PrismaClient, 'appRun' | 'app' | 'urnAlias'>,
  ref: string,
): Promise<{ id: string }> {
  if (isIdFunc(ref)) {
    const run = await db.appRun.findUnique({ where: { id: ref }, select: { id: true } });
    if (!run) throw new AppRunNotFoundError(ref);
    return { id: run.id };
  }

  // hrn:apprun:<root>:<app>:<run-id> — greenfield v2-only shape (#696). A
  // malformed URN and an absent run are indistinguishable (no existence oracle).
  let root: string;
  let appSlug: string;
  let runId: string;
  try {
    const p = parseUrnV2(ref);
    if (p.type !== 'apprun') throw new AppRunNotFoundError(ref);
    root = p.root;
    [appSlug, runId] = p.segments as [string, string];
  } catch (err) {
    if (err instanceof AppRunNotFoundError) throw err;
    throw new AppRunNotFoundError(ref);
  }

  let appId: string;
  try {
    ({ id: appId } = await resolveAppRef(db, composeUrnV2('app', root, appSlug)));
  } catch (err) {
    if (err instanceof AppNotFoundError) throw new AppRunNotFoundError(ref);
    throw err;
  }

  const run = await db.appRun.findFirst({ where: { appId, id: runId }, select: { id: true } });
  if (!run) throw new AppRunNotFoundError(ref);
  return { id: run.id };
}
