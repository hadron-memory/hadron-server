/** #4091 — wakes for plain-directory workers: teamBinding, resolveTerminal and hostRoster. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostRoster } from '../ticker-wake/ticker-wake.js';
import { resolveTerminal, teamBinding, type Config, type RosterEntry } from './router.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plain4091-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const plain = (name: string, worker: string | null): string => {
  const d = join(root, name);
  mkdirSync(join(d, '.hadron-team'), { recursive: true });
  if (worker) writeFileSync(join(d, '.hadron-team', 'hadron-team-session.json'), JSON.stringify({ workerId: worker, sessionId: 's1', appId: 'a1' }));
  return d;
};
const gitWt = (name: string, worker: string | null): string => {
  const d = join(root, name);
  mkdirSync(join(d, '.git'), { recursive: true });
  if (worker) writeFileSync(join(d, '.git', 'hadron-team-session.json'), JSON.stringify({ workerId: worker }));
  return d;
};
const term = (handle: string, worktreePath: string, extra: Record<string, unknown> = {}) =>
  ({ handle, worktreePath, agentIdentity: 'claude', connected: true, writable: true, ...extra });
const row = (worker: string, worktree: string, terminal?: string): RosterEntry => ({ worker, name: worker, worktree, ...(terminal ? { terminal } : {}) });
const cfgOf = (roster: RosterEntry[]): Config => ({ roster } as unknown as Config);

describe('teamBinding for a plain directory', () => {
  it('reads <dir>/.hadron-team/hadron-team-session.json when .git is absent', () => {
    expect(teamBinding(plain('p', 'w-a'))).toEqual({ workerId: 'w-a', sessionId: 's1', appId: 'a1' });
  });
  it('is null with no binding file, and ignores .hadron-team when a .git exists', () => {
    expect(teamBinding(plain('q', null))).toBeNull();
    const g = gitWt('g', null);
    mkdirSync(join(g, '.hadron-team'));
    writeFileSync(join(g, '.hadron-team', 'hadron-team-session.json'), JSON.stringify({ workerId: 'w-x' }));
    expect(teamBinding(g)).toBeNull();
  });
});

describe('resolveTerminal for a plain-directory row', () => {
  it("resolves the row's own pinned terminal although its worktreePath differs", () => {
    const d = plain('p', 'w-a'); const other = gitWt('creator', null);
    const r = row('w-a', d, 't1');
    expect(resolveTerminal(r, [term('t1', other)], cfgOf([r]))).toEqual(['t1', 'claude', 'pin']);
  });
  it('holds: pin missing, no fallback to identity in the directory', () => {
    const d = plain('p', 'w-a'); const r = row('w-a', d);
    const [h, why] = resolveTerminal(r, [term('t1', d)], cfgOf([r]));
    expect(h).toBeNull(); expect(why).toBe('plain directory: pin missing');
  });
  it('holds: pin absent from terminals, and pin disconnected or unwritable', () => {
    const d = plain('p', 'w-a'); const r = row('w-a', d, 't1');
    expect(resolveTerminal(r, [term('t9', d)], cfgOf([r]))[1]).toBe('plain directory: pin stale');
    expect(resolveTerminal(r, [term('t1', d, { connected: false })], cfgOf([r]))[1]).toBe('plain directory: pin stale');
    expect(resolveTerminal(r, [term('t1', d, { writable: false })], cfgOf([r]))[0]).toBeNull();
  });
  it('holds: pin claimed by another roster row (its pin)', () => {
    const d = plain('p', 'w-a'); const r = row('w-a', d, 't1'); const o = row('w-b', gitWt('b', 'w-b'), 't1');
    const [h, why] = resolveTerminal(r, [term('t1', d)], cfgOf([r, o]));
    expect(h).toBeNull(); expect(why).toBe('plain directory: pin claimed by w-b');
  });
  it('holds: pin claimed by another roster row (its worktree is the terminal\'s)', () => {
    const d = plain('p', 'w-a'); const bwt = gitWt('b', 'w-b');
    const r = row('w-a', d, 't1'); const o = row('w-b', bwt);
    expect(resolveTerminal(r, [term('t1', bwt)], cfgOf([r, o]))[1]).toBe('plain directory: pin claimed by w-b');
  });
  it("holds: the terminal's worktreePath is bound to a different worker (no roster row)", () => {
    const d = plain('p', 'w-a'); const bwt = gitWt('b', 'w-b'); const r = row('w-a', d, 't1');
    expect(resolveTerminal(r, [term('t1', bwt)], cfgOf([r]))[1]).toBe('plain directory: pin claimed by w-b');
  });
  it('holds: the directory binding names another worker', () => {
    const d = plain('p', 'w-b'); const r = row('w-a', d, 't1');
    const [h, why] = resolveTerminal(r, [term('t1', d)], cfgOf([r]));
    expect(h).toBeNull(); expect(why).toContain('w-b');
  });
});

describe('worktree rows are unchanged', () => {
  it('still resolves by identity in its own worktree, and ignores a pin outside it', () => {
    const wt = gitWt('wt', 'w-a'); const elsewhere = gitWt('el', null);
    const r = row('w-a', wt, 'tz');
    expect(resolveTerminal(r, [term('t1', wt), term('tz', elsewhere)], cfgOf([r]))).toEqual(['t1', 'claude', 'identity']);
  });
});

describe('hostRoster for a plain-directory roster row', () => {
  const run = (() => { throw new Error('no run expected'); }) as any;
  it('is live exactly when the guarded pin passes', () => {
    const d = plain('p', 'w-a'); const creator = gitWt('creator', null); const r = row('w-a', d, 't1');
    const hr = hostRoster(cfgOf([r]), [term('t1', creator)], run);
    expect(hr.why('w-a')).toBe(''); expect(hr.entry('w-a', 'A')).toEqual(r);
  });
  it('holds with the fixed reason when the pin is stale', () => {
    const d = plain('p', 'w-a'); const r = row('w-a', d, 't1');
    const hr = hostRoster(cfgOf([r]), [term('t2', d)], run);
    expect(hr.why('w-a')).toBe('plain directory: pin stale'); expect(hr.entry('w-a', 'A')).toBeNull();
  });
  it('holds when the pin is claimed by another worker', () => {
    const d = plain('p', 'w-a'); const bwt = gitWt('b', 'w-b'); const r = row('w-a', d, 't1');
    const hr = hostRoster(cfgOf([r]), [term('t1', bwt)], run);
    expect(hr.why('w-a')).toBe('plain directory: pin claimed by w-b');
  });
});
