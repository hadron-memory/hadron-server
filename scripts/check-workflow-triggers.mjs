/**
 * Workflow-trigger gate (#2657, epic #2139 B4).
 *
 * This repository is public. Three workflow constructs hand a fork's author a way to
 * run code with this repository's privileges, and nothing but review stopped a change
 * from adding one:
 *
 *   - `pull_request_target`: runs in the base repository's context with its secrets
 *     and a write token, on a trigger a fork can fire.
 *   - `workflow_run`: the same privilege inheritance, one hop removed.
 *   - the `self-hosted` runner label: runs the job on a machine we operate, with
 *     whatever it can reach.
 *
 * ## What it checks
 *
 * EVERY `*.yml` / `*.yaml` file under the workflows directory, every time. It is a
 * property of the whole tree, not of a diff, so a renamed file, a new file or a path
 * filter on the guard cannot hide a construct. Each file is PARSED as YAML (the `yaml`
 * package); there is no substring grep to fool with a quote, a comment or a flow list.
 *
 *   - `on:` as a string, a list or a map, including the YAML-1.1 spelling where the key
 *     is the boolean `true`. Matched case-insensitively.
 *   - every job's `runs-on` as a string, a list, a `labels` map, or `${{ matrix.<k> }}`
 *     resolved against the job's literal matrix (`<k>` values and `include` entries).
 *
 * ## Refusal, not a pass
 *
 * What it cannot read it refuses: a file that does not parse, has duplicate keys (the
 * second `on` would shadow the first), holds several documents, has no `on`, has an `on`
 * of another shape, a job with neither `runs-on` nor `uses`, a `runs-on` naming a runner
 * `group`, any other expression (`${{ inputs.runner }}`, `fromJson(...)`), or a YAML
 * merge key `<<` (resolving it would mean trusting merge semantics we do not model). A
 * gate that passes what it cannot understand is the phantom shape.
 *
 * ## Limits, stated
 *
 *   - The check is carried by the PR it checks. A PR that edits this script or
 *     `.github/workflows/workflow-guard.yml` runs its own edited copy, so the check alone
 *     is NOT a tamper-proof repository rule. Making it a required status check, or
 *     putting these two files under CODEOWNERS, is a repository setting and is out of
 *     scope here; this header and the PR say so rather than imply otherwise.
 *   - Only the literal `self-hosted` label is prohibited. A job that targets a
 *     self-hosted runner by a custom label alone would not be named here.
 *
 * Usage: node scripts/check-workflow-triggers.mjs [workflowsDir]   (default .github/workflows)
 * Exit: 0 clean, 1 a finding or a refusal, 2 the directory is missing or holds no workflow.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const PROHIBITED_TRIGGERS = new Set(['pull_request_target', 'workflow_run']);
const PROHIBITED_RUNNER = 'self-hosted';
const EXPRESSION = /\$\{\{/;
const MATRIX_REF = /^\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}$/;

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A YAML merge key anywhere below `v` (an alias-expanded tree has no other trace of it). */
function hasMergeKey(v) {
  if (Array.isArray(v)) return v.some(hasMergeKey);
  if (!isMap(v)) return false;
  return Object.keys(v).some((k) => k === '<<' || hasMergeKey(v[k]));
}

function triggerNames(on, out) {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) {
    if (!on.every((e) => typeof e === 'string')) out.push('refused: `on` list holds a non-string entry');
    return on.filter((e) => typeof e === 'string');
  }
  if (isMap(on)) return Object.keys(on);
  out.push('refused: `on` is neither a string, a list nor a map');
  return [];
}

/** Every literal value `matrix.<key>` can take, or null when the matrix is not a literal. */
function matrixValues(matrix, key) {
  if (!isMap(matrix)) return null;
  const vals = [];
  const take = (v) => {
    if (Array.isArray(v)) return v.every(take);
    if (typeof v === 'string' && !EXPRESSION.test(v)) return vals.push(v), true;
    return false;
  };
  if (key in matrix && !take(matrix[key])) return null;
  const inc = matrix.include;
  if (inc !== undefined) {
    if (!Array.isArray(inc)) return null;
    for (const e of inc) if (isMap(e) && key in e && !take(e[key])) return null;
  }
  return vals;
}

