# Orca attention router

Nudges **Orca-hosted** Hadron team workers when they are mentioned in team chat. It types one count-only line into the worker's Orca terminal, and the worker then reads the chat itself.

- **One router per host app** (Holger, 2026-09-25). This is Orca's; the Codex Desktop router is separate. The two share no token and **no roster**: a worker belongs to exactly one host router, or it gets nudged twice.
- **It reads nothing.** It never reads, relays or posts a chat message, never marks anything read, and never changes server state.
- **No model in the loop.** Delivery needs no judgement, so this is a plain script.
- **Operating procedure:** the Hadron skill `hrn:node:hadronmemory.com:core:tasks:orca-attention-router`.
- **Brief:** `hrn:node:hadronmemory.com:hadron-dev-team-shared:coordination:orca-attention-delivery`.

## How one poll works

1. **Poll:** the paged attention query `teamAttentionPage` (via `hadron api`, read-only), drained page by page from the adopted token. Only the final page's `adoptableSince` can be adopted, and only a completed scan counts. The CLI's `hadron team attention` output lacks `lastRelevantSeq`, which the ledger needs.
2. For each **roster** worker the server lists with `unreadMentions > 0`:
   - **Register check.** The worker's *effective* registration on the team Channel must be its own **mention-only** row. That is the winning row from `attendeeRegister`, resolved as the server does: App over organization, Worker over Agent over everyone. So an organization-owned worker row counts. Without such a row, the server reports the worker for *any* new message, with its whole unread-mention backlog as the count. So it's held and reported as a configuration error, never nudged.
   - **Skip** the worker if a nudge sent under the current token still covers its backlog (the ledger, below).
   - **Resolve** its terminal: the ONE `claude`/`codex` agent terminal (Orca's `agentIdentity`) whose `worktreePath` is the roster entry's `worktree`. Zero or several means *held*; it never guesses. If the worktree carries a CLI worker binding (`<gitdir>/hadron-team-session.json`), the binding must name this worker.
   - **Gate:** `orca terminal wait --for tui-idle --timeout-ms <busyWaitMs>`. Only positive proof of idle passes.
   - **Empty-prompt gate:** `orca terminal read --screen --json` must prove nobody is typing. Any non-empty `draft` holds, whitespace included. Then the rendered screen must prove the prompt empty, reading only **column-0** chrome (anything the user typed onto a continuation line is indented, so a typed `❯` or `───` never counts): for Claude Code, the input box between the last two column-0 `───` rules must hold the bare `❯` and nothing else, AND the status line below it must end with the empty-input hint `· ← for agents`; for Codex, the last column-0 `›` line must show the idle placeholder `Ask Codex to do anything`, with only footer below it. A bare `›` holds, and so does a Codex dialog such as its update menu. Anything unrecognized holds. The held reason never includes the typed text.
   - **Send:** `orca terminal send --text <nudge> --enter --wait-submit <s>`. An ambiguous transport failure is retried once with Orca's durable request id. It never re-sends on silence.
3. **Adopt the token only if no roster worker is held.** Otherwise:
   - the token stays, and the ledger records who was nudged, so the next poll retries only the held workers;
   - a worker is nudged again only for a **new** mention: one whose seq is above the `lastRelevantSeq` it was nudged for, however much older unrelated chat it has left unread;
   - each accepted nudge is written to the ledger **immediately**, so a crash or a failure later in the same poll can't resend it;
   - each held reason is logged once per token, not every poll.
4. Workers off the roster belong to another host's router. They are ignored and never block adoption.

## Why these rules

Measured 2026-09-30; finding `hrn:node:hadronmemory.com:hadron-server:findings:orca-terminal-send-busy-agent-claude-queues-codex-steers`.

- **Idle gate:** a prompt typed into a BUSY Codex agent steers its turn, and Codex silently drops the rest of its task. Claude Code queues it or absorbs it harmlessly, but the gate costs about 0.1 s when the agent is idle, so it applies to both.
- **Empty-prompt gate (#5473):** `tui-idle` reports idle while a HUMAN is typing in that terminal, so a nudge was appended to Holger's half-typed message and submitted it, twice. The two agents show typed-but-unsent text differently (live probe, 2026-10-01): Claude Code draws it on its `❯` line, while Codex draws an EMPTY `›` and the text appears only in Orca's `draft` field. Both signals are required. Typed WHITESPACE is invisible to both on screen: Claude draws a bare `❯` (Chip #5756), so a Claude prompt counts as empty only while its status line shows `· ← for agents`, which Claude removes the moment the composer holds anything, a single space included, in every permission mode. Whitespace typed into Codex appears in neither: Orca reports no `draft` and the screen shows a bare `›`. Only the placeholder's absence gives it away, so a Codex prompt counts as empty only while the placeholder shows. A residual window remains between the read and the send (milliseconds); it is not closable from outside the terminal.
- **Explicit roster:** tab titles are not identity (agents retitle their own tabs), and a worktree's name does not prove who drives it. The roster maps each worker to its worktree, and the binding check backs that up.
- **Hold the token:** advancing past a failed send would lose exactly the busy worker's nudge.
- **No orchestration mailbox:** `orca orchestration send` wakes no ordinary agent; the mail sits unread until the recipient polls.

## Install

1. **Register rows:** one worker-specific **BOTH, mention-only** row per roster worker on the team Channel (`hadron_register_add`, `mentionOnly: true`).
2. **Roster:** copy `config.example.json` to `~/.config/hadron-orca-attention-router/config.json` (or pass `--config`, or set `ORCA_ROUTER_CONFIG`). Verify each entry: exactly one agent terminal in the worktree, and a matching binding if the worktree has one.
3. **Codex Desktop roster:** remove every worker you add here from the Codex Desktop router's roster **in the same change**.
4. **Run:** `pnpm tsx scripts/orca-attention-router/router.ts poll`. The first poll has no token, so every roster worker with any unread mention is nudged once.

**Roster rule:** each roster worktree must be unique. The config is refused otherwise, because two workers would share one terminal.

State lives in `stateDir` (`0700`; the token file is `0600`), separate from every other router's. The single-writer lock records its owner's pid, the host's boot time, and when the lock was taken. The next poll reclaims a lock whose owner is provably gone:
- the host rebooted since;
- no process has the pid;
- the process now holding the pid started after the lock was taken (pid reuse).

A lock with no owner record that is older than a minute is reclaimed too. A live owner, even another user's, is never displaced.

A stale lock is never deleted "by path after a check" (that races). It is **renamed atomically** to a unique tomb, and the tomb's owner record is compared with the record judged dead:
- if they match, the stale lock is gone and the run retries `mkdir`;
- if they don't, another run broke the stale lock and took it first, so its live lock is renamed straight back and this run backs off.

The poll re-checks that it still owns the lock before every send and before adopting the token, and stops cleanly if it doesn't. Release removes the lock only while it still holds this run's record.

**Residual:** a *third* run taking the path during the brief window when a live lock is moved aside makes the rename-back fail. The moved lock's owner then stops at its next check, so at most one in-flight send can overlap. That needs three simultaneous pollers racing a stale lock; the loop is the only scheduled poller. Keep `adopted.token` private: never print, paste or reset it.

## Commands

```
pnpm tsx scripts/orca-attention-router/router.ts poll   [--config PATH]
pnpm tsx scripts/orca-attention-router/router.ts loop   [--config PATH] [--interval SECONDS]
pnpm tsx scripts/orca-attention-router/router.ts status [--config PATH]    # local state only
pnpm vitest run scripts/orca-attention-router                             # no network, no Orca
```

## Waking it (Holger's decision)

`poll` is a single shot, so any scheduler can drive it. Only one may run at a time; the router's lock refuses a concurrent run.

| Option | How | Trade-off |
|---|---|---|
| **Foreground loop** | `loop --interval 60` in a dedicated Orca terminal | Simplest, visible and stoppable; stops when that terminal or Orca closes. |
| launchd agent | a `~/Library/LaunchAgents` plist running `poll` every 60 s | Survives restarts and runs even when Orca is closed, where it has nobody to nudge; a standing scheduler. |
| Orca automation | `orca automations create …` | Unverified: it may only prompt an agent, and a model run per poll is the cost this design avoids. |

## Untested

An agent sitting at an approval prompt. The probe agents used for testing auto-approved.
