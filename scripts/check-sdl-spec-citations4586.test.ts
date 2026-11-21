/**
 * #4586 pins: follow-ups from the #4552 review of the SDL citation gate (annotation
 * encoding, shared constants, prefix anchoring, range-tail parsing and reporting, the
 * main() failure branches, and the refresh script's messages). Synthetic strings and
 * fixtures; the scripts run in a throwaway directory so no real file is touched.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPECS_MEMORY,
  escapeAnnotationData,
  findQualifiedCitations,
  findRangeTailProblems,
  missingFromSnapshot,
} from './check-sdl-spec-citations.mjs';
import * as refresh from './refresh-sdl-spec-citation-snapshot.mjs';

const P = 'hrn:node:hadronmemory.com:specs:';
const root = join(__dirname, '..');
const cites = (s: string) => findQualifiedCitations(s).map((c) => c.citation);

describe('#4586 F3 — annotation data is encoded', () => {
  it('escapes %, CR and LF so a multi-line message cannot end the annotation early', () => {
    expect(escapeAnnotationData('a%b\r\nc\nd')).toBe('a%25b%0D%0Ac%0Ad');
  });
});

describe('#4586 F4 — one spelling of the memory id and the whole-citation test', () => {
  it('the refresh script uses the check script\'s constants', () => {
    expect(refresh.SPECS_MEMORY).toBe(SPECS_MEMORY);
    expect(SPECS_MEMORY).toBe('hadronmemory.com:specs');
  });
});

describe('#4586 F5 — the specs prefix is judged on the whole token', () => {
  it('a URN nested inside another token is not a specs citation', () => {
    expect(cites(`hrn:node:example.org:hrn:node:hadronmemory.com:specs:cor:agt:050:01`)).toEqual([]);
    expect(cites(`hrn:node:a:urn:node:hadronmemory.com:specs:cor:agt:050:01`)).toEqual([]);
  });
  it('the real prefix still counts, after punctuation and in the legacy scheme', () => {
    expect(cites(`(${P}cor:agt:050:01) urn:node:hadronmemory.com:specs:cor:agt:050:02`)).toEqual(['cor:agt:050:01', 'cor:agt:050:02']);
  });
  it('is case-sensitive like the portal gate: an upper-case scheme is not qualified', () => {
    expect(cites(`HRN:NODE:hadronmemory.com:specs:cor:agt:050:01`)).toEqual([]);
  });
});

describe('#4586 — range tails', () => {
  it.each([
    ['spaced en dash', `${P}cor:agt:050:14 – :17`],
    ['em dash', `${P}cor:agt:050:14—:17`],
    ['hyphen', `${P}cor:agt:050:14-:17`],
  ])('reads %s', (_n, s) => {
    expect(cites(s)).toEqual(['cor:agt:050:14', 'cor:agt:050:17']);
    expect(findRangeTailProblems(s)).toEqual([]);
  });
  it('reads a chained tail', () => {
    expect(cites(`${P}cor:agt:050:14–:17–:19`)).toEqual(['cor:agt:050:14', 'cor:agt:050:17', 'cor:agt:050:19']);
  });
  it.each([
    ['three digits', `${P}cor:agt:050:14–:170`],
    ['one digit', `${P}cor:agt:050:14–:7`],
    ['not a number', `${P}cor:agt:050:14–:ab`],
    ['a head with no rule number', `${P}cor:agt:050–:17`],
  ])('reports an unparseable tail instead of skipping it: %s', (_n, s) => {
    const problems = findRangeTailProblems(`x\n${s}`);
    expect(problems).toHaveLength(1);
    expect(problems[0].line).toBe(2);
  });
  it('a dash that is prose, not a tail, is left alone', () => {
    expect(findRangeTailProblems(`${P}cor:agt:050:14 - see below`)).toEqual([]);
    expect(findRangeTailProblems(`${P}cor:agt:050:14-ish`)).toEqual([]);
  });
  it('a repeated citation on one line is reported once per line', () => {
    const q = findQualifiedCitations(`${P}cor:agt:050:14–:14`);
    expect(q).toEqual([{ line: 1, citation: 'cor:agt:050:14' }]);
    expect(missingFromSnapshot(q, new Set())).toHaveLength(1);
  });
});

/** A throwaway repo holding copies of both scripts, a snapshot and a baseline. */
function sandbox(files: { snapshot?: string | null; baseline?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sdl4586-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'src/api/graphql/schema'), { recursive: true });
  for (const f of ['check-sdl-spec-citations.mjs', 'refresh-sdl-spec-citation-snapshot.mjs']) {
    copyFileSync(join(root, 'scripts', f), join(dir, 'scripts', f));
  }
  const put = (name: string, body: string | null | undefined, fallback: string) => {
    if (body === null) return;
    writeFileSync(join(dir, 'scripts', name), body ?? fallback);
  };
  put('sdl-spec-citations-snapshot.txt', files.snapshot, 'cor:agt:130:04\n');
  put('sdl-spec-citations-baseline.txt', files.baseline, '');
  writeFileSync(join(dir, 'src/api/graphql/schema/typeDefs.ts'), '// clean\n');
  const git = (...a: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' });
    expect(r.status, `git ${a.join(' ')}: ${r.stderr}`).toBe(0);
  };
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('#4586 F6 — main() failure branches', () => {
  const check = (dir: string) => spawnSync('node', ['scripts/check-sdl-spec-citations.mjs', 'HEAD'], { cwd: dir, encoding: 'utf8' });

  it('a missing snapshot fails with an annotation naming the file', () => {
    const s = sandbox({ snapshot: null });
    try {
      const r = check(s.dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('::error file=scripts/sdl-spec-citations-snapshot.txt::');
    } finally { s.done(); }
  });
  it('a malformed snapshot fails and the annotation stays on one line', () => {
    const s = sandbox({ snapshot: 'cor:agt\nnot a citation\n' });
    try {
      const r = check(s.dir);
      expect(r.status).toBe(1);
      const annotations = r.stderr.split('\n').filter((l) => l.startsWith('::error'));
      expect(annotations).toHaveLength(1);
      expect(annotations[0]).toContain('%0A');
    } finally { s.done(); }
  });
  it('a malformed baseline fails', () => {
    const s = sandbox({ baseline: 'cor:agt:130:04 x\n' });
    try {
      const r = check(s.dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('::error file=scripts/sdl-spec-citations-baseline.txt::');
    } finally { s.done(); }
  });
  it('an unresolvable base exits 2', () => {
    const s = sandbox();
    try {
      const r = spawnSync('node', ['scripts/check-sdl-spec-citations.mjs', 'no-such-ref'], { cwd: s.dir, encoding: 'utf8' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('cannot diff against base "no-such-ref"');
    } finally { s.done(); }
  });
  it('an unparseable range tail fails the gate', () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.dir, 'src/api/graphql/schema/typeDefs.ts'), `// ${P}cor:agt:130:04–:170\n`);
      const r = check(s.dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('range tail');
    } finally { s.done(); }
  });
});

describe('#4586 F7/N1 — the refresh script\'s messages', () => {
  const list = [{ citation: 'cor:agt:130:04', updatedAt: '2026-11-05T00:00:00Z' }];
  /** Put a stub `hadron` first on PATH; it prints the fixtures for `spec list` / `spec describe`. */
  function stub(dir: string) {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const f = join(bin, 'hadron');
    writeFileSync(f, `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nconsole.log(JSON.stringify(a[1] === 'list' ? ${JSON.stringify(list)} : { placeholders: [] }));\n`);
    chmodSync(f, 0o755);
    return bin;
  }
  const run = (dir: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
    spawnSync(process.execPath, ['scripts/refresh-sdl-spec-citation-snapshot.mjs', ...args], { cwd: dir, encoding: 'utf8', env });

  it('--check passes when the snapshot matches the corpus', () => {
    const s = sandbox();
    try {
      const r = run(s.dir, { ...process.env, PATH: `${stub(s.dir)}:${process.env.PATH}` }, '--check');
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('matches');
    } finally { s.done(); }
  });
  it('--check on a differing snapshot says it differs', () => {
    const s = sandbox({ snapshot: 'cor:agt:130:03\n' });
    try {
      const r = run(s.dir, { ...process.env, PATH: `${stub(s.dir)}:${process.env.PATH}` }, '--check');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('differs');
    } finally { s.done(); }
  });
  it('--check on a MISSING snapshot says it is missing, not that it differs', () => {
    const s = sandbox({ snapshot: null });
    try {
      const r = run(s.dir, { ...process.env, PATH: `${stub(s.dir)}:${process.env.PATH}` }, '--check');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('missing');
      expect(r.stderr).not.toContain('differs');
    } finally { s.done(); }
  });
  it('a missing hadron binary gets its own message, not a stack trace', () => {
    const s = sandbox();
    try {
      const r = run(s.dir, { ...process.env, PATH: '/nonexistent' }, '--check');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('`hadron` CLI');
      expect(r.stderr).not.toContain('at ');
    } finally { s.done(); }
  });
});
