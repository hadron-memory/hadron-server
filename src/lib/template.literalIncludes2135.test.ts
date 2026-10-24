/**
 * #2135 — the shared compile keeps include tags written as code (cor:dmo:150:02)
 * through the Mustache render, byte for byte, and never leaks its protection marker.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileTemplate } from './template.js';
import { BROKEN_INCLUDE_NOTICE } from './includes/spliceIncludes.js';
import * as guardModule from './includes/literalGuard.js';

vi.mock('./includes/literalGuard.js', async importOriginal => {
  const real = await importOriginal<typeof import('./includes/literalGuard.js')>();
  return { ...real, makeLiteralGuard: vi.fn(real.makeLiteralGuard) };
});

function mockDb(nodes: Array<{ loc: string; data?: unknown; content?: string; revSeq?: number }>) {
  return {
    node: {
      findFirst: vi.fn(async ({ where }: any) => {
        const n = nodes.find(x => x.loc === where.loc);
        return n ? { id: `id-${n.loc}`, memoryId: 'mem1', revSeq: 1, memory: { id: 'mem1', isEncrypted: false }, ...n } : null;
      }),
    },
  } as any;
}

const compile = (t: string, data: Record<string, unknown> | null, db = mockDb([])) =>
  compileTemplate(t, data, 'mem1', db, {});

beforeEach(() => vi.mocked(guardModule.makeLiteralGuard).mockClear());

describe('compileTemplate keeps literal include examples (#2135)', () => {
  it('a template whose code holds a tag compiles to itself', async () => {
    for (const t of ['`{{> b}}`', 'x\n```\n{{> b}}\n```', '~~~\n{{> b rev=1}}\n~~~', 'p\n\n    {{> b}}\n']) {
      expect(await compile(t, null)).toBe(t);
    }
  });

  it('renders variables around the example and splices the active include beside it', async () => {
    const db = mockDb([{ loc: 'b', content: 'B' }]);
    expect(await compile('Hi {{name}} `{{> b}}` {{> b}}', { name: 'Zed' }, db)).toBe('Hi Zed `{{> b}}` B');
  });

  it('a missing active include is still the notice, and a literal one does no lookup', async () => {
    const db = mockDb([]);
    expect(await compile('`{{> gone}}` {{> gone}}', null, db)).toBe(`\`{{> gone}}\` ${BROKEN_INCLUDE_NOTICE}`);
    expect(db.node.findFirst.mock.calls.filter(([a]: any) => a.where.loc === 'gone')).toHaveLength(1);
  });

  it('a renderer failure returns the spliced text with the example restored, never the marker', async () => {
    const out = await compile('`{{> b}}` {{#open}} never closed', null);
    expect(out).toContain('`{{> b}}`');
    expect(out).not.toMatch(/\u0001/);
  });

  it('a guard found in the template, in an included node, or in the data is discarded and drawn again', async () => {
    const fresh = 'FRESH-GUARD-NOT-IN-ANY-TEXT';
    const bad = '\u0001hrn-lit-collides\u0001';
    const make = vi.mocked(guardModule.makeLiteralGuard);
    make.mockReturnValueOnce(bad).mockReturnValue(fresh);
    expect(await compile(`${bad} \`{{> b}}\``, null)).toBe(`${bad} \`{{> b}}\``);
    expect(make).toHaveBeenCalledTimes(2);

    make.mockClear();
    make.mockReturnValueOnce(bad).mockReturnValue(fresh);
    const db = mockDb([{ loc: 'c', content: `inc ${bad}` }]);
    expect(await compile('{{> c}} `{{> b}}`', null, db)).toBe(`inc ${bad} \`{{> b}}\``);
    expect(make).toHaveBeenCalledTimes(2);

    make.mockClear();
    make.mockReturnValueOnce(bad).mockReturnValue(fresh);
    expect(await compile('{{v}} `{{> b}}`', { v: bad })).toBe(`${bad} \`{{> b}}\``);
    expect(make).toHaveBeenCalledTimes(2);
  });

  it('never settles for a colliding guard: repeated collision fails loud rather than corrupting text', async () => {
    const bad = '\u0001hrn-lit-stuck\u0001';
    vi.mocked(guardModule.makeLiteralGuard).mockReturnValue(bad);
    await expect(compile(`${bad} \`{{> b}}\``, null)).rejects.toThrow(/collided/);
    vi.mocked(guardModule.makeLiteralGuard).mockImplementation(() => `\u0001hrn-lit-${Math.random()}\u0001`);
  });
});
