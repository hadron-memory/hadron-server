/**
 * #1254 part 2 — the hadron-cli#622 cross-host acceptance matrix, both columns.
 *
 * `__fixtures__/crosshost-acceptance.json` is VENDORED, not authored here:
 * copied byte-for-byte from hadron-cli `internal/skilldoc/testdata/
 * crosshost-acceptance.json` at d58c279 (hadron-cli PR #699, #621's
 * acceptance: format `version: 2`, the writer cases moved out of `pending`
 * into a `writer` section; the live sections are byte-identical to 36dac1b
 * from #680; before that e67ff80 from #679, 3c30a38 from #678, 0894a9f from
 * #671, first vendored from #664 at 31d5f62).
 * Its expectations
 * are written from the cor:agt:030 rules, not from either implementation, so
 * it can disagree with this one. That is the point of running it here.
 *
 * hadron-cli runs both columns too since #665, against its own Go host
 * table; this file runs both against this registry, so the two
 * implementations are checked against the same expectations independently.
 *
 * The digest pin below makes a local edit fail. To change a case, change it in
 * hadron-cli, re-vendor the file, and update the digest and the commit above
 * in the same change.
 *
 * Neither `writer` nor `pending` is EXECUTED here. `writer` cases run against
 * the real `hadron skill export` in hadron-cli (each names its `test`), with a
 * two-way guard there holding the subtests to this list; this runner pins only
 * that the section is present and well-formed, so a re-vendor that dropped it
 * fails here rather than passing as "nothing to check". The planner half of
 * the no-ID cases (P08, P12-P14) is the server's and runs through `skillPlan`
 * in resolvers.skillPlan.test.ts, including every legacy URN spelling (#1309).
 * `pending` holds what neither repo executes yet.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  classifyDeclaration,
  declaredSkill,
  lintCollisions,
  lintNode,
  lintUnknownHostKeys,
  normalizeDescription,
  parseFile,
  render,
  hash,
  SKILL_HOSTS,
  unknownHostKeys,
  type SkillNode,
} from './index.js';

const FIXTURE = join(import.meta.dirname, '__fixtures__', 'crosshost-acceptance.json');
const VENDORED_SHA256 = '6f81e1fdb3c63f047c20e0feaa3398250e97f721f8408faa4de0ba44e9004572';

const raw = readFileSync(FIXTURE);
const m = JSON.parse(raw.toString('utf8'));
const hosts: string[] = m.hosts;

const node = (urn: string, properties: unknown): SkillNode => ({
  urn,
  loc: urn.slice(urn.indexOf(':tasks:') + 1),
  memoryUrn: 'hrn:mem:example.com:demo',
  isRunnable: true,
  content: 'Do the demo.\n',
  properties,
});

describe('crosshost acceptance matrix (vendored from hadron-cli#622)', () => {
  it('is the vendored bytes, unedited', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VENDORED_SHA256);
  });

  it('is the matrix format this runner understands', () => {
    // A format this runner does not know may carry a section it would silently
    // skip. Fail loudly instead, and teach the runner the new format.
    expect(m.version).toBe(2);
  });

  it('carries the writer section, well-formed and disjoint from pending (format 2)', () => {
    // Not executed here: the writer is hadron-cli's. Pinned so a re-vendor that
    // lost the section, or a case that lost its `test`, fails here.
    expect(Array.isArray(m.writer)).toBe(true);
    expect(m.writer.length).toBeGreaterThan(0);
    for (const c of m.writer) {
      expect(Object.keys(c).sort(), c.id).toEqual(['contracts', 'expect', 'given', 'id', 'layer', 'test']);
      for (const k of ['id', 'layer', 'given', 'expect', 'test']) expect(typeof c[k], `${c.id}.${k}`).toBe('string');
      expect(Array.isArray(c.contracts) && c.contracts.length > 0, `${c.id}.contracts`).toBe(true);
    }
    const writerIds = m.writer.map((c: { id: string }) => c.id);
    const pendingIds = (m.pending ?? []).map((c: { id: string }) => c.id);
    expect(new Set(writerIds).size, 'duplicate writer ids').toBe(writerIds.length);
    expect(writerIds.filter((id: string) => pendingIds.includes(id)), 'in both writer and pending').toEqual([]);
  });

  it('names exactly the hosts this registry serves', () => {
    // A host added here without a matrix column, or the reverse, is a gap in
    // one of the two repos; this is where it shows.
    expect(hosts).toEqual(SKILL_HOSTS.map((h) => h.key));
  });

  it('POSITIVE CONTROL: every executable section is non-empty', () => {
    for (const section of ['declarations', 'lint', 'collisions', 'rendering']) {
      expect(m[section].length, section).toBeGreaterThan(0);
    }
  });

  // #1292: an unknown `exports` key belongs to NO host, so these columns sit
  // beside the per-host ones rather than inside them. Both are REQUIRED on
  // every case: a missing column must fail here, not pass as "nothing
  // reported" — which is the silent outcome #1292 exists to end.
  describe('host-free columns (#1292)', () => {
    it('POSITIVE CONTROL: both columns are present everywhere and exercised somewhere', () => {
      for (const c of m.declarations) expect(Array.isArray(c.unknown), `${c.id} unknown`).toBe(true);
      for (const c of m.lint) expect(Array.isArray(c.unhosted), `${c.id} unhosted`).toBe(true);
      expect(m.declarations.some((c: { unknown: unknown[] }) => c.unknown.length > 0)).toBe(true);
      expect(m.lint.some((c: { unhosted: unknown[] }) => c.unhosted.length > 0)).toBe(true);
    });

    for (const c of m.declarations) {
      it(`${c.id} unknown keys: ${c.title}`, () => {
        expect(unknownHostKeys(c.properties)).toEqual(c.unknown);
      });
    }

    for (const c of m.lint) {
      it(`${c.id} unhosted lint: ${c.title}`, () => {
        const rules = lintUnknownHostKeys(node(`hrn:node:example.com:demo:tasks:${c.id}`, c.properties))
          .map((f) => `${f.rule}:${f.severity}`)
          .sort();
        expect(rules).toEqual(c.unhosted);
      });
    }
  });

  for (const h of hosts) {
    describe(h, () => {
      for (const c of m.declarations) {
        it(`${c.id} declaration: ${c.title}`, () => {
          const { declaration, malformed } = classifyDeclaration(c.properties, h);
          const got = declaration && {
            key: declaration.key,
            name: declaration.name,
            description: declaration.description,
            enable: declaration.enable,
            enableSet: declaration.enableSet,
          };
          expect(got ?? null).toEqual(c.expect[h]);
          expect(malformed).toEqual(c.malformed[h]);
        });
      }

      for (const c of m.lint) {
        it(`${c.id} lint: ${c.title}`, () => {
          const rules = lintNode(node(`hrn:node:example.com:demo:tasks:${c.id}`, c.properties), h)
            .map((f) => `${f.rule}:${f.severity}`)
            .sort();
          expect(rules).toEqual(c.expect[h]);
        });
      }

      for (const c of m.collisions) {
        it(`${c.id} collisions: ${c.title}`, () => {
          // Every member of a colliding group is told, at error severity,
          // exactly once — not merely "some finding names this name".
          const byName = new Map<string, string[]>();
          for (const f of lintCollisions(
            c.nodes.map((n: { urn: string; properties: unknown }) => node(n.urn, n.properties)),
            h,
          )) {
            expect(f.rule).toBe('skill-name-collision');
            expect(f.severity).toBe('error');
            const name = /stores skill name "([^"]*)"/.exec(f.message)![1]!;
            byName.set(name, [...(byName.get(name) ?? []), f.urn]);
          }
          const got = [...byName.entries()]
            .map(([name, members]) => ({ name, members: members.sort() }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          expect(got).toEqual(c.expect[h]);
        });
      }
    });
  }

  describe('rendering: one renderer, per-host inputs', () => {
    const byId = new Map<string, unknown>(m.declarations.map((c: { id: string; properties: unknown }) => [c.id, c.properties]));
    const id = '01a0000000000000000000000000000r';
    const source = 'hrn:node:example.com:demo:tasks:demo';
    const body = 'Do the demo.\n';

    for (const r of m.rendering) {
      it(`${r.id}: ${r.title}`, () => {
        // Both sides from what this registry ACTUALLY reads — here, unlike in
        // the Go column, the Codex declaration is observable too.
        const [cl, cx] = hosts.map((h) => declaredSkill(byId.get(r.case), h));
        expect(cl, 'claude declaration').not.toBeNull();
        expect(cx, 'codex declaration').not.toBeNull();
        const files = [cl!, cx!].map((d) => render(id, d.name, source, d.description, body));
        for (const [i, d] of [cl!, cx!].entries()) {
          const parsed = parseFile(files[i]!);
          expect(parsed.name).toBe(d.name);
          expect(parsed.description).toBe(normalizeDescription(d.description));
        }
        expect(files[0] === files[1]).toBe(r.sameFile);
        const hashes = [cl!, cx!].map((d) => hash(id, source, d.name, d.description, body));
        expect(hashes[0] === hashes[1]).toBe(r.sameFile);
      });
    }
  });
});
