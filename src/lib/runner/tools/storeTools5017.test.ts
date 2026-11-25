/**
 * #5017 (Billing A10): `hadron_store_file` and the `assetBytes` owner limit. The cap is answered BEFORE any byte is written (no object,
 * no Asset row, no reference node) and again, under the owner-limit lock, where the row is inserted; the run goes on with the tool's error.
 * Red on main: the over-cap store succeeds.
 */

import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../integrations/objectstore/index.js', () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
  deleteObject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../bus/index.js', () => ({
  getBusClient: vi.fn(async () => null),
}));

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import { PLATFORM_DEFAULT_MAX_BYTES } from '../../asset/limits.js';
import { putObject, deleteObject } from '../../../integrations/objectstore/index.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { reloadOwnerDefaultLimitsForTests } from '../../ownerLimits/defaults.js';
import { hadronStoreFile, resolveRunTools } from './index.js';
import type { AppRun } from '../../../generated/prisma/index.js';
import type { RunToolContext } from './types.js';
import { testRunAgentId } from '../../../test/runAgent.js';

const ORG_URN = 'store-tool-org';
const MEM_URN = `${ORG_URN}:filestore`;

let orgId: string;
let appId: string;
let memoryId: string;
let writerId: string;

async function mintRun(userId?: string): Promise<AppRun> {
  return db.appRun.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      appId, agentId: await testRunAgentId(db, orgId, appId),
      userId: userId ?? null,
      triggerKind: 'MANUAL',
      entryNodeUrn: `${ORG_URN}::filestore::flow:entry`,
      status: 'RUNNING',
    },
  });
}

function toolCtx(run: AppRun): RunToolContext {
  return { log: vi.fn(), db, run, principal: runContext(db, run) };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: ORG_URN, urn: ORG_URN },
  });
  orgId = org.id;
  const app = await db.app.create({
    data: { id: generateId(), organizationId: orgId, name: 'store-app', urn: `${ORG_URN}::store-app` },
  });
  appId = app.id;
  const writer = await db.user.create({ data: { handle: `store-writer-${generateId().toLowerCase()}` } });
  writerId = writer.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: writerId, role: 'CONTRIBUTOR' } });
  await db.appMember.create({ data: { appId, userId: writerId, role: 'member' } });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: orgId, name: 'filestore',
      urn: MEM_URN, class: 'knowledge', visibility: 'ORGANIZATION',
    },
  });
  memoryId = memory.id;
  // #3278: an item never grants a userless run write authority. These storage
  // success probes run on behalf of an admitted writer; userless refusals stay below.
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: orgId, name: 'store-agent', urn: `${ORG_URN}:store-agent` },
  });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.agentMemoryItem.create({
    data: { agentId: agent.id, memoryId, role: 'read-write' },
  });
});


const KB = 1024;
const CAP = 1_048_576;
const limits = (value: unknown) => reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: JSON.stringify(value) });
const text = (bytes: number) => 'x'.repeat(bytes);
const store = (run: AppRun, loc: string, bytes: number) =>
  hadronStoreFile.execute(toolCtx(run), { urn: `${ORG_URN}::filestore::files:${loc}`, filename: `${loc}.txt`, content: text(bytes) });
const seedFile = (bytes: number) =>
  db.asset.create({ data: { id: generateId(), memoryId, filename: 's.txt', mimeType: 'text/plain', sizeBytes: bytes, storageKey: `k/${generateId()}.txt`, scanStatus: 'CLEAN' } });

afterEach(() => { reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }); });

describe('#5017 hadron_store_file and the assetBytes cap', () => {
  it('a store that would exceed the cap writes no object, no Asset row and no reference node, and the error says why', async () => {
    limits({ organization: { assetBytes: CAP } });
    await seedFile(600 * KB);
    const run = await mintRun(writerId);
    const err = await store(run, 'over', 600 * KB).then(() => null, (e: unknown) => e as { extensions?: Record<string, unknown> });
    expect(err).toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED', limitKey: 'assetBytes' } });
    expect(putObject).not.toHaveBeenCalled();
    expect(await db.asset.count({ where: { memoryId } })).toBe(1); // only the seeded file
    expect(await db.node.count({ where: { memoryId, loc: 'files:over' } })).toBe(0);
  });

  it('under the cap the store goes through; over it, an on-behalf-of CONTRIBUTOR is refused in the form with no owner and no number', async () => {
    limits({ organization: { assetBytes: CAP } });
    const run = await mintRun(writerId);
    await expect(store(run, 'fits', 100 * KB)).resolves.toMatchObject({ stored: true });
    await seedFile(1000 * KB); // now over for anyone
    const behalf = await store(run, 'behalf', 100 * KB).then(() => null, (e: unknown) => e as { extensions?: Record<string, unknown> });
    expect(behalf).toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED', callerCanManageOwner: false } });
    expect(behalf?.extensions).not.toHaveProperty('limit');
    expect(behalf?.extensions).not.toHaveProperty('ownerId');
  });

  it('the FINAL check, where the row is inserted: another file landing while the bytes are written refuses the store, and its object is removed', async () => {
    limits({ organization: { assetBytes: CAP } });
    const run = await mintRun(writerId);
    // The pre-check passes (nothing is stored yet); the other file lands between it and the row.
    vi.mocked(putObject).mockImplementationOnce(async () => { await seedFile(600 * KB); });
    const err = await store(run, 'parked', 600 * KB).then(() => null, (e: unknown) => e as { extensions?: Record<string, unknown> });
    expect(err).toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED', limitKey: 'assetBytes' } });
    expect(putObject).toHaveBeenCalledOnce();
    expect(deleteObject).toHaveBeenCalledOnce(); // the compensation removes the written object
    expect(await db.asset.count({ where: { memoryId, filename: 'parked.txt' } })).toBe(0);
    expect(await db.node.count({ where: { memoryId, loc: 'files:parked' } })).toBe(0);
  });
});
