/**
 * #3692 (follow-up to #3264 / #3687): pins for the legacy-sidecar helper paths the first slice left
 * unpinned. Test-only: every pin runs on a real temp checkout; `lstat` and `unlink` faults are
 * injected through a thin `fs` wrapper that delegates to the real functions except where a test says so.
 *
 * Item 1: a non-missing `unlink` error propagates. Item 2: a non-missing `lstat` error propagates (the
 * directory check and the `edges.yaml` check). Item 4: the reserved-name matrix at depth 1. Each pin
 * asserts the on-disk state, so a mutant fails by assertion and not only by an incidental ENOENT/EISDIR.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync), unlinkSync: vi.fn(fs.unlinkSync) };
});
import * as fs from 'fs';
import { legacySidecarEdgesFile, removeLegacySidecar } from './legacySidecar.js';
import { removeNodeFile, writeNodeFile, type NodeForGit } from './writeNodeToGit.js';

const IDENT = {
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const roots: string[] = [];
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hadron-3692-'));
  roots.push(dir);
  git(dir, 'init', '-b', 'main');
  writeFileSync(join(dir, 'seed.txt'), 'unpublished');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'unpublished local commit');
  return dir;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const put = (path: string, body: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
const eio = (code: string) => Object.assign(new Error(`synthetic ${code}`), { code });
const nodeAt = (loc: string): NodeForGit => ({
  id: 'node-3692', loc, name: loc, tags: [], content: 'body', role: null, isRunnable: null, isPlaceholder: false,
  authorshipKind: null, authoredByTask: null, authoredByRevision: null, outgoingEdges: [],
});
const STALE = '- {id: X, rel: stale}\n';

describe('#3692 item 1: a non-missing unlink error propagates', () => {
  it('removeLegacySidecar rethrows EIO from unlink and leaves edges.yaml and the directory in place', () => {
    const repo = checkout();
    const sidecar = join(repo, 'a', '.b');
    put(join(sidecar, 'edges.yaml'), STALE);
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => { throw eio('EIO'); });
    expect(() => removeLegacySidecar(sidecar)).toThrow(/synthetic EIO/);
    expect(readFileSync(join(sidecar, 'edges.yaml'), 'utf8')).toBe(STALE);
    expect(lstatSync(sidecar).isDirectory()).toBe(true);
  });

  it('control: ENOENT from unlink (a racing remover) is a no-op and the empty directory still goes', () => {
    const repo = checkout();
    const sidecar = join(repo, 'a', '.b');
    put(join(sidecar, 'edges.yaml'), STALE);
    vi.mocked(fs.unlinkSync).mockImplementationOnce(path => {
      rmSync(String(path));
      throw eio('ENOENT');
    });
    expect(() => removeLegacySidecar(sidecar)).not.toThrow();
    expect(existsSync(sidecar)).toBe(false);
  });
});

describe('#3692 item 2: a non-missing lstat error propagates', () => {
  it('legacySidecarEdgesFile rethrows EACCES from the directory lstat', () => {
    const repo = checkout();
    const sidecar = join(repo, 'a', '.b');
    put(join(sidecar, 'edges.yaml'), STALE);
    vi.mocked(fs.lstatSync).mockImplementationOnce(() => { throw eio('EACCES'); });
    expect(() => legacySidecarEdgesFile(sidecar)).toThrow(/synthetic EACCES/);
    expect(readFileSync(join(sidecar, 'edges.yaml'), 'utf8')).toBe(STALE);
  });

  it('legacySidecarEdgesFile rethrows EACCES from the edges.yaml lstat (the directory lstat succeeded)', () => {
    const repo = checkout();
    const sidecar = join(repo, 'a', '.b');
    put(join(sidecar, 'edges.yaml'), STALE);
    const real = vi.mocked(fs.lstatSync).getMockImplementation()!;
    vi.mocked(fs.lstatSync)
      .mockImplementationOnce(real)
      .mockImplementationOnce(() => { throw eio('EACCES'); });
    expect(() => legacySidecarEdgesFile(sidecar)).toThrow(/synthetic EACCES/);
  });

  it('removeLegacySidecar propagates it too and removes nothing', () => {
    const repo = checkout();
    const sidecar = join(repo, 'a', '.b');
    put(join(sidecar, 'edges.yaml'), STALE);
    vi.mocked(fs.lstatSync).mockImplementationOnce(() => { throw eio('EACCES'); });
    expect(() => removeLegacySidecar(sidecar)).toThrow(/synthetic EACCES/);
    expect(readFileSync(join(sidecar, 'edges.yaml'), 'utf8')).toBe(STALE);
  });

  it.each(['ENOENT', 'ENOTDIR'])('control: %s from lstat is a no-op (null, nothing thrown)', code => {
    const repo = checkout();
    vi.mocked(fs.lstatSync).mockImplementationOnce(() => { throw eio(code); });
    expect(legacySidecarEdgesFile(join(repo, 'a', '.b'))).toBeNull();
  });
});

describe('#3692 item 4: reserved names directly under the root (depth 1)', () => {
  for (const route of ['write', 'remove'] as const) {
    const run = (repo: string, loc: string) => {
      if (route === 'write') writeNodeFile(repo, nodeAt(loc), undefined, false);
      else { put(join(repo, `${loc}.md`), `---\nid: node-3692\nname: n\n---\n\nbody\n`); removeNodeFile(repo, loc, 'node-3692'); }
    };
    it.each([['git', '.git'], ['github', '.github'], ['hadron', '.hadron'], ['node', '.node'], ['Hadron', '.Hadron'], ['GitHub', '.GitHub']])(
      `${route}: loc %s leaves <root>/%s/edges.yaml untouched`, (loc, dir) => {
        const repo = checkout();
        const edges = join(repo, dir, 'edges.yaml');
        put(edges, STALE);
        run(repo, loc);
        expect(existsSync(edges)).toBe(true);
        expect(readFileSync(edges, 'utf8')).toBe(STALE);
        expect(lstatSync(join(repo, '.git')).isDirectory()).toBe(true);
        expect(git(repo, 'log', '--format=%s')).toContain('unpublished local commit');
      });
  }
});
