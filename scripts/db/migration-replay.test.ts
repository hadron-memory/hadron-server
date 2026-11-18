/**
 * #434 Slice C: the shrink-only judgement of scripts/db/migration-replay.ts, as pure functions. The database-level red
 * controls (a seeded new object, the stale IF-NOT-EXISTS redefinition, a baselined object changed again, a removed and a
 * stale baseline line, the green unaltered head) run as steps of the Migration Replay workflow itself (#4338 BLIND F4).
 */
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { diff, differenceKind } from '../../src/test/catalogSnapshot.js';
import {
  BASELINE_PATH, BaselineFormatError, baselineGrowth, differenceEntries, dropScratch, encodeKey, evaluate, exitCode, fingerprint,
  ignoreClosedPipe, isEngineBookkeeping, judge, parseBaseline, withDb,
} from './migration-replay.js';

describe('#434 Slice C: the replay baseline is shrink-only', () => {
  const baseline = ['added idx:a', 'changed col:t.c'];

  it('green: exactly the listed differences', () => {
    expect(judge(['added idx:a', 'changed col:t.c'], baseline)).toEqual({ unexpected: [], stale: [] });
  });
  it('red: a difference the baseline does not list is new drift', () => {
    expect(judge(['added idx:a', 'changed col:t.c', 'changed idx:new'], baseline)).toEqual({ unexpected: ['changed idx:new'], stale: [] });
  });
  it('red: a deleted line whose difference is still present is new drift again', () => {
    expect(judge(['added idx:a', 'changed col:t.c'], ['added idx:a'])).toEqual({ unexpected: ['changed col:t.c'], stale: [] });
  });
  it('red: a line whose difference is gone is stale (a fix must delete its line)', () => {
    expect(judge(['added idx:a'], baseline)).toEqual({ unexpected: [], stale: ['changed col:t.c'] });
  });
  it('red: a duplicated line is stale, so repetition cannot hide growth', () => {
    expect(judge(['added idx:a'], ['added idx:a', 'added idx:a']).stale).toEqual(['added idx:a']);
  });
  it('the baseline file parses: comments and blanks skipped, every entry a known kind, a key and a fingerprint, unique', () => {
    expect(parseBaseline('# c\n\n added idx:a 0123456789abcdef \n#x\nchanged col:t.c fedcba9876543210\n'))
      .toEqual(['added idx:a 0123456789abcdef', 'changed col:t.c fedcba9876543210']);
    const entries = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'));
    // An EMPTY baseline is valid once every listed drift is fixed (#4338 BLIND F6). A key may hold spaces (F2).
    for (const e of entries) expect(e).toMatch(/^(added|removed|changed|reformatted) (col|con|idx|fn|seq|view|tg):.+ [0-9a-f]{16}$/);
    expect(new Set(entries).size).toBe(entries.length);
  });
  it('builds entries from both snapshots: kind, key and a fingerprint of both definitions', () => {
    const reference = new Map([['idx:x', 'A'], ['idx:gone', 'G'], ['fn:f(x integer, y text)', 'BEGIN  RETURN 1; END']]);
    const replay = new Map([['idx:x', 'B'], ['idx:real_one', 'R'], ['fn:f(x integer, y text)', 'BEGIN RETURN 1; END']]);
    const { entries, details } = differenceEntries(reference, replay);
    expect(entries).toEqual([
      `added idx:real_one ${fingerprint(undefined, 'R')}`,
      `changed idx:x ${fingerprint('A', 'B')}`,
      `reformatted fn:f(x integer, y text) ${fingerprint('BEGIN  RETURN 1; END', 'BEGIN RETURN 1; END')}`,
      `removed idx:gone ${fingerprint('G', undefined)}`,
    ].sort());
    expect(details.get(`changed idx:x ${fingerprint('A', 'B')}`)).toContain('push + post-push: A');
  });
  it('a key with a newline or tab stays one line (#4338 BLIND F2)', () => {
    expect(encodeKey('col:"we\nird"\t.x\\y')).toBe('col:"we\\nird"\\t.x\\\\y');
    const { entries } = differenceEntries(new Map(), new Map([['col:"a\nb".c', 'text']]));
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain('\n');
  });
  it('skips only the EXACT engine bookkeeping relation and its pkey; a lookalike table is still drift (#4338 BLIND F3)', () => {
    for (const k of ['col:_prisma_migrations.checksum', 'con:_prisma_migrations._prisma_migrations_pkey', 'idx:_prisma_migrations_pkey']) {
      expect(isEngineBookkeeping(k)).toBe(true);
    }
    for (const k of ['col:_prisma_migrations_archive.id', 'idx:_prisma_migrations_archive_pkey', 'con:_prisma_migrations_x.c']) {
      expect(isEngineBookkeeping(k)).toBe(false);
    }
    const { entries } = differenceEntries(new Map(), new Map([['col:_prisma_migrations.id', 'a'], ['col:_prisma_migrations_archive.id', 'b']]));
    expect(entries).toEqual([`added col:_prisma_migrations_archive.id ${fingerprint(undefined, 'b')}`]);
  });
  it('red (#4338 BLIND F1, LOCAL F1): a baselined object that changes AGAIN no longer matches its line', () => {
    const accepted = `changed idx:x ${fingerprint('A', 'B')}`;
    const now = differenceEntries(new Map([['idx:x', 'A']]), new Map([['idx:x', 'C']])).entries;
    expect(judge(now, [accepted])).toEqual({ unexpected: now, stale: [accepted] });
  });
  it('the fingerprint depends on both sides and on their order', () => {
    expect(fingerprint('A', 'B')).not.toBe(fingerprint('B', 'A'));
    expect(fingerprint('A', 'B')).not.toBe(fingerprint('A', 'C'));
    expect(fingerprint(undefined, 'B')).toBe(fingerprint('', 'B'));
  });
  it('growth over the base branch\'s baseline is reported (#4338 BLIND F1); a shrink is not growth', () => {
    expect(baselineGrowth(['a 1', 'b 2', 'c 3'], ['a 1', 'b 2'])).toEqual(['c 3']);
    expect(baselineGrowth(['a 1'], ['a 1', 'b 2'])).toEqual([]);
    expect(baselineGrowth(['a 9'], ['a 1'])).toEqual(['a 9']); // a re-fingerprinted line is growth too
  });
});

