# ticker-wake

Interim ticker-wake deliverer for an Orca host (orca1). It reads `dueWakes`,
types one short nudge into the idle terminal of each roster worker whose wake
carries a TICK (alone, or joined with a MENTION), and acks the wake by proof. It reuses the attention
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
tsx scripts/ticker-wake/ticker-wake.ts once [--dry]
tsx scripts/ticker-wake/ticker-wake.ts loop [--interval <seconds>=120]   # at least 10
```

Config: the router's `~/.config/hadron-orca-attention-router/config.json`
(app, `hadronCli`, `orcaCli`, `stateDir`, roster). A worker not on the roster is
skipped. State lives in `<stateDir>/ticker-wake/` (`lock`, `receipts.json`).

## Contract

- **Reasons.** TICK, or TICK joined with MENTION: nudge once, then ack. Since
  #2069 (landed in #2102) a MENTION-only reservation absorbs a later tick, so a
  worker holding an outstanding mention is offered a TICK+MENTION wake; skipping
  it would starve that worker of ticks. Since R53 (#2072) acknowledging a wake
  moves no message mark: it records the tick and spends the reservation, and the
  mention stays unread and due (an S1 batch or `hadron-chat-send` delivers it,
  never this script). A wake carrying TASK or an unknown reason is left alone,
  neither nudged nor acked (a proof naming task events records them delivered
  unseen). A MENTION-only wake is ignored and never acked: there is no
  mention-ack path.
- **Timing (R63).** The server owns it: each wake carries `anchorAt`,
  `deliverAfter` and `busyDeadline` (Liam's seam, hadron-server#2017 (S1)
  branch). Nothing is typed before `deliverAfter`; a busy terminal is held until
  `busyDeadline`, after which busy alone stops vetoing. Nothing is recomputed or
  remembered locally, so a re-offer, join or restart cannot restart it, and a
  wake without timing (old server) is held.
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
  when the server or Orca named one, an error code (for example
  `graphql error WAKE_PROOF_STALE`, `send refused: composer_not_empty`). Never the
  raw message, stderr, wake proof or any typed or screen text.

## Recovering an ambiguous entry (a human decision)

The script never deletes a receipt itself. An entry in `receipts.json` with
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
Never edit the file while a pass is running (one instance per state dir).
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
