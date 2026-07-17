/**
 * hadron_store_file (#631 P2 first slice) — DB-backed handler tests over a
 * MOCKED object-store client (same posture as janitorAssets.test.ts: the
 * S3 seam is integrations/r2/client, everything else is real).
 *
 * Pins: the asset row + reference node are created together (the 2026-07-11
 * decision: every stored file gets a reference node), authorization runs
 * BEFORE any storage side effect, and failure after the PUT compensates
 * (no orphan bytes, no asset row without its node).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../integrations/r2/client.js', () => ({
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
import { putObject, deleteObject } from '../../../integrations/r2/client.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { hadronStoreFile, resolveRunTools } from './index.js';
import type { AppRun } from '../../../generated/prisma/index.js';
import type { RunToolContext } from './types.js';

const ORG_URN = 'store-tool-org';
const MEM_URN = `${ORG_URN}:filestore`;

let orgId: string;
let appId: string;
let memoryId: string;

async function mintRun(userId?: string): Promise<AppRun> {
  return db.appRun.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      appId,
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
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: orgId, name: 'filestore',
      urn: MEM_URN, class: 'app', appId,
    },
  });
  memoryId = memory.id;
  // Run-principal write access rides the App's installed Agent's memory map.
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: orgId, name: 'store-agent', urn: `${ORG_URN}:store-agent` },
  });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.agentMemoryItem.create({
    data: { agentId: agent.id, memoryId, role: 'read-write' },
  });
});

describe('hadron_store_file', () => {
  it('is resolvable from the run-tool registry at cost 1', () => {
    const { tools, unknown } = resolveRunTools(['hadron_store_file']);
    expect(unknown).toEqual([]);
    const def = tools.find((t) => t.name === 'hadron_store_file');
    expect(def?.cost).toBe(1);
  });

  it('stores the bytes, creates the Asset row AND the reference node, returns metadata not content', async () => {
    const run = await mintRun();
    const urn = `${ORG_URN}::filestore::files:q3-report`;
    const content = '# Q3 report\n\nRevenue up.';

    const out = (await hadronStoreFile.execute(toolCtx(run), {
      urn, filename: 'q3-report.md', content, description: 'Quarterly summary',
    })) as { stored: boolean; nodeUrn: string; asset: Record<string, unknown> };

    expect(out.stored).toBe(true);
    expect(out.nodeUrn).toBe(urn);
    expect(out.asset.mimeType).toBe('text/markdown');
    expect(out.asset.sizeBytes).toBe(Buffer.byteLength(content));
    expect(out.asset.urn).toBe(`hrn:asset:${MEM_URN}:assets:${out.asset.id}`);
    // The return value carries references only — never the bytes.
    expect(JSON.stringify(out)).not.toContain('Revenue up');

    // Bytes went to the object store under the storage-key scheme.
    expect(putObject).toHaveBeenCalledOnce();
    const putArgs = vi.mocked(putObject).mock.calls[0][0];
    expect(putArgs.key).toBe(`${ORG_URN}/filestore/${out.asset.id}.md`);
    expect(putArgs.contentType).toBe('text/markdown');
    expect(putArgs.body.toString('utf8')).toBe(content);

    // Asset row: attached (not staged), CLEAN (server-authored), no user.
    const asset = await db.asset.findUniqueOrThrow({ where: { id: out.asset.id as string } });
    expect(asset.memoryId).toBe(memoryId);
    expect(asset.scanStatus).toBe('CLEAN');
    expect(asset.uploadedBy).toBeNull();
    expect(asset.description).toBe('Quarterly summary');

    // Reference node: nodeType reference, asset metadata in data, run id.
    const node = await db.node.findUniqueOrThrow({
      where: { loc_memoryId: { loc: 'files:q3-report', memoryId } },
    });
    expect(node.nodeType).toBe('reference');
    expect(node.name).toBe('q3-report.md');
    expect((node.data as { asset: { id: string } }).asset.id).toBe(out.asset.id);
    expect((node.data as { runId: string }).runId).toBe(run.id);
    expect(node.content).toContain(`hrn:asset:${MEM_URN}:assets:${out.asset.id}`);
  });

  it('records the on-behalf-of user as uploadedBy when the run has one', async () => {
    const user = await db.user.create({
      data: { githubId: 4242, githubUsername: 'store-user', roles: ['READER'] },
    });
    const run = await mintRun(user.id);
    const out = (await hadronStoreFile.execute(toolCtx(run), {
      urn: `${ORG_URN}::filestore::files:note`, filename: 'note.txt', content: 'hi',
    })) as { asset: { id: string } };
    const asset = await db.asset.findUniqueOrThrow({ where: { id: out.asset.id } });
    expect(asset.uploadedBy).toBe(user.id);
  });

  it('rejects unknown extensions without an explicit mimeType, and non-text mimeTypes', async () => {
    const run = await mintRun();
    const ctx = toolCtx(run);
    await expect(
      hadronStoreFile.execute(ctx, {
        urn: `${ORG_URN}::filestore::files:x`, filename: 'report.pdf', content: 'x',
      }),
    ).rejects.toThrow(/cannot infer a MIME type/);
    await expect(
      hadronStoreFile.execute(ctx, {
        urn: `${ORG_URN}::filestore::files:x`, filename: 'x.bin', content: 'x', mimeType: 'application/pdf',
      }),
    ).rejects.toThrow(/not storable in v1/);
    expect(putObject).not.toHaveBeenCalled();
  });

  it('enforces the platform asset size limit BEFORE any side effect', async () => {
    const run = await mintRun();
    await expect(
      hadronStoreFile.execute(toolCtx(run), {
        urn: `${ORG_URN}::filestore::files:big`,
        filename: 'big.txt',
        content: 'x'.repeat(PLATFORM_DEFAULT_MAX_BYTES + 1),
      }),
    ).rejects.toThrow(/asset limit/);
    expect(putObject).not.toHaveBeenCalled();
    expect(await db.asset.count()).toBe(0);
  });

  it('denies unwritable memories before touching storage (class gates hold)', async () => {
    const owner = await db.user.create({
      data: { githubId: 9999, githubUsername: 'diary-owner', roles: ['READER'] },
    });
    await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, name: 'diary',
        urn: `${ORG_URN}:diary`, class: 'personal', userId: owner.id,
      },
    });
    const run = await mintRun(); // no on-behalf-of user
    await expect(
      hadronStoreFile.execute(toolCtx(run), {
        urn: `${ORG_URN}::diary::files:x`, filename: 'x.txt', content: 'x',
      }),
    ).rejects.toThrow(/not writable/);
    expect(putObject).not.toHaveBeenCalled();
  });

  it('enforces the memory acceptsUploads storage policy before touching storage', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { acceptsUploads: false } });
    const run = await mintRun();
    await expect(
      hadronStoreFile.execute(toolCtx(run), {
        urn: `${ORG_URN}::filestore::files:x`, filename: 'x.txt', content: 'x',
      }),
    ).rejects.toThrow(/upload/i);
    expect(putObject).not.toHaveBeenCalled();
    expect(await db.asset.count()).toBe(0);
  });

  it('denies encrypted memories on every touch', async () => {
    await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, name: 'vault',
        urn: `${ORG_URN}:vault`, class: 'app', appId, isEncrypted: true,
      },
    });
    const run = await mintRun();
    await expect(
      hadronStoreFile.execute(toolCtx(run), {
        urn: `${ORG_URN}::vault::files:x`, filename: 'x.txt', content: 'x',
      }),
    ).rejects.toThrow(/encrypted/);
    expect(putObject).not.toHaveBeenCalled();
  });

  it('compensates on loc conflict: no asset row survives, the stored object is deleted', async () => {
    const run = await mintRun();
    const urn = `${ORG_URN}::filestore::files:taken`;
    await db.node.create({
      data: { id: generateId(), memoryId, loc: 'files:taken', name: 'occupied', tags: [] },
    });
    await expect(
      hadronStoreFile.execute(toolCtx(run), { urn, filename: 'x.md', content: 'x' }),
    ).rejects.toThrow(/already exists/);
    expect(putObject).toHaveBeenCalledOnce(); // conflict surfaces at node write…
    expect(deleteObject).toHaveBeenCalledOnce(); // …and the bytes are cleaned up
    expect(await db.asset.count()).toBe(0);
  });
});
