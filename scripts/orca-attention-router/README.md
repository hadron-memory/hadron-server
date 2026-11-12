# Orca attention router (retired; helpers remain)

**The polling router is retired (#2030, C6).** It read the paged team attention API and typed a nudge line into
an Orca-hosted worker's terminal. It had been stopped on orca1 since 2026-10-16; the live deliverer is
**ticker-wake** (`scripts/ticker-wake/`, #2138), which delivers through `hadron team chat post` receipts and the
server's ticker. The attention poll, the nudge ledger, the state lock, the loop entrypoint (`poll`, `loop`,
`status`) and the tests that drove them were removed with it. Nothing under `scripts/` calls the team attention
API any more (`noAttentionPoll.test.ts` pins that), which is what lets the server retire it (#2027, S11).

## What stays, and why

`router.ts` is now a small helper module that `scripts/ticker-wake/ticker-wake.ts` imports:

- `loadConfig`, `DEFAULT_CONFIG` and the `Config` / `RosterEntry` types: the roster file;
- `runCommand` with its per-call hard timeout (`CALL_TIMEOUT_MS`), and the `Runner` / `RunResult` types;
- `listTerminals`, `resolveTerminal`, `teamBinding`: the ONE agent terminal in a worker's worktree, and the CLI
  worker binding there that must agree;
- `readScreen`, `isIdle`, `idleProofAbovePrompt`, `promptIsEmptyFromTerm`, `screenAgentFamily`: the screen-proof
  rules that decide a terminal is idle with an empty composer. They are pinned by `terminalHelpers.test.ts` (110
  cases recorded from the retired loop's tests, including real captures) and by the cli#907 captures in
  `router.test.ts`.

Nothing here reads chat, sends input or calls the network by itself.

## The config and state directory stay

`~/.config/hadron-orca-attention-router/config.json` (see `config.example.json`) is still read by ticker-wake and by
`hadron team worker onboard --config <router.json>` (hadron-cli v0.43.0, "kept from the retired team router"), and
the onboard command writes roster entries into the file's `stateDir`. Keep both until a CLI release moves
onboard off them.

## Why the idle rules exist

A prompt typed into a BUSY Codex agent steers its turn and silently drops the rest of its task; `tui-idle` also
reports idle while a HUMAN is typing, and Orca's `draft` state can go stale. So a send needs positive proof of an
idle screen AND an empty composer, with an untracked terminal (Orca lost its output stream, as on a serve restart)
decided by the screen shape alone. Measured 2026-09-30, finding
`hrn:node:hadronmemory.com:hadron-server:findings:orca-terminal-send-busy-agent-claude-queues-codex-steers`.

## History

The loop, ledger and liveness rule are in git history before the #2030 PR. The procedure skills that drove it
(`core:tasks:orca-attention-router` and the Claude chat-router) are retired separately.
