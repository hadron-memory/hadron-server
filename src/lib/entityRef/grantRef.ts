/**
 * resolveGrantRef — convert a grant reference to a definite Grant (#3709, Grants S2a-urn;
 * cor:urn:010:01's Grant row, shape ruled by rulings:0255 item 9). A Grant is addressable
 * two ways:
 *   - a bare Grant id (the `grants.id` column — a 32-hex uuidv7), or
 *   - a grammar-v2 URN `hrn:grant:<root>:<app-slug>:<grant-id>`.
 *
 * Grant has NO `urn` column (like Worker / AppRun / AiServiceConfig) — the URN is COMPUTED
 * from the App's URN plus the grant's id ({@link composeGrantUrn}), the form cor:urn:010:01
 * rules and urn-lib-js 0.0.22 composes (`composeGrantUrnV2`). The leaf atom is the id, so
 * the URN is 1:1 with the row and never minted from a display name.
 *
 * The URN path parses the flat v2 shape, reconstructs the owning App's URN from
 * `<root>:<app-slug>`, and resolves it to an App id **by reference** — through
 * `resolveAppRef`, which walks the App's rename alias map — exactly as the worker URN
 * resolver does (findings:app-rename-orphans-computed-worker-urns, review:urn-handling):
 * an App rename never breaks a grant URN. The grant is then the row whose id is the leaf
 * AND whose App is the resolved one, so a URN of another App names nothing even when its
 * leaf collides with a readable row's id.
 *
 * This helper answers IDENTITY only, never authorization: every caller applies its own
 * gate afterwards (the worker row scope of src/lib/grants/read.ts). A well-formed URN that
 * names nothing is deliberately indistinguishable from any other miss — no existence
 * oracle (cor:api:140:02) — while a MALFORMED or wrong-type URN is the typed input refusal
 * `UrnNotQualifiedError` (cor:api:140:01), which the boundary surfaces as URN_NOT_QUALIFIED.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { isId as isIdFunc } from './shape.js';
import { composeGrantUrnV2, parseUrnV2, composeUrnV2, UrnNotQualifiedError, UrnParseError } from '../urn.js';
import { AppNotFoundError, GrantNotFoundError } from './errors.js';
import { resolveAppRef } from './appRef.js';

/**
 * Compose the canonical `hrn:grant:<root>:<app-slug>:<grant-id>` URN from the App's URN
 * (the stored bare `<root>:<slug>` form) and the grant's id — the emit half of #3709.
 * Throws if the app URN isn't a simple `<root>:<slug>` pair: the grant's arity is fixed
 * by design, exactly like the worker's (`composeWorkerUrn`).
 */
export function composeGrantUrn(appUrn: string, grantId: string): string {
  const firstColon = appUrn.indexOf(':');
  if (firstColon === -1) throw new Error(`Malformed app URN (no root:slug): ${appUrn}`);
  const root = appUrn.slice(0, firstColon);
  const slug = appUrn.slice(firstColon + 1);
  return composeGrantUrnV2(root, slug, grantId);
}

/**
 * Parse a grant URN's grammar — pure, no database. Throws {@link UrnNotQualifiedError}
 * for a malformed URN or one of another type (cor:api:140:01's typed input refusal);
 * callers that conceal instead of refusing catch it (it is in `refNamesNothing`'s set).
 */
export function parseGrantUrn(ref: string): { root: string; appSlug: string; grantId: string } {
  const trimmed = (ref ?? '').trim();
  let p: ReturnType<typeof parseUrnV2>;
  try {
    p = parseUrnV2(trimmed);
  } catch (err) {
    // Attach the grammar's own cause when there is one, so the boundary's
    // URN_NOT_QUALIFIED mapping carries the real reason (malformed grammar,
    // invalid charset, …) instead of swallowing it.
    throw new UrnNotQualifiedError(trimmed, err instanceof UrnParseError ? err : undefined);
  }
  if (p.type !== 'grant') throw new UrnNotQualifiedError(trimmed);
  return { root: p.root, appSlug: p.segments[0]!, grantId: p.segments[1]! };
}

export async function resolveGrantRef(
  db: Pick<PrismaClient, 'grant' | 'app' | 'urnAlias'>,
  ref: string,
  options?: { appScope?: Prisma.AppWhereInput },
): Promise<{ id: string; appId: string }> {
  const trimmed = (ref ?? '').trim();

  if (isIdFunc(trimmed)) {
    const row = await db.grant.findUnique({ where: { id: trimmed }, select: { id: true, appId: true } });
    if (!row) throw new GrantNotFoundError(ref);
    return { id: row.id, appId: row.appId };
  }

  const { root, appSlug, grantId } = parseGrantUrn(trimmed);

  // Look the App up BY REFERENCE (the alias map walk), never by parsing the slug out of
  // the row: an App rename must keep this URN resolving (rulings:0255 item 9 (4)).
  let appId: string;
  try {
    ({ id: appId } = await resolveAppRef(db, composeUrnV2('app', root, appSlug), { scope: options?.appScope }));
  } catch (err) {
    if (err instanceof AppNotFoundError) throw new GrantNotFoundError(ref);
    throw err;
  }

  const row = await db.grant.findUnique({ where: { id: grantId }, select: { id: true, appId: true } });
  if (!row || row.appId !== appId) throw new GrantNotFoundError(ref);
  return { id: row.id, appId: row.appId };
}
