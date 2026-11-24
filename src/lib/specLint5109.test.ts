import { describe, expect, it } from 'vitest';
import { lintSpec, isSpecSubject } from './specLint.js';
import { retirementBanner } from './retireSpecText.js';

const rule = (body: string, extra: Record<string, unknown> = {}) =>
  ({ loc: 'cor:agt:100:03', name: 'Rule: A thing [cor:agt:100:03]', role: 'spec.rule', content: body, ...extra });
const frame = (why: string | null) =>
  `# Rule Spec: A thing\n\n- **Status:** Decided.\n\n## The Rule\n\nA worker checks its channel.\n\n${why === null ? '' : `## Why We Need This Rule\n\n${why}\n\n`}## Scenarios\n\nOne.\n\n---\n\n## Links\n\nNone.\n`;

describe('#5109 structural check: a Rule needs a Why', () => {
  it('no Why section is an ERROR', () => {
    const f = lintSpec(rule(frame(null)));
    expect(f).toEqual([expect.objectContaining({ citation: 'cor:agt:100:03', rule: 'RULE_WHY_MISSING', severity: 'ERROR', sentence: null })]);
  });
  it('an empty or whitespace-only or comment-only Why is an ERROR that points at the heading', () => {
    for (const why of ['', '   \n  ', '<!-- later -->']) {
      const f = lintSpec(rule(frame(why)));
      expect(f).toEqual([expect.objectContaining({ rule: 'RULE_WHY_EMPTY', severity: 'ERROR', line: 9 })]);
    }
  });
  it('a one-line reason passes', () => {
    expect(lintSpec(rule(frame('A budget caps what one App can spend in a day.')))).toEqual([]);
  });
  it('a Why that ends at the divider is read as the section it is', () => {
    expect(lintSpec(rule('# R\n\n## Why We Need This Rule\n\n---\n\nMore.\n'))).toEqual([
      expect.objectContaining({ rule: 'RULE_WHY_EMPTY' }),
    ]);
  });
  it('a non-Rule spec needs no Why', () => {
    expect(lintSpec({ loc: 'cor:agt:100', name: 'Feature: X [cor:agt:100]', role: 'spec.feature', content: '# Feature Spec: X\n\nBody.\n' })).toEqual([]);
  });
  it('a retired Rule is skipped: tagged superseded, or carrying the retirement banner', () => {
    expect(lintSpec(rule(frame(null), { tags: ['superseded'] }))).toEqual([]);
    expect(lintSpec(rule('# R\n\n> **⚠️ Superseded** (2026-11-01). **Do not apply.** Retained as a tombstone; the citation is never renumbered.\n'))).toEqual([]);
  });
  it('a Rule recognised by its name alone (no role) is still checked', () => {
    expect(lintSpec({ loc: 'cor:agt:100:03', name: 'Rule: X [cor:agt:100:03]', content: '# R\n\nBody.\n' })).toEqual([
      expect.objectContaining({ rule: 'RULE_WHY_MISSING' }),
    ]);
  });
});

