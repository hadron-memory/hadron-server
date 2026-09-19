/**
 * #1205 / #1218 — the governed signals round-trip through the git mirror.
 *
 * Tested at the CODEC level (frontmatter out, frontmatter in) rather than
 * through `syncGraphFromGithub`, because the codec is where the defect lives
 * and where the dangerous case is: a file that does NOT carry the key.
 *
 * The hazard this file exists to pin is not "the value is lost". It is that the
 * OBVIOUS fix loses more than the bug did. No mirrored file on disk predates
 * this change carrying `role`, so an importer that read an absent key as `null`
 * — which is how every other optional field on `NodeYaml` is read — would clear
 * the column on the next sync of every mirrored memory. Un-governing on a
 * schedule, with nothing refused, introduced by the fix for it.
 *
 * So the load-bearing assertion here is an ABSENCE: `'role' in parsed === false`.
 * A test that only checked values would pass against the broken version.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildNodeFrontmatter } from './nodeFrontmatter.js';
import { loadNodeFromFs } from '../localFs/loadNodeFromFs.js';

const base = { id: 'n1', name: 'N', tags: [] as string[] };

describe('export — governed signals reach the frontmatter', () => {
  it('emits role and runnable when set', () => {
    const fm = buildNodeFrontmatter({ ...base, role: 'review', isRunnable: true });
    expect(fm.role).toBe('review');
    expect(fm.runnable).toBe(true);
  });

  it('omits them when unset — which is what keeps this off every existing file', () => {
    // Emit-when-set is not tidiness: it is why shipping this produces no diff
    // on the mirrors of memories that carry no governed node, and why a file
    // written before this change still means "no opinion" rather than "clear".
    const fm = buildNodeFrontmatter({ ...base });
    expect('role' in fm).toBe(false);
    expect('runnable' in fm).toBe(false);
  });
});

describe('import — absence is preserved, presence is applied', () => {
  const load = async (frontmatter: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'gsm-'));
    try {
      const md = join(dir, 'topic.md');
      writeFileSync(md, `---\nid: n1\nname: N\n${frontmatter}---\n\nbody\n`, 'utf-8');
      const { node } = await loadNodeFromFs(md, dir, 'owner/repo');
      return node as Record<string, unknown>;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('a file WITHOUT the keys yields no keys at all (the load-bearing absence)', async () => {
    const node = await load('');
    // Not `toBeNull()` — the key must be ABSENT, so the Prisma update omits it
    // and the stored value survives. `role: null` here would be the bug.
    expect('role' in node).toBe(false);
    expect('isRunnable' in node).toBe(false);
  });

  it('a file WITH role sets it', async () => {
    const node = await load('role: review\n');
    expect(node.role).toBe('review');
  });

  it('accepts `runnable`, and `isRunnable` as the legacy spelling', async () => {
    // Same two-spelling rule the edge codec already follows, for the same
    // reason: mirrors pushed by an older writer are still on disk.
    expect((await load('runnable: true\n')).isRunnable).toBe(true);
    expect((await load('isRunnable: true\n')).isRunnable).toBe(true);
  });

  it('an EXPLICIT null clears — the repo may deliberately un-govern', async () => {
    const node = await load('role: null\n');
    expect('role' in node).toBe(true);
    expect(node.role).toBeNull();
  });

  it('round-trips: export → import returns what went in', async () => {
    const fm = buildNodeFrontmatter({ ...base, role: 'spec', isRunnable: true });
    const node = await load(`role: ${fm.role}\nrunnable: ${fm.runnable}\n`);
    expect(node.role).toBe('spec');
    expect(node.isRunnable).toBe(true);
  });
});
