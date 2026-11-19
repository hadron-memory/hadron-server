import { lstatSync, rmdirSync, unlinkSync } from 'fs';
import { basename, join } from 'path';

/**
 * The legacy edge sidecar of a node is `<parent>/.<lastSegment>/edges.yaml` (#3264).
 *
 * The directory name is derived from a loc atom, so it can collide with a dotted directory the
 * checkout itself owns: loc `git` names `<checkout>/.git`, `hadron` names `.hadron`, `github`
 * names `.github`, and `<dir>:node` names the legacy `.node/` layout of a different node. The
 * mirror used to `rmSync(recursive)` that path after every write, which destroyed the repository
 * metadata and its unpublished commits. Cleanup is now bounded by construction: it can remove one
 * regular file and one empty directory, never a tree.
 *
 * Reserved names are compared case-insensitively. The importer uses the same predicate for the
 * sidecar it reads, so an `edges.yaml` in a reserved directory (which cleanup refuses to touch)
 * cannot mask a node's inline edges. The legacy `.node/node.yaml` loader does not read edges
 * through the sidecar path and is not affected.
 */
const RESERVED_SIDECAR_NAMES = new Set(['.git', '.node', '.hadron', '.github']);

/**
 * Whether a dotted directory name belongs to the checkout or the legacy layout, not to a sidecar.
 * The case-insensitive match is deliberately conservative for deletion (a `.GIT` or `.Hadron` directory is never
 * touched, including on case-insensitive filesystems) and lossy for import (an `edges.yaml` beside such a name
 * is ignored rather than read, so it cannot mask a node's inline edges).
 */
export function isReservedSidecarName(name: string): boolean {
  return RESERVED_SIDECAR_NAMES.has(name.toLowerCase());
}

const isMissing = (err: unknown) => ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '');

/**
 * The one file cleanup may remove for `sidecar`: its `edges.yaml`, only when `sidecar` is a
 * real (non-link) directory with a non-reserved name and `edges.yaml` is a regular file.
 * `lstat`, never `stat`: a symlink or gitlink is not ours. Null means cleanup does nothing.
 * Missing paths are a no-op; any other error propagates.
 */
export function legacySidecarEdgesFile(sidecar: string): string | null {
  if (isReservedSidecarName(basename(sidecar))) return null;
  try {
    if (!lstatSync(sidecar).isDirectory()) return null;
    const edges = join(sidecar, 'edges.yaml');
    return lstatSync(edges).isFile() ? edges : null;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * Remove a legacy edge sidecar: unlink `edges.yaml`, then rmdir the directory only if that left
 * it empty. Other files stay (the importer reads `edges.yaml` whatever sits beside it, so it must
 * go, while the rest is not ours to delete). Not atomic against an external writer swapping the
 * path between the `lstat` and the `unlink`; the bound is that the most this can remove is one
 * regular file and an empty directory.
 */
export function removeLegacySidecar(sidecar: string): void {
  const edges = legacySidecarEdgesFile(sidecar);
  if (edges === null) return;
  try { unlinkSync(edges); } catch (err) { if (!isMissing(err)) throw err; }
  try { rmdirSync(sidecar); } catch (err) {
    if (!isMissing(err) && !['ENOTEMPTY', 'EEXIST'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
  }
}
