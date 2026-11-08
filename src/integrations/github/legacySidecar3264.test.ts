/**
 * #3264: the mirror's legacy edge-sidecar cleanup must never delete recursively.
 *
 * The sidecar of loc `x` is `'.' + lastSegment`, so loc `git` named `<checkout>/.git` and the
 * writers `rmSync(recursive)`'d it: the checkout's repository metadata, with any unpublished
 * commit, went with it. The same shape reaches `.hadron`, `.github` and a nested `.node`.
 * Cleanup may now remove exactly one regular file (`edges.yaml`) and then the directory only if
 * that left it empty; reserved names are never touched, by the writers, the checkpoint or the
 * importer. Everything here runs on a real temp checkout, because the behaviour under test is
 * "what is actually on disk".
 *
 * Controls (green on main by design) pin what must keep working: ordinary sidecars still go.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadGraphFromFs } from '../localFs/loadGraphFromFs.js';
import { loadNodeFromFs } from '../localFs/loadNodeFromFs.js';
import { nodeFilePath, orphanedLegacyPaths } from './nodeFrontmatter.js';
import { removeNodeFile, writeNodeFile, type NodeForGit } from './writeNodeToGit.js';

const IDENT = {
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const roots: string[] = [];
/** A real checkout holding one commit that exists nowhere else (no remote). */
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hadron-3264-'));
  roots.push(dir);
  git(dir, 'init', '-b', 'main');
  writeFileSync(join(dir, 'seed.txt'), 'unpublished');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'unpublished local commit');
  return dir;
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const nodeAt = (loc: string, id = 'node-3264'): NodeForGit => ({
  id, loc, name: loc, tags: [], content: 'body', role: null, isRunnable: null, isPlaceholder: false,
  authorshipKind: null, authoredByTask: null, authoredByRevision: null, outgoingEdges: [],
});
const put = (path: string, body: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
const idFile = (id: string) => `---\nid: ${id}\nname: n\n---\n\nbody\n`;
const gitIntact = (repo: string, stage = true) => {
  expect(lstatSync(join(repo, '.git')).isDirectory()).toBe(true);
  expect(git(repo, 'log', '--format=%s')).toContain('unpublished local commit');
  // The step that used to fail with "not a repository". Git itself refuses a nested `.GIT` fixture.
  if (stage) git(repo, 'add', '-A');
};

describe('#3264 loc `git` no longer deletes the checkout metadata', () => {
  it('writeNodeFile: git.md is written, .git and the unpublished commit survive', () => {
    const repo = checkout();
    expect(writeNodeFile(repo, nodeAt('git'), undefined, false)).toBe(true);
    expect(readFileSync(join(repo, 'git.md'), 'utf8')).toContain('node-3264');
    gitIntact(repo);
  });

  it('removeNodeFile: the matching git.md goes, .git and the commit survive', () => {
    const repo = checkout();
    put(join(repo, 'git.md'), idFile('node-3264'));
    expect(removeNodeFile(repo, 'git', 'node-3264')).toBe(true);
    expect(existsSync(join(repo, 'git.md'))).toBe(false);
    gitIntact(repo);
  });
});

describe('#3264 the helper removes exactly edges.yaml, then an empty directory', () => {
  for (const route of ['write', 'remove'] as const) {
    const run = (repo: string, loc: string) => {
      if (route === 'write') writeNodeFile(repo, nodeAt(loc), undefined, false);
      else { put(nodeFilePath(repo, loc), idFile('node-3264')); removeNodeFile(repo, loc, 'node-3264'); }
    };

    it(`${route}: a real legacy sidecar a/.b/edges.yaml is removed with its empty directory (control)`, () => {
      const repo = checkout();
      put(join(repo, 'a', '.b', 'edges.yaml'), '- {id: X, rel: stale}\n');
      run(repo, 'a:b');
      expect(existsSync(join(repo, 'a', '.b'))).toBe(false);
    });

    it(`${route}: edges.yaml goes, keep.txt and the directory stay`, () => {
      const repo = checkout();
      put(join(repo, 'a', '.b', 'edges.yaml'), '- {id: X, rel: stale}\n');
      put(join(repo, 'a', '.b', 'keep.txt'), 'not ours');
      run(repo, 'a:b');
      expect(existsSync(join(repo, 'a', '.b', 'edges.yaml'))).toBe(false);
      expect(existsSync(join(repo, 'a', '.b', 'keep.txt'))).toBe(true);
      expect(readFileSync(join(repo, 'a', '.b', 'keep.txt'), 'utf8')).toBe('not ours');
    });

    for (const [atom, dir] of [['git', '.git'], ['node', '.node'], ['hadron', '.hadron'], ['github', '.github'],
      ['GIT', '.GIT'], ['Hadron', '.Hadron']] as const) {
      it(`${route}: a/${dir} holding only edges.yaml is untouched (reserved, any depth and case)`, () => {
        const repo = checkout();
        put(join(repo, 'a', dir, 'edges.yaml'), '- {id: X, rel: keep}\n');
        run(repo, `a:${atom}`);
        expect(existsSync(join(repo, 'a', dir, 'edges.yaml'))).toBe(true);
        expect(readFileSync(join(repo, 'a', dir, 'edges.yaml'), 'utf8')).toBe('- {id: X, rel: keep}\n');
        gitIntact(repo, dir !== '.GIT');
      });
    }

    it(`${route}: an edges.yaml that is a directory is untouched`, () => {
      const repo = checkout();
      put(join(repo, 'a', '.b', 'edges.yaml', 'inner.txt'), 'inner');
      run(repo, 'a:b');
      expect(lstatSync(join(repo, 'a', '.b', 'edges.yaml')).isDirectory()).toBe(true);
      expect(existsSync(join(repo, 'a', '.b', 'edges.yaml', 'inner.txt'))).toBe(true);
      expect(readFileSync(join(repo, 'a', '.b', 'edges.yaml', 'inner.txt'), 'utf8')).toBe('inner');
    });

    it(`${route}: a sidecar directory that is a symlink is not followed: target tree stays`, () => {
      const repo = checkout();
      const outside = mkdtempSync(join(tmpdir(), 'hadron-3264-out-'));
      roots.push(outside);
      writeFileSync(join(outside, 'edges.yaml'), 'outside');
      mkdirSync(join(repo, 'a'), { recursive: true });
      symlinkSync(outside, join(repo, 'a', '.b'));
      run(repo, 'a:b');
      expect(existsSync(join(outside, 'edges.yaml'))).toBe(true);
      expect(readFileSync(join(outside, 'edges.yaml'), 'utf8')).toBe('outside');
      expect(lstatSync(join(repo, 'a', '.b')).isSymbolicLink()).toBe(true);
    });

    it(`${route}: an edges.yaml symlink is not followed: link and target both stay`, () => {
      const repo = checkout();
      const outside = mkdtempSync(join(tmpdir(), 'hadron-3264-out-'));
      roots.push(outside);
      writeFileSync(join(outside, 'target.yaml'), 'outside');
      mkdirSync(join(repo, 'a', '.b'), { recursive: true });
      symlinkSync(join(outside, 'target.yaml'), join(repo, 'a', '.b', 'edges.yaml'));
      run(repo, 'a:b');
      expect(lstatSync(join(repo, 'a', '.b', 'edges.yaml')).isSymbolicLink()).toBe(true);
      expect(existsSync(join(outside, 'target.yaml'))).toBe(true);
      expect(readFileSync(join(outside, 'target.yaml'), 'utf8')).toBe('outside');
    });
  }
});

describe('#3264 a stored loc can never address repository metadata', () => {
  it.each(['a:.git', 'a:.GIT:b', '.Git'])('locToSegments refuses %s (via nodeFilePath and orphanedLegacyPaths)', (loc) => {
    expect(() => nodeFilePath('/g', loc)).toThrow(/Unsafe loc/);
    expect(() => orphanedLegacyPaths('/g', loc)).toThrow(/Unsafe loc/);
  });
  it.each(['git', 'hadron', 'github', 'node', 'a:git', 'gitx'])('legal loc %s stays legal', (loc) => {
    expect(nodeFilePath('/g', loc)).toBe(`/g/${loc.split(':').join('/')}.md`);
    expect(() => orphanedLegacyPaths('/g', loc)).not.toThrow();
  });
});

describe('#3264 the importer uses the same reserved set', () => {
  it('.github/edges.yaml beside github.md does not mask the inline edges', async () => {
    const root = checkout();
    put(join(root, 'github.md'), `---\nid: gh1\nname: GH\nnodes:\n  - id: INLINE\n    rel: inline edge\n---\n\nbody\n`);
    put(join(root, '.github', 'edges.yaml'), '- {id: STALE, rel: stale edge}\n');
    const { edges } = await loadGraphFromFs(root, 'g', 'org/repo');
    expect(edges.some((e) => e.targetId === 'STALE')).toBe(false);
    expect(edges.some((e) => e.targetId === 'INLINE')).toBe(true);
  });

  it('control: a non-reserved sidecar still masks inline edges, as the importer documents', async () => {
    const root = checkout();
    put(join(root, 'arch.md'), `---\nid: ar1\nname: A\nnodes:\n  - id: INLINE\n    rel: inline edge\n---\n\nbody\n`);
    put(join(root, '.arch', 'edges.yaml'), '- {id: SIDE, rel: sidecar edge}\n');
    const { edges } = await loadGraphFromFs(root, 'g', 'org/repo');
    expect(edges.some((e) => e.targetId === 'SIDE')).toBe(true);
  });

  it('control: the legacy .node/node.yaml layout still loads', async () => {
    const root = checkout();
    put(join(root, 'legacy', '.node', 'node.yaml'), 'id: lg1\nname: Legacy\n');
    put(join(root, 'legacy', '.node', 'topic.md'), 'legacy body\n');
    const loaded = await loadNodeFromFs(join(root, 'legacy'), root, 'org/repo');
    expect(loaded.node.name).toBe('Legacy');
  });
});
