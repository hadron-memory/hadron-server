/**
 * Public asset hotlinks — `GET /assets/:id`.
 *
 * ⚠️  THIS ROUTE IS DELIBERATELY UNAUTHENTICATED. ⚠️
 *
 * Anyone holding the URL can fetch the bytes. There is no session, no
 * bearer token, and no memory read gate: the asset id IS the
 * credential, and asset ids are not secrets — they are returned by
 * every asset read surface and embedded in reference nodes.
 *
 * This is a KNOWN, ACCEPTED, TEMPORARY posture (Holger, 2026-08-06):
 * he has a use case that needs a stable URL an external consumer can
 * embed, and safeguarding it comes later. It is called out here rather
 * than buried so nobody mistakes it for an oversight, and so the
 * eventual fix has an obvious home.
 *
 * Since #1667 (cor:dmo:060:15) a per-asset opt-in guards it: an asset is served
 * only while its `publicLinkEnabled` switch is on (default off, switched by the
 * memory's manager through `setAssetPublicLink`), on top of the deployment gate
 * below and the checks that follow. A leaked id alone is therefore no longer
 * enough for an asset nobody published.
 *
 * What this route still enforces, and must keep enforcing:
 *   - `publicLinkEnabled` — the per-asset opt-in (#1667).
 *   - `scanStatus = CLEAN` — the malware gate is NOT relaxed here
 *     (cor:dmo:060:10 makes the clean-scan download gate an invariant
 *     independent of the entry path).
 *   - not soft-deleted, and attached to a memory.
 *   - encrypted memories are NEVER served: the storage key can only be
 *     decrypted with a session key, which an anonymous request has no
 *     way to hold. An encrypted memory's assets are simply not
 *     hotlinkable, by construction.
 *
 * Implementation note: the route 302s to a short-TTL presigned GET
 * rather than streaming bytes through the server. The public URL stays
 * stable while the credential the object store actually sees expires
 * in minutes, and hadron-server never proxies file traffic.
 */

import type { Express } from 'express';
import type { PrismaClient } from '../generated/prisma/index.js';
import { mintGetUrl } from '../integrations/r2/client.js';
import { decryptStorageKey } from '../lib/asset/encryption.js';
import { logAssetEvent } from '../lib/asset/audit.js';

/** TTL of the presigned URL the public route redirects to. */
const REDIRECT_TTL_SECONDS = 5 * 60;

/**
 * Is the anonymous hotlink switched on for this deployment?
 *
 * **Default OFF.** The route hands out uploaded bytes to anyone holding
 * an asset id, and — until a malware scanner exists (#896) — those bytes
 * are unscanned, so a deployment that never asked for this should not
 * have it. Opting in is one env var; discovering you were serving
 * unscanned files anonymously because it was on by default is not
 * recoverable.
 *
 * Read per call rather than cached at module load so a deployment can
 * turn it off with a restart, and so tests can flip it.
 */
export function isPublicHotlinkEnabled(): boolean {
  return process.env.ASSET_PUBLIC_HOTLINK_ENABLED === 'true';
}

/**
 * Absolute public URL for an asset, or null when no canonical origin is
 * configured.
 *
 * Follows the project's emit-no-link-when-unset posture: a link built
 * on a wrong or missing origin is worse than no link at all, because
 * the caller cannot tell it is broken.
 */
