/**
 * The ONE primitive for the legacy edge sidecar (`<parent>/.<lastSeg>/edges.yaml`) (#3264).
 *
 * The old export wrote a node's edges to a dot-directory beside its file. The importer still reads
 * it and gives it precedence over frontmatter `nodes:`, so a leftover `edges.yaml` masks freshly
 * exported edges and cleanup stays mandatory. But the sidecar name is `'.' + lastSegment` for ANY
 * loc, so loc `git` names `<checkout>/.git` and `hadron`/`github`/`node` name directories that are
 * not ours. The old cleanup `rmSync(..., { recursive })` destroyed repository metadata and every
 * unpublished commit with it.
 *
 * Cleanup therefore never deletes recursively. It may remove exactly one regular file, the
 * sidecar's `edges.yaml`, and then the sidecar directory only if that left it empty:
 *  1. a reserved sidecar name (case-insensitive) does nothing;
 *  2. the sidecar must be a real directory and `edges.yaml` a regular file (`lstat`), so a symlink,
 *     a gitlink file or a directory named `edges.yaml` does nothing;
 *  3. other files in the sidecar stay (the importer reads `edges.yaml` whatever sits beside it).
 *
 * Limit: `lstat` then `unlink` is not atomic. The per-memory mirror lock serialises mirror writers;
 * it does not stop a hostile external rename or symlink swap between the two calls. What this
 * bounds is the damage: the most it can remove is one regular file and an empty directory.
 *
 * Dependency-free on purpose: the importer (`loadNodeFromFs`) and the mirror writers share it.
 */
import { lstatSync, rmdirSync, unlinkSync, type Stats } from 'fs';
import { basename, join } from 'path';

/** Directory names a sidecar may never be: Git metadata, the legacy `.node/` layout and our own roots. */
const RESERVED_SIDECAR_NAMES: ReadonlySet<string> = new Set(['.git', '.node', '.hadron', '.github']);

export function isReservedSidecarName(name: string): boolean {
  return RESERVED_SIDECAR_NAMES.has(name.toLowerCase());
}

/** `lstat`, with "not there / not a directory on the way" as null. Anything else propagates. */
function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * The `edges.yaml` this primitive would remove, or null when the sidecar is not ours to touch.
 * The sweep checkpoints exactly this path, never the sidecar directory.
 */
export function removableSidecarEdgesFile(sidecar: string): string | null {
  if (isReservedSidecarName(basename(sidecar))) return null;
  const dir = lstatOrNull(sidecar);
  if (!dir || !dir.isDirectory()) return null;
  const edges = join(sidecar, 'edges.yaml');
  const file = lstatOrNull(edges);
  return file && file.isFile() ? edges : null;
}

/** Remove the sidecar's `edges.yaml`, then the sidecar directory if that left it empty. Never recursive. */
export function removeLegacySidecar(sidecar: string): void {
  const edges = removableSidecarEdgesFile(sidecar);
  if (!edges) return;
  try { unlinkSync(edges); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try { rmdirSync(sidecar); } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Other files live there (kept), or it is already gone.
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') throw err;
  }
}
