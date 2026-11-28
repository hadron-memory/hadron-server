// Ticker slug minting — #1747, cor:agt:080:01, Holger #8083.
//
// A ticker's URN is `hrn:ticker:<root>:<app-slug>:<slug>`. The slug is derived
// from the NAME at creation and is PERMANENT: unique within the App forever,
// deleted tickers included, so a re-created `engineering` gets `engineering-2`.
// Like `nextFreeWorkerSlug` (src/lib/workerSlug.ts) minting NEVER REFUSES: it
// advances to `-2`, `-3`, ... until an atom is free and not a reserved word (#5203 S3). `tickers_app_slug_uniq`
// arbitrates; a concurrent create re-runs this on P2002.

import { workerSlugCandidate } from '../workerSlug.js';
import { isReservedSlug } from '../derivedSlug.js';
import { deriveSlugFromName } from '../urn.js';

export const TICKER_SLUG_FALLBACK = 'ticker';

/** The slug atom a ticker name slugifies to; `ticker` for a name that leaves nothing. */
export function tickerSlugBase(name: string): string {
  try {
    return deriveSlugFromName(name);
  } catch {
    // `empty-derived-slug` — nothing in the charset survived.
    return TICKER_SLUG_FALLBACK;
  }
}

type TickerSlugDb = {
  ticker: {
    findMany: (args: {
      where: { appId: string; OR: { slug: string | { startsWith: string } }[] };
      select: { slug: true };
    }) => Promise<{ slug: string }[]>;
  };
};

/** The first slug free for `name` in `appId`, counting deleted tickers. Advisory. */
export async function nextFreeTickerSlug(db: TickerSlugDb, appId: string, name: string): Promise<string> {
  const base = tickerSlugBase(name);
  const rows = await db.ticker.findMany({
    where: { appId, OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
    select: { slug: true },
  });
  const taken = new Set(rows.map((r) => r.slug));
  for (let n = 1; ; n++) {
    const candidate = workerSlugCandidate(base, n);
    // #5203 S3: a reserved word is skipped like a taken slug (cor:urn:010:01), case-insensitively.
    if (!taken.has(candidate) && !isReservedSlug(candidate)) return candidate;
  }
}
