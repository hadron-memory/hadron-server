/**
 * Public asset hotlinks (GET /assets/:id).
 *
 * The route is intentionally unauthenticated, so what matters most is
 * the set of gates it does NOT relax: a non-CLEAN scan, a soft-deleted
 * or staged asset, and — the one with real blast radius — an encrypted
 * memory, whose bytes must never be reachable anonymously.
 *
 * Every rejection must be the SAME bare 404, or the route becomes a
 * probe for which asset ids exist and what state they are in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { mountPublicAssetRoutes, publicAssetUrl } from './assetPublic.js';

const mintGetUrlMock = vi.hoisted(() => vi.fn());

vi.mock('../integrations/r2/client.js', () => ({
  mintGetUrl: mintGetUrlMock,
}));

let server: Server;
let base: string;
let memory: { id: string };
let encryptedMemory: { id: string };

/** GET without following the redirect — the Location header is the assertion. */
function get(path: string) {
  return fetch(`${base}${path}`, { redirect: 'manual' });
}

async function seedAsset(
  over: Partial<{
    scanStatus: 'PENDING' | 'CLEAN' | 'BLOCKED';
    deletedAt: Date | null;
    memoryId: string | null;
    publicLinkEnabled: boolean;
  }> = {},
) {
  const id = generateId();
  await db.asset.create({
    data: {
      id,
      memoryId: over.memoryId === undefined ? memory.id : over.memoryId,
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      storageKey: `pub-key-${id}`,
      scanStatus: over.scanStatus ?? 'CLEAN',
      deletedAt: over.deletedAt ?? null,
      // #1667: these cases exercise the route's other gates, so the per-asset opt-in is ON unless a case says otherwise.
      publicLinkEnabled: over.publicLinkEnabled ?? true,
    },
  });
  return id;
}

