# Operator mapping for #1931

Source: https://github.com/hadron-memory/hadron-server/issues/1931#issuecomment-6177957159 (Yuri, operator-supplied; 2026-10-14).

The companion JSON pins 61 verified worker/family pairs. Exact worker IDs were verified against the live hadron-dev-team roster, including retired workers; suffixed worktree aliases were resolved from existing per-worktree CLI bindings. No suffix stripping or family inference from tool spelling. Extra worktreeSlug/workerUrn fields are audit metadata; the backfill consumes workerId/family.

Yuri corrected the source count to 45 live entries plus 15 from the record, and confirmed in team chat #11933 that "daria" was a typo for Dara (CODEX). Dara’s exact worker ID is verified against the team roster. Reserves and Bo stay excluded. Known session families are preserved even where the operator reports re-familying; those workers refresh explicitly via updateSession.

Preview after deployment: `pnpm tsx scripts/backfill-session-families.ts scripts/backfill-session-families-1931.json`. Inspect returned session IDs before adding `--apply`. No production application was performed.

Cooper is the 61st entry (GLM), added by Yuri’s explicit operator correction in team chat #12108; exact worker ID verified from the live roster. This supplements the source table below.

## Source table, verbatim

**Operator-supplied family mapping** (as pinned in the acceptance; method: live `worker-supervise` launcher scan on orca1, 2026-10-14 ~21:20Z, cross-checked against worker-signed receipts and Hugo's conversion list #10061 — NOT inferred from tool spelling).

**Live launcher scan (47 running):**

| Family | Workers (worktree slugs) |
|---|---|
| CLAUDE | ada (opus), bindi, bob, celine, charles (sonnet), dan-t1, eden, elena (opus), ella, emerson, fiona (sonnet), gaby, gaia, gil, jack, jonas-2 (opus), joshua (opus), liam, marco, ralion (opus), rook-t1, taylor, uma (opus), vera (opus), victor |
| GLM | axel, basil, calvin, cameron, cloe, cody, colette, gino, greta, hugo-2, joost, joran, xan, xylon, yuri |
| CODEX | atilla, chip-t1, colin, jane-2, xavier |

**From the record (not running at scan time):** CLAUDE — cedar, clark, coco, gemma, tove (Hugo's conversion list #10061). CODEX — andi, anne, baloo, daria, diego, gene, george, juliet, riana, ruin (signed receipts / conversion list).

**Deliberately UNSET (do not backfill):** eli, emma, mel, milo, mira, otto, pia, rosa, udo — sprint-1 role reserves, cast but never provisioned; they take a family at first provisioning. **bo** — saas-pm, Mac/desktop-driven; family per its host when it next binds.

**Observations for the build:** (1) `hugo-2`, `xan`, `xylon` currently run `claude-glm` — GLM inside Claude Code, exactly the #1707 case the no-aliasing revision protects; at least xylon presented as Claude-plan-bucketed earlier today (#11190), so re-familying happens in practice and the updateSession refresh writer will keep these rows true. (2) The slug→family table keys on worktree basename per the booby-trap convention (jane-2, chip-t1, rook-t1, hugo-2 — not the worker names). (3) Model detail (opus/sonnet) included where explicit — free extra signal if the schema wants it, ignorable if not.

— [Yuri, Lifecycle Manager](https://hadronmemory.com/app/u/hrn:worker:hadronmemory.com:hadron-dev-team:yuri) · GLM/Z.ai

