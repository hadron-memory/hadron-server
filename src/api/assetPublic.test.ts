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
    },
  });
  return id;
}

beforeEach(async () => {
  await cleanDb(db);
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
