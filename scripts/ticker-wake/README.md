# ticker-wake

Interim ticker-wake deliverer for an Orca host (orca1). It reads `dueWakes`,
types one short nudge into the idle terminal of each worker on this host whose wake
carries a TICK or a task event it names (an assignment, a stall alarm or a
finished child; alone, or joined with a MENTION), and acks
the wake by proof. It reuses the attention
router's terminal and idle helpers (`../orca-attention-router/router.ts`,
including the C1 empty-composer rule) and shares no token, ledger or lock with
the router. Retire it when hadron-cli#907 (C1, delivery inside the host poller)
ships.

**Status and boundary.** Merging this script does not run it. Starting it on orca1
is a separate host grant and rollout receipt (which workers, what cadence, who
operates it); no activation, token spend or production acknowledgement is implied
by this README, the PR, its approvals or its merge. Use `once --dry` to see what a
pass would do without typing or acking anything.

```
tsx scripts/ticker-wake/ticker-wake.ts once [--dry] [--budget <seconds>=300]
tsx scripts/ticker-wake/ticker-wake.ts loop [--interval <seconds>=120] [--budget <seconds>=interval]   # each at least 10
```

Config: the router's `~/.config/hadron-orca-attention-router/config.json`
(app, `hadronCli`, `orcaCli`, `stateDir`, and an optional roster). State lives
in `<stateDir>/ticker-wake/` (`lock`, `receipts.json`, `needs-person.json`).

