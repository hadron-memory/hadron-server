# worker-shed-reminder (#2163 part 2)

A Claude Code `UserPromptSubmit` hook that reminds a worker to run the team's shed procedure when its context is large.
It reminds and nothing else: no terminal input, no handoff, no process stop, no session end or rebind, no settings write,
no PostToolUse or PreCompact hook. Output is one fixed `hookSpecificOutput.additionalContext` JSON object, or nothing.
Any failure is silence with exit 0.

- Source and tests: this directory. Policy numbers come from the team shed policy (task `trim-context-clear-and-recover`):
  Opus 150k, Sonnet and GLM 100k reclaimable; reclaimable = occupied context minus a fixed 67k floor.
- **Not installed by this change.** Installation is Hugo's separately approved step: manual, per worktree, merged into the
  gitignored `.claude/settings.local.json` as one hook group whose command identifies this script; JSON merge with a `.bak`,
  idempotent, rollback by removing that group. Never the tracked `settings.json`, never Orca's managed groups, no Codex worktree.
- Install the file as an ES module (it needs the `.mjs` extension to run as one): for example
  `~/.local/bin/worker-shed-reminder.mjs`, and use that exact path as the command string.
- Environment: `CLAUDE_CONFIG_DIR` (default `~/.claude`) names the root whose `projects/` the transcript must live under;
  `HADRON_SHED_REMINDER_STATE_DIR` (default `~/.local/state/hadron-worker-shed`) holds `reminder/<session_id>.json` state,
  `reminder.log` and per-session lock directories.
- Observed on Claude Code 2.1.306 (print mode, disposable session): `/clear` makes a new `session_id` and transcript, resume and
  `/compact` keep both, a compaction appends a `compact_boundary` line carrying `postTokens`, slash commands fire no
  `UserPromptSubmit`. Interactive TUI parity, automatic compaction parity and Codex are not established.