/** Labels a `runs-on` resolves to; pushes a refusal and returns [] for what it cannot read. */
function runnerLabels(job, jobId, out) {
  const ro = job['runs-on'];
  const where = `job \`${jobId}\``;
  const flat = (v) => {
    if (typeof v === 'string') return resolveOne(v);
    if (Array.isArray(v)) return v.flatMap((e) => (typeof e === 'string' ? resolveOne(e) : (out.push(`refused: ${where} runs-on list holds a non-string entry`), [])));
    return (out.push(`refused: ${where} runs-on has an unsupported form`), []);
  };
  const resolveOne = (s) => {
    if (!EXPRESSION.test(s)) return [s];
    const m = MATRIX_REF.exec(s.trim());
    const vals = m ? matrixValues(job.strategy?.matrix, m[1]) : null;
    if (vals === null) return (out.push(`refused: ${where} runs-on \`${s}\` is dynamic and cannot be resolved statically`), []);
    return vals;
  };
  if (isMap(ro)) {
    if ('group' in ro) return (out.push(`refused: ${where} runs-on names a runner group`), []);
    return 'labels' in ro ? flat(ro.labels) : (out.push(`refused: ${where} runs-on map has no labels`), []);
  }
  return flat(ro);
}

/** Findings for one workflow file's text; an empty array means clean. */
export function checkWorkflowText(text) {
  const out = [];
  let doc;
  try {
    doc = parse(text);
  } catch (e) {
    return [`refused: not parseable as a single YAML document (${String(e?.message ?? e).split('\n')[0]})`];
  }
  if (!isMap(doc)) return ['refused: the file is not a YAML mapping'];
  if (hasMergeKey(doc)) return ['refused: contains a YAML merge key (`<<`)'];

  // YAML 1.1 reads the bare key `on` as boolean true; the 1.2 parser keeps "on".
  const onKeys = ['on', 'true'].filter((k) => k in doc);
  if (onKeys.length === 0) out.push('refused: no `on` key');
  for (const k of onKeys) {
    for (const t of triggerNames(doc[k], out)) {
      if (PROHIBITED_TRIGGERS.has(String(t).toLowerCase())) out.push(`prohibited trigger \`${t}\``);
    }
  }

  const jobs = doc.jobs;
  if (jobs !== undefined && !isMap(jobs)) out.push('refused: `jobs` is not a mapping');
  for (const [id, job] of Object.entries(isMap(jobs) ? jobs : {})) {
    if (!isMap(job)) { out.push(`refused: job \`${id}\` is not a mapping`); continue; }
    if (!('runs-on' in job)) {
      if (!('uses' in job)) out.push(`refused: job \`${id}\` has neither \`runs-on\` nor \`uses\``);
      continue;
    }
    for (const label of runnerLabels(job, id, out)) {
      if (label.toLowerCase() === PROHIBITED_RUNNER) out.push(`prohibited runner label \`${label}\` in job \`${id}\``);
    }
  }
  return out;
}

function main() {
  const dir = resolve(process.argv[2] ?? '.github/workflows');
  let names;
  try {
    names = readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort();
  } catch {
    console.error(`check-workflow-triggers: cannot read ${dir}`);
    process.exit(2);
  }
  if (names.length === 0) {
    console.error(`check-workflow-triggers: no workflow files under ${dir}`);
    process.exit(2);
  }
  let bad = 0;
  for (const f of names) {
    for (const finding of checkWorkflowText(readFileSync(join(dir, f), 'utf8'))) {
      console.error(`check-workflow-triggers: ${f}: ${finding}`);
      bad++;
    }
  }
  if (bad > 0) process.exit(1);
  console.log(`OK — ${names.length} workflow files, no prohibited trigger or runner.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
