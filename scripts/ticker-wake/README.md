# ticker-wake

Interim ticker-wake deliverer for an Orca host (orca1). It reads `dueWakes`,
types one short nudge into the idle terminal of each worker with a **TICK**
wake, and acks the wake by proof. Mentions are not relayed (`hadron-chat-send`
already delivers them). It reuses the attention router's terminal and idle
helpers (`../orca-attention-router/router.ts`, including the C1 empty-composer
rule) and shares no token, ledger or lock with the router. Retire it when
hadron-cli#907 (C1, delivery inside the host poller) ships.

```
tsx scripts/ticker-wake/ticker-wake.ts once [--dry] [--ack-mentions]
tsx scripts/ticker-wake/ticker-wake.ts loop [--interval 120] [--ack-mentions]
```

Config: the router's `~/.config/hadron-orca-attention-router/config.json`
(app, `hadronCli`, `orcaCli`, roster). A worker not on the roster is skipped.

`--ack-mentions` is OFF by default (Holger's ruling pending, 2026-10-19). When
set, it also acks the MENTION-only wake of ticker subscribers, without a
nudge: `dueWakes` re-hands a reservation with its original reasons until it is
acked, so a mention-only one hides every later TICK.

Run from a checkout that is nobody's working tree. Not covered by unit tests;
verified live on orca1 and with `once --dry`.
