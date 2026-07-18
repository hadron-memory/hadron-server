/**
 * Grammar-v2 memory-URN minting for compound-scoped memories (#697 Stage 3 —
 * the minting flip).
 *
 * Before v2, the runtime/App provisioners stored a COMPOUND memory URN whose
 * scope was encoded in the URN path itself:
 *
 *   app-user (personal)  `<org>:<agent>:app-user:<opaqueId>`
 *   anon                 `<org>:<agent>:anon:<opaqueId>`
 *   app-mem (app class)  `<org>:<app>:<agent>:app-mem:<slug>`
 *   shared (app class)   `<org>:<app>:<agent>:shared`
 *
 * v2 memory URNs are FLAT and single-slug: `<root>:<slug>` (one slug atom), so a
 * node URN `<root>:<mem>:<loc…>` parses with `mem` as ONE atom (`cor:urn:010:01`)
 * and round-trips through `splitNodeUrn`. The scope that used to live in the URN
 * path now lives entirely in the row's columns (`class`, `userMemoryOfAgentId`,
 * `appId`, `userId`). This helper mints that flat single-atom URN, collapsing the
 * old compound form to its terminal atom (the rule the Task A backfill applied to
 * existing rows) and disambiguating a slug collision under the root with the
 * shared, author-derived {@link mintLocalSlug} primitive.
 *
 * ROOT authority mirrors Task A: it is the owner PRINCIPAL (org name or user
 * handle). Most compound provisioners are org-rooted (they set `organizationId`
 * and pass `org.urn`), but the app-mem path falls back to a user-owned App's own
 * root atom (a user handle). The helper is root-agnostic — it composes
 * `<root>:<slug>` for whatever bare root the caller supplies.
 *
 * COLLISION posture: the `isTaken` probe treats ANY row (live OR soft-deleted)
 * whose `urn` OR `legacyUrn` equals the candidate as taken. `urn` is unique, so a
 * soft-deleted row still occupies it — aliasing around it avoids a create-time
 * unique violation rather than silently reusing a tombstoned slot; `legacyUrn` is
 * indexed but NON-unique, and a match there means the candidate would shadow
 * another row's stored legacy identity (which resolution checks before the
 * `legacyUrn` fallback), so it too counts as taken. For the opaque-id provisioners
 * (app-user / anon) a collision is effectively impossible (a fresh `generateId`),
 * so the mint returns `<root>:<id>` unaliased; the named provisioners (app-mem /
 * shared) alias deterministically (`<slug>-<agent>`) instead of the pre-v2
 * hard-conflict, consistent with how Task A collapsed those same rows.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { mintLocalSlug } from './mintLocalSlug.js';

export interface MintMemoryUrnV2Args {
  /**
   * The bare pool root the memory is owned under — an org name (`acme.com`) or,
   * for a user-owned App, a user handle. Composed as `<root>:<slug>`.
   */
  root: string;
  /**
   * The desired terminal slug: the fresh `opaqueId` for app-user/anon, or the
   * name-derived slug for app-mem, or the fixed marker (`shared`) — kept when
   * `<root>:<slug>` is free, else aliased.
   */
  desiredSlug: string;
  /**
   * The author root used to derive a deterministic collision alias — the agent
   * slug of the provisioning agent (so an aliased app-mem reads `recipes-coder`).
   */
  authorRoot: string;
}

/**
 * Mint a collision-free, single-atom grammar-v2 memory URN (`<root>:<slug>`,
 * bare — no `hrn:` prefix, matching the stored `Memory.urn` form). Reuses
 * {@link mintLocalSlug}; the probe consults BOTH `urn` and `legacyUrn` so a
 * minted URN never shadows another row's stored legacy identity (resolution
 * checks `urn` before the `legacyUrn` fallback).
 */
export async function mintMemoryUrnV2(
  db: Pick<PrismaClient, 'memory'>,
  args: MintMemoryUrnV2Args,
): Promise<string> {
  const minted = await mintLocalSlug({
    root: args.root,
    desiredSlug: args.desiredSlug,
    authorRoot: args.authorRoot,
    isTaken: async (composedUrn) =>
      (await db.memory.count({
        where: { OR: [{ urn: composedUrn }, { legacyUrn: composedUrn }] },
      })) > 0,
  });
  return minted.urn; // bare `<root>:<slug>`, single colon.
}
