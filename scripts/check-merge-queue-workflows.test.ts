/**
 * The merge queue's workflow contract (#4819), pinned against the REAL workflow directory.
 *
 * Twice on 2026-11-21 `main` went red from two PRs that were each green alone (#4653 with #905, #4706 with #4696).
 * A merge queue runs the required checks on the MERGED tree, through the `merge_group` event, and a required check
 * the queue cannot see never reports and blocks every entry. So three things must stay true, and none of them is
 * visible from a single PR's own diff:
 *
 *   1. every workflow has an EXPLICIT decision here (in the queue or not, and why), so a new workflow is decided
 *      the day it is added instead of silently left out;
 *   2. the workflows whose checks the `main` ruleset requires listen to `merge_group`;
 *   3. a required workflow has NO `paths:` filter on any trigger: a required check that a path filter keeps from
 *      running never reports, for a PR that touches no matching file as much as for a queue entry.
 *
 * ONLY the checks the `main` ruleset REQUIRES gate a queue entry. A workflow listed on `merge_group` that is not required
 * reports a result but does not block the merge, so its entry below says "advisory" and never claims to stop a clash.
 *
 * `merge_group` and `paths:`: reports from GitHub's community say a path filter is not applied to a merge_group
 * run (so a filtered workflow listed there runs on EVERY entry). That is not stated in GitHub's own documentation and
 * is pinned only by the live dry run after the ruleset is applied; nothing below relies on it. `tsc` carries no
 * filter at all, so it behaves the same either way.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const DIR = join(process.cwd(), '.github', 'workflows');

type Decision = { queue: boolean; why: string };
/** One entry per workflow file. `queue: true` means the file lists `merge_group`. */
const DECISIONS: Record<string, Decision> = {
  'test.yml': { queue: true, why: 'REQUIRED: the whole suite on the merged tree (about 27 minutes, the queue entry\'s critical path)' },
  'tsc.yml': { queue: true, why: 'REQUIRED: the type check on the merged tree, the check that would have caught both red mains' },
  'no-agent-specific-code.yml': { queue: true, why: 'REQUIRED: whole-tree guard, seconds' },
  'no-station-refs.yml': { queue: true, why: 'REQUIRED: whole-tree guard, seconds' },
  'urn-rename-aliased.yml': { queue: true, why: 'REQUIRED: whole-tree guard, seconds' },
  'object-store-import-boundary.yml': { queue: true, why: 'advisory in the queue (not required): a whole-tree guard that failed on the merged result in the #4653 with #905 clash, so it would have caught that clash but does NOT block a merge unless the ruleset requires it (unfiltered and about 0.2 minutes, so it is a safe candidate; Holger\'s call)' },
  'workflow-guard.yml': { queue: true, why: 'advisory in the queue (not required): whole-tree over every workflow file, so two PRs adding workflows are judged together; seconds' },
  'no-unscoped-loc.yml': { queue: true, why: 'advisory in the queue (not required): whole-tree grep guard on src; seconds; a path filter, if GitHub ignores it on merge_group, only makes it run on every entry' },
  'restore-private-cluster.yml': { queue: true, why: 'advisory in the queue (not required): no event-specific logic, about 2 minutes, runs in parallel with the suite; contents: read, no secrets' },
  'e2e-seed.yml': { queue: true, why: 'advisory in the queue (not required): no event-specific logic, about 1 minute, runs in parallel with the suite; contents: read, no secrets' },
  'migration-smoke-test.yml': { queue: true, why: 'advisory in the queue (not required, and path-filtered so it could not be required): it applies the merged tree\'s migrations to a database, which is where two PRs adding migrations clash, so it SHOWS such a clash but does not block it; about 1.5 minutes' },
  'migration-replay.yml': {
    queue: false,
    why: 'NOT in the queue yet: its base logic is event-specific. On a non-pull_request event it compares with HEAD^ and looks up the MERGED PR\'s labels by commit SHA to learn whether baseline growth was approved; a queue commit has no associated PR, so a growth the change manager approved by label would fail in the queue. It needs a merge_group branch of its own (the queue\'s base_sha, and a label source), not a one-line trigger.',
  },
  'graphql-sdl-parse.yml': {
    queue: false,
    why: 'NOT in the queue yet: its citation gate resolves the base from github.base_ref, which is empty on merge_group, then falls through to github.event.before (also empty) and HEAD~1. It checks out full history, so HEAD~1 is READABLE on a queue commit, but what it POINTS AT depends on how GitHub builds the merge-group branch (for a group of several entries it may be the previous entry rather than main), so the gate could silently check only part of the change. The file itself says a wrong base is silent. It needs github.event.merge_group.base_sha and a test for it first.',
  },
};

