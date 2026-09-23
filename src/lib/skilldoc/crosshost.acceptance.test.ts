/**
 * #1254 part 2 — the hadron-cli#622 cross-host acceptance matrix, both columns.
 *
 * `__fixtures__/crosshost-acceptance.json` is VENDORED, not authored here:
 * copied byte-for-byte from hadron-cli `internal/skilldoc/testdata/
 * crosshost-acceptance.json` at 31d5f62 (hadron-cli PR #664). Its expectations
 * are written from the cor:agt:030 rules, not from either implementation, so
 * it can disagree with this one. That is the point of running it here.
 *
 * hadron-cli runs only the claudeSkill column, because its Go library knows one
 * host. This registry knows both, so this file runs both columns of every
 * declaration, lint, collision and rendering case.
 *
 * The digest pin below makes a local edit fail. To change a case, change it in
 * hadron-cli, re-vendor the file, and update the digest and the commit above
 * in the same change.
 *
 * The `pending` section is not run here. Its resolver cases (P01, P02) are
 * covered through `skillPlan` in resolvers.skillPlan.test.ts; the rest wait
 * on the hadron-cli#621 writer.
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
  normalizeDescription,
  parseFile,
  render,
  hash,
  SKILL_HOSTS,
  type SkillNode,
} from './index.js';

const FIXTURE = join(import.meta.dirname, '__fixtures__', 'crosshost-acceptance.json');
const VENDORED_SHA256 = '924361a365de774b29a0280b0d201d56839e42f36ca3e557cfe9c5fd55ff8562';

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
