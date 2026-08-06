/**
 * listAssets — the uniform cross-memory asset list (#891).
 *
 * Tested one case per PRINCIPAL SHAPE rather than per code path. That is
 * the explicit lesson of #888: its uploader-only gate survived because
 * every fixture uploaded as the calling user, so the wrong gate and the
 * right one agreed on every case exercised. Here that means an uploader,
 * a co-member who uploaded nothing, a non-member, an App key, and the
 * NULL-uploader (run-created) row.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { listAssets } from './listAssets.js';
import { MAX_MEMORY_SCOPE_REFS } from '../../lib/usageActivity.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let memA: { id: string };
let memB: { id: string };
let uploader: { id: string };
let coMember: { id: string };
let outsider: { id: string };

/** A Context shaped like the GraphQL one, for a plain user principal. */
function userCtx(userId: string, over: Partial<Context> = {}): Context {
  return { db, userId, roles: ['READER'], ...over } as unknown as Context;
}

async function makeUser(tag: string) {
  return db.user.create({
    data: {
      id: generateId(),
      handle: `assets-${tag}-${generateId()}`,
      email: `assets-${tag}-${generateId()}@example.com`,
      roles: ['READER'],
    },
  });
}

async function makeAsset(
  memoryId: string,
  filename: string,
  over: Partial<{ uploadedBy: string | null; mimeType: string; scanStatus: 'PENDING' | 'CLEAN' | 'BLOCKED'; deletedAt: Date }> = {},
) {
  return db.asset.create({
    data: {
      id: generateId(),
      memoryId,
      filename,
      mimeType: over.mimeType ?? 'application/pdf',
      sizeBytes: 100,
      storageKey: `key-${generateId()}`,
      scanStatus: over.scanStatus ?? 'CLEAN',
      uploadedBy: over.uploadedBy === undefined ? uploader.id : over.uploadedBy,
      deletedAt: over.deletedAt ?? null,
    },
  });
}

const names = (page: { items: Array<{ filename: string }> }) =>
  page.items.map((a) => a.filename).sort();

beforeEach(async () => {
  await cleanDb(db);
  orgA = await db.organization.create({
    data: { id: generateId(), name: 'Org A', urn: `org-a-${generateId()}` },
  });
  orgB = await db.organization.create({
    data: { id: generateId(), name: 'Org B', urn: `org-b-${generateId()}` },
  });
  uploader = await makeUser('uploader');
  coMember = await makeUser('comember');
  outsider = await makeUser('outsider');

  memA = await db.memory.create({
    data: {
      id: generateId(), class: 'knowledge', organizationId: orgA.id,
      urn: `${orgA.urn}:docs`, name: 'A docs', visibility: 'ORGANIZATION',
    },
  });
  memB = await db.memory.create({
    data: {
      id: generateId(), class: 'knowledge', organizationId: orgB.id,
      urn: `${orgB.urn}:docs`, name: 'B docs', visibility: 'ORGANIZATION',
    },
  });
  // uploader and coMember are in BOTH orgs; outsider is in neither.
  for (const u of [uploader, coMember]) {
    for (const o of [orgA, orgB]) {
      await db.orgMember.create({
        data: { userId: u.id, organizationId: o.id, role: 'CONTRIBUTOR' },
      });
    }
  }

  await makeAsset(memA.id, 'a-mine.pdf');
  await makeAsset(memB.id, 'b-mine.pdf');
});

