import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock child_process.execFile. `git rev-parse --verify --quiet <ref>` resolves
// or rejects based on `existingRefs`, mirroring how real git exits non-zero for
// a missing ref. Every other git command succeeds, unless its argv matches
// `failArgv` (used to simulate a non-ff `git merge`). All argv vectors are
// recorded in `calls` for assertions.
// ---------------------------------------------------------------------------
let existingRefs: Set<string>;
let failArgv: ((argv: string[]) => boolean) | null;
const calls: string[][] = [];

vi.mock('child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const argv = args[1] as string[];
    const cb = args[args.length - 1] as (e: Error | null, o: string, err: string) => void;
    calls.push(argv);

    if (argv[0] === 'rev-parse') {
      const ref = argv[argv.length - 1];
      if (!existingRefs.has(ref)) {
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
  failArgv = null;
});

describe('prepareWriteBranch', () => {
  it('local branch exists, origin/<branch> does NOT: checkout only, never re-create', async () => {
    // The exact state behind the reported bug: a non-default write branch
    // created locally on the first push and never tracked. Must NOT run
    // `checkout -b`, which would die "a branch named '…' already exists".
    existingRefs = new Set(['refs/heads/changes']);
    await prepareWriteBranch('/repo', 'changes');

    expect(actions()).toEqual([['checkout', 'changes']]);
    expect(actions().some((a) => a[0] === 'checkout' && a[1] === '-b')).toBe(false);
  });

  it('local + origin both exist: checkout then fast-forward to origin', async () => {
    existingRefs = new Set(['refs/heads/changes', 'refs/remotes/origin/changes']);
    await prepareWriteBranch('/repo', 'changes');

    expect(actions()).toEqual([
      ['checkout', 'changes'],
      ['merge', '--ff-only', 'origin/changes'],
    ]);
  });

  it('a non-ff divergence is swallowed (left for push to reject), not thrown', async () => {
    existingRefs = new Set(['refs/heads/changes', 'refs/remotes/origin/changes']);
    failArgv = (argv) => argv[0] === 'merge';
    await expect(prepareWriteBranch('/repo', 'changes')).resolves.toBeUndefined();
  });

  it('origin/<branch> exists but no local branch: create one tracking the remote', async () => {
    existingRefs = new Set(['refs/remotes/origin/changes']);
    await prepareWriteBranch('/repo', 'changes');

    expect(actions()).toEqual([['checkout', '-b', 'changes', 'origin/changes']]);
  });

  it('branch absent on both sides: fork a new one from origin/main', async () => {
    existingRefs = new Set(['refs/remotes/origin/main']);
    await prepareWriteBranch('/repo', 'changes');

    expect(actions()).toEqual([['checkout', '-b', 'changes', 'origin/main']]);
  });
});
