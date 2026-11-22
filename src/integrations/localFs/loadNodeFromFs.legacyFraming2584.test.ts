/**
 * #2584 (cor:int:020:01): the legacy node.yaml / .node/topic.md layout has no
 * framing (saveNodeToFs writes content raw), so the loader strips nothing. An
 * empty or ASCII-whitespace-only file is null; a Unicode-space-only body is content.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNodeFromFs } from './loadNodeFromFs.js';
import { saveNodeToFs } from './saveNodeToFs.js';
import { generateId } from '../../lib/id.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hadron-2584-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const dir = () => join(root, 'a', 'b');
const loadSaved = async (content: string) => {
  const res = await saveNodeToFs({ id: generateId(), loc: 'a:b', name: 'n', content }, root);
  expect(res.error).toBeUndefined();
  return (await loadNodeFromFs(dir(), root, 'synthetic/legacy2584')).node.content;
};

describe('#2584 legacy topic.md content fidelity', () => {
  it.each([
    ['leading indent and trailing newline', '    code\n'],
    ['trailing blank lines', 'text\n\n\n'],
    ['leading blank lines', '\n\ntext'],
    ['CRLF kept', 'a\r\nb\r\n'],
    ['Unicode-space-only body is content', '  '],
  ])('round-trips %s byte for byte', async (_n, content) => {
    expect(await loadSaved(content)).toBe(content);
  });

  it.each([
    ['empty', ''],
    ['space, tab, LF, CR, VT, FF only', ' \t\n\r\v\f'],
  ])('%s file loads as null', async (_n, body) => {
    await saveNodeToFs({ id: generateId(), loc: 'a:b', name: 'n', content: 'x' }, root);
    writeFileSync(join(dir(), '.node', 'topic.md'), body, 'utf-8');
    expect((await loadNodeFromFs(dir(), root, 'synthetic/legacy2584')).node.content).toBeNull();
  });
});
