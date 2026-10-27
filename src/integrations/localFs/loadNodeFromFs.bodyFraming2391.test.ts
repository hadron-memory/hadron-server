/**
 * #2391 (cor:int:020:01, F1): the frontmatter loader removes exactly the framing
 * the writers add and keeps the authored content byte for byte. Every row of the
 * fixture shared with hadron-cli#945 is read through the real loader, and every
 * writer row is first written by the real incremental writer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from './markdownBodyFraming.fixture.json' with { type: 'json' };
import { loadNodeFromFs } from './loadNodeFromFs.js';
import { writeNodeFile } from '../github/writeNodeToGit.js';
import { generateId } from '../../lib/id.js';

type Case = { name: string; kind: 'roundtrip' | 'lossy' | 'parse'; stored?: string | null; body: string; loaded: string | null };
const cases = fixture.cases as Case[];
const written = cases.filter((c) => c.kind !== 'parse');

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hadron-2391-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const load = async (file: string) => (await loadNodeFromFs(join(root, file), root, 'synthetic/fixture2391')).node.content;

describe('#2391 shared body-framing fixture', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s: the loader returns the fixture content', async (_name, c) => {
    writeFileSync(join(root, 'node.md'), fixture.frontmatter + c.body, 'utf-8');
    expect(await load('node.md')).toBe(c.loaded);
  });

  it.each(written.map((c) => [c.name, c] as const))('%s: the real writer frames stored content as the fixture body', async (_name, c) => {
    writeNodeFile(root, {
      id: generateId(), loc: 'node', name: 'fixture', nodeType: 'info', content: c.stored ?? null,
      tags: [], role: null, isRunnable: null, isPlaceholder: false, outgoingEdges: [],
    });
    const text = readFileSync(join(root, 'node.md'), 'utf-8');
    const close = text.indexOf('\n---\n');
    expect(close).toBeGreaterThan(0);
    expect(text.slice(close + '\n---\n'.length)).toBe(c.body);
    expect(await load('node.md')).toBe(c.loaded);
  });

  it('round-trip rows read back exactly what was stored', () => {
    for (const c of cases.filter((row) => row.kind === 'roundtrip')) expect(c.loaded, c.name).toBe(c.stored);
    for (const c of cases.filter((row) => row.kind === 'lossy')) expect(c.loaded, c.name).not.toBe(c.stored);
  });
});
