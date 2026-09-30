import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

vi.mock('./gitMirrorCheckout.js', () => ({ withMirrorCheckout: vi.fn() }));

import { withMirrorCheckout } from './gitMirrorCheckout.js';
import { writeNodeToGit, type NodeForGit } from './writeNodeToGit.js';

const checkout = vi.mocked(withMirrorCheckout);
const dirs: string[] = [];

afterEach(() => {
  vi.resetAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Node Git mirror ordering', () => {
  it('reads the latest Node only after entering the serialized checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hadron-mirror-order-'));
    dirs.push(dir);
    let enterCheckout!: () => void;
    const checkoutGate = new Promise<void>((resolve) => { enterCheckout = resolve; });
    checkout.mockImplementationOnce(async (_opts, mutate) => {
      await checkoutGate;
      await mutate({ localPath: dir, branch: 'hadron-updates' });
      return 'mirrored';
    });

    const initial: NodeForGit = {
      id: 'node-1', loc: 'source', name: 'Source', content: 'old', tags: [],
      role: null, isRunnable: null, isPlaceholder: false, outgoingEdges: [],
    };
    let latest = { ...initial, content: 'new' };
    const refresh = vi.fn(async () => latest);
    const writing = writeNodeToGit(initial, 'owner/repo', null, 'memory-1', refresh);
    expect(refresh).not.toHaveBeenCalled();
    latest = { ...latest, content: 'newest' };
    enterCheckout();
    await writing;

    expect(refresh).toHaveBeenCalledOnce();
    expect(readFileSync(join(dir, 'source.md'), 'utf8')).toContain('newest');
    expect(readFileSync(join(dir, 'source.md'), 'utf8')).not.toContain('old\n');
  });

  it('does not let an older encrypted edge snapshot overwrite the newer Git file', async () => {
    await cleanDb(db);
    const dir = mkdtempSync(join(tmpdir(), 'hadron-mirror-order-'));
    dirs.push(dir);
    const org = await db.organization.create({
      data: { id: generateId(), name: 'mirror', urn: 'mirror-order-org' },
    });
    const memory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, name: 'memory',
        urn: 'mirror-order-org:memory', class: 'knowledge', isEncrypted: true,
      },
    });
    const source = await db.node.create({
      data: { id: generateId(), memoryId: memory.id, loc: 'source', name: 'Source', tags: [] },
    });
    const target = await db.node.create({
      data: { id: generateId(), memoryId: memory.id, loc: 'target', name: 'Target', tags: [] },
    });
    const edge = await db.edge.create({
      data: {
        id: generateId(), memoryId: memory.id, sourceId: source.id, targetId: target.id,
        loc: 'source:uses:target', name: 'uses', description: 'old',
      },
      include: { target: true },
    });
    const payload = (description: string): NodeForGit => ({
      id: source.id, loc: source.loc, name: source.name, content: 'plaintext',
      tags: [], role: null, isRunnable: null, isPlaceholder: false,
      outgoingEdges: [{ ...edge, description }],
      mirrorRevSeq: source.revSeq,
    });

    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    checkout.mockImplementationOnce(async (_opts, mutate) => {
      await oldGate;
      await mutate({ localPath: dir, branch: 'hadron-updates' });
      return 'mirrored';
    });
    checkout.mockImplementationOnce(async (_opts, mutate) => {
      await mutate({ localPath: dir, branch: 'hadron-updates' });
      return 'mirrored';
    });

    const oldWrite = writeNodeToGit(payload('old'), 'owner/repo', null, memory.id);
    await db.edge.update({ where: { id: edge.id }, data: { description: 'new' } });
    await writeNodeToGit(payload('new'), 'owner/repo', null, memory.id);
    releaseOld();
    await oldWrite;

    const mirrored = readFileSync(join(dir, 'source.md'), 'utf8');
    expect(mirrored).toContain('description: new');
    expect(mirrored).not.toContain('description: old');
  });
});
