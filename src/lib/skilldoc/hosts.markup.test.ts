/**
 * #1341 — the description rule Cowork's upload validator applies, pinned to the
 * 20 cases of Holger's probe upload (2026-09-25): every refused case fires
 * `skill-description-markup` for Claude, every accepted one does not, and Codex
 * (whose loader has no such check) never fires it.
 *
 * The strings are the probe's EXACTLY as uploaded (the synthetic
 * `eli-tagprobe.zip`, #1341 measurement step 2), keyed by its skill names, and
 * are the same table hadron-cli#722's Go mirror pins. The measurement itself is
 * on #1341 (issuecomment-5834495585).
 */
import { describe, it, expect } from 'vitest';
import { lintNode, type Finding, type SkillNode } from './lint.js';
import { HOST_CLAUDE_SKILL, HOST_CODEX_SKILL, skillHost } from './hosts.js';

const PROBE_REFUSED: Record<string, string> = {
  'p02-placeholder': 'Use when adding a node to <memory>.',
  'p03-capital-tag': 'Use when working as <Name>.',
  'p04-hyphen-tag': 'Use when given a <memory-urn>.',
  'p07-lt-and-gt-spaced': 'Use when 1 < 2 and 3 > 2.',
  'p08-closing-tag': 'Use when the block ends with </end>.',
  'p09-self-closing': 'Use when a <br/> appears.',
  'p12-shift': 'Use when shifting x << 2 or y >> 1.',
  'p14-digit-tag': 'Use when step <1> is next.',
  'p15-two-words': 'Use when <two words> appear.',
  'p16-email': 'Use when mailing <user@example.com>.',
  'p17-html-comment': 'Use when a <!-- note --> appears.',
  'p19-url': 'Use when linking <https://example.com>.',
};

const PROBE_ACCEPTED: Record<string, string> = {
  'p01-clean-control': 'Does a thing. Use when you need it.',
  'p05-lone-lt': 'Use when a < b.',
  'p06-lone-gt': 'Use when b > a.',
  'p10-arrows': 'Use when mapping a -> b or x => y.',
  'p11-heart': 'Use when you <3 it.',
  'p13-entities': 'Use when text shows &lt;memory&gt; escaped.',
  'p18-empty-brackets': 'Use when <> appears.',
  'p20-lt-letter': 'Use when a<b holds.',
};

const descNode = (description: string): SkillNode => {
  const decl = { name: 'probe', description, enable: true };
  return {
    urn: 'hrn:node:example.com:demo:tasks:probe',
    loc: 'tasks:probe',
    memoryUrn: 'hrn:mem:example.com:demo',
    isRunnable: true,
    content: '# Body',
    properties: { exports: { claudeSkill: decl, codexSkill: decl } },
  };
};

const markup = (description: string, host: string): Finding | undefined =>
  lintNode(descNode(description), host).find((f) => f.rule === 'skill-description-markup');

describe('#1341 — skill-description-markup matches the Cowork probe', () => {
  it('the probe had 12 refused and 8 accepted cases', () => {
    expect([Object.keys(PROBE_REFUSED).length, Object.keys(PROBE_ACCEPTED).length]).toEqual([12, 8]);
  });

  it.each(Object.entries(PROBE_REFUSED))('%s: Cowork refused it, so claudeSkill fires', (_name, desc) => {
    expect(markup(desc, HOST_CLAUDE_SKILL)?.severity).toBe('error');
  });

  it.each(Object.entries(PROBE_ACCEPTED))('%s: Cowork accepted it, so claudeSkill does not fire', (_name, desc) => {
    expect(markup(desc, HOST_CLAUDE_SKILL)).toBeUndefined();
  });
});

describe('#1341 — the rule is the Claude host\'s, not a global ban', () => {
  it('the registry: Claude rejects description markup; Codex does not', () => {
    expect(skillHost(HOST_CLAUDE_SKILL)?.rejectsDescriptionMarkup).toBe(true);
    expect(skillHost(HOST_CODEX_SKILL)?.rejectsDescriptionMarkup).toBe(false);
  });

  it.each(Object.entries(PROBE_REFUSED))('%s: codexSkill never fires', (_name, desc) => {
    expect(markup(desc, HOST_CODEX_SKILL)).toBeUndefined();
  });
});

describe('#1341 — the finding', () => {
  it('is an error quoting the offending span Go-style and naming the host, word for word with hadron-cli#722', () => {
    expect(markup('Use when adding a node to <memory>.', HOST_CLAUDE_SKILL)).toMatchObject({
      severity: 'error',
      message:
        'description contains "<memory>", which claudeSkill\'s upload validator refuses as an XML tag (a "<" followed later by a ">", with at least one character between) — reword it in plain words, e.g. "a memory" for "<memory>"',
    });
  });

  it('quotes the LEFTMOST span, from the first "<" that has a later ">"', () => {
    expect(markup('Use when shifting x << 2 or y >> 1.', HOST_CLAUDE_SKILL)?.message).toContain('"<< 2 or y >"');
    expect(markup('Use when <a> then <b>.', HOST_CLAUDE_SKILL)?.message).toContain('"<a>"');
  });

  it('escapes the quoted span the way Go\'s %q does (an author-controlled value)', () => {
    expect(markup('Use when <say "hi"> fires.', HOST_CLAUDE_SKILL)?.message).toContain('"<say \\"hi\\">"');
  });

  it('is reported BESIDE the length rule, so fixing one does not reveal the other on the next run', () => {
    const rules = lintNode(descNode(`Use when <memory> ${'x'.repeat(1024)}`), HOST_CLAUDE_SKILL).map((f) => `${f.rule}:${f.severity}`);
    expect(rules).toEqual(expect.arrayContaining(['skill-description-markup:error', 'skill-description-too-long:error']));
  });

  it('an empty description reports only the missing description', () => {
    expect(markup('', HOST_CLAUDE_SKILL)).toBeUndefined();
  });
});

// UNMEASURED, and pinned on purpose. Two predicates fit all 20 probe cases:
// `<[^>]+>` and the narrower `<[^<>]+>`. They differ only on a nested `<<>`,
// which the probe did not include. This encodes the broader one, so `<<>` is
// refused; if Cowork is ever measured to accept it, this test is the one to
// change, together with DESCRIPTION_MARKUP_RE (and the Go mirror).
describe('#1341 — the unmeasured nested case', () => {
  it('the broader predicate refuses a nested `<<>` (conservative)', () => {
    expect(markup('Use when a <<> appears.', HOST_CLAUDE_SKILL)?.message).toContain('"<<>"');
  });
});