describe('listAssets — principal shapes', () => {
  it('the uploader sees their assets across every readable memory', async () => {
    const page = await listAssets(userCtx(uploader.id), {});
    expect(names(page)).toEqual(['a-mine.pdf', 'b-mine.pdf']);
    expect(page.total).toBe(2);
  });

  it("a co-member who uploaded nothing sees the same set", async () => {
    // The gate is the MEMORY's, not uploader identity (cor:dmo:060:10).
    const page = await listAssets(userCtx(coMember.id), {});
    expect(names(page)).toEqual(['a-mine.pdf', 'b-mine.pdf']);
  });

  it('a non-member sees nothing', async () => {
    const page = await listAssets(userCtx(outsider.id), {});
    expect(page).toEqual({ items: [], total: 0 });
  });

  it('includes run-created assets with a NULL uploader', async () => {
    await makeAsset(memA.id, 'run-output.csv', { uploadedBy: null });
    const page = await listAssets(userCtx(coMember.id), {});
    expect(names(page)).toContain('run-output.csv');
  });

  it('returns nothing under impersonation, even for a readable memory', async () => {
    // cor:acl:100:03 — a cross-memory list is the worst place to leak:
    // it would enumerate the target's files across every org they belong
    // to, and an asset id is the credential for the unauthenticated
    // hotlink. Guarded in the controller as well as the resolver.
    const ctx = userCtx(uploader.id, {
      impersonation: { orgId: orgA.id },
    } as unknown as Partial<Context>);
    expect(await listAssets(ctx, {})).toEqual({ items: [], total: 0 });
  });

  it('an App-key caller asking for `mine` gets an empty page, not everything', async () => {
    // No user identity ⇒ "uploaded by me" has no answer. Failing to the
    // empty page keeps the filter from silently widening the result.
    const app = await db.app.create({
      data: { id: generateId(), name: 'A', urn: `${orgA.urn}:app`, organizationId: orgA.id },
    });
    const ctx = { db, appId: app.id, organizationId: orgA.id } as unknown as Context;
    expect(await listAssets(ctx, { filter: { mine: true } })).toEqual({ items: [], total: 0 });
  });
});

