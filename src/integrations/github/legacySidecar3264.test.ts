/**
 * #3264: mirror cleanup of a legacy edge sidecar must never delete recursively.
 *
 * `orphanedLegacyPaths` names `'.' + lastSegment`, so loc `git` named `<checkout>/.git`
 * and the writers rmSync'ed it recursively (unpublished commits gone). These pins run
 * on a REAL temp git checkout with an unpublished commit: what matters is what is on disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeNodeFile, writeNodeFile, type NodeForGit } from './writeNodeToGit.js';
import { nodeFilePath } from './nodeFrontmatter.js';
import { loadNodeFromFs } from '../localFs/loadNodeFromFs.js';

const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let repo: string;
let unpublished: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'sidecar3264-'));
  git(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'seed.txt'), 'seed');
  git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'unpublished commit');
  unpublished = git(repo, 'rev-parse', 'HEAD');
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

const node = (loc: string, id = `id-${loc}`): NodeForGit => ({
  id, loc, name: loc, content: 'body', tags: [], outgoingEdges: [],
} as unknown as NodeForGit);
const put = (rel: string, body: string) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), body); };
const seedMd = (loc: string, id: string) => put(nodeFilePath(repo, loc).slice(repo.length + 1), `---\nid: ${id}\nname: x\n---\n\nbody\n`);
/** Assert presence first: a deleted file must fail as an assertion, not as an ENOENT from the read. */
const kept = (path: string, body: string) => { expect(existsSync(path)).toBe(true); expect(readFileSync(path, 'utf8')).toBe(body); };
const repoIntact = () => {
  expect(existsSync(join(repo, '.git'))).toBe(true);
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(unpublished);
  expect(git(repo, 'log', '--format=%H')).toContain(unpublished);
  git(repo, 'add', '-A'); // "not a repository" is the reported failure
};

describe('#3264 reserved sidecar names are never touched', () => {
  it('writeNodeFile for loc "git": writes git.md, .git and the unpublished commit survive', () => {
    expect(writeNodeFile(repo, node('git'), undefined, false)).toBe(true);
    expect(readFileSync(join(repo, 'git.md'), 'utf8')).toContain('id: id-git');
    repoIntact();
  });
  it('removeNodeFile for loc "git" removes git.md only', () => {
    seedMd('git', 'n1');
    expect(removeNodeFile(repo, 'git', 'n1')).toBe(true);
    expect(existsSync(join(repo, 'git.md'))).toBe(false);
    repoIntact();
  });
  it.each(['hadron', 'github', 'node'])('loc "%s" leaves its reserved sibling directory intact', (loc) => {
    put(`.${loc}/edges.yaml`, '- rel: x\n');
    put(`.${loc}/keep.txt`, 'keep');
    writeNodeFile(repo, node(loc), undefined, false);
    seedMd(loc, 'n1');
    removeNodeFile(repo, loc, 'n1');
    kept(join(repo, `.${loc}/edges.yaml`), '- rel: x\n');
    kept(join(repo, `.${loc}/keep.txt`), 'keep');
    repoIntact();
  });
  it.each(['.git', '.node', '.hadron', '.github', '.GIT', '.Github'])('a/%s holding ONLY edges.yaml is untouched (write and remove)', (dir) => {
    const loc = `a:${dir.slice(1)}`; // loc atom keeps the case, so the sidecar IS `a/${dir}`
    put(`a/${dir}/edges.yaml`, '- rel: x\n');
    writeNodeFile(repo, node(loc), undefined, false);
    seedMd(loc, 'n1');
    removeNodeFile(repo, loc, 'n1');
    kept(join(repo, `a/${dir}/edges.yaml`), '- rel: x\n');
  });
  it('a:git leaves a/.git (nested repository metadata) intact', () => {
    put('a/.git/HEAD', 'ref: refs/heads/main');
    writeNodeFile(repo, node('a:git'), undefined, false);
    kept(join(repo, 'a/.git/HEAD'), 'ref: refs/heads/main');
  });
});

