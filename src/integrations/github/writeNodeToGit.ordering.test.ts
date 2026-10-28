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
      await mutate({ localPath: dir, branch: 'hadron-updates', memoryUrn: 'test-org:root-memory' });
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
});
