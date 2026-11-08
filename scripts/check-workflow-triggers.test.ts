/**
 * The workflow-trigger gate (#2657, epic #2139 B4), proven to FAIL, not merely to pass.
 *
 * Every YAML body below is a SYNTHETIC fixture written inline for this test. None of
 * it is a live workflow: the checker only ever scans `.github/workflows/` of the tree
 * it is pointed at, and each case points it at a throwaway directory.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const FINDING_PREFIX = 'check-workflow-triggers:';
const SCRIPT = join(process.cwd(), 'scripts', 'check-workflow-triggers.mjs');

/** Run the checker over a directory holding exactly the given workflow files. */
function runOn(files: Record<string, string>, dirArg = true): { code: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'wf-guard-'));
  try {
    const dir = join(root, '.github', 'workflows');
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    try {
      const out = execFileSync('node', dirArg ? [SCRIPT, dir] : [SCRIPT], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status: number; stderr: string; stdout: string };
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      // A crash (missing script, thrown exception) also exits non-zero. Only the
      // checker's own finding counts as a refusal, or every "must fail" case below
      // would pass vacuously against a script that does not exist.
      if (!out.includes(FINDING_PREFIX)) throw new Error(`checker did not run: exit ${err.status}\n${out}`);
      return { code: err.status, out };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const job = (runsOn: string, extra = '') => `jobs:\n  a:\n    runs-on: ${runsOn}\n${extra}    steps:\n      - run: echo hi\n`;
const wf = (on: string, runsOn = 'ubuntu-latest', extra = '') => `name: x\n${on}\n${job(runsOn, extra)}`;

describe('check-workflow-triggers: benign controls pass', () => {
  it('a GitHub-hosted pull_request workflow passes', () => {
    expect(runOn({ 'ok.yml': wf('on: pull_request') }).code).toBe(0);
  });
  it('list and map trigger forms of allowed events pass', () => {
    expect(runOn({ 'a.yml': wf('on: [push, pull_request]'), 'b.yml': wf('on:\n  push:\n    branches: [main]\n  pull_request:\n') }).code).toBe(0);
  });
  it('runs-on list and a literal matrix pass', () => {
    const m = `    strategy:\n      matrix:\n        os: [ubuntu-latest, ubuntu-24.04]\n`;
    expect(runOn({ 'a.yml': wf('on: push', '[ubuntu-latest]'), 'b.yml': wf('on: push', '${{ matrix.os }}', m) }).code).toBe(0);
  });
  it('a reusable-workflow job (uses:, no runs-on) passes', () => {
    expect(runOn({ 'a.yml': 'on: push\njobs:\n  a:\n    uses: ./.github/workflows/other.yml\n' }).code).toBe(0);
  });
  it('a workflow_dispatch / schedule / workflow_call trigger passes (not the prohibited ones)', () => {
    expect(runOn({ 'a.yml': wf('on:\n  workflow_dispatch:\n  schedule:\n    - cron: "0 0 * * *"\n  workflow_call:') }).code).toBe(0);
  });
});

describe('check-workflow-triggers: prohibited triggers fail in every form', () => {
  for (const ev of ['pull_request_target', 'workflow_run']) {
    it(`${ev} as a string`, () => {
      const r = runOn({ 'bad.yml': wf(`on: ${ev}`) });
      expect(r.code).toBe(1);
      expect(r.out).toContain(ev);
      expect(r.out).toContain('bad.yml');
    });
    it(`${ev} in a list`, () => expect(runOn({ 'bad.yml': wf(`on: [push, ${ev}]`) }).code).toBe(1));
    it(`${ev} as a map key`, () => expect(runOn({ 'bad.yml': wf(`on:\n  push:\n  ${ev}:\n    types: [completed]`) }).code).toBe(1));
    it(`${ev} quoted, and under the YAML-1.1 "true" key`, () => {
      expect(runOn({ 'q.yml': wf(`"on": "${ev}"`) }).code).toBe(1);
      expect(runOn({ 't.yml': wf(`true:\n  ${ev}:`) }).code).toBe(1);
    });
  }
  it('matches case-insensitively (conservative)', () => {
    expect(runOn({ 'bad.yml': wf('on: Pull_Request_Target') }).code).toBe(1);
  });
});

describe('check-workflow-triggers: self-hosted runners fail in every form', () => {
  it('runs-on string', () => expect(runOn({ 'bad.yml': wf('on: push', 'self-hosted') }).code).toBe(1));
  it('runs-on list', () => expect(runOn({ 'bad.yml': wf('on: push', '[self-hosted, linux]') }).code).toBe(1));
  it('runs-on block list', () => {
    expect(runOn({ 'bad.yml': 'on: push\njobs:\n  a:\n    runs-on:\n      - linux\n      - Self-Hosted\n    steps: []\n' }).code).toBe(1);
  });
  it('runs-on labels map', () => {
    expect(runOn({ 'bad.yml': 'on: push\njobs:\n  a:\n    runs-on:\n      labels: [self-hosted]\n    steps: []\n' }).code).toBe(1);
  });
  it('a literal matrix value that is self-hosted', () => {
    const m = `    strategy:\n      matrix:\n        os: [ubuntu-latest, self-hosted]\n`;
    expect(runOn({ 'bad.yml': wf('on: push', '${{ matrix.os }}', m) }).code).toBe(1);
  });
  it('a matrix include entry that is self-hosted', () => {
    const m = `    strategy:\n      matrix:\n        include:\n          - os: self-hosted\n`;
    expect(runOn({ 'bad.yml': wf('on: push', '${{ matrix.os }}', m) }).code).toBe(1);
  });
  it('the offending job is named', () => {
    expect(runOn({ 'bad.yml': wf('on: push', 'self-hosted') }).out).toContain('a');
  });
});

describe('check-workflow-triggers: unsupported or dynamic forms are refused, never passed', () => {
  it('an expression runs-on it cannot resolve statically', () => {
    const r = runOn({ 'bad.yml': wf('on: push', '${{ inputs.runner }}') });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/refus|unsupported|dynamic/i);
  });
  it('a matrix expression fed by fromJson', () => {
    const m = `    strategy:\n      matrix:\n        os: \${{ fromJson(needs.x.outputs.os) }}\n`;
    expect(runOn({ 'bad.yml': wf('on: push', '${{ matrix.os }}', m) }).code).toBe(1);
  });
  it('a runs-on that names a runner group', () => {
    expect(runOn({ 'bad.yml': 'on: push\njobs:\n  a:\n    runs-on:\n      group: big\n    steps: []\n' }).code).toBe(1);
  });
  it('a malformed YAML file', () => expect(runOn({ 'bad.yml': 'on: [push\njobs: {' }).code).toBe(1));
  it('a file with a duplicate key (the second `on` would shadow the first)', () => {
    expect(runOn({ 'bad.yml': 'on: push\non: pull_request_target\njobs: {}\n' }).code).toBe(1);
  });
  it('a multi-document file', () => expect(runOn({ 'bad.yml': 'on: push\njobs: {}\n---\non: workflow_run\njobs: {}\n' }).code).toBe(1));
  it('a file with no `on`', () => expect(runOn({ 'bad.yml': 'jobs: {}\n' }).code).toBe(1));
  it('an `on` that is neither string, list nor map', () => expect(runOn({ 'bad.yml': 'on: 5\njobs: {}\n' }).code).toBe(1));
  it('a job with neither runs-on nor uses', () => {
    expect(runOn({ 'bad.yml': 'on: push\njobs:\n  a:\n    steps: []\n' }).code).toBe(1);
  });
  it('a YAML merge key (cannot be resolved without trusting the merge semantics)', () => {
    const body = 'on: push\nx: &d\n  runs-on: self-hosted\njobs:\n  a:\n    <<: *d\n    steps: []\n';
    expect(runOn({ 'bad.yml': body }).code).toBe(1);
  });
  it('a runs-on map with BOTH a group and labels is still refused for the group', () => {
    expect(runOn({ 'bad.yml': 'on: push\njobs:\n  a:\n    runs-on:\n      group: big\n      labels: ubuntu-latest\n    steps: []\n' }).code).toBe(1);
  });
  it('a merge key is refused even where every job has a runs-on of its own', () => {
    const body = 'on: push\nx: &d\n  env: {A: b}\njobs:\n  a:\n    <<: *d\n    runs-on: ubuntu-latest\n    steps: []\n';
    const r = runOn({ 'bad.yml': body });
    expect(r.code).toBe(1);
    expect(r.out).toContain('merge key');
  });
  it('a scalar or a list document is refused, not crashed on', () => {
    expect(runOn({ 'a.yml': 'just text\n' }).out).toContain('not a YAML mapping');
    expect(runOn({ 'b.yml': '- on: workflow_run\n' }).out).toContain('not a YAML mapping');
  });
  it('a `true` key (YAML 1.1 `on`) is read even when a plain `on` is also present', () => {
    expect(runOn({ 'bad.yml': 'on: push\ntrue:\n  workflow_run:\njobs: {}\n' }).code).toBe(1);
  });
  it('an empty workflows directory fails', () => {
    expect(runOn({}).code).toBe(2);
    expect(runOn({}, false).code).toBe(2);
  });
  it('a directory that does not exist fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'wf-guard-missing-'));
    try {
      let code = 0;
      let out = '';
      try {
        execFileSync('node', [SCRIPT, join(root, 'no-such-dir')], { encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        const err = e as { status: number; stderr: string };
        code = err.status;
        out = err.stderr;
      }
      expect(code).toBe(2);
      expect(out).toContain(FINDING_PREFIX);
      expect(out).toContain('cannot read');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('check-workflow-triggers: the scan is a whole-tree property', () => {
  it('a new or renamed file is checked like any other, and the clean files do not mask it', () => {
    const r = runOn({ 'ok.yml': wf('on: push'), 'renamed-from-ci.yaml': wf('on: workflow_run'), 'z-new.yml': wf('on: push', 'self-hosted') });
    expect(r.code).toBe(1);
    expect(r.out).toContain('renamed-from-ci.yaml');
    expect(r.out).toContain('z-new.yml');
    expect(r.out).not.toContain('ok.yml');
  });
  it('a path filter on the workflow does not exempt it', () => {
    expect(runOn({ 'bad.yml': wf('on:\n  pull_request_target:\n    paths: ["docs/**"]') }).code).toBe(1);
  });
  it('non-YAML files in the directory are ignored', () => {
    expect(runOn({ 'ok.yml': wf('on: push'), 'README.md': 'on: workflow_run' }).code).toBe(0);
  });
});

describe('check-workflow-triggers: fail-closed matrix, labels and reusable workflows (§10 on #2939)', () => {
  const m = (matrix: string) => `    strategy:\n      matrix:\n${matrix}`;
  it('a non-map include entry is refused (an expression string or a nested list)', () => {
    const expr = m("        include:\n          - '${{ fromJSON(inputs.m) }}'\n");
    expect(runOn({ 'bad.yml': wf('on: push', '${{ matrix.os }}', expr) }).code).toBe(1);
    const nested = m('        include:\n          - [{os: self-hosted}]\n');
    // Beside a readable entry, so only the include-entry refusal (not the zero-label one) can catch it.
    const mixed = m("        include:\n          - os: ubuntu-latest\n          - '${{ fromJSON(inputs.m) }}'\n");
    expect(runOn({ 'bad.yml': wf('on: push', '${{ matrix.os }}', mixed) }).code).toBe(1);
    expect(runOn({ 'bad.yml': wf('on: push', '${{ matrix.os }}', nested) }).code).toBe(1);
  });
  it('a matrix reference that resolves to zero labels is refused, not passed as "no runner"', () => {
    const r = runOn({ 'bad.yml': wf('on: push', '${{ matrix.os }}', m('        foo: [a]\n')) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/dynamic|resolved/);
  });
  it('a matrix key that only exists on the prototype resolves to nothing and is refused', () => {
    for (const k of ['constructor', 'toString', '__proto__']) {
      expect(runOn({ 'bad.yml': wf('on: push', `\${{ matrix.${k} }}`, m('        foo: [a]\n')) }).code).toBe(1);
    }
  });
  it('a matrix whose include entries are all maps still resolves and passes', () => {
    const ok = m('        include:\n          - os: ubuntu-latest\n          - os: ubuntu-24.04\n');
    expect(runOn({ 'ok.yml': wf('on: push', '${{ matrix.os }}', ok) }).code).toBe(0);
  });
  it('labels are trimmed before the self-hosted comparison', () => {
    expect(runOn({ 'bad.yml': wf('on: push', '[" self-hosted"]') }).code).toBe(1);
    expect(runOn({ 'bad.yml': wf('on: push', '"self-hosted "') }).code).toBe(1);
  });
  it('a job that calls a remote reusable workflow is refused; a local one passes', () => {
    const remote = 'on: push\njobs:\n  a:\n    uses: some-org/some-repo/.github/workflows/x.yml@main\n';
    const r = runOn({ 'bad.yml': remote });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/reusable/);
    expect(runOn({ 'ok.yml': 'on: push\njobs:\n  a:\n    uses: ./.github/workflows/other.yml\n' }).code).toBe(0);
    expect(runOn({ 'bad2.yml': 'on: push\njobs:\n  a:\n    uses: 5\n' }).code).toBe(1);
  });
  it('a cyclic YAML alias is refused with a finding, not crashed on', () => {
    for (const body of ['on: push\nx: &a\n  - *a\njobs: {}\n', 'on: push\nx: &a {k: *a}\njobs: {}\n']) {
      const r = runOn({ 'bad.yml': body });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/cyclic|refused/);
    }
  });
  it('the guard workflow refuses to run when the checkout carries its own node_modules', () => {
    const doc = parse(readFileSync(join(process.cwd(), '.github', 'workflows', 'workflow-guard.yml'), 'utf8'));
    const install = (Object.values(doc.jobs)[0] as { steps: Array<{ name?: string; run?: string }> }).steps.find((st) => st.name === 'Install the YAML parser');
    expect(install?.run).toMatch(/find .*node_modules/);
    expect(install?.run).toMatch(/exit 1/);
  });
});

describe('check-workflow-triggers: the real tree', () => {
  it('every current workflow passes, and the guard workflow itself stays inside its own rules', () => {
    const dir = join(process.cwd(), '.github', 'workflows');
    const files = Object.fromEntries(readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(8);
    expect(runOn(files).code).toBe(0);
  });
  it('workflow-guard.yml is pull_request only, read-only, hosted, secret-free, unfiltered', () => {
    const doc = parse(readFileSync(join(process.cwd(), '.github', 'workflows', 'workflow-guard.yml'), 'utf8'));
    expect(Object.keys(doc.on).sort()).toEqual(['pull_request', 'push']);
    expect(doc.on.pull_request ?? {}).not.toHaveProperty('paths');
    expect(doc.on.push).not.toHaveProperty('paths');
    expect(doc.permissions).toEqual({ contents: 'read' });
    const jobs = Object.values(doc.jobs) as Array<{ 'runs-on': string; permissions?: unknown }>;
    expect(jobs.every((j) => j['runs-on'] === 'ubuntu-latest' && j.permissions === undefined)).toBe(true);
    expect(JSON.stringify(doc)).not.toContain('secrets.');
  });
});