describe('#3264 cleanup removes exactly edges.yaml', () => {
  it('a real legacy sidecar a/.b/edges.yaml is removed with its now-empty directory (write and remove)', () => {
    put('a/.b/edges.yaml', '- rel: x\n');
    writeNodeFile(repo, node('a:b'), undefined, false);
    expect(existsSync(join(repo, 'a/.b'))).toBe(false);
    put('a/.b/edges.yaml', '- rel: x\n');
    seedMd('a:b', 'n1');
    expect(removeNodeFile(repo, 'a:b', 'n1')).toBe(true);
    expect(existsSync(join(repo, 'a/.b'))).toBe(false);
  });
  it('edges.yaml goes, keep.txt and the directory stay (write and remove)', () => {
    for (const route of ['write', 'remove']) {
      put('a/.b/edges.yaml', '- rel: x\n');
      put('a/.b/keep.txt', 'keep');
      if (route === 'write') writeNodeFile(repo, node('a:b'), undefined, false);
      else { seedMd('a:b', 'n1'); removeNodeFile(repo, 'a:b', 'n1'); }
      expect(existsSync(join(repo, 'a/.b/edges.yaml'))).toBe(false);
      kept(join(repo, 'a/.b/keep.txt'), 'keep');
      rmSync(join(repo, 'a/.b'), { recursive: true });
    }
  });
  it('edges.yaml that is a directory is untouched', () => {
    put('a/.b/edges.yaml/inner.txt', 'inner');
    expect(() => writeNodeFile(repo, node('a:b'), undefined, false)).not.toThrow();
    kept(join(repo, 'a/.b/edges.yaml/inner.txt'), 'inner');
  });
  it('edges.yaml that is a symlink to a file outside the sidecar: link and target stay', () => {
    const outside = join(repo, 'outside.txt');
    writeFileSync(outside, 'target');
    mkdirSync(join(repo, 'a/.b'), { recursive: true });
    symlinkSync(outside, join(repo, 'a/.b/edges.yaml'));
    expect(() => writeNodeFile(repo, node('a:b'), undefined, false)).not.toThrow();
    expect(existsSync(join(repo, 'a/.b/edges.yaml'))).toBe(true);
    expect(lstatSync(join(repo, 'a/.b/edges.yaml')).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('target');
  });
  it('a sidecar that is a gitlink-style FILE does nothing and the write proceeds', () => {
    put('a/.b', 'gitdir: ../x');
    expect(writeNodeFile(repo, node('a:b'), undefined, false)).toBe(true);
    kept(join(repo, 'a/.b'), 'gitdir: ../x');
  });
  it('a sidecar that is a SYMLINK to a directory: the target edges.yaml stays', () => {
    const target = mkdtempSync(join(tmpdir(), 'sidecar3264-target-'));
    try {
      writeFileSync(join(target, 'edges.yaml'), '- rel: x\n');
      mkdirSync(join(repo, 'a'), { recursive: true });
      symlinkSync(target, join(repo, 'a/.b'));
      expect(() => writeNodeFile(repo, node('a:b'), undefined, false)).not.toThrow();
      kept(join(target, 'edges.yaml'), '- rel: x\n');
      expect(lstatSync(join(repo, 'a/.b')).isSymbolicLink()).toBe(true);
    } finally { rmSync(target, { recursive: true, force: true }); }
  });
  it('no sidecar at all is a no-op', () => {
    expect(writeNodeFile(repo, node('a:b'), undefined, false)).toBe(true);
    expect(readFileSync(join(repo, 'a/b.md'), 'utf8')).toContain('id: id-a:b');
  });
});

describe('#3264 importer and stored-loc parity', () => {
  it('inline edges win over an edges.yaml in a reserved directory (.github beside github.md)', async () => {
    const mdPath = join(repo, 'github.md');
    const inline = '---\nid: gh1\nname: GH\nnodes:\n  - id: target1\n    rel: inline-edge\n---\n\nbody\n';
    writeFileSync(mdPath, inline);
    put('.github/edges.yaml', '- id: other\n  rel: sidecar-edge\n');
    const loaded = await loadNodeFromFs(mdPath, repo, 'o/r');
    expect(loaded.edges.map((e) => e.name)).toEqual(['inline-edge']);
  });
  it('a real sidecar still masks inline edges (ordinary precedence unchanged)', async () => {
    const mdPath = join(repo, 'b.md');
    writeFileSync(mdPath, '---\nid: b1\nname: B\nnodes:\n  - id: target1\n    rel: inline-edge\n---\n\nbody\n');
    put('.b/edges.yaml', '- id: other\n  rel: sidecar-edge\n');
    const loaded = await loadNodeFromFs(mdPath, repo, 'o/r');
    expect(loaded.edges.map((e) => e.name)).toEqual(['sidecar-edge']);
  });
  it.each(['.git', '.GIT', 'a:.git', 'a:.Git:b'])('a stored loc "%s" with a .git segment is refused', (loc) => {
    expect(() => nodeFilePath(repo, loc)).toThrow(/Unsafe loc/);
  });
  it.each(['git', 'hadron', 'github', 'node', 'a:git'])('legal loc "%s" stays legal', (loc) => {
    expect(() => nodeFilePath(repo, loc)).not.toThrow();
  });
});
