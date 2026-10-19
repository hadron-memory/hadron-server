# ticker-wake

Interim ticker-wake deliverer for an Orca host (orca1). It reads `dueWakes`,
types one short nudge into the idle terminal of each roster worker whose wake
carries **only** a TICK, and acks the wake by proof. It reuses the attention
router's terminal and idle helpers (`../orca-attention-router/router.ts`,
including the C1 empty-composer rule) and shares no token, ledger or lock with
the router. Retire it when hadron-cli#907 (C1, delivery inside the host poller)
ships.

```
tsx scripts/ticker-wake/ticker-wake.ts once [--dry]
tsx scripts/ticker-wake/ticker-wake.ts loop [--interval <seconds>=120]   # at least 10
```

Config: the router's `~/.config/hadron-orca-attention-router/config.json`
(app, `hadronCli`, `orcaCli`, `stateDir`, roster). A worker not on the roster is
skipped. State lives in `<stateDir>/ticker-wake/` (`lock`, `receipts.json`).

## Contract

- **Reasons.** TICK-only: nudge once, then ack. A wake carrying any other reason
  (MENTION, TASK, unknown) is left alone, neither nudged nor acked: the opaque
  proof would acknowledge the unseen components (#2069 owns the joining policy).
  There is no mention-ack path.
- **Composer.** A nudge is typed only after the terminal proves idle and a final
  read shows the composer empty with no Orca draft (even when `tui-idle` holds).
  Nothing is cleared or interrupted.
- **Typed once.** A send counts only when Orca's receipt stages include the
  exact stage `turn_started`. It is recorded in `receipts.json` (delivered tick
  coverage + receiving terminal incarnation) before the ack; a lost ack is
  retried ack-only for a proof fully covered by a receipt for the same
  receiver. New ticks, or a replacement terminal, get a fresh nudge that names
  **only the uncovered** ticker work (if that cannot be identified, the wake is
  held). A structured refusal with no request id typed nothing and is retried.
  A failure that names a request id is reissued once with that same id.
  Accepted-without-`turn_started`, an unparsable receipt, or a failure after
  possible submission is *ambiguous*: never retyped, never acked, kept without
  expiry. If Orca gave a request id it is reconciled on later passes by
  reissuing that exact request (which never types twice); otherwise a human
  deletes the entry from `receipts.json` after checking the terminal.
  Unreadable or malformed receipt state (not a plain object, bad entries) stops
  the pass.
- **One instance** per state dir. Acquisition is an atomic hard link; a dead
  owner's lock is replaced only by a contender holding the exclusive
  `lock.takeover` file, after re-reading the lock, so a replacement owner is
  never unlinked.

Dependencies: #2067 (footer rule), #2068, #2069, hadron-cli#907. The `turn_started` stage name is from Orca's documented receipt and
recorded sends, not yet from an independent scratch-terminal capture (QA).
Busy-delay timing follows the router's idle wait; composer safety is
independent of it. Verified by the 43 fake-runner tests; live-host rollout
evidence is separate.
