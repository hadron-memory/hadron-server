# One-page reference boot prompt (#4228, S7 of epic #4229)

A role's boot prompt is 2,250 to 8,541 words today, mostly general policy, and every fresh run pays for it. This is a reference prompt of at most 1,200 words: a role page plus one shared core. It names procedures by their trigger and pastes none.

It is a draft. Nothing here is served, and this PR changes no server code. A boot prompt is a Hadron node, and a worker session may not edit, compile or approve one (`src/lib/bootPrompt.ts` guard B, `src/lib/bootPromptApproval.ts`), so putting it in service is a manager's step, listed below. That is also why the drafts are plain nodes.

## The prompt

| Part | File here | Draft node |
|---|---|---|
| Shared core | [core.md](reference-boot-prompt-4228/core.md) | `hrn:node:hadronmemory.com:skills-engineer-system:reference-boot-prompt:core` |
| Server engineer page | [server-engineer.md](reference-boot-prompt-4228/server-engineer.md) | `...:reference-boot-prompt:server-engineer` |
| QA engineer page | [qa-engineer.md](reference-boot-prompt-4228/qa-engineer.md) | `...:reference-boot-prompt:qa-engineer` |
| Coordinator page | [coordinator.md](reference-boot-prompt-4228/coordinator.md) | `...:reference-boot-prompt:coordinator` |

A compiled prompt is the role page followed by the core. The index node `hrn:node:hadronmemory.com:skills-engineer-system:reference-boot-prompt` carries the same install steps as this file. The files here are a copy of the nodes at the time of this PR; the nodes are the source.

The core has three sections:

