/**
 * Test-side helper for the #561 git transport guard.
 *
 * Deliberately NOT in `src/test/helpers.ts`: that module is imported by nearly
 * every test file in the suite, and putting a git-specific helper there would
 * pull `child_process` into all of their import graphs to serve two of them.
 * A helper's blast radius should match its audience.
 */
import { GIT_TRANSPORT_GUARD } from '../integrations/github/execGit.js';

/**
 * Split a recorded `git` argv into the #561 transport guard and the command's
 * own arguments.
 *
 * Every git invocation goes through `execGit`, which prepends
 * `GIT_TRANSPORT_GUARD` — so a test that reads `argv[0]` to identify the
 * command sees `-c` instead of `clone`. This is what those tests call, and it
 * returns `guarded` as well as `args` so a test can assert the guard is present
 * rather than silently accepting an unguarded call.
 *
 * `guarded` is false when the prefix does not match exactly, which is the shape
 * a regression takes: a call site that reached for `execFile('git', …)`
 * directly.
 *
 * An EMPTY `GIT_TRANSPORT_GUARD` is reported as NOT guarded, deliberately. A
 * zero-token prefix matches every argv, so without this every "each invocation
 * is guarded" assertion in the suite would pass against a guard that had been
 * emptied — a check that reads as a guarantee and measures nothing. Found by
 * mutation: emptying the constant left all but one of them green.
 *
 * Matching the prefix says the guard is PRESENT, never that it is CORRECT — a
 * weakened policy (`protocol.allow=always`) still matches. The policy itself is
 * pinned once, literally, in `execGit.test.ts`.
 */
export function splitGitArgv(argv: string[]): { guarded: boolean; args: string[] } {
  const prefix = argv.slice(0, GIT_TRANSPORT_GUARD.length);
  const guarded = GIT_TRANSPORT_GUARD.length > 0
    && prefix.length === GIT_TRANSPORT_GUARD.length
    && prefix.every((a, i) => a === GIT_TRANSPORT_GUARD[i]);
  return { guarded, args: guarded ? argv.slice(GIT_TRANSPORT_GUARD.length) : argv };
}
