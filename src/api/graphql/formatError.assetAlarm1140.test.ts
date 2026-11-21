/**
 * #1140 residual (George's BLIND P2 on #4653): the formatter stops reporting ASSET_BYTES_GONE only because another alarm
 * now reports a missing object where it is DISCOVERED. This file pins both halves of that trade in one place:
 *  1. the formatter classifies AssetUploadError(ASSET_BYTES_GONE) as an expected client error (src/server.ts:189 skips
 *     Sentry for exactly those), and the wire code is kept;
 *  2. both discovery points raise the `asset.bytes_missing` Sentry event for the missing asset:
 *     - the bytes-missing sweep, over a row whose object is gone (and not for a row whose object exists);
 *     - restoreAsset, when a soft-deleted row inside its window has no object (it refuses ASSET_BYTES_GONE AND alarms).
 * The fuller sweep and restore-path pins stay in src/jobs/sweepAssetBytes.test.ts and restoreAsset.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { ORPHAN_MIN_AGE_MS } from '../../lib/asset/retention.js';
import { ASSET_BYTES_MISSING_TAG, resetAssetBytesMissingDedupe } from '../../lib/asset/bytesMissingAlarm.js';
import { AssetUploadError } from '../../controller/operations/beginAssetUpload.js';
import { restoreAsset } from '../../controller/operations/restoreAsset.js';
import { sweepAssetBytes } from '../../jobs/sweepAssetBytes.js';
import { isOrgAdminFor } from './schema/resolvers.helpers.js';
import { formatGraphQLError, isExpectedClientError } from './formatError.js';

const headObjectMock = vi.hoisted(() => vi.fn());
const captureMock = vi.hoisted(() => vi.fn());
vi.mock('../../integrations/objectstore/index.js', async (orig) => ({ ...(await orig<object>()), headObject: headObjectMock, isObjectStoreConfigured: () => true }));
vi.mock('@sentry/node', () => ({ captureMessage: captureMock }));

describe('#1140: the formatter goes quiet on ASSET_BYTES_GONE', () => {
  it('keeps the wire code and classifies the refusal as expected (skipped by Sentry)', () => {
    const err = new AssetUploadError('ASSET_BYTES_GONE', 'gone');
    const wire = formatGraphQLError({ message: err.message, extensions: {} } as never, new GraphQLError(err.message, { originalError: err }));
    expect(wire.extensions?.code).toBe('ASSET_BYTES_GONE');
    expect(isExpectedClientError(err)).toBe(true);
  });
});

describe('#1140: both discovery points alarm instead', () => {
  const NOW = new Date('2026-10-23T12:00:00Z');
  const OLD = new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS - 60_000);
  let memoryId: string;
  let userId: string;

  async function asset(over: { deletedAt?: Date; uploadedBy?: string } = {}) {
    const id = generateId();
    return db.asset.create({ data: {
      id, memory: { connect: { id: memoryId } }, filename: `${id}.pdf`, mimeType: 'application/pdf', sizeBytes: 10,
      storageKey: `alarm-org/bytes/${id}.pdf`, scanStatus: 'CLEAN', uploadedAt: OLD,
      ...(over.deletedAt ? { deletedAt: over.deletedAt } : {}), ...(over.uploadedBy ? { uploadedBy: over.uploadedBy } : {}),
    } });
  }

  /** The one alarm event: error level, tagged asset.bytes_missing, fingerprinted by the asset, naming where it was found. */
  function expectOneAlarm(assetId: string, source: string) {
    expect(captureMock).toHaveBeenCalledTimes(1);
    const [message, event] = captureMock.mock.calls[0];
    expect(String(message)).toBe('Asset row has no object in storage');
    expect(event.level).toBe('error');
    expect(event.tags[ASSET_BYTES_MISSING_TAG]).toBe('true');
    expect(event.tags.source).toBe(source);
    expect(event.fingerprint).toEqual([ASSET_BYTES_MISSING_TAG, assetId]);
    expect(event.extra.assetId).toBe(assetId);
  }

  beforeEach(async () => {
    await cleanDb(db);
    headObjectMock.mockReset();
    captureMock.mockReset();
    resetAssetBytesMissingDedupe();
    const org = await db.organization.create({ data: { id: generateId(), name: 'alarm-org', urn: 'alarm-org' } });
    userId = (await db.user.create({ data: { githubId: 114001, githubUsername: 'alarm-user', roles: ['READER'] } })).id;
    await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'CONTRIBUTOR' } });
    memoryId = (await db.memory.create({ data: {
      class: 'knowledge', id: generateId(), organizationId: org.id, urn: `${org.urn}:bytes`, name: 'bytes', visibility: 'ORGANIZATION',
    } })).id;
  });

  it('the sweep raises asset.bytes_missing for the row whose object is gone, and not for the one that has it', async () => {
    const gone = await asset();
    const here = await asset();
    headObjectMock.mockImplementation(async (key: string) => ({ exists: key.includes(here.id) }));
    const out = await sweepAssetBytes({ now: NOW });
    expect(out).toMatchObject({ missing: 1, reported: 1 });
    expectOneAlarm(gone.id, 'sweep');
  });

  it('restore refuses ASSET_BYTES_GONE and raises asset.bytes_missing when a row inside its window has no object', async () => {
    const gone = await asset({ deletedAt: new Date(), uploadedBy: userId });
    headObjectMock.mockResolvedValue({ exists: false });
    await expect(restoreAsset(db, { userId }, { assetId: gone.id }, isOrgAdminFor)).rejects.toMatchObject({ code: 'ASSET_BYTES_GONE' });
    expectOneAlarm(gone.id, 'restore');
  });
});
