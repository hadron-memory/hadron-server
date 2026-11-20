import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `importMetaUrl` is the file this process was started with (#4348).
 *
 * The jobs' hand-run entry used `import.meta.url === \`file://${process.argv[1]}\``, which is false for a relative
 * `argv[1]` and for a symlink whose real path differs, so the job exited 0 having done nothing. Both sides are compared
 * by real path. No `argv[1]` (`node -e`, a REPL) or a path that cannot be resolved is not the entry: it never throws.
 */
export function isProcessEntry(importMetaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
