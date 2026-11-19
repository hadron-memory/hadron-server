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
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Node Git mirror ordering', () => {
  it('reads the latest Node only after entering the serialized checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hadron-mirror-order-'));
    dirs.push(dir);
    const ownerRead = vi.spyOn(db.node, 'findFirst').mockResolvedValue(null);
    let enterCheckout!: () => void;
    const checkoutGate = new Promise<void>((resolve) => { enterCheckout = resolve; });
    checkout.mockImplementationOnce(async (_opts, mutate) => {
      await checkoutGate;
      await mutate({ localPath: dir, branch: 'hadron-updates', memoryUrn: 'test-org:root-memory', memoryId: 'memory-1' });
      return 'mirrored';
    });

    const initial: NodeForGit = {
      id: 'node-1', loc: 'source', name: 'Source', content: 'old', tags: [],
      role: null, isRunnable: null, isPlaceholder: false, authorshipKind: null, authoredByTask: null, authoredByRevision: null, outgoingEdges: [],
    };
    let latest = { ...initial, content: 'new' };
    const refresh = vi.fn(async () => latest);
    const writing = writeNodeToGit(initial, 'owner/repo', null, undefined, refresh);
    expect(refresh).not.toHaveBeenCalled();
    expect(ownerRead).not.toHaveBeenCalled();
    latest = { ...latest, content: 'newest' };
    enterCheckout();
    await writing;

    expect(refresh).toHaveBeenCalledOnce();
    expect(ownerRead).toHaveBeenCalledWith({ where: { memoryId: 'memory-1', loc: 'source:README', deletedAt: null }, select: { id: true } });
    expect(readFileSync(join(dir, 'source.md'), 'utf8')).toContain('newest');
    expect(readFileSync(join(dir, 'source.md'), 'utf8')).not.toContain('old\n');
  });
});
