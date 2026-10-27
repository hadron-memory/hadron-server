# Orca attention router

Nudges **Orca-hosted** Hadron team workers when they are mentioned in team chat. It types one short line into the worker's Orca terminal — counts recomputed at send time, with the seq range they cover — and the worker then reads the chat itself.

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
   - **Resolve** its terminal: the ONE `claude`/`codex` agent terminal (Orca's `agentIdentity`) whose `worktreePath` is the roster entry's `worktree`. Zero or several means *held*; it never guesses. If the worktree carries a CLI worker binding (`<gitdir>/hadron-team-session.json`), the binding must name this worker. One refinement, the **identity-flap fallback**: Orca's `agentIdentity` tracking degrades mid-life (same family as the `lastOutputAt` loss the idle gate already survives — observed 2026-10-12 holding a live worker ~6.5h), so when identity resolves NOTHING, ONE remaining connected terminal in the worktree whose screen positively shows an agent family (`screenAgentFamily`: the agents' own chrome — Claude's composer `───` box pair, strong column-0 glyphs like `✻`/`⏺`, and completion/banner markers anchored to banner-chrome line starts so ordinary output merely MENTIONING them never classifies; Codex's `›` composer only with content after the glyph, or its banners) still resolves, and the resolution is logged as `resolved by screen` (those lines are the flap-incidence record for the upstream Orca report). A plain shell, an ambiguous screen count, or a screen carrying both families' markers holds exactly as before — and a wrong family guess is caught one gate later, because the empty-prompt and idle-proof gates check family-specific shapes and hold anything unrecognized. That later gate is load-bearing, not redundancy: a shell can `cat` a CAPTURED agent idle screen, so the composer shape the gates demand is a terminal-BOTTOM shape — historical chrome with trailing shell content holds (blind review, #1823).
   - **Gate:** `orca terminal wait --for tui-idle --timeout-ms <busyWaitMs>`. Only positive proof of idle passes — with one refinement (#7398): a tui-idle TIMEOUT means "busy" only when Orca is TRACKING the terminal (`lastOutputAt` set). Tracking is lost fleet-wide on a serve restart and degrades mid-life; an untracked terminal can never satisfy tui-idle, so its timeout is UNKNOWN, proven instead by the rendered screen showing the idle-prompt shape (the same evidence the empty-prompt gate trusts). A tracked timeout still holds as busy.
   - **Empty-prompt gate:** `orca terminal read --screen --json` must prove nobody is typing. A non-empty `draft` holds — **except on Claude, where a screen that proves the composer empty REFUTES the draft**: Claude Code renders typed-but-unsent text on its `❯` line (#1555), so a bare `❯` box plus the `· ← for agents` hint means the draft is STALE Orca state, not pending input (observed twice on 2026-10-05, #6736: draft text no client showed pinned seven workers for hours; the discard is logged once per token, never the text). Codex's draft stays authoritative — its composer renders empty while text is pending. Then the rendered screen must prove the prompt empty, reading only **column-0** chrome (anything the user typed onto a continuation line is indented, so a typed `❯` or `───` never counts): for Claude Code, the input box between the last two column-0 `───` rules must hold the bare `❯` and nothing else, AND the status line below it must end with the empty-input hint `· ← for agents` AND be the screen's LAST content — anything non-blank after it (a shell prompt following `cat`ed agent output, #1823) holds; for Codex, the last column-0 `›` line must show the idle placeholder `Ask Codex to do anything`, with only footer below it. A bare `›` holds, and so does a Codex dialog such as its update menu. Anything unrecognized holds. The held reason never includes the typed text.
   - **Recompute (#1616):** immediately before the send, one more tokenless attention scan — per worker, relative to its OWN read cursor — rebuilds the nudge. If nothing relevant remains (the worker read its chat while the nudge waited out the gates), the nudge is DROPPED and the frontier recorded as covered; the scan's adoptable token is discarded either way. A failed scan fails the poll, so no stale count is ever sent. The scan's round trip reopened both windows the gates had closed, so idle AND the empty prompt are re-proven right before the send — the idle recheck FAIL-CLOSED (prove idle now or hold; a second busy-wait there could outlast a turn in which the worker read its own chat, and the send would deliver the wait-re-aged counts).
   - **Send:** `orca terminal send --text <nudge> --enter --wait-submit <s>`. The text carries the fresh counts, the unread span `#A–#B` and the latest mention seq, so it can be checked against the recipient's own cursor and stays true when delivered. The read anchor has two forms (#1811): at or below a 400-seq span between first unread and head, the #1805 watermark anchor (start at the first unread of any kind, walk forward, bounded pages); above it — the cursor-0 / stale-watermark class that would page the whole history — a **mentions-only anchor**: a **BACKWARD walk** of the `--mentions-me` filter, starting `--before` the head the nudge named (frozen ceiling — a message arriving mid-walk can neither enter a page nor be acknowledged, #1827) and following each page's `prevBefore` down to the fixed `--since` floor at the first unread — beforeSeq selects the NEWEST page under the bound, so a forward nextSince walk with more than one page of mentions would return the newest page, an empty next page, and a mark that acknowledges the unseen OLDEST mention (#1827 cycle 1); on the MCP tool, whose pages carry no `prevBefore` field, the walk re-calls with `beforeSeq` = the smallest seq on the last page; every unread mention is on the backward path (the filter skips non-mention history, never mentions). Then mark read through the worker's OWN session at the highest seq actually delivered — never above the named head; a mentions-filtered read does not auto-mark, so the mark is a separate deliberate step, an incomplete walk marks NOTHING, and anything outside the walked bound stays unread. An ambiguous transport failure is retried once with Orca's durable request id. It never re-sends on silence.
3. **Adopt the token only if no roster worker is held.** Otherwise:
   - the token stays, and the ledger records who was nudged, so the next poll retries only the held workers;
   - a worker is nudged again only for a **new** mention: one whose seq is above the `lastRelevantSeq` it was nudged for, however much older unrelated chat it has left unread;
   - each accepted nudge is written to the ledger **immediately**, so a crash or a failure later in the same poll can't resend it;
   - on adoption, a nudge whose frontier is ABOVE the token's horizon (the fresh scan reads later than the main one, so its mention can postdate the token) is **carried** into the new ledger — the next poll would list that mention again and nudge twice (blind-review P2, first head);
   - each held reason is logged once per token, not every poll.
4. Workers off the roster belong to another host's router. They are ignored and never block adoption.

## The liveness rule (#1826)

**What to set:** `coordinator: true` or `lifecycle: true` on a roster entry, and optionally `coordinatorWatchMinutes` (top level; default 20). Both are validated loudly at `loadConfig`. The rollout of flags on the live host roster is a host-side deploy step, not part of this repo. `status` shows each flagged worker's idle minutes and covered frontier.

A roster entry flagged `coordinator: true` or `lifecycle: true` holds a watch that a passive wait can strand: a coordinator "watching for Jane's head" or a lifecycle manager between sweeps sits idle, the chat moves past their read watermark with **no mention anywhere in it**, and nothing ever wakes them — the mention rule is their only wake, and it never fires. The liveness rule closes that gap. For a flagged worker:

- **Liveness condition:** the team chat has unread content for that worker, **mentions or not**. The attention API cannot serve this — it counts non-self unread for mention-only registrations but suppresses zero-relevant rows from every poll, so a flagged worker with unread non-mention chat is invisible to each scan. The source is the existing authorized read-state surface instead: the worker's cursor (`channelReadState(attendeeRef, appRef, channelRef){lastSeenSeq}`; `0` is a real cursor, null is unknown) against the Channel's head (`channel(ref){lastSeq}`). Candidate iff `head > cursor`. Unknown/null/error on **either** side is fail-closed: no candidate this poll, the reason logged once per reason (`liveness-notes.json`) — absence of evidence is not a verdict. Reading read state confers no access (cor:dmo:090:06); this is reuse, not new law.
- **Idle persistence:** continuously screen-idle for **strictly more than** `coordinatorWatchMinutes` (default 20; positive finite number validated at load; fires at elapsed > N, never at exactly N). Measured by a **cheap per-poll probe** (a short idle wait plus prompt-empty proof — tui-idle alone reports idle while a human types, #5473, so a half-typed prompt never accumulates a clock). The **full guard chain** — fresh terminal resolution, the `busyWaitMs` idle gate with the #7398/#1700 screen fallback, the empty-prompt gate, a fresh `head > cursor` recompute, the fail-closed idle/prompt recheck — runs only when a send is owed. Every guard outcome at send time (busy, draft, unreadable, ambiguous) **holds with its reason** and holds the token exactly like a held mention nudge.
- **The clock is durable and separate** (`liveness.json`, atomic write): `State.adopt` deletes the ledger but **never touches it**, and a router restart reads it back — an idle episode survives token adoption and restarts mid-wait. The clock **resets** on any non-idle evidence while watching (busy, non-empty draft, unreadable screen, ambiguous resolution, a **replaced terminal** — the record names its handle), on a removed roster flag (records are pruned), and on `head ≤ cursor` observed (the worker read the chat). A failed liveness *source* never resets it — the episode keeps aging through an outage and fires on recovery.
- **Coverage and dedupe:** a delivered liveness nudge records `coveredFrontier` = the head at send, persisted **immediately after the send, before any other step in the poll** — a crash or a later failure in that poll cannot resend it. (The sub-second window between send and persist is the same one every nudge in this router carries; closing it would need a write-ahead intent record whose "maybe sent" state is undecidable without a receipt the router does not have.) Re-eligibility needs `head > coveredFrontier` AND idle > N measured from the send — an unchanged backlog never re-nudges. **Mention-first collapse:** a mention nudge delivered in the same poll skips the liveness send and restarts the clock **on the terminal it was delivered to** (one send per wake window); a held or dropped mention observation resets it as non-idle evidence. A held poll neither restarts nor deletes a pending clock (it is a timestamp; it ages in wall-clock time by design), and mention polling may adopt a token while a liveness clock waits — the separate file is what makes that safe.
- **The nudge text is its own literal** (`livenessNudgeText`): no unread/mention count claim — it names itself as the idle-watch rule, names the worker's cursor and the head (both read fresh immediately before the send), anchors an unfiltered catch-up from the watermark in both CLI and MCP forms, and ends with the mark-read-and-finish-silently discipline.
- **Deliberately no register check** on this path: the mention-only row guards against attention's backlog-count behavior for unflagged workers; the liveness candidate comes from read state, and the roster flag is the explicit opt-in.

## Why these rules

Measured 2026-09-30; finding `hrn:node:hadronmemory.com:hadron-server:findings:orca-terminal-send-busy-agent-claude-queues-codex-steers`.

- **Idle gate:** a prompt typed into a BUSY Codex agent steers its turn, and Codex silently drops the rest of its task. Claude Code queues it or absorbs it harmlessly, but the gate costs about 0.1 s when the agent is idle, so it applies to both.
- **Empty-prompt gate (#5473):** `tui-idle` reports idle while a HUMAN is typing in that terminal, so a nudge was appended to Holger's half-typed message and submitted it, twice. The two agents show typed-but-unsent text differently (live probe, 2026-10-01): Claude Code draws it on its `❯` line, while Codex draws an EMPTY `›` and the text appears only in Orca's `draft` field. Both signals are required. Typed WHITESPACE is invisible to both on screen: Claude draws a bare `❯` (Chip #5756), so a Claude prompt counts as empty only while its status line shows `· ← for agents`, which Claude removes the moment the composer holds anything, a single space included, in every permission mode. Whitespace typed into Codex appears in neither: Orca reports no `draft` and the screen shows a bare `›`. Only the placeholder's absence gives it away, so a Codex prompt counts as empty only while the placeholder shows. A residual window remains between the read and the send (milliseconds); it is not closable from outside the terminal.
- **Explicit roster:** tab titles are not identity (agents retitle their own tabs), and a worktree's name does not prove who drives it. The roster maps each worker to its worktree, and the binding check backs that up.
- **Hold the token:** advancing past a failed send would lose exactly the busy worker's nudge.
- **Recompute at send (#1616):** the sprint-1 retro's top complaint (10 of 22 workers): counts computed at poll time were stale by delivery — "199 unread" with the head being the worker's own post. Each nudge's numbers now come from a tokenless scan taken after every gate; a worker that read its chat in between is not nudged about nothing.
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

## Open-task line (#2613)

Every wake this script types ends with ` You have N open task(s) (as read when this was sent); run `hadron team task mine`.` when the delivered worker holds assigned PENDING or STARTED tasks in the wake App (the same set as `hadron team task mine`). The count comes from the existing `agentTasks` read under this script's credential, shared in `scripts/lib/openTaskLine.ts`. Zero adds nothing; a refused, malformed or over-budget read also adds nothing and never says "none". Existing wake text is unchanged ahead of the added line. Merging deploys nothing. Fresh/recovery briefs and the future in-poller delivery (hadron-cli#907) are out of scope; that delivery needs the same line.