describe('listAssets — filters', () => {
  it('mine narrows to the caller’s own uploads without changing the gate', async () => {
    await makeAsset(memA.id, 'theirs.pdf', { uploadedBy: coMember.id });
    expect(names(await listAssets(userCtx(uploader.id), { filter: { mine: true } })))
      .toEqual(['a-mine.pdf', 'b-mine.pdf']);
    expect(names(await listAssets(userCtx(coMember.id), { filter: { mine: true } })))
      .toEqual(['theirs.pdf']);
  });

  it('mine excludes NULL-uploader rows (NULL is nobody)', async () => {
    await makeAsset(memA.id, 'run.csv', { uploadedBy: null });
    expect(names(await listAssets(userCtx(uploader.id), { filter: { mine: true } })))
      .not.toContain('run.csv');
  });

  it('orgId narrows to that org’s memories', async () => {
    const page = await listAssets(userCtx(uploader.id), { orgId: orgA.id });
    expect(names(page)).toEqual(['a-mine.pdf']);
  });

  it('orgId for a non-member org returns the empty page, not an error', async () => {
    // cor:api:100:01 — no org-existence disclosure, no admin bypass.
    const page = await listAssets(userCtx(outsider.id), { orgId: orgA.id });
    expect(page).toEqual({ items: [], total: 0 });
  });

  it('memoryRefs narrows, and accepts a URN as well as an id', async () => {
    const byId = await listAssets(userCtx(uploader.id), { filter: { memoryRefs: [memA.id] } });
    expect(names(byId)).toEqual(['a-mine.pdf']);
    const memory = await db.memory.findUniqueOrThrow({ where: { id: memA.id } });
    const byUrn = await listAssets(userCtx(uploader.id), { filter: { memoryRefs: [memory.urn] } });
    expect(names(byUrn)).toEqual(['a-mine.pdf']);
  });

  it('silently drops an unreadable memoryRef instead of leaking its existence', async () => {
    // outsider can't read memA — dropped, so the scope becomes empty
    // rather than throwing a distinguishable "forbidden".
    const page = await listAssets(userCtx(outsider.id), { filter: { memoryRefs: [memA.id] } });
    expect(page).toEqual({ items: [], total: 0 });
  });

  it('an EXPLICITLY EMPTY memoryRefs list is the empty scope, never a fallback', async () => {
    // The trap in conventions:multi-ref-scope-args — falling back to the
    // default scope here would relabel one principal's data as the
    // resource's.
    const page = await listAssets(userCtx(uploader.id), { filter: { memoryRefs: [] } });
    expect(page).toEqual({ items: [], total: 0 });
  });

  it('rejects an over-long memoryRefs list rather than resolving it', async () => {
    // One DB round trip per ref (two on a miss), so an unbounded list is
    // a cheap way to tie up a worker. Loud on the query path.
    const refs = Array.from({ length: MAX_MEMORY_SCOPE_REFS + 1 }, () => memA.id);
    await expect(
      listAssets(userCtx(uploader.id), { filter: { memoryRefs: refs } }),
    ).rejects.toThrow(/Too many memoryRefs/);
  });

  it('propagates a malformed ref instead of silently dropping it', async () => {
    // Only "names nothing" is droppable. A structurally invalid ref is
    // caller error — swallowing it would return a partial page that
    // looks complete.
    await expect(
      listAssets(userCtx(uploader.id), { filter: { memoryRefs: ['not-a-valid-urn'] } }),
    ).rejects.toThrow();
  });

  it('drops an unknown-but-well-formed ref without erroring', async () => {
    // The other side of the same rule: a syntactically fine URN that
    // resolves to nothing is the documented unknown-ref case.
    const page = await listAssets(userCtx(uploader.id), {
      filter: { memoryRefs: [`${orgA.urn}:no-such-memory`] },
    });
    expect(page).toEqual({ items: [], total: 0 });
  });

  it('filters by mimeType and scanStatus', async () => {
    await makeAsset(memA.id, 'note.txt', { mimeType: 'text/plain' });
    await makeAsset(memA.id, 'scanning.pdf', { scanStatus: 'PENDING' });
    expect(names(await listAssets(userCtx(uploader.id), { filter: { mimeType: 'text/plain' } })))
      .toEqual(['note.txt']);
    expect(names(await listAssets(userCtx(uploader.id), { filter: { scanStatus: 'PENDING' } })))
      .toEqual(['scanning.pdf']);
  });

  it('excludes soft-deleted assets unless includeDeleted', async () => {
    await makeAsset(memA.id, 'gone.pdf', { deletedAt: new Date() });
    expect(names(await listAssets(userCtx(uploader.id), {}))).not.toContain('gone.pdf');
    expect(names(await listAssets(userCtx(uploader.id), { filter: { includeDeleted: true } })))
      .toContain('gone.pdf');
  });

  it('never returns staged assets (memoryId NULL)', async () => {
    await db.asset.create({
      data: {
        id: generateId(), memoryId: null, filename: 'staged.pdf',
        mimeType: 'application/pdf', sizeBytes: 1, storageKey: `key-${generateId()}`,
        scanStatus: 'CLEAN', uploadedBy: uploader.id,
      },
    });
    expect(names(await listAssets(userCtx(uploader.id), {}))).not.toContain('staged.pdf');
  });

  it('excludes assets in a soft-deleted memory', async () => {
    await db.memory.update({ where: { id: memA.id }, data: { deletedAt: new Date() } });
    expect(names(await listAssets(userCtx(uploader.id), {}))).toEqual(['b-mine.pdf']);
  });
});

describe('listAssets — envelope', () => {
  it('paginates newest-first with an exact total', async () => {
    const page = await listAssets(userCtx(uploader.id), { limit: 1 });
    expect(page.items).toHaveLength(1);
    // total is the full match count, not the page size.
    expect(page.total).toBe(2);
    const second = await listAssets(userCtx(uploader.id), { limit: 1, offset: 1 });
    expect(second.items[0]!.id).not.toBe(page.items[0]!.id);
  });

  it('limit: 0 is count-only', async () => {
    const page = await listAssets(userCtx(uploader.id), { limit: 0 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(2);
  });
});
