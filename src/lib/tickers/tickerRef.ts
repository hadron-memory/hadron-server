/**
 * resolveTickerRef — a ticker is addressable by its id or by its URN
 * `hrn:ticker:<root>:<app-slug>:<slug>` (cor:urn:010:01, #1747).
 *
 * Like a Worker, a Ticker has NO `urn` column: the URN is COMPUTED from the
 * App's URN plus the stored permanent `slug`. Deleted tickers resolve (their
 * slug is never reused); callers that care check `deletedAt`.
 *
 * Answers IDENTITY only, never authorization. A malformed URN and an absent
 * ticker are indistinguishable.
 *
 * SEAM: urn-lib-js has no `ticker` type until hadron-memory/urn-lib-js#20
 * ships, so the shape is composed and parsed here against the same grammar
 * (`composeWorkerUrn`'s sibling: exactly two segments after the root). Switch
 * to `composeTickerUrnV2` / `parseUrnV2` when the library bump lands.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId } from '../entityRef/shape.js';
import { composeUrnV2 } from '../urn.js';
import { AppNotFoundError } from '../entityRef/errors.js';
import { resolveAppRef } from '../entityRef/appRef.js';

export class TickerNotFoundError extends Error {
  constructor(public readonly ref: string) {
    super(`Ticker not found: ${ref}`);
    this.name = 'TickerNotFoundError';
  }
}

const TICKER_URN = /^(?:hrn|urn):ticker:([^:\s]+):([^:\s]+):([^:\s]+)$/;

/** `hrn:ticker:<root>:<app-slug>:<slug>` from the App's stored `<root>:<slug>` URN. */
export function composeTickerUrn(appUrn: string, tickerSlug: string): string {
  const i = appUrn.indexOf(':');
  if (i === -1) throw new Error(`Malformed app URN (no root:slug): ${appUrn}`);
  return `hrn:ticker:${appUrn.slice(0, i)}:${appUrn.slice(i + 1)}:${tickerSlug}`;
}

export async function resolveTickerRef(
  db: Pick<PrismaClient, 'ticker' | 'app' | 'urnAlias'>,
  ref: string,
): Promise<{ id: string; appId: string }> {
  const trimmed = (ref ?? '').trim();
  if (isId(trimmed)) {
    const t = await db.ticker.findUnique({ where: { id: trimmed }, select: { id: true, appId: true } });
    if (!t) throw new TickerNotFoundError(ref);
    return t;
  }
  const m = TICKER_URN.exec(trimmed);
  if (!m) throw new TickerNotFoundError(ref);
  const [, root, appSlug, slug] = m as unknown as [string, string, string, string];
  let appId: string;
  try {
    ({ id: appId } = await resolveAppRef(db, composeUrnV2('app', root, appSlug)));
  } catch (err) {
    if (err instanceof AppNotFoundError) throw new TickerNotFoundError(ref);
    throw err;
  }
  const t = await db.ticker.findFirst({ where: { appId, slug }, select: { id: true, appId: true } });
  if (!t) throw new TickerNotFoundError(ref);
  return t;
}
