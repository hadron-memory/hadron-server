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

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildNodeFrontmatter } from './nodeFrontmatter.js';
import { writeNodeFile } from './writeNodeToGit.js';
import { loadNodeFromFs } from '../localFs/loadNodeFromFs.js';

const base = { id: 'n1', name: 'N', tags: [] as string[] };

describe('export — governed signals reach the frontmatter', () => {
  it('emits a placeholder marker only for a reserved citation', () => {
    expect(buildNodeFrontmatter({ ...base, role: 'spec', isPlaceholder: true }).placeholder).toBe(true);
    expect(buildNodeFrontmatter({ ...base, role: 'spec', isPlaceholder: false })).not.toHaveProperty('placeholder');
  });
  it('emits role and runnable when set', () => {
    const fm = buildNodeFrontmatter({ ...base, role: 'review', isRunnable: true });
    expect(fm.role).toBe('review');
    expect(fm.runnable).toBe(true);
  });

  it('emits isRunnable FALSE — it is a distinct state from null, not an absence', () => {
    // @copilot, PR #1221. `findNodes(isRunnable: false)` matches only
    // explicitly-false rows and excludes the nulls, so false is observable on
    // its own; a truthy emit test rebuilt such a node as null. Deliberately
    // UNLIKE the edge codec below it, where false and absent are one state.
    const fm = buildNodeFrontmatter({ ...base, isRunnable: false });
    expect(fm.runnable).toBe(false);
    expect('runnable' in fm).toBe(true);
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

describe('export — the INCREMENTAL mirror path emits them too', () => {
  it('writeNodeFile carries the server-set placeholder marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'placeholder-write-'));
    try {
      writeNodeFile(dir, {
        id: 'reserved', loc: 'pas:010:01', name: 'Reserved', tags: [],
        role: 'spec', isRunnable: null, isPlaceholder: true, outgoingEdges: [],
      });
      expect(readFileSync(join(dir, 'pas', '010', '01.md'), 'utf-8')).toMatch(/^placeholder: true$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('writeNodeFile puts role and runnable in the file it writes', async () => {
    // The gap a mutation found, not review: wiring `pushMemoryToGit` and the
    // `NodeForGit` type left `writeNodeFile` — the path ordinary writes and
    // moves take — still calling the builder without them, and NOTHING here
    // covered it. Removing the forward from `writeNodeFile` passed every test
    // in this file, which is the definition of an untested fix.
    const dir = mkdtempSync(join(tmpdir(), 'gsm-write-'));
    try {
      writeNodeFile(dir, {
        id: 'n5',
        loc: 'topic',
        name: 'N',
        tags: [],
        role: 'review',
        isRunnable: true,
        isPlaceholder: false,
        outgoingEdges: [],
      });
      const written = readFileSync(join(dir, 'topic.md'), 'utf-8');
      expect(written).toMatch(/^role: review$/m);
      expect(written).toMatch(/^runnable: true$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('and omits them for an ungoverned node, so ordinary files are unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsm-write2-'));
    try {
      writeNodeFile(dir, {
        id: 'n6', loc: 'plain', name: 'P', tags: [],
        role: null, isRunnable: null, outgoingEdges: [],
        isPlaceholder: false,
      });
      const written = readFileSync(join(dir, 'plain.md'), 'utf-8');
      expect(written).not.toMatch(/^role:/m);
      expect(written).not.toMatch(/^runnable:/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect('isPlaceholder' in node).toBe(false);
  });

  it('loads only a true placeholder marker, warning on malformed claims', async () => {
    expect((await load('placeholder: true\n')).isPlaceholder).toBe(true);
    expect('isPlaceholder' in await load('placeholder: false\n')).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect('isPlaceholder' in await load('placeholder: "true"\n')).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('non-boolean placeholder marker'));
    } finally {
      warn.mockRestore();
    }
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

  it('an explicit null on the CANONICAL key clears, with no legacy key present', async () => {
    // @codex P2, PR #1221. `meta.runnable ?? meta.isRunnable` read this as
    // ABSENT and fell through to the legacy key; with that missing too the
    // update was omitted, so a stored `isRunnable: true` survived a file that
    // explicitly asked to clear it. My first round only tested `role: null`,
    // so the fixture could not see it — one fixture per discriminator, and
    // "which of two spellings" is a discriminator.
    const node = await load('runnable: null\n');
    expect('isRunnable' in node).toBe(true);
    expect(node.isRunnable).toBeNull();
  });

  it('the LEGACY .node/node.yaml layout round-trips them too', async () => {
    // `loadNodeFromFs` still accepts the legacy directory format, so handling
    // only the frontmatter loader rebuilt a legacy-layout memory ungoverned
    // (@copilot, PR #1221).
    const dir = mkdtempSync(join(tmpdir(), 'gsm-legacy-'));
    try {
      const nodeDir = join(dir, 'topic', '.node');
      mkdirSync(nodeDir, { recursive: true });
      writeFileSync(join(nodeDir, 'node.yaml'), 'id: n9\nname: N\nrole: spec\nrunnable: true\nplaceholder: true\n', 'utf-8');
      writeFileSync(join(nodeDir, 'topic.md'), 'body\n', 'utf-8');
      const { node } = await loadNodeFromFs(join(dir, 'topic'), dir, 'owner/repo');
      expect((node as Record<string, unknown>).role).toBe('spec');
      expect((node as Record<string, unknown>).isRunnable).toBe(true);
      expect((node as Record<string, unknown>).isPlaceholder).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips FALSE, not just true', async () => {
    const fm = buildNodeFrontmatter({ ...base, isRunnable: false });
    const node = await load(`runnable: ${fm.runnable}\n`);
    expect('isRunnable' in node).toBe(true);
    expect(node.isRunnable).toBe(false);
  });

  it('round-trips: export → import returns what went in', async () => {
    const fm = buildNodeFrontmatter({ ...base, role: 'spec', isRunnable: true });
    const node = await load(`role: ${fm.role}\nrunnable: ${fm.runnable}\n`);
    expect(node.role).toBe('spec');
    expect(node.isRunnable).toBe(true);
  });
});