export function publicAssetUrl(assetId: string): string | null {
  // No link when the route is switched off — otherwise a client offers a
  // "copy link" action for a URL that 404s.
  if (!isPublicHotlinkEnabled()) return null;
  const base = process.env.BASE_URL;
  if (!base) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${base.replace(/\/+$/, '')}/assets/${assetId}`;
  } catch {
    return null;
  }
}

/**
 * Sanitize a filename for use inside a quoted HTTP header parameter.
 *
 * Filenames are user-supplied at upload time and this value is handed to
 * the object store, which reflects it back as a `Content-Disposition`
 * response header — so CR/LF would be a header-injection vector, not
 * merely cosmetic. Strip quotes, CR/LF, and every other control
 * character rather than just the quote.
 */
export function sanitizeFilenameForHeader(filename: string): string {
  // eslint-disable-next-line no-control-regex
  return filename.replace(/["\\]/g, '').replace(/[\u0000-\u001f\u007f]/g, '');
}

/** Mount the unauthenticated asset hotlink route. */
export function mountPublicAssetRoutes(app: Express, db: PrismaClient): void {
  app.get('/assets/:id', async (req, res, next) => {
    // Express 4 does not forward an async handler's rejection to the
    // error middleware, so an unhandled Prisma failure would hang the
    // request and surface as an unhandled rejection instead of a 5xx.
    // Everything below runs inside this try; genuine faults go to next().
    try {
      const assetId = String(req.params.id ?? '');

      // Checked inside the handler, not at mount time, so toggling it is a
      // restart rather than a redeploy — and so the disabled response is
      // the same 404 as every other rejection, revealing nothing about
      // whether the feature exists or the asset does.
      if (!isPublicHotlinkEnabled()) {
        return res.status(404).json({ error: 'not found' });
      }

      const asset = await db.asset.findUnique({ where: { id: assetId } });

      // Every rejection below answers an identical bare 404 — including
      // the object-store failure at the end. The route is anonymous, so
      // any distinguishable response lets a stranger probe for which
      // asset ids exist, which are pending a scan, and which sit in
      // encrypted memories. A 503 would have been such a tell: it is
      // only reachable for an asset that passed every gate, so during an
      // outage it would confirm "this id exists and is clean".
      const notFound = () => res.status(404).json({ error: 'not found' });

      if (!asset || asset.deletedAt || !asset.memoryId) return notFound();
      if (asset.scanStatus !== 'CLEAN') return notFound();
      // #1667, cor:dmo:060:15: the per-asset opt-in. OFF is the default for every
      // asset and answers the SAME bare 404 as a missing one.
      if (!asset.publicLinkEnabled) return notFound();

      const memory = await db.memory.findUnique({
        where: { id: asset.memoryId },
        select: { isEncrypted: true, deletedAt: true },
      });
      if (!memory) return notFound();
      // A soft-deleted memory is terminal — there is no restore
      // mutation, and its assets are excluded from every normal read
      // surface. Without this check a public URL kept serving the file
      // indefinitely after the owner deleted the memory holding it
      // (PR #888 review, Codex P1).
      if (memory.deletedAt) return notFound();
      // Anonymous requests hold no session key, so an encrypted memory's
      // storage key can never be decrypted here.
      if (memory.isEncrypted) return notFound();

      let plainStorageKey: string;
      try {
        plainStorageKey = decryptStorageKey(asset.storageKey, null);
      } catch {
        return notFound();
      }

      let url: string;
      try {
        url = await mintGetUrl({
          key: plainStorageKey,
          ttlSeconds: REDIRECT_TTL_SECONDS,
          responseContentDisposition: `inline; filename="${sanitizeFilenameForHeader(asset.filename)}"`,
          responseContentType: asset.mimeType,
        });
      } catch (err) {
        // Logged, not surfaced: the operator signal belongs in the logs,
        // not in a response that would otherwise become an oracle.
        logAssetEvent({
          operation: 'download-url-issued',
          assetId: asset.id,
          memoryId: asset.memoryId,
          error: `public hotlink presign failed: ${String(err)}`,
        });
        return notFound();
      }

      logAssetEvent({
        operation: 'download-url-issued',
        assetId: asset.id,
        memoryId: asset.memoryId,
        userId: null,
        ttlSeconds: REDIRECT_TTL_SECONDS,
        reason: 'public hotlink (unauthenticated)',
      });

      // 302, not 301: the target is a short-lived presigned URL and must
      // never be cached as this asset's permanent location.
      return res.redirect(302, url);
    } catch (err) {
      return next(err);
    }
  });
}
