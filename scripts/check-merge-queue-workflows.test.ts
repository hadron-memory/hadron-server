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
  'object-store-import-boundary.yml': { queue: true, why: 'whole-tree guard that failed on the merged result in the #4653 with #905 clash; not required today, seconds' },
  'workflow-guard.yml': { queue: true, why: 'whole-tree guard over every workflow file, so two PRs adding workflows are judged together; seconds' },
  'no-unscoped-loc.yml': { queue: true, why: 'whole-tree grep guard on src; seconds; a path filter, if GitHub ignores it on merge_group, only makes it run on every entry' },
  'restore-private-cluster.yml': { queue: true, why: 'no event-specific logic, about 2 minutes, runs in parallel with the suite' },
  'e2e-seed.yml': { queue: true, why: 'no event-specific logic, about 1 minute, runs in parallel with the suite' },
  'migration-smoke-test.yml': { queue: true, why: 'applies the merged tree\'s migrations to a database, which is where two PRs adding migrations clash; about 1.5 minutes' },
  'migration-replay.yml': {
    queue: false,
    why: 'NOT in the queue yet: its base logic is event-specific. On a non-pull_request event it compares with HEAD^ and looks up the MERGED PR\'s labels by commit SHA to learn whether baseline growth was approved; a queue commit has no associated PR, so a growth the change manager approved by label would fail in the queue. It needs a merge_group branch of its own (the queue\'s base_sha, and a label source), not a one-line trigger.',
  },
  'graphql-sdl-parse.yml': {
    queue: false,
    why: 'NOT in the queue yet: its citation gate resolves the base from github.base_ref, which is empty on merge_group, and then falls into the push branch (github.event.before, else HEAD~1, which a depth-1 checkout cannot read). The file itself says a wrong base is SILENT, so it is left out until it has a merge_group base (github.event.merge_group.base_sha) and a test for it.',
  },
};

/** The workflows whose job names the `main` ruleset requires (the required check context is the job name). */
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

  it('tsc runs on pull_request, merge_group and push to main', () => {
    const t = triggers(load('tsc.yml'));
    expect(Object.keys(t).sort()).toEqual(['merge_group', 'pull_request', 'push']);
    expect((t.push as { branches?: string[] }).branches).toEqual(['main']);
  });

  it('the two event-specific workflows stay out of the queue until they have a merge_group base', () => {
    for (const f of ['migration-replay.yml', 'graphql-sdl-parse.yml']) expect('merge_group' in triggers(load(f)), f).toBe(false);
  });
});
