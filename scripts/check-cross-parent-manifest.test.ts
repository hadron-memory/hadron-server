/**
 * #3221 (#1522 S3): the fail-closed manifest of cross-parent object fields.
 *
 * The walk proves CLASSIFICATION, not authorization (the issue's Ask 3): it
 * finds every object-returning field whose type differs from its parent and
 * refuses to pass until each one carries a reasoned entry. Authorization is
 * carried by the `child-gated` tests the manifest names and by the reading of
 * the `parent-implies-child` entries.
 *
 * Every refusal below is asserted by its message AND by exit code on the real
 * CLI: a check that names the field and exits 0 is a phantom gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  walkCrossParentFields,
  checkManifest,
  MANIFEST_PATH,
  CLASSES,
} from './check-cross-parent-manifest.mjs';

const SCRIPT = join(process.cwd(), 'scripts', 'check-cross-parent-manifest.mjs');

/** A small schema: three entities, an envelope and a value type. */
const FIXTURE_SDL = `
  type Query { memory(id: ID!): Memory  agents: AgentsPage! }
  type Mutation { makeAgent: MakeAgentPayload! }
  type Memory { id: ID! name: String agent: Agent members: [Member!]! self: Memory owner: Owner }
  type Agent { id: ID! name: String memory: Memory stats: Stats }
  type Member { id: ID! user: Owner }
  type Owner { id: ID! email: String }
  type AgentsPage { items: [Agent!]! total: Int! }
  type MakeAgentPayload { agent: Agent }
  type Stats { count: Int }
  enum Kind { A B }
`;
const NON_ENTITY = { AgentsPage: 'envelope', MakeAgentPayload: 'envelope', Stats: 'value' };

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'manifest-3221-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'resolvers.ts'), 'export const memoryAgent = () => requireMemoryRead();\n');
  writeFileSync(join(root, 'src', 'gate.test.ts'), "it('refuses a stranger on Memory.members', () => {});\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const E = {
  self: { class: 'self-gated', resolver: 'src/resolvers.ts::memoryAgent', gate: 'requireMemoryRead' },
  child: { class: 'child-gated', test: 'src/gate.test.ts::refuses a stranger on Memory.members' },
  parent: { class: 'parent-implies-child', audience: 'the Agent page reader sees its memory', spec: 'cor:acl:090:02' },
  proj: { class: 'closed-projection', projection: 'Owner', why: 'carries id and email only, both already public' },
  open: { class: 'open', evidence: '#1522 row 11: narrow-vs-direct parity unresolved' },
};
function completeEntries() {
  return {
    'Memory.agent': E.self,
    'Memory.members': E.child,
    'Memory.owner': E.proj,
    'Agent.memory': E.parent,
    'Member.user': E.open,
    'AgentsPage.items': E.self,
    'MakeAgentPayload.agent': E.parent,
  };
}
const TARGETS: Record<string, string> = {
  'Memory.agent': 'Agent', 'Memory.members': 'Member', 'Memory.owner': 'Owner', 'Agent.memory': 'Memory', 'Member.user': 'Owner',
  'AgentsPage.items': 'Agent', 'MakeAgentPayload.agent': 'Agent', 'Memory.gone': 'Memory', 'Query.memory': 'Memory', 'Owner.synthetic': 'Memory',
};
/** The fixtures state what is under test; the target each entry must record is filled in here. */
const withTargets = (entries: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(entries).map(([c, e]) => [c, { target: TARGETS[c], ...(e as object) }]));
const run = (entries: Record<string, unknown>, sdl = FIXTURE_SDL) =>
  checkManifest({ sdl, manifest: { nonEntityTypes: NON_ENTITY, entries: withTargets(entries) }, root });

describe('the walk: what counts as a cross-parent object field', () => {
  const coords = walkCrossParentFields(FIXTURE_SDL, Object.keys(NON_ENTITY)).map((f: { coord: string }) => f.coord);
  it('finds every field that returns a different entity object, through list and non-null wrappers', () => {
    expect(coords.sort()).toEqual(['Agent.memory', 'AgentsPage.items', 'MakeAgentPayload.agent', 'Member.user', 'Memory.agent', 'Memory.members', 'Memory.owner']);
  });
  it('skips the root operation types, scalars, self-typed fields and non-entity targets (an envelope is excluded as a TARGET, its entity-returning fields stay in)', () => {
    for (const skipped of ['Query.memory', 'Mutation.makeAgent', 'Memory.self', 'Memory.name', 'Agent.stats', 'AgentsPage.total']) {
      expect(coords).not.toContain(skipped);
    }
  });
  it('treats a type missing from the non-entity table as in scope (fail closed)', () => {
    const open = walkCrossParentFields(FIXTURE_SDL, []).map((f: { coord: string }) => f.coord);
    expect(open).toContain('Agent.stats');
    expect(open).toContain('Memory.agent');
  });
});