- **Every run starts the same way.** Five recovery steps: who am I, my tasks, my state note, my tagged chat from the read mark, then a one-paragraph read-back. One line says that `hadron team session recover` (hadron-cli#2062, C7, Wolfgang's lane) replaces steps 1 to 4 when it exists. This PR does not build it.
- **Standing directions.** Nine numbered rules that replace about 4,500 words of policy.
- **Procedures by trigger.** A table from a situation to the task node to read. Every task it names exists today (`hadron agent tasks list <agent>`).

It uses only platform variables from the closed set in `src/lib/personaDescription.ts`: `worker.name`, `worker.role`, `worker.url`. It does not use `worker.reportsTo.name`, which is empty for a worker with no reports-to (mine is), and would leave a sentence with a hole in it.

## Size before and after

Before: the prompt each role Agent is served now in the hadron-dev-team App (`hadron agent boot-prompt hrn:agent:hadronmemory.com:<role> --app hrn:app:hadronmemory.com:hadron-dev-team`, 2026-11-15, variables filled as a chat fills them). After: the role page plus the core, variables unfilled.

Tokens are counted with the `o200k_base` encoding (`gpt-tokenizer`), run locally. That is not Claude's tokenizer, so read the token columns as a comparison between rows, not as billed tokens.

| Pilot role | Words before | Words after | Tokens before | Tokens after | Tokens after / before |
|---|---|---|---|---|---|
| server-engineer | 5,674 | 1,113 | 7,934 | 1,733 | 22% |
| qa-engineer | 4,793 | 1,179 | 6,484 | 1,752 | 27% |
| coordinator | 8,541 | 1,189 | 11,910 | 1,815 | 15% |

The core alone is 859 words (1,312 tokens); the role pages are 254, 320 and 330 words.

Baseline for every role with a served prompt (the `saas-pm` Agent did not resolve by that name and is not measured):

| Role | Words | Tokens (o200k) |
|---|---|---|
| android-app-engineer | 5,404 | 7,463 |
| change-manager | 3,059 | 4,333 |
| cli-engineer | 5,538 | 7,621 |
| coordinator | 8,541 | 11,910 |
| docs-engineer | 5,513 | 7,591 |
| e2e-engineer | 4,197 | 5,787 |
| envoy | 2,250 | 3,311 |
| host-manager | 3,637 | 5,192 |
| ios-app-engineer | 5,392 | 7,455 |
| lifecycle-manager | 3,378 | 4,785 |
| milestone-manager | 3,159 | 4,410 |
| ops-engineer | 4,167 | 5,721 |
| penetration-tester | 4,228 | 5,845 |
| portal-engineer | 5,527 | 7,616 |
| project-manager | 3,475 | 4,748 |
| qa-engineer | 4,793 | 6,484 |
| relay-engineer | 5,565 | 7,632 |
| security-engineer | 4,270 | 5,876 |
| server-engineer | 5,674 | 7,934 |
| skills-engineer | 5,764 | 7,971 |
| specs-engineer | 6,653 | 9,328 |
| task-manager | 3,156 | 4,415 |
| ux-designer | 3,188 | 4,467 |

A worker's own bind briefing can be larger than its role's: mine (Eli, a worker-level pointer) printed 6,113 words at bind, including the previous handoff.

How to repeat the count:

```js
// node measure.mjs <file>...   (npm i gpt-tokenizer)
import { readFileSync } from 'node:fs';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
for (const f of process.argv.slice(2)) {
  let t = readFileSync(f, 'utf8');
  if (t.startsWith('served boot prompt:')) t = t.slice(t.indexOf('\n') + 1); // the CLI's header line
  t = t.trim();
  console.log(f, t.split(/\s+/).filter(Boolean).length, encode(t).length);
}
```

## Fresh-run trial

Acceptance: a fresh run with no handoff states its task and standing directions correctly on its first turn, 5 of 5.

What was run: five separate headless processes (`claude -p`, model `claude-sonnet-5-5`), each started in my bound worktree with the server-engineer prompt rendered for Eli as its only briefing, and one line of input: recover as the briefing says, stop after the read-back. Each process could run only read-only `hadron` commands (`session whoami`, `task mine`, `task get`, `node get`, `chat read`, `worker get`). No handoff was given and the prompt reads none.

What a correct read-back had to contain: the task (AT0.7559, hadron-server#4228 S7, from the task record), the task's own directions, and both standing directions in my state note (the `state` node in my working memory, `hrn:mem:hadronmemory.com:hadron-dev-team-eli`: my repo is hadron-server, and questions go to Peter with a default while Holger is away).

| Round | Prompt | Result |
|---|---|---|
| 1 | First wording | 4 of 5. One run reported the state note as missing and so left out both of its directions. Step 3 named the memory and left the run to build the node address; "missing is normal" then hid the wrong address. |
| 2 | Step 3 gives the exact command and says where the address comes from (the slug of the worker URL); step 5 names both sources of directions | 5 of 5. Every run named the task, the task's own directions and both state-note directions. |
| 3 | Steps 1, 3 and 4 as changed by review. First run of this wording: 4 of 5; one run cut the state-note read short with `head -20`, saw only the header and reported no directions. Step 3 now says to read all of it. | 4 of 5, then the fix below |
| 4 | Step 3 with the read-all line | 5 of 5. Every run named the task, its own directions and both state-note directions (hadron-server only; questions to Peter with a default). |

Each run took 5 to 12 turns and about $0.20.

Limits of this trial:

- It is a stand-in for a real bind. No worker was bound with the new prompt, because that needs the manager steps below. The processes also loaded this repo's `CLAUDE.md`, as a real worker in this worktree would.
- One worker, one role page, one model. The QA and coordinator pages were measured, not trialled.
- The chat read mark was not advanced: `mark-read` is a write and was not allowed. Every run reported that instead of claiming it.
- After round 2, one string in direction 7 changed (the commit trailer now ends with the worker URL, matching the platform's trailer template). It is not part of recovery and the trial was not repeated for it.
- After round 2, step 3 changed (Wolfgang's C7 note: find the state note through the worker's `memory:` id, `Worker.memoryId`), step 1 (plain `session start`, no `--as`) and step 4 (mark read only after a fully seen read) changed on Coco's review. Rounds 3 and 4 re-ran the trial on that wording.

## Putting it in service

The path, for one role. It needs a person who manages the role Agent, acting as themselves:

1. Copy the core to `hrn:node:hadronmemory.com:base-role-agent-system:boot:rules:reference-core` with role `boot-prompt.rule` (`boot-prompt-rule` before #5453), next to the existing `boot:rules:preamble`.
2. Replace the body of `hrn:node:hadronmemory.com:<role>-system:boot:source` (role `boot-prompt`) with the role page plus the include tag for `boot:rules:reference-core`.
3. `hadron agent compile hrn:agent:hadronmemory.com:<role>` writes a new revision of `<role>-system:boot:compiled` (type `system`, role `boot-prompt.compiled`; the node type `compiled-boot-prompt` before #5453).
4. Approve that revision (`approveNode`). The serve picks the newest approved revision of the node the pointer names (`src/lib/bootPrompt/serve.ts`), so the next bind gets it. Until it is approved, the old approved revision keeps being served.
5. A worker with its own pointer (`Worker.bootPromptNodeId`; its source is `hadron-dev-team-install-<role>:boot:workers:<worker id>:source`) is served that instead of the role's. Clear the pointer with `setWorkerBootPrompt` and no node, after moving that worker's own directions into its state note.

A worker session is refused steps 1 and 2 (`BOOT_PROMPT_WORKER_SESSION_REFUSED`; the one exception is a signed edit grant for the worker's own source), can do step 3 only for an existing compiled node named by a signed `bootprompt.compile.approve` grant (`hadron agent compile --as-worker`), and never approves (step 4). `BOOT_PROMPT_SERVE_ENABLED`, which #2833 mentions, no longer exists: #2712 retired it and `resolvers.deleteSystemPrompt2712.test.ts` pins that.

Rollback: a compiled node is written only by a compile (`BOOT_PROMPT_COMPILED_WRITE` refuses any other write, so `node revision restore` on it fails), and the serve picks the newest approved revision, so re-approving an older one does not outrank a newer one. Roll back the sources, then compile again: on `<role>-system:boot:source` and on `base-role-agent-system:boot:rules:reference-core`, run `hadron node revision list` and `hadron node revision restore <id>` of the revision before step 2 (or remove the include tag and the core node if there was none). Then `hadron agent compile hrn:agent:hadronmemory.com:<role>` writes a new compiled revision, a manager approves it (`approveNode`), and `hadron team worker get <name>` (`boot prompt (next bind)`) shows the revision served. Until then the reference prompt keeps being served.

## Defaults taken (Holger is away; recorded for Peter and the decision queue)

| Question | Default | Reversible |
|---|---|---|
| Which roles first? | server-engineer and qa-engineer (short-lived under G7) and coordinator (long-lived): the shape of the epic's pilot lane. | Yes: a role page is one node. |
| Where does a run read its standing directions? | The task record, plus one overwritten `state` node in the worker's working memory, which holds only what cannot be read elsewhere and is usually empty. No dated handoff is read. | Yes: one line in the core. C7 needs this address. |
| Where do the drafts live? | `skills-engineer-system:reference-boot-prompt:*`, as plain nodes with no boot-prompt role, so nothing is served from them. | Yes. |
| Who puts it in service? | Nobody yet. It waits for a manager of the role Agents. | n/a |

## What is left out, on purpose

The core drops the long text on session lifetime, review policy, QA intake and messaging. Each has a task or process that a run reads when its trigger occurs: `finish-a-task`, `report-a-defect-to-qa`, `drive-a-change-home`, `handle-a-team-chat-wake`. Two rules the old prompts stated that have no task of their own are kept as one line each in the core: the limits on merge, deploy and session end (direction 4), and the ready gate (direction 8).
