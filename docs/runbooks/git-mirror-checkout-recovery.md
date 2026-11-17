# Recover an incomplete Git-mirror row mutation

This is an operator-only checkout repair procedure, not a repair API or an
authorization to touch production. Obtain the required host/production grant
first. The application deliberately keeps the checkout blocked until repair is
verified. Never remove the marker merely to retry a push.

## Identify and isolate

1. Identify the affected memory's actual checkout and its host owner. A blocked
   incremental mirror logs "Checkout needs repair after an incomplete file
   mutation"; a manual full push returns that fixed error with nodeCount=0.
   The sweep takes no new attempt on a checkout already marked incomplete.
2. Establish exclusive access for every process/namespace that can use that
   checkout, including ordinary writers, sweep, full push and inbound sync.
   Pausing only the sweep, or observing no local PID, does not prove exclusion.
   Keep this exclusion through all repair and verification steps.
3. In private operator storage, preserve the complete checkout (including .git),
   marker and backup, current branch/index/worktree state and local unpublished
   refs. These may contain plaintext node data or credentials in old Git config;
   do not paste their contents or authenticated remote URLs into tickets/logs.

## Inspect the checkpoint

The marker is .git/hadron-incomplete-row. It names one private checkpoint directory
inside this same checkout's .git. That directory contains manifest.json and
numbered snapshots. Each manifest entry has path (original absolute path), index
(snapshot name) and exists (whether the original path existed).

4. Verify ownership, that the marker names a real non-symlink checkpoint directory
   inside this checkout's .git, and that the manifest is complete. Resolve and
   inspect every path before changing anything: it must name this operation's
   markdown file, legacy README or legacy edge-sidecar subtree within this
   checkout, never .git or another checkout. Inspect symlinks without following
   them outside the checkout. Stop on inconsistent ownership, paths or snapshots.
5. Record which entries existed. For an existing entry, its numbered snapshot
   is the complete pre-operation file/directory/symlink state. For a missing
   entry there must be no original content to recover. Checkpoints are made
   immediately before one operation, so they include any preceding healthy
   sibling edits on overlapping paths.

## Restore and verify

6. Restore only the listed paths, using tools appropriate to their file types:
   replace each exists=true path with its numbered snapshot, preserving bytes,
   file type and modes; remove each exists=false path introduced by that failed
   operation. Do not reset the entire Git tree, delete child directories outside
   the manifest, discard unpublished commits, or re-clone over the existing repo.
7. Verify each restored entry against its snapshot and verify baseline-absent
   entries are absent. Compare the rest of the checkout, index, branch and refs
   with the preserved pre-repair state: unrelated healthy edits and unpublished
   history must remain unchanged. If any copy/check fails, keep the marker and
   retained evidence and stop; the checkout remains blocked.
8. Only after those checks pass, remove this checkout's marker under the same
   exclusive fence. Retain or clean only the matching private checkpoint under
   the operator's evidence-retention policy. Release exclusion and verify the
   next already-authorized mirror attempt can progress normally. Do not clear
   debt rows, reset attempt counts, or requeue EXHAUSTED debt without a separate
   authorization; file repair does not change database attempt state.

## Missing or invalid recovery evidence

Keep the marker and preserve the checkout. No automatic recovery/reset/re-clone is
safe: unpublished local commits may contain writes not present on the remote
(#3234). Obtain a separate recovery decision if reconstructing pre-operation files
requires another source. A replacement checkout is acceptable only after its
operator proves that all intended files and unpublished history are preserved;
this document does not supply that proof or grant that operation.

Checkpoints and markers share the checkout's storage lifetime; this is not a
power-loss/fsync guarantee or a disk-usage bound. Completed-backup cleanup can fail
without blocking a successful mirror; such unreferenced backups are a separate
operator retention concern and must not be deleted by an absence-of-PID guess.