describe('#5109 sentence check: a restriction needs a reason', () => {
  const spec = (body: string) => ({ loc: 'cor:api:120:03', name: 'Feature: X [cor:api:120:03]', role: 'spec.feature', content: body });
  it('names the sentence, with the citation and a WARNING', () => {
    const f = lintSpec(spec('# Feature Spec: X\n\nOther text here. Per-user agent memories are excluded from the regular memory list.\n'));
    expect(f).toEqual([expect.objectContaining({
      citation: 'cor:api:120:03', rule: 'LIMIT_WITHOUT_REASON', severity: 'WARNING', line: 3,
      sentence: 'Per-user agent memories are excluded from the regular memory list.',
    })]);
  });
  it('a reason in the same paragraph clears it', () => {
    for (const reason of ['because they are noisy', 'so that the list stays short', 'since nobody reads them', 'to prevent a leak']) {
      expect(lintSpec(spec(`# X\n\nX is excluded from the list ${reason}.\n`))).toEqual([]);
    }
    expect(lintSpec(spec('# X\n\nX is excluded from the list. The reason is that nobody reads it, which is why it stays out.\n'))).toEqual([]);
  });
  it('a link to a ruling or a Why section marks it justified elsewhere', () => {
    expect(lintSpec(spec('# X\n\nX is excluded from the list ([[hrn:node:hadronmemory.com:rulings:0185|ruling 0185]]).\n'))).toEqual([]);
    expect(lintSpec(spec('# X\n\nX is excluded from the list. See [the Why](#why-we-need-this-rule).\n'))).toEqual([]);
    expect(lintSpec(spec('# X\n\nX is excluded from the list. See [x](https://example.com/decisions/1).\n'))).toEqual([]);
    // an unrelated link does not
    expect(lintSpec(spec('# X\n\nX is excluded from the list. See [[cor:api:120:01|Other]].\n'))).toHaveLength(1);
  });
  it('a reason in another paragraph or list item does not clear it; each list item is its own paragraph', () => {
    const f = lintSpec(spec('# X\n\n- A is never shown.\n- B exists because C.\n\nA reason elsewhere because D.\n'));
    expect(f.map((x) => x.sentence)).toEqual(['A is never shown.']);
  });
  it('only the text above the divider is read; the Why section, code and tables are not', () => {
    const body = '# X\n\n```\nnever refused\n```\n\n| a | only |\n| - | - |\n\n## Why We Need This Rule\n\nIt is only fine.\n\n## Other\n\nok\n\n---\n\nBelow the line it is never read.\n';
    expect(lintSpec(spec(body))).toEqual([]);
  });
  it('the forms of the restricting words are found', () => {
    for (const w of ['is refused', 'is forbidden', 'must not run', 'is not allowed', 'stays hidden', 'is never sent', 'is only for owners', 'cannot read']) {
      expect(lintSpec(spec(`# X\n\nThe thing ${w}.\n`)), w).toHaveLength(1);
    }
  });
  it('a legacy heading (no frame, no role) is checked by its citation-shaped loc', () => {
    const legacy = { loc: 'cor:api:120:03', name: 'cor:api:120:03 — Lists', content: 'cor:api:120:03 — Lists\n\nHidden from view.\n' };
    expect(isSpecSubject(legacy)).toBe(true);
    expect(lintSpec(legacy)).toEqual([expect.objectContaining({ rule: 'LIMIT_WITHOUT_REASON', sentence: 'Hidden from view.' })]);
  });
  it('a node that is not a spec has no findings, whatever it says', () => {
    expect(lintSpec({ loc: 'notes:todo', name: 'Todo', content: 'Never do this.' })).toEqual([]);
    // A node with no text is an unwritten spec (a placeholder), not a malformed one.
    for (const content of [null, '', '  \n ']) expect(lintSpec({ loc: 'cor:agt:100:03', role: 'spec.rule', content })).toEqual([]);
  });
  it('findings are capped and the sentence is trimmed', () => {
    const many = Array.from({ length: 300 }, (_, i) => `- Item ${i} is never shown.`).join('\n');
    expect(lintSpec(spec(`# X\n\n${many}\n`))).toHaveLength(200);
    const long = lintSpec(spec(`# X\n\nIt is never ${'a'.repeat(500)}.\n`));
    expect(long[0].sentence!.length).toBeLessThanOrEqual(300);
  });
});

