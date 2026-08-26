/**
 * removeNodeFile's identity gate (#1095; PR #1098 review, Codex P1).
 *
 * The move mirror deletes the path a node vacated, and it runs AFTER its
 * transaction commits — so by then some other node may already have been created
 * at that loc and mirrored its own file to that exact path. Deleting it blind
 * would erase a live node from the repo and let the next repo-wins sync act on
 * the absence.
 *
 * These run against a real temp checkout rather than a mocked fs, because the
 * whole behaviour under test is "what is actually on disk at this path".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { removeNodeFile } from './writeNodeToGit.js';
import { nodeFilePath, orphanedLegacyPaths } from './nodeFrontmatter.js';

let repo: string;

/** Write a mirror-shaped file at `loc` carrying `id` in its frontmatter. */
function seed(loc: string, id: string | null, path = nodeFilePath(repo, loc)): string {
  mkdirSync(dirname(path), { recursive: true });
  const fm = id == null ? 'name: Some node' : `id: ${id}\nname: Some node`;
  writeFileSync(path, `---\n${fm}\n---\n\nbody\n`, 'utf-8');
  return path;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'hadron-mirror-'));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('removeNodeFile', () => {
  it('removes the file when its frontmatter id is the moved node', () => {
    const path = seed('a:b', 'node-1');
    expect(removeNodeFile(repo, 'a:b', 'node-1')).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('LEAVES a file whose frontmatter names a DIFFERENT node', () => {
    // The vacated loc was re-occupied and mirrored before this ran.
    const path = seed('a:b', 'replacement-node');
    expect(removeNodeFile(repo, 'a:b', 'node-1')).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('replacement-node');
  });

  it('LEAVES a file that carries no id (hand-authored, not the mirror\'s to delete)', () => {
    const path = seed('a:b', null);
    expect(removeNodeFile(repo, 'a:b', 'node-1')).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it('LEAVES a file with unreadable frontmatter rather than guessing', () => {
    const path = nodeFilePath(repo, 'a:b');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'no frontmatter at all\n', 'utf-8');
    expect(removeNodeFile(repo, 'a:b', 'node-1')).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it('is a no-op when nothing is there', () => {
    expect(removeNodeFile(repo, 'a:b', 'node-1')).toBe(false);
  });

  it('removes the legacy README form too, under the same gate', () => {
    const legacy = orphanedLegacyPaths(repo, 'a:b');
    seed('a:b', 'node-1', legacy.readme);
    expect(removeNodeFile(repo, 'a:b', 'node-1')).toBe(true);
    expect(existsSync(legacy.readme)).toBe(false);
  });

  it('takes the edge sidecar only when it actually removed the node file', () => {
    const legacy = orphanedLegacyPaths(repo, 'a:b');
    mkdirSync(legacy.sidecar, { recursive: true });
    writeFileSync(join(legacy.sidecar, 'edges.yaml'), 'edges: []\n', 'utf-8');

    // Someone else's file at the loc ⇒ nothing goes, sidecar included.
    seed('a:b', 'replacement-node');
    expect(removeNodeFile(repo, 'a:b', 'node-1')).toBe(false);
    expect(existsSync(legacy.sidecar)).toBe(true);

    // Our file ⇒ both go (a stale sidecar would mask inline edges on re-import).
    seed('a:b', 'node-1');
    expect(removeNodeFile(repo, 'a:b', 'node-1')).toBe(true);
    expect(existsSync(legacy.sidecar)).toBe(false);
  });

  it('never touches the node\'s child DIRECTORY — a descendant may not have moved', () => {
    seed('a:b', 'node-1');
    const childFile = seed('a:b:kept', 'child-node');
    expect(removeNodeFile(repo, 'a:b', 'node-1')).toBe(true);
    expect(existsSync(childFile)).toBe(true);
  });

  it('refuses the empty-loc root (a memory root cannot be moved)', () => {
    const rootReadme = join(repo, 'README.md');
    writeFileSync(rootReadme, '---\nid: node-1\n---\n\nroot\n', 'utf-8');
    expect(removeNodeFile(repo, '', 'node-1')).toBe(false);
    expect(existsSync(rootReadme)).toBe(true);
  });
});
