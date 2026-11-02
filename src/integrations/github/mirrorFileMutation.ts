/** #3242: a failed row must not leave partial files for a sibling's git add -A. */
import { cpSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

export function hasIncompleteMirrorMutation(localPath: string): boolean {
  try { lstatSync(mirrorMutationMarker(localPath)); return true; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export const mirrorMutationMarker = (localPath: string) => join(localPath, '.git', 'hadron-incomplete-row');

/**
 * Checkpoint only this operation's file and legacy paths, after preceding healthy
 * operations. Never reset HEAD or the whole tree: that would discard those siblings.
 * A crash or failed rollback leaves a marker that blocks ALL mirror commits on this
 * checkout until it is repaired/recloned. The backup stays available for repair.
 */
export function mutateMirrorFiles(localPath: string, paths: readonly string[], mutate: () => void): void {
  const marker = mirrorMutationMarker(localPath);
  let safeToClean = true;
  const entries = [...new Set(paths)].map((path, i) => {
    let exists = false;
    try { lstatSync(path); exists = true; } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return { path, index: String(i), exists };
  });
  const backup = mkdtempSync(join(tmpdir(), 'hadron-mirror-row-'));
  try {
    for (const entry of entries) if (entry.exists) cpSync(entry.path, join(backup, entry.index), { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(backup, 'manifest.json'), JSON.stringify(entries));
    // Keep the backup on a crash; no payload or exception text enters the marker.
    writeFileSync(marker, backup, { flag: 'wx' });
    safeToClean = false;
    try {
      mutate();
    } catch (err) {
      for (const entry of entries) {
        rmSync(entry.path, { recursive: true, force: true });
        if (entry.exists) {
          mkdirSync(dirname(entry.path), { recursive: true });
          // Backup and checkout can be on different filesystems.
          cpSync(join(backup, entry.index), entry.path, { recursive: true, verbatimSymlinks: true });
        }
      }
      rmSync(marker);
      safeToClean = true;
      throw err;
    }
    rmSync(marker);
    safeToClean = true;
  } finally {
    if (safeToClean) {
      // Completed checkpoint cleanup is not a row failure: publishing a successful
      // mutation while charging it TREE_WRITE would misreport that row again.
      try { rmSync(backup, { recursive: true, force: true }); }
      catch { console.warn('[git-mirror] Could not remove a completed file checkpoint'); }
    }
  }
}
