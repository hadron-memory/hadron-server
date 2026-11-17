# Git mirror: quarantined commits (#3234)

**Decided policy** (Holger, data-integrity ruling, 2026-11-10, relayed by Fiona on #3234): rejected-but-unpublished work is
moved aside into a held, recoverable area; the branch is marked blocked with a recovery path; healthy writes continue.
Nothing is dropped silently and accepted history is never rewritten. Server-internal only: there is no GraphQL, MCP, portal
or CLI surface. Encrypted memories never reach this path (R206, `ENCRYPTED_GIT_SYNC_UNAVAILABLE`).

## What triggers it

A mirror push of a write branch exits with git status **1** (the remote refused a ref: a pre-receive hook, push protection)
AND, after a fresh fetch, the remote's tip (or the fork base of a new branch) is still an ancestor of the local branch. A
transport failure (status 128), or a remote that moved, is **not** a quarantine: the commit stays for the retry.

## What it does

1. Holds the local tip under `refs/hadron-quarantine/<write-branch>/<commit-sha>` in the memory's own clone
   (`GRAPHS_PATH/<org>/<memory>`). That namespace is **never pushed** (every push uses an explicit `refs/heads/...`
   refspec), so held content never reaches any remote ref, and it is never written to a log or error.
2. Resets the write branch to the published tip, so the refused commit is no longer an ancestor of later pushes.
3. In a retry batch of several rows, publishes the rows one at a time from that clean tip, so a refusal names exactly one row.
4. Charges only the refused row, as `error_class = 'PUSH_REJECTED'` (retry cap and backoff as for any row, `EXHAUSTED` at the
   cap). Healthy rows clear without being charged.

The blocked state is: the `git_mirror_obligations` row(s) with `error_class = 'PUSH_REJECTED'`, plus one log line per
quarantine: `git-mirror.quarantine memory=<id> branch=<branch> commits=<n> recovery=runbook` (ids and a count only).

## Recover

```sql
-- Which memories and branches are blocked
SELECT memory_id, node_id, kind, branch, state, attempts FROM git_mirror_obligations WHERE error_class = 'PUSH_REJECTED';
```

```bash
cd "$GRAPHS_PATH/<org>/<memory>"
git for-each-ref refs/hadron-quarantine/            # the held work
git log --stat <held-ref>                            # inspect it (it may contain a secret: handle accordingly)
```

1. Remove the cause at the remote (a rejected secret: rotate it and release the push-protection block, or fix the content).
2. Reset the debt so the sweep retries it: `UPDATE git_mirror_obligations SET state = 'FAILED', attempts = 1 WHERE memory_id = '<id>' AND error_class = 'PUSH_REJECTED';`
   (a new write to the node also retries it). The next sweep publishes the node's **current** DB content.
3. The held refs are never deleted automatically. Once the content is accounted for, delete each with
   `git update-ref -d <held-ref>`. Held work that is still wanted can be restored with `git cherry-pick <held-ref>`.

Each refused retry holds one more ref (bounded by the retry cap), so a long-blocked row accrues at most that many.
