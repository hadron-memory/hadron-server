import { describe, it, expect, beforeEach, vi } from 'vitest';
import { splitGitArgv } from '../../test/gitArgv.js';

// ---------------------------------------------------------------------------
// Mock child_process.execFile. `git rev-parse --verify --quiet <ref>` resolves
// or rejects based on `existingRefs`, mirroring how real git exits non-zero for
// a missing ref. Refs are normalized so the short (`origin/main`) and full
// (`refs/remotes/origin/main`) spellings of the same ref are equivalent — real
// `git rev-parse` resolves both. Every other git command succeeds, unless its
// argv matches `failArgv` (used to simulate a non-ff `git merge`). All argv
// vectors are recorded in `calls` for assertions.
// ---------------------------------------------------------------------------
let existingRefs: Set<string>;
let failArgv: ((argv: string[]) => boolean) | null;
const calls: string[][] = [];
/** Whether each recorded invocation carried the #561 transport guard. */
const guardFlags: boolean[] = [];

/** Normalize a git ref to a stable key: refs/heads/x → x, refs/remotes/x → x. */
function refKey(ref: string): string {
  if (ref.startsWith('refs/remotes/')) return ref.slice('refs/remotes/'.length);
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  return ref;
}

vi.mock('child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const rawArgv = args[1] as string[];
    const cb = args[args.length - 1] as (e: Error | null, o: string, err: string) => void;
    // #561 — every invocation carries the transport guard; record it separately
    // so the assertions below still read as the command's own argv, and record
    // whether it was there so `every call is guarded` is checkable.
    const { guarded, args: argv } = splitGitArgv(rawArgv);
    calls.push(argv);
    guardFlags.push(guarded);

    if (argv[0] === 'rev-parse') {
      const ref = argv[argv.length - 1];
      if (!existingRefs.has(refKey(ref))) {
        cb(new Error(`fatal: Needed a single revision`), '', '');
        return;
      }
    }
    if (failArgv?.(argv)) {
      cb(new Error('fatal: Not possible to fast-forward, aborting.'), '', '');
      return;
    }
    cb(null, '', '');
  }),
}));

const { prepareWriteBranch } = await import('./gitBranch.js');

/** git argv vectors that aren't the existence probes. */
function actions(): string[][] {
  return calls.filter((c) => c[0] !== 'rev-parse');
}

beforeEach(() => {
  calls.length = 0;
  guardFlags.length = 0;
  failArgv = null;
});

describe('prepareWriteBranch', () => {
  it('local branch exists, origin/<branch> does NOT: checkout only, never re-create', async () => {
    // The exact state behind the reported bug: a non-default write branch
    // created locally on the first push and never tracked. Must NOT run
    // `checkout -b`, which would die "a branch named '…' already exists".
    existingRefs = new Set(['changes']);
    await prepareWriteBranch('/repo', 'changes');

    expect(actions()).toEqual([['checkout', 'changes']]);
    expect(actions().some((a) => a[0] === 'checkout' && a[1] === '-b')).toBe(false);
  });

  it('local + origin both exist: checkout then fast-forward to origin', async () => {
    existingRefs = new Set(['changes', 'origin/changes']);
    await prepareWriteBranch('/repo', 'changes');

    expect(actions()).toEqual([
      ['checkout', 'changes'],
      ['merge', '--ff-only', 'origin/changes'],
    ]);
  });

  it('a non-ff divergence is swallowed (left for push to reject), not thrown', async () => {
    existingRefs = new Set(['changes', 'origin/changes']);
    failArgv = (argv) => argv[0] === 'merge';
    await expect(prepareWriteBranch('/repo', 'changes')).resolves.toBeUndefined();
  });

  it('origin/<branch> exists but no local branch: create one tracking the remote', async () => {
    existingRefs = new Set(['origin/changes']);
    await prepareWriteBranch('/repo', 'changes');

    expect(actions()).toEqual([['checkout', '-b', 'changes', 'origin/changes']]);
  });

  // --- brand-new branch: base resolution (origin/main was previously hardcoded) ---

  it('brand-new branch forks from the read branch when given and present', async () => {
    existingRefs = new Set(['origin/production', 'origin/HEAD', 'origin/main']);
    await prepareWriteBranch('/repo', 'changes', 'production');

    expect(actions()).toEqual([['checkout', '-b', 'changes', 'origin/production']]);
  });

  it('brand-new branch falls back to origin/HEAD (remote default) over main', async () => {
    // read branch given but absent on the remote → next preference is the
    // remote's default branch, not a hardcoded main.
    existingRefs = new Set(['origin/HEAD', 'origin/main']);
    await prepareWriteBranch('/repo', 'changes', 'production');

    expect(actions()).toEqual([['checkout', '-b', 'changes', 'origin/HEAD']]);
  });

  it('brand-new branch falls back to origin/master when there is no main/HEAD', async () => {
    existingRefs = new Set(['origin/master']);
    await prepareWriteBranch('/repo', 'changes');

    expect(actions()).toEqual([['checkout', '-b', 'changes', 'origin/master']]);
  });

  it('brand-new branch with no resolvable base: create from current HEAD (no start point)', async () => {
    existingRefs = new Set();
    await prepareWriteBranch('/repo', 'changes');

    expect(actions()).toEqual([['checkout', '-b', 'changes']]);
  });

  // #561 — the guard is a property of EVERY invocation, not of the clone. These
  // are local-ref commands that cannot reach a remote, and they are still
  // asserted: the point of routing all of them through one helper is that no
  // call site has to be judged individually, and a direct `execFile('git', …)`
  // added here later would show up as an unguarded call.
  it('every git invocation carries the transport guard', async () => {
    existingRefs = new Set(['changes', 'origin/changes']);
    await prepareWriteBranch('/repo', 'changes');

    expect(guardFlags.length).toBeGreaterThan(0);
    expect(guardFlags.every(Boolean)).toBe(true);
  });
});
