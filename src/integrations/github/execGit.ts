/**
 * The ONE place this server shells out to `git` (#561).
 *
 * Every git invocation goes through `execGit`, which prepends a transport
 * allowlist to the argv. It exists so the guard cannot drift: a new call site
 * that reaches for `execFile('git', …)` directly is the defect, and there is
 * nothing to remember at the call site because the helper carries it.
 *
 * ## Why the guard is here at all
 *
 * `git` treats a remote URL as a *transport selector*, not just an address.
 * `ext::<command>` runs `<command>` and speaks the pack protocol over its
 * stdio — by design. So any code path that hands git a caller-influenced URL is
 * a command-execution primitive unless the transport is constrained. Ours is
 * `Memory.source`, settable through `createMemory` / `updateMemory`.
 *
 * **Measured, because the issue's premise did not survive it (2026-09-08).**
 * #561 says an `ext::` source yields command execution. Run against the git
 * that actually serves this code — 2.50.1 locally, 2.54.0 in the prd container,
 * neither carrying any `protocol.*` config — `ext::` is refused by git's OWN
 * default: `fatal: transport 'ext' not allowed`. It executes only when
 * something sets `protocol.ext.allow`, which nothing here does. So the headline
 * RCE was not reachable on this deployment, and the issue's re-verification
 * ("grep finds no protocol guard") was true about our code and silent about
 * git's defaults.
 *
 * What the same measurement DID find reachable, on both versions, by default:
 *
 *   - **`file` / a bare local path clones.** `protocol.file.allow` defaults to
 *     `user`, and a server-issued clone counts as `user`. A `source` of
 *     `/srv/something` ingests that repository's files into the memory as
 *     nodes — host-filesystem disclosure into a tenant-readable graph.
 *   - **Any https host clones.** Nothing pinned github.com, so `source` was an
 *     outbound-request primitive (the SSRF half). That one is closed by
 *     `validateMemorySource`, not here.
 *
 * The `ext` clause is still the right thing to write, and this is why: git's
 * default is a property of the BINARY, not of our code. It is not pinned by
 * anything in this repo, the base image, or the deployment; a rebuild onto a
 * distro that ships a different default, or any future `protocol.*` config,
 * silently re-opens it. Denying by default costs nothing and does not depend on
 * a version we do not control.
 *
 * ## What this guard does NOT cover — and what does
 *
 * `Memory.source` is validated by `validateMemorySource`, at the mutations AND
 * again at each point of use (`syncGraphFromGithub`, `pushMemoryToGit`,
 * `withMirrorCheckout`). Both are needed, and the reason is a correction to an
 * earlier draft of this comment, which claimed this guard was "the layer that
 * holds for a value that reached the column some other way". **It is not, for
 * the SSRF case.** https is explicitly ALLOWED here — it has to be, it is the
 * production transport — so a stored non-github https source sails straight
 * through the guard. Only the allowlist refuses that one, which is why the
 * allowlist is re-run against the STORED value rather than only the incoming
 * one (@codex, PR #1142).
 *
 * The division of labour, stated so neither is mistaken for the other:
 *
 *   - the allowlist decides WHICH HOST, and is the only thing that can;
 *   - this guard decides WHICH TRANSPORT, and holds even for a value that never
 *     passed the allowlist at all — a URL this server builds from parts, or an
 *     argv assembled by a call site added later.
 *
 * ## The policy
 *
 * Deny by default, allow the two transports this integration actually uses.
 * An allowlist rather than `protocol.ext.allow=never`, because a denylist has
 * to be revisited every time git grows a transport; this one does not.
 *
 * - `https` — every clone/fetch/push in practice. `toHttpsUrl` rewrites both
 *   accepted `source` spellings to an `https://x-access-token:…@github.com/…`
 *   URL before git ever sees it.
 * - `ssh` — kept because `pushMemoryToGit` falls back to the raw `source` when
 *   an org has no installation token, and `git@github.com:owner/repo` is an
 *   accepted source spelling. Nothing in dev or prod uses it today (measured
 *   2026-09-08: 12 non-null sources, all `https://github.com/…`), so this is
 *   preserving a documented shape rather than a live path.
 *
 * Everything else — `ext`, `file`, `git`, and whatever comes next — is refused
 * by git itself, with a message naming the protocol.
 *
 * The policy applies to sub-invocations too: git exports `-c` overrides through
 * `GIT_CONFIG_PARAMETERS`, so a helper git spawns inherits them.
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { mirrorFailureMetadata, type MirrorFailureMetadata } from './mirrorFailureMetadata.js';

const execFile = promisify(execFileCb);

/**
 * Transport allowlist, prepended to every git argv.
 *
 * Exported for tests, which assert it is present on the clone/pull path rather
 * than trusting that a call site remembered it.
 */
export const GIT_TRANSPORT_GUARD: readonly string[] = Object.freeze([
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.ssh.allow=always',
]);

/** Options accepted by a git invocation — the `execFile` subset we use. */
export interface ExecGitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Never expose an execFile rejection: Node includes the full argv in its
 * message/cmd, and git may repeat the authenticated remote in stderr. The
 * installation token is in that argv for clone and remote set-url. Keep no
 * raw cause, command or output on this error. Only bounded allowlisted diagnostic fields survive.
 */
export class GitCommandError extends Error {
  readonly code = 'GIT_COMMAND_FAILED';

  readonly exitCode?: number;
  readonly providerCode?: MirrorFailureMetadata['providerCode'];
  readonly signal?: MirrorFailureMetadata['signal'];

  constructor(error?: unknown) {
    super('Git command failed. Check the repository and branch, then retry.');
    this.name = 'GitCommandError';
    const metadata = mirrorFailureMetadata(error, 'git', 'GIT_COMMAND_FAILED');
    this.exitCode = metadata.exitCode;
    this.providerCode = metadata.providerCode;
    this.signal = metadata.signal;
  }
}

/**
 * Run `git` with the transport guard applied.
 *
 * `args` is the command's own argv (`['clone', url, path]`), WITHOUT the guard —
 * callers never spell it. Resolves with the process output. A failed command
 * rejects with fixed copy, never with execFile's credential-bearing argv or
 * git's stderr.
 */
export async function execGit(
  args: string[],
  options: ExecGitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile('git', [...GIT_TRANSPORT_GUARD, ...args], options);
  } catch (error) {
    throw new GitCommandError(error);
  }
}