/**
 * The workflows whose job names the `main` ruleset requires (the required check context is the job name).
 * The SOURCE OF TRUTH is the ruleset (id 25457960) in #4819's PR body: this table is a hand-copied mirror of its
 * `required_status_checks`, so a change there must be mirrored here. Nothing in the repo can read the ruleset.
 */
const REQUIRED: Record<string, string> = {
  'test.yml': 'test',
  'tsc.yml': 'tsc',
  'no-agent-specific-code.yml': 'no-agent-specific-code',
  'no-station-refs.yml': 'no-station-refs',
  'urn-rename-aliased.yml': 'urn-rename-aliased',
};

type Doc = { on?: unknown; true?: unknown; jobs?: Record<string, { name?: string }> };
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const load = (f: string): Doc => parse(readFileSync(join(DIR, f), 'utf8')) as Doc;
/** The `on:` value, tolerating the YAML 1.1 spelling where the key parses as the boolean true. */
const onOf = (d: Doc): unknown => d.on ?? (d as Record<string, unknown>)['true'];
const triggers = (d: Doc): Record<string, unknown> => {
  const on = onOf(d);
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [String(e), null]));
  return (on ?? {}) as Record<string, unknown>;
};

describe('merge queue workflow contract (#4819)', () => {
  it('every workflow file has an explicit queue decision, and every decision names a real file', () => {
    expect(files.filter((f) => !(f in DECISIONS)), 'a workflow with no decision: add it to DECISIONS with a reason').toEqual([]);
    expect(Object.keys(DECISIONS).filter((f) => !files.includes(f)), 'a decision for a file that is gone').toEqual([]);
  });

  it.each(Object.entries(DECISIONS))('%s lists merge_group exactly when the decision says it should', (f, d) => {
    expect('merge_group' in triggers(load(f)), `${f}: ${d.why}`).toBe(d.queue);
  });

  it.each(Object.entries(REQUIRED))('%s is required: it is in the queue and its job is named %s', (f, job) => {
    expect(DECISIONS[f].queue).toBe(true);
    const j = load(f).jobs?.[job];
    expect(j, `${f} has no job ${job}: the required check context would never report`).toBeDefined();
    expect(j?.name === undefined || j.name === job, `${f}: the job's name is the check context, it must stay ${job}`).toBe(true);
  });

  it.each(Object.keys(REQUIRED))('%s (required) has no paths filter on any trigger: a required check that does not run never reports', (f) => {
    for (const [event, cfg] of Object.entries(triggers(load(f)))) {
      const c = (cfg ?? {}) as Record<string, unknown>;
      expect('paths' in c || 'paths-ignore' in c, `${f}: ${event} has a paths filter`).toBe(false);
    }
  });

  // A required check must really RUN on a merge_group event under exactly its context name. A skipped job reports as
  // passing, a matrix renames the context to `name (1)`, and an expression in `name:` changes the string.
  const EVENT_CONTEXT = /github\.event_name|github\.event\.pull_request|github\.base_ref|github\.head_ref/;
  it.each(Object.entries(REQUIRED))('%s (required) job %s is not skipped, matrixed or renamed on a merge_group event', (f, job) => {
    const j = load(f).jobs?.[job] as { if?: unknown; name?: unknown; strategy?: { matrix?: unknown }; steps?: Array<{ if?: unknown }> };
    expect(j.strategy?.matrix, `${f}: a matrix on the required job renames its context`).toBeUndefined();
    expect(String(j.name ?? ''), `${f}: an expression in name changes the context`).not.toContain('${{');
    expect(String(j.if ?? ''), `${f}: a job-level if that reads the event context can skip the required job on merge_group`).not.toMatch(EVENT_CONTEXT);
    for (const st of j.steps ?? []) expect(String(st.if ?? ''), `${f}: a step-level if on the event context`).not.toMatch(EVENT_CONTEXT);
  });

  // "A queue entry is never cancelled by another run" is otherwise only a comment: a merge_group run has no
  // pull_request.number, so its group is its own run_id, and cancel-in-progress must stay false for it.
  it.each(Object.keys(REQUIRED))('%s (required) cannot cancel a queue entry: its group falls back to run_id and cancel-in-progress is gated on pull_request', (f) => {
    const c = (load(f) as unknown as { concurrency?: { group?: string; 'cancel-in-progress'?: unknown } }).concurrency;
    expect(String(c?.group), `${f}`).toContain('github.run_id');
    expect(String(c?.['cancel-in-progress']), `${f}: must be false for a merge_group run`).toContain("github.event_name == 'pull_request'");
  });

  it('tsc runs on pull_request, merge_group and push to main', () => {
    const t = triggers(load('tsc.yml'));
    expect(Object.keys(t).sort()).toEqual(['merge_group', 'pull_request', 'push']);
    expect((t.push as { branches?: string[] }).branches).toEqual(['main']);
  });
});
