/**
 * createAssetReferenceNode — attaching an existing asset to the graph
 * as a `reference` node.
 *
 * The two-sided gate is the point of most of these cases: READ on the
 * asset's memory, WRITE on the memory the node lands in. They are
 * separate memories in the cross-memory tests, which is exactly where
 * checking only one side would leak.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import {
  createAssetReferenceNode,
  assetIdFromRef,
} from './createAssetReferenceNode.js';

let org: { id: string; urn: string };
let user: { id: string };
let outsider: { id: string };
let memory: { id: string; urn: string };
let assetId: string;

/** Minimal GraphQL-ish context for writeNodeCore. */
function ctxFor(userId: string) {
  return {
    db,
    userId,
    roles: ['READER'],
    organizationId: org.id,
  } as never;
}

function callerFor(userId: string) {
  return { userId, roles: ['READER'] as never, organizationId: org.id };
}

async function seedAsset(over: Partial<{ memoryId: string; deletedAt: Date }> = {}) {
  assetId = generateId();
  return db.asset.create({
    data: {
      id: assetId,
      memoryId: over.memoryId ?? memory.id,
      filename: 'plan.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      storageKey: `key-${assetId}`,
      scanStatus: 'CLEAN',
      uploadedBy: user.id,
      deletedAt: over.deletedAt ?? null,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'ref-org', urn: 'ref-org' },
  });
  user = await db.user.create({
    data: { githubId: 9801, githubUsername: 'ref-user', roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { githubId: 9802, githubUsername: 'ref-outsider', roles: ['READER'] },
  });
  // A spec-047 user-owned memory: org membership alone confers only
  // READ, so a writable fixture needs an ownership path. ownerUserId
  // XOR organizationId, hence the null org.
  memory = await db.memory.create({
    data: {
      class: 'knowledge',
      id: generateId(),
      organizationId: null,
      ownerUserId: user.id,
      urn: `${org.urn}:docs`,
      name: 'docs',
      visibility: 'ORGANIZATION',
    },
  });
  await db.orgMember.create({
    data: { userId: user.id, organizationId: org.id, role: 'CONTRIBUTOR' },
  });
});

describe('assetIdFromRef', () => {
  it('passes a raw id through', () => {
    expect(assetIdFromRef('abc123')).toBe('abc123');
  });

  it('extracts the id from an asset URN', () => {
    expect(assetIdFromRef('hrn:asset:acme.com:docs:assets:abc123')).toBe('abc123');
  });

  it('extracts the id from a bare asset URN', () => {
    expect(assetIdFromRef('acme.com:docs:assets:abc123')).toBe('abc123');
  });

  it('keys on the marker, not the last atom', () => {
    // Anything trailing must not be mistaken for the id — that would
    // look up an unrelated asset rather than fail.
    expect(assetIdFromRef('acme.com:docs:assets:abc123:extra')).toBe('abc123');
  });

  it('handles a memory literally named "assets"', () => {
    expect(assetIdFromRef('acme.com:assets:assets:abc123')).toBe('abc123');
  });
});

describe('createAssetReferenceNode', () => {
  it('creates a reference node carrying the asset pointer', async () => {
    await seedAsset();
    const node = await createAssetReferenceNode(
      db,
      callerFor(user.id),
      ctxFor(user.id),
      { assetRef: assetId, nodeUrn: `hrn:node:${org.urn}:docs:files:plan` },
    );

    expect(node.nodeType).toBe('reference');
    expect(node.loc).toBe('files:plan');
    // Same data.asset shape hadron_store_file writes — one shape for
    // both origins, so readers don't branch on how the file got here.
    const data = node.data as { asset: Record<string, unknown> };
    expect(data.asset).toMatchObject({
      id: assetId,
      filename: 'plan.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
    });
    expect(String(data.asset.urn)).toContain(assetId);
  });

  it("defaults the node name to the asset's filename", async () => {
    await seedAsset();
    const node = await createAssetReferenceNode(
      db,
      callerFor(user.id),
      ctxFor(user.id),
      { assetRef: assetId, nodeUrn: `hrn:node:${org.urn}:docs:files:plan` },
    );
    expect(node.name).toBe('plan.pdf');
  });

  it('accepts an asset URN as the ref', async () => {
    await seedAsset();
    const node = await createAssetReferenceNode(
      db,
      callerFor(user.id),
      ctxFor(user.id),
      {
        assetRef: `${memory.urn}:assets:${assetId}`,
        nodeUrn: `hrn:node:${org.urn}:docs:files:plan`,
      },
    );
    expect((node.data as { asset: { id: string } }).asset.id).toBe(assetId);
  });

  it('rejects an unknown asset with NOT_FOUND', async () => {
    await expect(
      createAssetReferenceNode(db, callerFor(user.id), ctxFor(user.id), {
        assetRef: 'nope',
        nodeUrn: `hrn:node:${org.urn}:docs:files:plan`,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a soft-deleted asset with NOT_FOUND', async () => {
    await seedAsset({ deletedAt: new Date() });
    await expect(
      createAssetReferenceNode(db, callerFor(user.id), ctxFor(user.id), {
        assetRef: assetId,
        nodeUrn: `hrn:node:${org.urn}:docs:files:plan`,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a caller who cannot READ the asset\'s memory', async () => {
    // The outsider is in no org, so the asset's memory is unreadable —
    // and reports NOT_FOUND rather than a distinguishable forbidden,
    // matching the rest of the asset surface.
    await seedAsset();
    await expect(
      createAssetReferenceNode(db, callerFor(outsider.id), ctxFor(outsider.id), {
        assetRef: assetId,
        nodeUrn: `hrn:node:${org.urn}:docs:files:plan`,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects when the TARGET memory is not writable', async () => {
    // Readable asset, unwritable destination: a second memory in
    // another org the caller has no role in.
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'other-org', urn: 'other-org' },
    });
    await db.memory.create({
      data: {
        class: 'knowledge',
        id: generateId(),
        organizationId: otherOrg.id,
        urn: `${otherOrg.urn}:vault`,
        name: 'vault',
        visibility: 'ORGANIZATION',
      },
    });
    await seedAsset();

    await expect(
      createAssetReferenceNode(db, callerFor(user.id), ctxFor(user.id), {
        assetRef: assetId,
        nodeUrn: `hrn:node:${otherOrg.urn}:vault:files:plan`,
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('rejects an unknown target memory with NOT_FOUND', async () => {
    await seedAsset();
    await expect(
      createAssetReferenceNode(db, callerFor(user.id), ctxFor(user.id), {
        assetRef: assetId,
        nodeUrn: `hrn:node:${org.urn}:ghost:files:plan`,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('references an asset from a DIFFERENT memory the caller can read', async () => {
    // Cross-memory referencing is deliberate: read there, write here.
    const target = await db.memory.create({
      data: {
        class: 'knowledge',
        id: generateId(),
        organizationId: null,
        ownerUserId: user.id,
        urn: `${org.urn}:project`,
        name: 'project',
        visibility: 'ORGANIZATION',
      },
    });
    await seedAsset(); // lives in `memory`, referenced from `target`

    const node = await createAssetReferenceNode(
      db,
      callerFor(user.id),
      ctxFor(user.id),
      {
        assetRef: assetId,
        nodeUrn: `hrn:node:${org.urn}:project:files:plan`,
      },
    );
    expect(node.memoryId).toBe(target.id);
    expect((node.data as { asset: { id: string } }).asset.id).toBe(assetId);
  });
});
