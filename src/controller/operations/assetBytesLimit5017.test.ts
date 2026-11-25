/**
 * #5017 (Billing A10, cor:acl:150:02, :04, :05): the `assetBytes` owner limit at the doors that add live bytes: begin (v1 and v2, before a
 * presigned URL exists), completion (again, because two uploads begun under the cap can complete past it), and restore. The run tool and
 * the transfer have their own files. The count is exact above 2^31 and counts a PENDING file, never a BLOCKED, a soft-deleted or a
 * deleted-memory file.
 *
 * Red on main: the second begin succeeds (no key, no check); the unknown key refuses `OWNER_DEFAULT_LIMITS` at boot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { reloadOwnerDefaultLimitsForTests } from '../../lib/ownerLimits/defaults.js';
import { OWNER_LIMIT_KEYS } from '../../lib/ownerLimits/keys.js';
import { isOrgAdminFor as isAdminFor } from '../../api/graphql/schema/resolvers.helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { beginAssetUpload, beginAssetUploadV2 } from './beginAssetUpload.js';
import { completeAssetUpload } from './completeAssetUpload.js';
import { restoreAsset } from './restoreAsset.js';
import { assetLimitCaller } from '../../lib/asset/ownerBytes.js';

const headObjectMock = vi.hoisted(() => vi.fn());
const deleteObjectMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const copyObjectMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mintPutUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue('https://r2.example/presigned-put'));
const readObjectPrefixMock = vi.hoisted(() => vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7\n')));

vi.mock('../../integrations/objectstore/index.js', () => ({
  mintPutUrl: mintPutUrlMock,
  headObject: headObjectMock,
  deleteObject: deleteObjectMock,
  copyObject: copyObjectMock,
  readObjectPrefix: readObjectPrefixMock,
  mintGetUrl: vi.fn().mockResolvedValue('https://bucket/presigned-get'),
  getObjectStoreBucket: vi.fn().mockReturnValue('test-bucket'),
}));
vi.mock('../../lib/scanClient.js', () => ({ isScanConfigured: vi.fn().mockReturnValue(false), scanUrl: vi.fn() }));

const KB = 1024;
const CAP = 1_048_576; // 1 MiB
const limits = (value: unknown) => reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: JSON.stringify(value) });
const settle = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { extensions?: Record<string, unknown>; message: string; code?: string });

let org: { id: string; urn: string };
let contrib: { id: string };
let admin: { id: string };
let person: { id: string };
let memory: { id: string; urn: string };
let personMemory: { id: string; urn: string };
let agentId: string;

const asset = (memoryId: string | null, sizeBytes: number, over: Record<string, unknown> = {}) =>
  db.asset.create({
    data: {
      id: generateId(), memoryId, filename: 'f.pdf', mimeType: 'application/pdf', sizeBytes,
      storageKey: `k/${generateId()}.pdf`, scanStatus: 'CLEAN', uploadedBy: contrib.id, ...over,
    } as never,
  });
const begin = (size: number, userId = contrib.id, memoryId = memory.id) =>
  beginAssetUploadV2(db, { userId }, { memoryId, filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: size, uploadIntent: 'USER' });
const complete = (uploadId: string, size: number, userId = contrib.id) => {
  headObjectMock.mockResolvedValue({ exists: true, contentLength: size, contentType: 'application/pdf' });
  return completeAssetUpload(db, { userId }, { uploadId });
};

beforeEach(async () => {
  await cleanDb(db);
  limits({});
  vi.clearAllMocks();
  mintPutUrlMock.mockResolvedValue('https://r2.example/presigned-put');
  deleteObjectMock.mockResolvedValue(undefined);
  copyObjectMock.mockResolvedValue(undefined);
  readObjectPrefixMock.mockResolvedValue(Buffer.from('%PDF-1.7\n'));
  org = await db.organization.create({ data: { id: generateId(), name: 'ab-org', urn: 'ab-org' } });
  contrib = await db.user.create({ data: { githubId: 501701, githubUsername: 'ab-contrib', roles: ['READER'] } });
  admin = await db.user.create({ data: { githubId: 501702, githubUsername: 'ab-admin', roles: ['READER'] } });
  person = await db.user.create({ data: { githubId: 501703, githubUsername: 'ab-person', roles: ['READER'] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: contrib.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  ] });
  memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'ab-org:files', name: 'files', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  personMemory = await db.memory.create({
    data: { id: generateId(), ownerUserId: person.id, userId: person.id, urn: 'ab-person:files', name: 'mine', class: 'private' },
  });
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: 'ab-org:buno', name: 'Buno', type: 'CHATBOT', surfaces: ['api'] },
  });
  agentId = agent.id;
  await db.app.create({
    data: {
      id: generateId(), organizationId: org.id, urn: 'ab-org:buno', name: 'Buno App', agentTools: ['asset:upload'],
      appAgents: { create: { agentId } },
    },
  });
});
afterEach(() => { reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }); });

describe('#5017 begin: the cap is answered before a presigned URL exists', () => {
  it('v2: a first 600 KB upload succeeds, a second is refused with OWNER_LIMIT_REACHED / assetBytes, and the first stays', async () => {
    limits({ organization: { assetBytes: CAP } });
    const first = await begin(600 * KB);
    const stored = await complete(first.uploadId, 600 * KB);
    mintPutUrlMock.mockClear();
    const refused = await settle(begin(600 * KB));
    expect(refused).toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED', limitKey: 'assetBytes', ownerType: 'organization' } });
    expect(mintPutUrlMock).not.toHaveBeenCalled();
    expect(await db.asset.count({ where: { memoryId: memory.id, deletedAt: null } })).toBe(1);
    expect((await db.asset.findUniqueOrThrow({ where: { id: stored.id } })).deletedAt).toBeNull();
  });

  it('v1: the Agent-addressed begin is refused the same way', async () => {
    limits({ organization: { assetBytes: CAP } });
    await asset(memory.id, 600 * KB);
    const refused = await settle(beginAssetUpload(
      db, { userId: contrib.id },
      // agentUrn accepts an id or a URN (007-entity-id-or-urn).
      { agentUrn: agentId, filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 600 * KB, uploadIntent: 'USER' },
      async () => ({ memoryId: memory.id }),
    ));
    expect(refused).toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED', limitKey: 'assetBytes' } });
    expect(mintPutUrlMock).not.toHaveBeenCalled();
  });

  it('an organization CONTRIBUTOR at the cap learns no owner, limit or number; an ADMIN gets the number and the files wording', async () => {
    limits({ organization: { assetBytes: CAP } });
    await asset(memory.id, 600 * KB);
    const asContributor = await settle(begin(600 * KB, contrib.id)) as { extensions: Record<string, unknown>; message: string };
    expect(asContributor.extensions).toMatchObject({ code: 'OWNER_LIMIT_REACHED', limitKey: 'assetBytes', callerCanManageOwner: false });
    expect(asContributor.extensions).not.toHaveProperty('ownerId');
    expect(asContributor.extensions).not.toHaveProperty('limit');
    expect(asContributor.message).not.toMatch(/\d/);
    const asAdmin = await settle(begin(600 * KB, admin.id)) as { extensions: Record<string, unknown>; message: string };
    expect(asAdmin.extensions).toMatchObject({ callerCanManageOwner: true, ownerId: org.id, limit: String(CAP) });
    expect(asAdmin.message).toBe(`This organization has reached its limit of ${CAP} bytes of files.`);
  });

  it('a person\'s own memory is limited by the person\'s form of the default', async () => {
    limits({ user: { assetBytes: CAP } });
    await asset(personMemory.id, 600 * KB, { uploadedBy: person.id });
    const refused = await settle(begin(600 * KB, person.id, personMemory.id));
    expect(refused).toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED', limitKey: 'assetBytes', ownerType: 'user', callerCanManageOwner: true, ownerId: person.id } });
  });

  it('with the variable unset, or naming another key, nothing is refused', async () => {
    await asset(memory.id, 600 * KB);
    await expect(begin(600 * KB)).resolves.toBeTruthy();
    limits({ organization: { nodes: 1 } });
    await expect(begin(600 * KB)).resolves.toBeTruthy();
  });

  it('a negative size is refused as the upload\'s own INVALID_INPUT at both begins, before any limit is read', async () => {
    const v2 = await settle(begin(-1));
    expect(v2).toMatchObject({ code: 'INVALID_INPUT' });
    const v1 = await settle(beginAssetUpload(
      db, { userId: contrib.id },
      { agentUrn: agentId, filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: -1, uploadIntent: 'USER' },
      async () => ({ memoryId: memory.id }),
    ));
    expect(v1).toMatchObject({ code: 'INVALID_INPUT' });
    expect(mintPutUrlMock).not.toHaveBeenCalled();
  });

  it('OWNER_DEFAULT_LIMITS naming assetBytes boots', () => {
    expect(() => limits({ organization: { assetBytes: 5 }, user: { assetBytes: 5 } })).not.toThrow();
  });
});

describe('#5017 completion: two uploads begun under the cap cannot both land', () => {
  it('the second completion is refused, no row is written, and its promoted and staging objects are deleted', async () => {
    limits({ organization: { assetBytes: CAP } });
    const t1 = await begin(600 * KB);
    const t2 = await begin(600 * KB); // under the cap while nothing is stored yet: the begin is not a reservation
    await complete(t1.uploadId, 600 * KB);
    deleteObjectMock.mockClear();
    const refused = await settle(complete(t2.uploadId, 600 * KB));
    expect(refused).toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED', limitKey: 'assetBytes' } });
    expect(await db.asset.count({ where: { memoryId: memory.id } })).toBe(1);
    const deleted = deleteObjectMock.mock.calls.map((c) => c[0] as string);
    expect(deleted).toContain(t2.storageKey);
    expect(deleted.length).toBeGreaterThanOrEqual(2); // the promoted key and the staging key
  });

  it('two completions racing at one file below the cap: exactly one succeeds', async () => {
    limits({ organization: { assetBytes: CAP } });
    const t1 = await begin(600 * KB);
    const t2 = await begin(600 * KB);
    const results = await Promise.allSettled([complete(t1.uploadId, 600 * KB), complete(t2.uploadId, 600 * KB)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED', limitKey: 'assetBytes' } });
    expect(await db.asset.count({ where: { memoryId: memory.id } })).toBe(1);
  });
});

describe('#5017 restore: an un-delete adds live bytes', () => {
  const deleted = (size: number, over: Record<string, unknown> = {}) => asset(memory.id, size, { deletedAt: new Date(), ...over });
  const restore = (id: string) => restoreAsset(db, { userId: contrib.id }, { assetId: id }, isAdminFor);

  it('a restore that would take the owner over the cap is refused and the file stays deleted', async () => {
    limits({ organization: { assetBytes: CAP } });
    headObjectMock.mockResolvedValue({ exists: true, contentLength: 600 * KB, contentType: 'application/pdf' });
    await asset(memory.id, 600 * KB);
    const gone = await deleted(600 * KB);
    expect(await settle(restore(gone.id))).toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED', limitKey: 'assetBytes' } });
    expect((await db.asset.findUniqueOrThrow({ where: { id: gone.id } })).deletedAt).not.toBeNull();
  });

  it('with headroom the restore succeeds; a BLOCKED file adds no counted bytes and is not checked', async () => {
    limits({ organization: { assetBytes: CAP } });
    headObjectMock.mockResolvedValue({ exists: true, contentLength: 600 * KB, contentType: 'application/pdf' });
    const gone = await deleted(600 * KB);
    await expect(restore(gone.id)).resolves.toMatchObject({ id: gone.id, deletedAt: null });
    const blocked = await deleted(900 * KB, { scanStatus: 'BLOCKED' });
    await expect(restore(blocked.id)).resolves.toMatchObject({ id: blocked.id, deletedAt: null });
  });
});

describe('#5017 what counts', () => {
  const used = () => OWNER_LIMIT_KEYS.assetBytes.count(db, { organizationId: org.id });

  it('counts live file rows until reclaimed, a deleted memory\'s included (re-gate on #5017); PENDING counts; BLOCKED, soft-deleted and memory-less files do not', async () => {
    const gone = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'ab-org:gone', name: 'gone', class: 'knowledge', visibility: 'ORGANIZATION', deletedAt: new Date() },
    });
    await asset(memory.id, 100);
    await asset(memory.id, 1600, { scanStatus: 'PENDING' });
    await asset(memory.id, 200, { scanStatus: 'BLOCKED' });
    await asset(memory.id, 400, { deletedAt: new Date() });
    await asset(gone.id, 800);
    await asset(null, 3200);
    expect(await used()).toBe(2500n); // 100 + 1600 PENDING + 800 in the deleted memory
  });

  it('deleting a memory frees no file headroom: its files keep counting until reclaimed, so the cap cannot be cycled by delete-and-refill', async () => {
    limits({ organization: { assetBytes: CAP } });
    const filled = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'ab-org:filled', name: 'filled', class: 'knowledge', visibility: 'ORGANIZATION' },
    });
    await asset(filled.id, 900 * KB);
    await db.memory.update({ where: { id: filled.id }, data: { deletedAt: new Date() } });
    expect(await settle(begin(600 * KB))).toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED', limitKey: 'assetBytes' } });
  });

  it('deleting the first file lets the second through at once', async () => {
    limits({ organization: { assetBytes: CAP } });
    const first = await asset(memory.id, 600 * KB);
    expect(await settle(begin(600 * KB))).toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED' } });
    await db.asset.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    await expect(begin(600 * KB)).resolves.toBeTruthy();
  });

  it('is exact above 2^31 bytes, as a 64-bit sum, in ownerLimits as a base-10 string', async () => {
    await asset(memory.id, 2_000_000_000);
    await asset(memory.id, 2_000_000_000);
    await asset(memory.id, 7);
    expect(await used()).toBe(4_000_000_007n);
    const rows = await (resolvers.Query as any).ownerLimits({}, { orgRef: org.id }, { db, userId: admin.id, roles: ['READER'] } as Context);
    expect(rows.find((r: { key: string }) => r.key === 'assetBytes')).toMatchObject({ used: '4000000007', limit: null });
  });
});

describe('#5017 the refusal\'s caller form', () => {
  it('assetLimitCaller: a person acting as themselves is named; an impersonated or unattended caller is not', () => {
    expect(assetLimitCaller({ userId: 'u1' })).toEqual({ userId: 'u1' });
    expect(assetLimitCaller({ userId: 'u1', impersonation: { actorUserId: 'admin' } })).toBeNull();
    expect(assetLimitCaller({ userId: null })).toBeNull();
    expect(assetLimitCaller({})).toBeNull();
  });
});
