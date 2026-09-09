/**
 * #561 — the git transport allowlist, pinned literally.
 *
 * Every other test in the suite checks that a git invocation CARRIES the guard,
 * by comparing its argv prefix to `GIT_TRANSPORT_GUARD`. That is a shape check:
 * it goes green for any value of the constant, including a weakened one and
 * (before the `length > 0` arm in `splitGitArgv`) an empty one. So the policy
 * itself is asserted here, spelled out, in exactly one place.
 *
 * What the policy has to be, and why each clause is load-bearing:
 *
 *   - `protocol.allow=never` — DENY BY DEFAULT. Two reasons, and the second is
 *     the one the measurement produced: a denylist naming `ext` has to be
 *     revisited every time git grows a transport, AND `ext` turned out not to
 *     be the reachable transport at all — `file` was (see execGit.ts). A guard
 *     written to the issue's payload would have closed the case and left the
 *     live path open.
 *   - `protocol.https.allow=always` — every clone/fetch/push in practice.
 *   - `protocol.ssh.allow=always` — `pushMemoryToGit` falls back to the raw
 *     `Memory.source` when an org has no installation token, and
 *     `git@github.com:owner/repo` is an accepted source spelling.
 *
 * Inverting the first clause is the mutation this file exists to catch: it
 * reads as a guard, matches the prefix shape, and permits `ext::` again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[][] = [];

vi.mock('child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    calls.push(args[1] as string[]);
    const cb = args[args.length - 1] as (e: Error | null, o: string, err: string) => void;
    cb(null, '', '');
  }),
}));

const { execGit, GIT_TRANSPORT_GUARD } = await import('./execGit.js');

beforeEach(() => {
  calls.length = 0;
});

describe('GIT_TRANSPORT_GUARD', () => {
  it('is deny-by-default, allowing only https and ssh', () => {
    expect([...GIT_TRANSPORT_GUARD]).toEqual([
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      '-c', 'protocol.ssh.allow=always',
    ]);
  });

  it('denies by default rather than naming the transports it refuses', () => {
    // The property, stated independently of the exact argv above: there is no
    // `protocol.<x>.allow=never` clause, because the base policy already
    // refuses everything not explicitly allowed. A guard that switched to
    // naming `ext` would satisfy the issue's reproduction and still let the
    // next transport through.
    const policy = GIT_TRANSPORT_GUARD.filter((a) => a !== '-c');
    expect(policy).toContain('protocol.allow=never');
    expect(policy.filter((p) => p.endsWith('=never'))).toEqual(['protocol.allow=never']);
    // ext:: is refused by the default, and must never be explicitly allowed.
    expect(policy).not.toContain('protocol.ext.allow=always');
  });
});

describe('execGit', () => {
  it('prepends the guard, ahead of the command', async () => {
    await execGit(['clone', '--', 'https://github.com/o/r', '/tmp/r']);

    expect(calls).toHaveLength(1);
    const [command, argv] = [calls[0], calls[0]];
    expect(command).toBeDefined();
    expect(argv.slice(0, GIT_TRANSPORT_GUARD.length)).toEqual([...GIT_TRANSPORT_GUARD]);
    // The guard has to LEAD: git only honours `-c` overrides that precede the
    // subcommand, so a guard appended after `clone` would be passed to clone as
    // arguments and silently not apply.
    expect(argv[GIT_TRANSPORT_GUARD.length]).toBe('clone');
  });

  it('leaves the caller argv otherwise untouched', async () => {
    await execGit(['pull', '--ff-only'], { cwd: '/repo' });

    expect(calls[0].slice(GIT_TRANSPORT_GUARD.length)).toEqual(['pull', '--ff-only']);
  });

  it('runs `git`, never a caller-chosen binary', async () => {
    // The helper's whole contract is that the executable is fixed and only the
    // arguments vary; a signature that let the binary vary would reintroduce
    // the class this module closes.
    const { execFile } = await import('child_process');
    await execGit(['status', '--porcelain'], { cwd: '/repo' });
    expect((execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('git');
  });
});
