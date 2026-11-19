# worker-shed-reminder (#2163 part 2)

A Claude Code `UserPromptSubmit` (and, when wired, `Stop`) hook that reminds a worker to run the team's shed procedure when its context is large.
It reminds and nothing else: no terminal input, no handoff, no process stop, no session end or rebind, no settings write,
no PostToolUse or PreCompact hook. Output is one JSON object or nothing: on `UserPromptSubmit` a fixed
`hookSpecificOutput.additionalContext` object; on `Stop` a `{"decision":"block","reason":...}` object, which makes Claude
continue its turn once with the reminder (see Stop below).
Any failure is silence with exit 0.

- Source and tests: this directory. Policy numbers come from the team shed policy r16 (task `trim-context-clear-and-recover`),
  except GLM, which deliberately departs from r16's 100k (next point): Opus 150k, Sonnet 100k, GLM 50k reclaimable;
  reclaimable = occupied context minus a fixed 67k floor. After the first fire the reminder escalates once: Opus and Sonnet
  after 50k more, GLM after 20k more.
- **Why GLM differs** (#4518, 2026-11-19): Claude Code auto-compacts a GLM session at about 167k occupied (92 auto compactions
  measured in `~/.claude-zai` transcripts: `preTokens` min 165k, median 167k; the `claude-glm` 200k window minus its buffer). The
  team policy's 100k GLM threshold is 67k + 100k = 167k occupied, the same point, so the compaction always shed the worker first
  and the reminder never fired. GLM now fires at about 117k occupied and escalates at about 137k, both before the measured 165k
  minimum (incident `hrn:node:hadronmemory.com:hadron-dev-team-hugo:incidents:2026-11-19-glm-shed-reminder-never-fires`).
  Opus and Sonnet are unchanged. If the GLM window or the compaction point moves, re-measure and keep both numbers below it.
- **Not installed by this change.** Installation is Hugo's separately approved step: manual, per worktree, merged into the
  gitignored `.claude/settings.local.json` as one `UserPromptSubmit` hook group whose command identifies this script, plus, only
  if that install approval names it, a second group on `Stop` with the same command; JSON merge with a `.bak`, idempotent,
  rollback by removing those groups. Never the tracked `settings.json`, never Orca's managed groups, no Codex worktree.
- Install the file as an ES module (it needs the `.mjs` extension to run as one): for example
  `~/.local/bin/worker-shed-reminder.mjs`, and use that exact path as the command string.
- Environment: `CLAUDE_CONFIG_DIR` (default `~/.claude`) names the root whose `projects/` the transcript must live under;
  `HADRON_SHED_REMINDER_STATE_DIR` (default `~/.local/state/hadron-worker-shed`) holds `reminder/<session_id>.json` state,
  `reminder.log` and per-session lock directories.
- Observed on Claude Code 2.1.306 (print mode, disposable session): `/clear` makes a new `session_id` and transcript, resume and
  `/compact` keep both, a compaction appends a `compact_boundary` line carrying `postTokens`, slash commands fire no
  `UserPromptSubmit`. Interactive TUI parity, automatic compaction parity and Codex are not established.
- **Idle gaps do not silence it** (2026-11-13, Cedric): the age of the last usage line is not checked, only that its timestamp
  parses and is not in the future. Before this the hook skipped as `stale` after 15 minutes, which is the normal gap before a
  worker's next prompt, so it almost never fired.
- **Stop (end of turn).** Wired as a second hook group on the `Stop` event with the same command, the hook shares the arm and,
  when it fires, returns `{"decision":"block","reason":...}`, so Claude continues its turn once with the reminder. `Stop` runs at
  EVERY end of turn, including mid-task and while a question awaits an answer, so the text does not claim a task boundary: it
  asks the worker to shed if it is at one, and otherwise to end its turn again. It never blocks when `stop_hook_active` is set,
  so it can delay a stop by one turn at most, and it fires at most twice per arm, shared with the prompt reminder (an arm resets
  as described above).