describe('#5109 fold: blind P2-1/P2-2, local P2 and P3s', () => {
  const spec = (body: string) => ({ loc: 'cor:api:120:03', name: 'Feature: X [cor:api:120:03]', role: 'spec.feature', content: body });

  it('blind P2-1: a Why heading inside a fenced code block is not a Why section', () => {
    const body = '# Rule Spec: A\n\n## The Rule\n\nIt checks.\n\n```\n## Why We Need This Rule\n\nquoted template\n```\n';
    expect(lintSpec(rule(body))).toEqual([expect.objectContaining({ rule: 'RULE_WHY_MISSING' })]);
    // and a real, empty Why after a fenced one reports the real heading line, not the quoted one
    const both = '# R\n\n```\n## Why We Need This Rule\n```\n\n## Why We Need This Rule\n\n## Scenarios\n';
    expect(lintSpec(rule(both))).toEqual([expect.objectContaining({ rule: 'RULE_WHY_EMPTY', line: 7 })]);
  });

  it('blind P2-2: a ### subheading stays inside the Why section; its text is neither a restriction nor ends the section', () => {
    const body = '# Rule Spec: A\n\n## Why We Need This Rule\n\nWe cap budgets.\n\n### Rationale\n\nOnly the owner may raise the cap, never an agent.\n\n## Scenarios\n\nOne.\n';
    expect(lintSpec(rule(body))).toEqual([]);
    // a Why that holds only a ### subsection is not empty
    expect(lintSpec(rule('# R\n\n## Why We Need This Rule\n\n### Why\n\nBecause.\n'))).toEqual([]);
    // text after the next ## heading is body again
    expect(lintSpec(rule('# R\n\n## Why We Need This Rule\n\nok.\n\n## Scenarios\n\nIt is never sent.\n')).map((f) => f.sentence)).toEqual(['It is never sent.']);
  });

  it('local P2: pathological text is linear (repeated unclosed openers, 400 KB, well under a second)', () => {
    for (const unit of ['](', '[[', '`', '<!--', '](ruling ', '.']) {
      const text = `# Feature Spec: X\n\nIt is never ${unit.repeat(Math.ceil(400_000 / unit.length))}\n`;
      const t0 = performance.now();
      lintSpec(spec(text));
      lintSpec(rule(`# R\n\n## Why We Need This Rule\n\n${unit.repeat(Math.ceil(400_000 / unit.length))}\n`));
      expect(performance.now() - t0, `unit ${JSON.stringify(unit)}`).toBeLessThan(1000);
    }
  });

  it('local P3-3: a temporal "since" is not a reason; a causal one is', () => {
    expect(lintSpec(spec('# X\n\nIt is never sent since 2026-11-01.\n'))).toHaveLength(1);
    expect(lintSpec(spec('# X\n\nIt is never sent since v0.38.0.\n'))).toHaveLength(1);
    expect(lintSpec(spec('# X\n\nIt is never sent since nobody reads it.\n'))).toEqual([]);
  });

  it('blind P3-5: the retirement banner is the one retireSpecText writes, only under the title', () => {
    const body = (form: 'RESCIND' | 'SUPERSEDE', withdrawn: boolean) =>
      `# Rule Spec: A\n\n${retirementBanner({ form, withdrawn, date: '2026-11-01', reason: 'x', successor: null })}\n\nIt is never sent.\n`;
    for (const [form, withdrawn] of [['SUPERSEDE', false], ['RESCIND', false], ['RESCIND', true]] as const) {
      expect(lintSpec(rule(body(form, withdrawn)))).toEqual([]);
    }
    // a banner QUOTED far below the title does not retire the spec
    const far = '# Rule Spec: A\n\n' + 'filler.\n\n'.repeat(20) + '> **⚠️ Superseded** (quoted).\n';
    expect(lintSpec(rule(far)).map((f) => f.rule)).toEqual(['RULE_WHY_MISSING']);
  });

  it('blind P3-4: the human-facing messages are the ones the CLI will show', () => {
    expect(lintSpec(rule('# R\n\nBody.\n'))[0].message).toBe('A Rule spec needs a "## Why We Need This Rule" section.');
    expect(lintSpec(rule('# R\n\n## Why We Need This Rule\n\n## S\n'))[0].message).toBe('The "## Why We Need This Rule" section is empty.');
    expect(lintSpec(spec('# X\n\nIt is never sent.\n'))[0].message).toMatch(/restricts something and gives no reason/);
  });
});
