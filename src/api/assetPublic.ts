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
 * When safeguards land, the likely shape is an explicit per-asset
 * publish flag (default off) plus an unguessable token in the path, so
 * that only assets whose owner opted in are reachable and a leaked id
 * is not by itself sufficient. Until then, treat every uploaded asset
 * as world-readable-if-its-id-leaks and size the risk accordingly.
 *
 * What this route still enforces, and must keep enforcing:
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
 * Absolute public URL for an asset, or null when no canonical origin is
 * configured.
 *
 * Follows the project's emit-no-link-when-unset posture: a link built
 * on a wrong or missing origin is worse than no link at all, because
 * the caller cannot tell it is broken.
 */
export function publicAssetUrl(assetId: string): string | null {
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

/** Mount the unauthenticated asset hotlink route. */
export function mountPublicAssetRoutes(app: Express, db: PrismaClient): void {
  app.get('/assets/:id', async (req, res) => {
    const assetId = String(req.params.id ?? '');

    const asset = await db.asset.findUnique({ where: { id: assetId } });

    // Every rejection below answers an identical bare 404. The route is
    // anonymous, so a descriptive error would let a stranger probe for
    // which asset ids exist, which are pending a scan, and which sit in
    // encrypted memories.
    const notFound = () => res.status(404).json({ error: 'not found' });

    if (!asset || asset.deletedAt || !asset.memoryId) return notFound();
    if (asset.scanStatus !== 'CLEAN') return notFound();

    const memory = await db.memory.findUnique({
      where: { id: asset.memoryId },
      select: { isEncrypted: true },
    });
    if (!memory) return notFound();
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
        responseContentDisposition: `inline; filename="${asset.filename.replace(/"/g, '')}"`,
        responseContentType: asset.mimeType,
      });
    } catch {
      return res.status(503).json({ error: 'object storage unavailable' });
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
    res.redirect(302, url);
  });
}