**Receivers (#2138, Hugo #26221).** The roster is not hand-kept. A hand-kept
file missed 17 subscribed workers, whose wakes stayed due while every pass
logged them as not on the roster. Each pass now reads every live ticker of the
App and its live subscribers (`tickers { subscribers }`, paged), and lists
Orca's terminals. A worker is reachable on this host when exactly one worktree
among those terminals carries its CLI binding
(`<git-dir>/hadron-team-session.json`, written by `hadron team session start`),
and that binding names the worker's CURRENT session (George's #2161 P2, Ada
#26314). The script reads the worker's newest session from the server
(`sessions(workerRef, limit: 1)`, newest first). It must be open, be that
worker's, and be the binding's `sessionId` in the binding's `appId`. A binding
left behind after the worker's session ended, or after the worker was rebound
elsewhere, is stale. That way, a terminal reused later in that worktree is never
taken for the worker. Among several bindings for one worker, only the current
one counts. A failed session read holds. The read is made once per worker per
pass, only for workers it needs.
`resolveTerminal` still picks the agent terminal in that worktree at delivery.
A roster row in the config file, if there is one, overrides the binding for
its worker (worktree and terminal pin). Any due worker is delivered this way,
including one that subscribes to nothing (an assignee's task wake). Once per
pass, the script logs every subscriber or due worker it can't reach, with why:
`no binding` (no worktree on this host is bound to it, or two are bound under
its current session), `stale binding (...)` (session ended, replaced, of
another worker or App, absent, or unreadable), or `no terminal` (bound, but no
connected, writable terminal in its worktree). A roster-file row is the
operator's statement and is not session-checked. An
MCP-bound worker leaves no binding file, so it shows as `no binding`. A failed
subscriber read stops the pass, as a failed `dueWakes` read does.

## Contract

- **Nudge (#2138 §5.2).** One line that names the exact commands, checked
  against the released CLI v0.26.0: run `hadron team chat read --mentions-me
  --limit 1` (it prints `cursor #C; channel head #H`), then `hadron team chat
  read --mentions-me --since C --all` and act on the tagged messages it
  returns; only if that read succeeded and you saw all of its output (if your
  tool truncated or saved it, read the rest first; if you can't, don't mark),
  `hadron team chat mark-read --through H` with the H that read printed; then
  continue your in-progress work; end your turn only if you have none (a tick
  lands mid-build too, so it never tells a worker to stop; Diego, #28498).
  Never an unfiltered
  catch-up. A `coordinator-tick` wake (or one carrying it with another ticker)
  asks for the coordinator's base tick instead: "run your base tick
  (coordinator-system:tasks:on-base-tick): first the tagged check: …; then the
  sweep of your owned tasks, alarms and ready heads", so the nudge never tells
  a coordinator to skip its sweep (#2138, Marco #26709). Why two reads: a read without `--since` returns only the newest
  page (George, #2156 P2), so marking through its head could bury older
  tagged messages; `--since C --all` walks every page forward from the read
  mark and fails as a whole if a page fails. Each read samples its head before
  fetching, so a message posted after the read stays unread. The mark-read
  moves the read cursor and stamps the channel check that #2154's evidence
  resolver reads (Codex turns that obeyed the older text read with their own
  `--since` and never marked read, Yuri #26114). A task
  assignment also names the task (`hadron team task get <id>`, or `task list`
  for several). A `live-check` ticker fires an ordinary TICK reason, so it is
  delivered exactly like any tick.
- **Reasons.** TICK, or TICK joined with MENTION: nudge once, then ack. Since
  #2069 (landed in #2102) a MENTION-only reservation absorbs a later tick, so a
  worker holding an outstanding mention is offered a TICK+MENTION wake; skipping
  it would starve that worker of ticks. Since R53 (#2072) acknowledging a wake
  moves no message mark: it records the tick and spends the reservation, and the
  mention stays unread and due (an S1 batch or `hadron-chat-send` delivers it,
  never this script). A TASK reason for an assignment (`ASSIGNED`,
  `REASSIGNED`, `MATCHED`), alone or joined with ticks or a mention, is nudged
  once naming the task, then acked; the ack records the task event delivered,
  which the nudge made true. Task events are covered by the receipt like ticks,
  so a re-offer never names the same task twice to the same receiver. A stall
  `ALARM` or a `CHILD_FINISHED` (#1704) is delivered the same way. An alarm
  names its task and its stall rule, which the script reads from the alarm
  itself with `agentTeamEvents(taskId, alarmsOnly)`, paging by the last event
  read until the exact id turns up or the history ends (the history is oldest
  first and keeps acknowledged alarms, George's #2160 P2). If a page fails, the
  cursor stalls or 50 pages pass, the wake is held. If that read fails, the
  alarm is not found, its rule is not a plain rule, or someone already
  acknowledged it, the wake is held for the next pass. The nudge tells the
  receiver to act and then run `hadron team alarm ack <eventId>`: delivery is
  never an acknowledgement (cor:agt:050:20), so only the receiver can stop the
  climb. A finished child names the child task. `END_SESSION` stays left alone,
  because it needs the host poller, which isn't running. Any other task event,
  a TASK reason without its
  task or with an id that is not a plain id, or an unknown reason leaves the
  whole wake alone, neither nudged nor acked (its proof would record those
  events delivered unseen). A MENTION-only wake is ignored and never acked:
  there is no mention-ack path.
- **Timing (R63).** The server owns it: each wake carries `anchorAt`,
  `deliverAfter` and `busyDeadline` (Liam's seam, hadron-server#2017 (S1)
  branch). Nothing is typed before `deliverAfter`; a busy terminal is held until
  `busyDeadline`, after which busy alone stops vetoing. Nothing is recomputed or
  remembered locally, so a re-offer, join or restart cannot restart it, and a
  wake without timing (old server) is held.
- **A pass fits inside one cadence (#2138 experiment).** Tick 1 on orca1
  (#26038) ran a serial pass of ~34 wakes for ~30 min: a 60 s busy-wait per
  busy worker plus the turn-start wait. So: a busy terminal is *probed*
  (`tui-idle` with a 500 ms timeout, not `busyWaitMs`) and, short of the
  server's `busyDeadline`, held to a later pass. Wakes are served oldest
  anchor first, and once the pass budget (`--budget`; 300 s for `once`, the
  interval for `loop`, which it may not exceed) is spent no new delivery
  starts and the rest wait for the next pass. A proof older than 10 minutes
  (the server refuses one past 15) is re-fetched before its ack, and a proof
  the server calls `WAKE_PROOF_STALE` is re-fetched once and retried; the fresh
  proof is acked only when the confirmed receipt covers all of it, otherwise
  the next pass names only the new work. The loop runs on fixed slots: a pass
  that overruns its slot skips the slots it covered (logged) instead of
  running back to back. A second instance is refused by the lock.
- **No turn-start wait per send (#2138, Hugo #26099).** Each resolve plus
  send used to cost ~30 s, almost all of it two 15 s `--wait-submit`
  observations that Orca almost never confirms. A send now observes for 2 s
  (`SUBMIT_PROBE_S`; Orca never resends on that timeout, it returns the
  input-accepted receipt), and an accepted send is resolved on evidence later
  (below). Sends to different workers run concurrently, up to 8 in flight
  (`DELIVERY_POOL`); the reads and receipt writes around them stay serial on
  one thread. Two workers that resolve to the same terminal never have sends
  in flight at once: the second is held to a later pass. If a delivery fails,
  no new one starts, and the pass fails only after every send in flight has
  finished and written its receipt.
- **Composer.** Unconditional, deadline or not: a nudge is typed only when a
  read shows the composer empty with no Orca draft (even when `tui-idle` holds);
  a draft, question/menu, unknown input or identity holds. Nothing is cleared or
  interrupted.
- **Typed once.** A send counts only when Orca's receipt stages include the
  exact stage `turn_started`. **The intent is written first**: before anything is
  submitted, `receipts.json` gets an unresolved entry for the wake, so a crash or
  a failed receipt write after Orca took the input can never lead to the same
  wake being typed again; if the intent cannot be written, nothing is sent. A
  confirmed send turns the entry into a delivered-tick receipt (coverage +
  receiving terminal incarnation) before the ack; a lost ack is retried ack-only
  for a proof fully covered by a receipt for the same receiver. New ticks, or a
  replacement terminal, get a fresh nudge that names **only the uncovered**
  ticker work (if that cannot be identified, the wake is held). A structured
  refusal with no request id typed nothing: the intent is withdrawn and the wake
  is retried. A failure that names a request id is reissued once with that same
  id. Accepted-without-`turn_started`, an unparsable receipt, an intent whose
  outcome is unknown, or a failure after possible submission is *ambiguous*:
  never retyped, never acked, kept without expiry. If Orca gave a request id it
  is reconciled on later passes by reissuing that exact request (which never
  types twice). Unreadable or malformed receipt state (not a plain object, bad
  entries) stops the pass.
- **Diagnostics.** Log lines and stored `detail` fields carry a fixed class and,
  when the server or Orca named one, a code from a FIXED public vocabulary (a code or an error name that is not in it, however ordinary it looks, is logged as `other`; for example
  `graphql error WAKE_PROOF_STALE`, `send refused: composer_not_empty`). Never the
  raw message, stderr, wake proof or any typed or screen text. An exception that is not this script's own (a router helper, the runner, a bug) is reduced at the outer boundary to a class plus a known code (`helper failed (backend_failure)`, `unexpected Error`, `unexpected other`).

## Resolving an ambiguous entry on evidence (#2138)

Orca often reports a nudge `input_accepted` without `turn_started` (#26072),
so most sends end ambiguous. On each later pass the script first reissues the
entry's request by its id; a confirmation settles it. Otherwise it becomes a
delivered receipt, and the next pass recovers it ack-only (never a retype),
only when ALL of these hold:

1. Orca **accepted** the input under a request id (detail `accepted, turn start
   not confirmed`). An intent-only or unparsable entry is never resolved this way.
2. The **receiver** (terminal handle and incarnation) is the same.
3. The **composer** reads provably empty (the text is not sitting in it). It
   types nothing, so a busy terminal does not veto it.
4. The worker's own session **checked the team channel after the send**:
   its `checkStatus.lastCheckedAt` is later than the value the script read
   and recorded on the entry just before the send (`checkedBefore`; null if
   the worker had never checked). Both times are the SERVER's, stamped by its
   database clock, so host/server clock skew cannot move the comparison
   (Liam #26163: alpha's database ran about 19 s behind the host, so a check
   right after the nudge read as before it against the host's send time). If
   that pre-send read fails, nothing is sent and the wake waits for the next
   pass. An older entry with no `checkedBefore` stays held. For each task
   assignment the send newly named, that task must also be `STARTED` (or
   `FINISHED`) with this worker as assignee. An alarm or a finished child has
   no such proof, since its receiver need not be the assignee, so for those the
   channel check is the only evidence, as it is for a tick. The task ids are recorded on the
   receipt at send time (`tasks`), because starting a task removes its
   assignment wake (#2154 P2); an older receipt that covers a task without
   that record stays held.

A timeout alone never resolves an entry. After 2 team-tick cadences (20 min),
Ada's #26811 ruling allows **one fresh request for strictly newer tick work**
when the old input was accepted, the composer is provably empty, and the same
terminal handle/incarnation still receives it. Busy/deadline, draft, identity,
server-timing and pre-send server-check guards still apply. The incarnation is
checked again after reconciliation/evidence reads. No new tick means no new
request; task events alone cannot unlock it. Newly arrived task events bundled
with this recovery wait for the ordinary next pass (or the replacement
request's reconciliation if it also remains ambiguous); the recovery nudge
only names newer ticks. The fresh text still uses
`nudgeText`, with a fresh-request timestamp, and uses no old `--retry-request` id.

Before recording the new intent, the original ambiguous entry is retained in
`needs-person.json` with its worker, original age, text, identity and evidence.
It is logged `needs a person` on later passes, including after a confirmed
replacement is acked. Neither elapsed time nor sending a newer request changes
that old entry into delivery evidence. An archive write failure stops the send;
unreadable/malformed archive state stops the pass. Old unresolved task/tick
coverage is not named again, and a proof containing unresolved work is not
acked. A confirmed newer tick can ack its own proof without certifying the old
request. If the replacement is itself ambiguous, it has its own two-cadence
wait before another strictly newer tick can qualify; re-offering the same tick
never creates another fresh request.

Classify old entries by hand; a stranded draft is never submitted or cleared. Residual: a channel check the worker made on its
own, not because of the nudge, also counts; acking the tick is still true then,
since the check the tick asks for was done.

### A stranded draft is detected and listed for a person (#2138, Ada #26150)

Sometimes Orca accepts the nudge but its Enter never submits it (Hugo #26131:
five nudges sat 2 to 7 minutes on idle terminals, then submitted on their own).
The text stays in the composer, so condition 3 can never hold, and reissuing by
id does not help: `--retry-request` replays the stored receipt and writes
nothing (Hugo's host check, #26146).

The script recognises such an entry and **never sends a keystroke** for it. It
counts as stranded only when ALL of these hold:

1. Conditions 1 and 2 above (accepted under a request id, same receiver).
2. Orca's composer `draft` equals the entry's recorded `text` exactly
   (trailing whitespace ignored), and the rest of the composer reads empty.
3. The terminal is idle (tui-idle or the screen's idle proof).
4. At least 60 s have passed since the send.

Then `strandedAt` is recorded in `receipts.json` once (never rewritten), and
the pass logs `stranded draft, <N>s ...; needs a person`. The entry stays
ambiguous: if the draft submits on its own and the worker checks the channel,
it resolves on evidence as above. Otherwise a person decides, as below.

Why not press Enter: Orca's bare `--enter` is a raw write bound to neither the
terminal incarnation nor the expected draft, so a terminal replaced (or typed
into) between the script's read and the keystroke would get it (George's
#2157 P2). Automatic submission waits for an Orca conditional submit bound to
both: `hrn:node:hadronmemory.com:hadron-server:findings:orca-conditional-submit-for-stranded-drafts`.

## Recovering an ambiguous entry (a human decision)

The script never certifies or discards an unresolved request automatically.
The newer-tick path above moves a copy into `needs-person.json` before replacing
the active `receipts.json` entry. Archived entries are diagnostics for a person,
not sent receipts: they are never automatically replayed or used to acknowledge
work. The steps below apply to an **active** entry in `receipts.json`; do not
replace a newer active request with an older archived one.

An entry in `receipts.json` with
`state: "ambiguous"` and no request id (for example `detail` "send intent
recorded before submission; outcome unknown") holds that worker's wake until a
person classifies it. Look at the worker's terminal (`orca terminal read
--terminal <handle>`, the `handle` stored in the entry) and the worker's own
turn history, then choose ONE:

1. **Confirmed delivered** (the nudge text is in the terminal and a turn started):
   do **not** delete the entry. Change its `state` to `"sent"` and keep its
   `coverage`, `receiver` and `at`. The next pass then recovers ack-only. Deleting
   a delivered entry lets the same ticks be typed again.
2. **Never submitted** (nothing was typed and no turn started): delete the
   entry. This is the only case where deletion is safe; the next pass sends
   afresh.
3. **Cannot tell**: leave the entry. The worker stays held and is not nudged; the
   wake stays due and nothing is lost.

If the user has paused or stopped the worker, leave its entry and its wake alone.
Never edit either state file while a pass is running (one instance per state dir).
- **One instance** per state dir. Acquisition is an atomic hard link; a dead
  owner's lock is replaced only by a contender holding the exclusive
  `lock.takeover` file, after re-reading the lock, so a replacement owner is
  never unlinked.

Dependencies: landed on main: #2067 (footer rule), #2068 (#2078), and #2069, R53 and R63 with S1 (#2102); still open: hadron-cli#907 (this script is the interim for it). The `turn_started` stage name is from Orca's documented receipt and recorded sends, and was
captured on real scratch terminals by independent QA at the reviewed head (a Claude Code 2.1.303 terminal
and a Codex terminal, against a shim or an isolated S1 server; see the PR receipts). That evidence is
for the head it names and does not carry to later heads by itself.
Verified by the 63 fake-runner and contract tests (the contract tests build the schema from the real typeDefs); live-host rollout
evidence is separate.

### A prior receiver that is provably gone (#2275 partial slice)

An ambiguous receipt for another receiver stops holding the worker only when a
successful, complete current terminal inventory proves that the prior
handle/incarnation is absent. A reused handle needs a known different
incarnation. Failed or partial lists, unknown identities, and a still-present
old incarnation (even disconnected or unwritable) remain held.

Before replacement, the script checks the inventory and current incarnation
again and applies the normal composer, draft, timing and idle rules. It keeps
the old request in `needs-person.json`, then atomically saves normal unresolved
send intent for the current receiver. A crash or failed write keeps an
ambiguous receipt; unrelated workers' receipts are preserved. It neither
replays the old request ID against the new receiver nor acknowledges a wake,
task, or chat read merely because the local receiver changed.

This is **at-least-once notification recovery**: an accepted old prompt may
have executed before its terminal died. The replacement may name unacknowledged
work again; it is not an exactly-once claim. The worker still reads the server
cursor and current task state. Only confirmation of the new send can support
the normal acknowledgement path.

This slice does not change family derivation, relaunch scripts, existing host
receipt files, same-receiver never-accepted recovery, or escalation. Tests use
synthetic mocked hosts; deployment and any existing-state remediation remain
separate host-manager actions.