describe('the check: a complete manifest passes', () => {
  it('accepts one entry of every class', () => {
    expect(run(completeEntries()).problems).toEqual([]);
  });
  it('names the five entry classes (non-entity types live in the type table)', () => {
    expect([...CLASSES].sort()).toEqual(['child-gated', 'closed-projection', 'open', 'parent-implies-child', 'self-gated']);
  });
});

describe('the check: it fails and names the field', () => {
  it('fails with no manifest at all', () => {
    const r = checkManifest({ sdl: FIXTURE_SDL, manifest: undefined, root });
    expect(r.problems.join('\n')).toMatch(/manifest/i);
    expect(r.problems.length).toBeGreaterThan(0);
  });
  it('fails when one in-scope field has no entry, and names it', () => {
    const entries: Record<string, unknown> = completeEntries();
    delete entries['Memory.members'];
    const r = run(entries);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('Memory.members');
    expect(r.problems[0]).toMatch(/no manifest entry/);
  });
  it('MUTANT OF THE WALK: a synthetic object field added to the schema with no entry turns it red', () => {
    const mutated = FIXTURE_SDL.replace('type Owner {', 'type Owner { synthetic: Memory ');
    const r = run(completeEntries(), mutated);
    expect(r.problems.join('\n')).toContain('Owner.synthetic');
  });
  it('fails an entry for a field that no longer exists, and names it', () => {
    const r = run({ ...completeEntries(), 'Memory.gone': E.self });
    expect(r.problems.join('\n')).toMatch(/Memory\.gone.*no longer|stale/i);
  });
  it('fails an entry for a root-operation or non-entity field (it is out of scope, so the entry is stale)', () => {
    const r = run({ ...completeEntries(), 'Query.memory': E.self });
    expect(r.problems.join('\n')).toContain('Query.memory');
  });
  it('fails an entry whose recorded target is not the type the schema now returns', () => {
    const r = run({ ...completeEntries(), 'Memory.agent': { ...E.self, target: 'Owner' } });
    expect(r.problems.join('\n')).toMatch(/Memory\.agent.*Agent/);
  });
  it('fails an entry with no recorded target', () => {
    const r = checkManifest({ sdl: FIXTURE_SDL, manifest: { nonEntityTypes: NON_ENTITY, entries: completeEntries() }, root });
    expect(r.problems.join('\n')).toMatch(/Memory\.agent.*target/);
  });
  it('fails an entry with no class, or an unknown class', () => {
    expect(run({ ...completeEntries(), 'Memory.agent': {} }).problems.join('\n')).toMatch(/Memory\.agent.*class/);
    expect(run({ ...completeEntries(), 'Memory.agent': { class: 'trusted' } }).problems.join('\n')).toMatch(/Memory\.agent.*class/);
  });
  it('fails a self-gated entry whose resolver file is missing, or does not contain the named gate', () => {
    const missing = run({ ...completeEntries(), 'Memory.agent': { ...E.self, resolver: 'src/nope.ts::memoryAgent' } });
    expect(missing.problems.join('\n')).toMatch(/Memory\.agent.*src\/nope\.ts/);
    const noGate = run({ ...completeEntries(), 'Memory.agent': { ...E.self, gate: 'requireNothing' } });
    expect(noGate.problems.join('\n')).toMatch(/Memory\.agent.*requireNothing/);
  });
  it('fails a child-gated entry that names no test, or a test title the file does not contain', () => {
    expect(run({ ...completeEntries(), 'Memory.members': { class: 'child-gated' } }).problems.join('\n')).toMatch(/Memory\.members.*test/);
    const wrong = run({ ...completeEntries(), 'Memory.members': { class: 'child-gated', test: 'src/gate.test.ts::a title that is not there' } });
    expect(wrong.problems.join('\n')).toMatch(/Memory\.members.*a title that is not there/);
  });
  it('fails a parent-implies-child entry without an audience or without a citation', () => {
    expect(run({ ...completeEntries(), 'Agent.memory': { class: 'parent-implies-child', spec: 'cor:acl:090:02' } }).problems.join('\n')).toMatch(/Agent\.memory.*audience/);
    expect(run({ ...completeEntries(), 'Agent.memory': { class: 'parent-implies-child', audience: 'x' } }).problems.join('\n')).toMatch(/Agent\.memory.*(spec|resolver)/);
    expect(run({ ...completeEntries(), 'Agent.memory': { class: 'parent-implies-child', audience: 'x', spec: 'because I said so' } }).problems.join('\n')).toMatch(/Agent\.memory.*spec/);
  });
  it('fails a closed-projection entry that does not name the projection type, or says nothing about why', () => {
    expect(run({ ...completeEntries(), 'Memory.owner': { class: 'closed-projection', why: 'ok' } }).problems.join('\n')).toMatch(/Memory\.owner.*projection/);
    expect(run({ ...completeEntries(), 'Memory.owner': { class: 'closed-projection', projection: 'Agent', why: 'ok' } }).problems.join('\n')).toMatch(/Memory\.owner.*Owner/);
    expect(run({ ...completeEntries(), 'Memory.owner': { class: 'closed-projection', projection: 'Owner' } }).problems.join('\n')).toMatch(/Memory\.owner.*why/);
  });
  it('fails an open entry that names no issue or evidence requirement', () => {
    expect(run({ ...completeEntries(), 'Member.user': { class: 'open' } }).problems.join('\n')).toMatch(/Member\.user.*evidence/);
    expect(run({ ...completeEntries(), 'Member.user': { class: 'open', evidence: 'later' } }).problems.join('\n')).toMatch(/Member\.user.*(#|issue)/);
  });
  it('fails a stale non-entity table row (the type is gone)', () => {
    const r = checkManifest({ sdl: FIXTURE_SDL, manifest: { nonEntityTypes: { ...NON_ENTITY, Ghost: 'value' }, entries: withTargets(completeEntries()) }, root });
    expect(r.problems.join('\n')).toContain('Ghost');
  });
  it('fails a non-entity row with no kind', () => {
    const r = checkManifest({ sdl: FIXTURE_SDL, manifest: { nonEntityTypes: { ...NON_ENTITY, Stats: 'whatever' }, entries: withTargets(completeEntries()) }, root });
    expect(r.problems.join('\n')).toMatch(/Stats.*(envelope|value)/);
  });
});

describe('the real schema and the committed manifest', () => {
  it('the CLI exits 0 on the real SDL with the committed manifest', () => {
    const out = execFileSync('pnpm', ['-s', 'tsx', SCRIPT], { encoding: 'utf8', cwd: process.cwd() });
    expect(out).toMatch(/cross-parent/i);
  }, 60_000);

  it('the CLI exits non-zero and names the field when the committed manifest loses an entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-3221-cli-'));
    try {
      const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      delete manifest.entries['Organization.agents'];
      const file = join(dir, 'm.json');
      writeFileSync(file, JSON.stringify(manifest));
      let code = 0;
      let err = '';
      try {
        execFileSync('pnpm', ['-s', 'tsx', SCRIPT, '--manifest', file], { encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        code = (e as { status: number }).status;
        err = String((e as { stderr: string }).stderr);
      }
      expect(code).toBe(1);
      expect(err).toContain('Organization.agents');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  const manifest = () => JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  it('S2 row 11: Organization.agents is open', () => {
    expect(manifest().entries['Organization.agents'].class).toBe('open');
  });
  it('S2 rows 12-14: the scope-lens fields are open until the differential test exists, citing cor:acl:120:01', () => {
    for (const c of ['ScopeMemoryEntry.memory', 'ScopeExplanation.memories', 'ScopeExplanation.winner']) {
      const e = manifest().entries[c];
      expect(e.class, c).toBe('open');
      expect(e.evidence, c).toContain('cor:acl:120:01');
    }
  });
  it('S2 row 8: Session.worker is parent-implies-child for the identity fields, citing cor:acl:090:02, with a named masking test', () => {
    const e = manifest().entries['Session.worker'];
    expect(e.class).toBe('parent-implies-child');
    expect(e.spec).toBe('cor:acl:090:02');
    expect(e.maskingTest).toMatch(/::/);
  });
  it('the nested User fields are classified per #2574 and none is left open', () => {
    const userFields = Object.entries(manifest().entries).filter(([, v]) => (v as { target?: string }).target === 'User');
    expect(userFields.length).toBeGreaterThan(0);
    for (const [c, v] of userFields) expect((v as { class: string }).class, c).not.toBe('open');
  });
  it('every entry records its target type, and the target is what the walk found', () => {
    for (const [c, v] of Object.entries(manifest().entries)) expect((v as { target?: string }).target, c).toBeTruthy();
  });
});