describe('#4378: baseline-line validation, the exit-code contract and the pure seams', () => {
  const fp = '0123456789abcdef';

  it('red-first: parseBaseline refuses a malformed line, naming its line number and the line', () => {
    for (const bad of ['garbage', 'added idx:a', 'added idx:a 0123', `grew idx:a ${fp}`, `added zz:a ${fp}`, `added idx: ${fp}`, `added idx:a ${fp.toUpperCase()}`]) {
      expect(() => parseBaseline(`# header\nchanged col:t.c ${fp}\n${bad}\n`)).toThrow(BaselineFormatError);
      expect(() => parseBaseline(`# header\nchanged col:t.c ${fp}\n${bad}\n`)).toThrow(`line 3: ${bad.trim()}`);
    }
  });
  it('parseBaseline accepts a key with spaces and an escaped key, and keeps blanks and comments skipped', () => {
    expect(parseBaseline(`\n  # c\nchanged fn:f(x integer, y text) ${fp}\nadded col:"a\\nb".c ${fp}\n`))
      .toEqual([`changed fn:f(x integer, y text) ${fp}`, `added col:"a\\nb".c ${fp}`]);
    expect(parseBaseline('# only comments\n\n')).toEqual([]);
  });

  it('exit codes: 1 is detection, 2 is operational; a cleanup failure on an otherwise clean run is 2, never 1', () => {
    expect(exitCode(0, 0)).toBe(0);
    expect(exitCode(1, 0)).toBe(1);
    expect(exitCode(0, 1)).toBe(2);
    expect(exitCode(1, 2)).toBe(1); // drift found AND a leak: the detection is still reported as a detection
    expect(exitCode(2, 1)).toBe(2);
  });

  it('withDb replaces only the database path and keeps the query string', () => {
    expect(withDb('postgresql://u:p@h:5432/postgres?sslmode=require&x=1', 'scratch_db'))
      .toBe('postgresql://u:p@h:5432/scratch_db?sslmode=require&x=1');
    expect(withDb('postgresql://u@h/postgres', 'n')).toBe('postgresql://u@h/n');
  });

  describe('evaluate', () => {
    const details = new Map([[`added idx:new ${fp}`, '  defs']]);
    it('--print returns 0 and prints the entries without judging them (no baseline read)', () => {
      const r = evaluate({ entries: [`added idx:new ${fp}`], details, print: true, baseline: undefined, baseBaseline: undefined, allowGrowth: false });
      expect(r).toEqual({ code: 0, out: [`added idx:new ${fp}`], err: [] });
    });
    it('green: the baseline lists exactly the differences', () => {
      expect(evaluate({ entries: [`added idx:new ${fp}`], details, print: false, baseline: [`added idx:new ${fp}`], baseBaseline: [`added idx:new ${fp}`], allowGrowth: false }).code).toBe(0);
    });
    it('new drift is 1, naming the entry and its definitions', () => {
      const r = evaluate({ entries: [`added idx:new ${fp}`], details, print: false, baseline: [], baseBaseline: [], allowGrowth: false });
      expect(r.code).toBe(1);
      expect(r.err).toEqual([`NEW DRIFT (not in the baseline): added idx:new ${fp}\n  defs`]);
    });
    it('growth over the base is 1 without approval, 0 with it, and not judged without a base baseline', () => {
      const args = { entries: [`added idx:new ${fp}`], details, print: false, baseline: [`added idx:new ${fp}`] };
      expect(evaluate({ ...args, baseBaseline: [], allowGrowth: false }).code).toBe(1);
      const ok = evaluate({ ...args, baseBaseline: [], allowGrowth: true });
      expect(ok.code).toBe(0);
      expect(ok.err).toEqual([`APPROVED BASELINE GROWTH: added idx:new ${fp}`]);
      expect(evaluate({ ...args, baseBaseline: undefined, allowGrowth: false }).code).toBe(0);
    });
  });

  it('ONE kind decision: catalogSnapshot.diff and differenceEntries agree on every kind (#4338 BLIND F5)', () => {
    const before = new Map([['idx:same', 'S'], ['idx:gone', 'G'], ['idx:chg', 'A'], ['fn:f()', 'BEGIN  RETURN 1; END'], ['fn:g()', 'BEGIN RETURN 1; END']]);
    const after = new Map([['idx:same', 'S'], ['idx:new', 'N'], ['idx:chg', 'B'], ['fn:f()', 'BEGIN RETURN 1; END'], ['fn:g()', 'BEGIN RETURN 2; END']]);
    const kinds = (lines: string[]) => lines.map((l) => l.split('\n')[0]!.split(' ').slice(0, 2).join(' ')).sort();
    const expected = ['added idx:new', 'changed fn:g()', 'changed idx:chg', 'reformatted fn:f()', 'removed idx:gone'];
    expect(kinds(diff(before, after))).toEqual(expected);
    expect(kinds(differenceEntries(before, after).entries)).toEqual(expected);
    for (const k of new Set([...before.keys(), ...after.keys()])) {
      const kind = differenceKind(k, before.get(k), after.get(k));
      expect(kind === null ? 'same' : `${kind} ${k}`).toBe(k === 'idx:same' ? 'same' : expected.find((e) => e.endsWith(` ${k}`)));
    }
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

describe('#4395 item 1: an early-closed stdout cannot skip the scratch-database cleanup', () => {
  it('a drop that fails is reported by name, and an otherwise clean run then exits 2 (the CLEANUP FAILED rule)', async () => {
    const logged: string[] = [];
    const failed = await dropScratch(
      async (sql) => { if (sql.includes('hadron_replayref434_t')) throw new Error('boom'); },
      ['hadron_replay434_t', 'hadron_replayref434_t'],
      (line) => logged.push(line),
    );
    expect(failed).toEqual(['hadron_replayref434_t']);
    expect(logged).toEqual(['CLEANUP FAILED: could not drop scratch database hadron_replayref434_t: boom']);
    expect(exitCode(0, failed.length)).toBe(2);
  });

  it('a closed reader (EPIPE) on the output stream is swallowed; any other stream error still crashes', () => {
    const stream = new EventEmitter();
    ignoreClosedPipe(stream as unknown as NodeJS.WriteStream);
    const err = (code: string) => Object.assign(new Error(code), { code });
    expect(() => stream.emit('error', err('EPIPE'))).not.toThrow();
    expect(() => stream.emit('error', err('EIO'))).toThrow('EIO');
  });

  // A real run of the script: it needs a CREATEDB role, so it runs where MIGRATION_REPLAY_ADMIN_URL is set (the Migration
  // Replay workflow, or by hand) and is skipped in the main suite. Red on main: the run died on `write EPIPE` and left both
  // scratch databases. The guard (pinned above) and writing the result only after cleanup each prevent it on their own.
  const adminUrl = process.env.MIGRATION_REPLAY_ADMIN_URL;
  it.skipIf(!adminUrl)('`--print` with stdout closed before the first write leaves no hadron_replay*434_* database behind', async () => {
    // `node --import tsx` keeps the script in THIS process id, which names its scratch databases (`<prefix>_<pid>_<hex>`).
    const child = spawn(process.execPath, ['--import', 'tsx', join(HERE, 'migration-replay.ts'), '--print'], {
      cwd: ROOT, env: { ...process.env, MIGRATION_REPLAY_ADMIN_URL: adminUrl }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.destroy(); // the reader is gone before anything is written, as `| head` is once it has its lines
    let stderr = '';
    child.stderr!.on('data', (d) => { stderr += String(d); });
    const code = await new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datname LIKE 'hadron\\_replay%434\\_' || $1 || '\\_%'`, [String(child.pid)],
      );
      // Leave nothing behind even when the pin is red.
      for (const r of rows) await admin.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
      expect(rows.map((r) => r.datname), `leaked scratch databases; exit ${code}; stderr:\n${stderr}`).toEqual([]);
    } finally {
      await admin.end();
    }
    expect(code, stderr).toBe(0);
  }, 300_000);
});

describe('#4395 item 2: the workflow\'s growth-approval label filters (scripts/db/growth-approval.sh)', () => {
  const SCRIPT = join(HERE, 'growth-approval.sh');
  const run = (args: string[], payload: unknown) =>
    execFileSync('bash', [SCRIPT, ...args], { input: JSON.stringify(payload), encoding: 'utf8' }).trim();
  const SHA = 'a'.repeat(40);
  const label = (name: string) => ({ name });

  it('push: the PR whose merge commit IS the push lends its label', () => {
    expect(run(['push', SHA], [{ number: 1, merge_commit_sha: SHA, labels: [label('x'), label('baseline-growth-approved')] }])).toBe('true');
  });
  it('push: a stacked PR that only contains the commit does not, even with the label', () => {
    expect(run(['push', SHA], [
      { number: 2, merge_commit_sha: 'b'.repeat(40), labels: [label('baseline-growth-approved')] },
      { number: 1, merge_commit_sha: SHA, labels: [label('x')] },
    ])).toBe('false');
  });
  it('push: an empty response is not approved', () => {
    expect(run(['push', SHA], [])).toBe('false');
  });
  it('push: a PR with no labels field is not approved, and the filter does not error', () => {
    expect(run(['push', SHA], [{ number: 1, merge_commit_sha: SHA }])).toBe('false');
  });
  it('pr: the PR\'s own label approves; without it, or with no labels field, it does not', () => {
    expect(run(['pr'], { pull_request: { labels: [label('baseline-growth-approved')] } })).toBe('true');
    expect(run(['pr'], { pull_request: { labels: [label('other')] } })).toBe('false');
    expect(run(['pr'], { pull_request: {} })).toBe('false');
  });
  it('an unknown mode or a push without a SHA is a usage error, never an approval', () => {
    expect(() => run(['nope'], {})).toThrow();
    expect(() => run(['push'], [])).toThrow();
  });
});

describe('#4395 item 2: --print ignores the baselines', () => {
  it('evaluate with print: true gives the same code and output with or without a baseline and a base baseline', () => {
    const fp = '0123456789abcdef';
    const entries = [`added idx:new ${fp}`, `changed col:t.c ${fp}`];
    const details = new Map<string, string>();
    const bare = evaluate({ entries, details, print: true, baseline: undefined, baseBaseline: undefined, allowGrowth: false });
    // A baseline that would make the run red three ways: a stale line, an unlisted entry and growth over the base.
    const loaded = evaluate({ entries, details, print: true, baseline: [`added idx:gone ${fp}`], baseBaseline: [], allowGrowth: false });
    expect(loaded).toEqual(bare);
    expect(bare).toEqual({ code: 0, out: entries, err: [] });
  });
});
