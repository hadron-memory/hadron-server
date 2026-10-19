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
- **Typed once.** A send counts only when Orca reports the turn started. It is
  recorded in `receipts.json` (delivered tick coverage + receiving terminal
  incarnation) before the ack; a lost ack is retried ack-only for a proof fully
  covered by a receipt for the same receiver. New ticks, or a replacement
  terminal, get a fresh nudge. An accepted-but-unconfirmed or unparsable send is
  *ambiguous*: never retyped, never acked, kept until a human deletes its entry
  from `receipts.json` after checking the terminal. Unreadable or malformed
  receipt state stops the pass.
- **One instance** per state dir (atomic lock file; a dead owner is replaced).

Dependencies: #2067 (footer rule), #2068, #2069, hadron-cli#907. Verified by
the 34 fake-runner tests; live-host rollout evidence is separate.