beforeEach(async () => {
  await cleanDb(db);
  // The hotlink is OFF by default (#896 interim hardening) — it serves
  // unscanned bytes anonymously, so a deployment has to opt in. These
  // tests exercise the enabled behaviour; the disabled case has its own
  // block at the bottom.
  process.env.ASSET_PUBLIC_HOTLINK_ENABLED = 'true';
  mintGetUrlMock.mockReset();
  mintGetUrlMock.mockResolvedValue('https://store.example/presigned-get');

  const org = await db.organization.create({
    data: { id: generateId(), name: 'pub-org', urn: 'pub-org' },
  });
  memory = await db.memory.create({
    data: {
      class: 'knowledge',
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:pub`,
      name: 'pub',
      visibility: 'ORGANIZATION',
    },
  });
  encryptedMemory = await db.memory.create({
    data: {
      class: 'knowledge',
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:vault`,
      name: 'vault',
      visibility: 'ORGANIZATION',
      isEncrypted: true,
    },
  });

  const app = express();
  mountPublicAssetRoutes(app, db);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  delete process.env.ASSET_PUBLIC_HOTLINK_ENABLED;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('GET /assets/:id', () => {
  it('redirects to a presigned URL for a clean asset — with no auth at all', async () => {
    const id = await seedAsset();
    const res = await get(`/assets/${id}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://store.example/presigned-get');
  });

  it('redirects with 302, never 301', async () => {
    // The target is a short-lived presigned URL; a 301 would let a
    // client cache it as this asset's permanent location.
    const id = await seedAsset();
    expect((await get(`/assets/${id}`)).status).toBe(302);
  });

  it('serves the file inline with its own filename and type', async () => {
    const id = await seedAsset();
    await get(`/assets/${id}`);
    expect(mintGetUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        responseContentType: 'application/pdf',
        responseContentDisposition: 'inline; filename="report.pdf"',
      }),
    );
  });

  // ── Gates the public route must never relax ──

  it('404s a PENDING asset (the malware gate is not relaxed here)', async () => {
    const id = await seedAsset({ scanStatus: 'PENDING' });
    expect((await get(`/assets/${id}`)).status).toBe(404);
  });

  it('404s a BLOCKED asset', async () => {
    const id = await seedAsset({ scanStatus: 'BLOCKED' });
    expect((await get(`/assets/${id}`)).status).toBe(404);
  });

  it('404s a soft-deleted asset', async () => {
    const id = await seedAsset({ deletedAt: new Date() });
    expect((await get(`/assets/${id}`)).status).toBe(404);
  });

  it('404s a staged asset (no memory)', async () => {
    const id = await seedAsset({ memoryId: null });
    expect((await get(`/assets/${id}`)).status).toBe(404);
  });

  it('404s an asset in an ENCRYPTED memory and never signs a URL', async () => {
    // The highest-stakes case: an anonymous request holds no session
    // key, so encrypted memories are not hotlinkable by construction.
    const id = await seedAsset({ memoryId: encryptedMemory.id });
    expect((await get(`/assets/${id}`)).status).toBe(404);
    expect(mintGetUrlMock).not.toHaveBeenCalled();
  });

  it('404s an unknown id', async () => {
    expect((await get('/assets/nope')).status).toBe(404);
  });

  it('404s once the holding memory is soft-deleted', async () => {
    // Memory soft-delete is terminal (no restore mutation), so a public
    // URL must stop working — it previously kept serving the file
    // indefinitely after the owner deleted the memory.
    const id = await seedAsset();
    expect((await get(`/assets/${id}`)).status).toBe(302);

    await db.memory.update({
      where: { id: memory.id },
      data: { deletedAt: new Date() },
    });
    expect((await get(`/assets/${id}`)).status).toBe(404);
  });

  it('404s (not 503) when the object store fails, and never leaks the fault', async () => {
    // A 503 is only reachable for an asset that passed every gate, so
    // during an outage it would confirm "this id exists and is clean".
    const id = await seedAsset();
    mintGetUrlMock.mockRejectedValue(new Error('store down'));
    const real = await get(`/assets/${id}`);
    const unknown = await get('/assets/nope');
    expect(real.status).toBe(404);
    expect(`${real.status}:${await real.text()}`).toBe(
      `${unknown.status}:${await unknown.text()}`,
    );
  });

  it('strips CR/LF from the filename (header injection)', async () => {
    const id = await seedAsset();
    await db.asset.update({
      where: { id },
      data: { filename: 'evil\r\nX-Injected: yes.pdf' },
    });
    await get(`/assets/${id}`);
    const disposition = mintGetUrlMock.mock.calls[0]![0]
      .responseContentDisposition as string;
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toBe('inline; filename="evilX-Injected: yes.pdf"');
  });

  it('surfaces a database fault as a 5xx rather than hanging', async () => {
    // Express 4 does not forward an async handler's rejection, so an
    // unwrapped Prisma failure would hang the request.
    const broken = express();
    mountPublicAssetRoutes(broken, {
      asset: { findUnique: () => Promise.reject(new Error('db down')) },
    } as never);
    const srv = broken.listen(0);
    try {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/assets/anything`, {
        redirect: 'manual',
      });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('answers every rejection with an identical body (no state oracle)', async () => {
    const pending = await seedAsset({ scanStatus: 'PENDING' });
    const encrypted = await seedAsset({ memoryId: encryptedMemory.id });
    const deleted = await seedAsset({ deletedAt: new Date() });

    const bodies = await Promise.all(
      [pending, encrypted, deleted, 'nope'].map(async (id) => {
        const res = await get(`/assets/${id}`);
        return `${res.status}:${await res.text()}`;
      }),
    );
    // A stranger must not be able to tell "pending a scan" from
    // "encrypted" from "never existed".
    expect(new Set(bodies).size).toBe(1);
  });
});

describe('the hotlink is OFF unless a deployment opts in', () => {
  // #896 interim hardening. The route hands uploaded bytes to anyone
  // holding an asset id, and nothing scans them — so a deployment that
  // never asked for this must not have it. Opting in is one env var;
  // finding out you were serving unscanned files anonymously because it
  // defaulted on is not recoverable.

  it('404s a perfectly good asset when the flag is unset', async () => {
    const id = await seedAsset();
    expect((await get(`/assets/${id}`)).status).toBe(302); // enabled by beforeEach

    delete process.env.ASSET_PUBLIC_HOTLINK_ENABLED;
    expect((await get(`/assets/${id}`)).status).toBe(404);
  });

  it('never signs a URL while disabled', async () => {
    const id = await seedAsset();
    delete process.env.ASSET_PUBLIC_HOTLINK_ENABLED;
    mintGetUrlMock.mockClear();
    await get(`/assets/${id}`);
    expect(mintGetUrlMock).not.toHaveBeenCalled();
  });

  it('is indistinguishable from a missing asset while disabled', async () => {
    // Same uniform-404 property as every other rejection: a stranger must
    // not learn whether the feature is off or the id is unknown.
    const id = await seedAsset();
    delete process.env.ASSET_PUBLIC_HOTLINK_ENABLED;
    const real = await get(`/assets/${id}`);
    const unknown = await get('/assets/nope');
    expect(`${real.status}:${await real.text()}`).toBe(
      `${unknown.status}:${await unknown.text()}`,
    );
  });

  it('emits no publicUrl while disabled, so no client offers a dead link', async () => {
    // The route and the URL have to agree — gating one but still handing
    // out the other means a "copy link" action for a URL that 404s
    // (PR #897 review, Copilot).
    process.env.BASE_URL = 'https://hadronmemory.com';
    expect(publicAssetUrl('abc')).toBe('https://hadronmemory.com/assets/abc');
    delete process.env.ASSET_PUBLIC_HOTLINK_ENABLED;
    expect(publicAssetUrl('abc')).toBeNull();
  });

  it('takes effect on a restart, not a redeploy', async () => {
    // Read per request rather than captured at mount, so flipping the
    // env var is enough — no rebuild, no re-mount.
    const id = await seedAsset();
    delete process.env.ASSET_PUBLIC_HOTLINK_ENABLED;
    expect((await get(`/assets/${id}`)).status).toBe(404);
    process.env.ASSET_PUBLIC_HOTLINK_ENABLED = 'true';
    expect((await get(`/assets/${id}`)).status).toBe(302);
  });
});

describe('publicAssetUrl', () => {
  const saved = process.env.BASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = saved;
  });

  it('builds an absolute URL from BASE_URL', () => {
    process.env.BASE_URL = 'https://hadronmemory.com';
    expect(publicAssetUrl('abc')).toBe('https://hadronmemory.com/assets/abc');
  });

  it('tolerates a trailing slash', () => {
    process.env.BASE_URL = 'https://hadronmemory.com/';
    expect(publicAssetUrl('abc')).toBe('https://hadronmemory.com/assets/abc');
  });

  it('returns null when BASE_URL is unset — no link beats a wrong one', () => {
    delete process.env.BASE_URL;
    expect(publicAssetUrl('abc')).toBeNull();
  });

  it('returns null when BASE_URL is malformed', () => {
    process.env.BASE_URL = 'not a url';
    expect(publicAssetUrl('abc')).toBeNull();
  });

  it('returns null for a non-http(s) scheme', () => {
    process.env.BASE_URL = 'file:///etc';
    expect(publicAssetUrl('abc')).toBeNull();
  });
});
