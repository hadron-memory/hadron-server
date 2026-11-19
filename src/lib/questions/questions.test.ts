/** #1641 — the pure parts of question nodes: codes, codec, renderer and the one evaluation. */
import { describe, expect, it } from 'vitest';
import { GraphQLError } from 'graphql';
import { bijectiveLetters, questionCode, lettersToNumber, parseQuestionCitation, DEFAULT_QUESTION_PREFIX } from './codes.js';
import { askInputSchema, checkQuestion, currentAnswer, everAnswered, QUESTION_CODEC, questionDataSchema, parseOrRefuse, type AnswerEntry, type QuestionData } from './codec.js';
import { canonicalQuestionJson, questionName, extractQuestionBlock, renderQuestion, renderQuestionAbstract } from './render.js';
import { evaluateQuestion, type QuestionNodeRow } from './evaluate.js';
import { computeApprovalHash } from '../approvalHash.js';

const codeOf = (fn: () => unknown) => {
  try { fn(); return 'NO_ERROR'; } catch (e) { return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message; }
};

describe('codes (§4)', () => {
  it('is bijective base-26: 1→A, 26→Z, 27→AA, 702→ZZ, 703→AAA', () => {
    expect([1, 2, 21, 26, 27, 52, 702, 703].map(bijectiveLetters)).toEqual(['A', 'B', 'U', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
    for (let n = 1; n <= 2000; n++) expect(lettersToNumber(bijectiveLetters(n))).toBe(n);
    expect(() => bijectiveLetters(0)).toThrow();
  });

  it('keeps the earlier DA…DU codes by construction, and the default prefix is Q (#4426)', () => {
    expect(questionCode('D', 1)).toBe('DA');
    expect(questionCode('D', 21)).toBe('DU');
    expect(questionCode('D', 26)).toBe('DZ');
    expect(questionCode('D', 27)).toBe('DAA');
    expect(questionCode(DEFAULT_QUESTION_PREFIX, 1)).toBe('QA');
  });

  it('parses citations against a prefix; a part suffix is no longer a citation (#4426)', () => {
    expect(parseQuestionCitation('QA', 'Q')).toEqual({ code: 'QA', n: 1 });
    expect(parseQuestionCitation('DAA', 'D')).toEqual({ code: 'DAA', n: 27 });
    expect(parseQuestionCitation('QA-1', 'Q')).toBeNull();
    expect(parseQuestionCitation('XU', 'D')).toBeNull();
    expect(parseQuestionCitation('D', 'D')).toBeNull();
    expect(parseQuestionCitation('du', 'D')).toBeNull();
  });
});

const actor = { userId: 'u1', workerId: 'w1', appId: null };

const OPTIONS = [
  { key: 'yes', label: 'Yes', whyChoose: 'it is ready', whyNot: null, risks: null },
  { key: 'no', label: 'No', whyChoose: null, whyNot: 'delays us', risks: 'a week lost' },
];

function question(overrides: Partial<QuestionData> = {}): QuestionData {
  return questionDataSchema.parse({
    codec: QUESTION_CODEC, renderer: 'question-md/1', kind: 'question', logId: 'log1', code: 'QA', n: 1,
    title: 'Ship it?', background: 'Background', whyNow: 'Friday', priority: 'normal', tier: 'answered',
    authorizes: false, grant: null, deciders: ['holger', 'ada'], assignee: null, askedBy: actor,
    askedAt: '2026-10-06T20:00:00.000Z', neededBy: null, defaultAction: null, taskId: null,
    blocks: [{ ref: 'hadron-server#1641' }], sources: [{ ref: 'team:7326' }],
    specsTouched: [{ spec: 'cor:dmo:140' }], specsMustChange: [{ spec: 'cor:dmo:140:07' }],
    options: OPTIONS,
    recommendation: { key: 'yes', by: actor, reason: 'ready' }, noRecommendation: null,
    answers: [], status: 'open', withdrawn: null,
    ...overrides,
  });
}

const entry = (over: Partial<AnswerEntry> = {}): AnswerEntry => ({
  kind: 'answer', key: 'yes', text: null, reason: null, by: 'holger', at: '2026-10-06T21:00:00.000Z', via: 'portal', ...over,
});
const retraction = (over: Partial<AnswerEntry> = {}): AnswerEntry => entry({ kind: 'retraction', key: null, text: null, at: '2026-10-06T22:00:00.000Z', ...over });
const answered = (over: Partial<QuestionData> = {}) => question({ answers: [entry()], status: 'answered', ...over });

/** A node row exactly as a door writes it, optionally approved at its current revision by `approvedBy`. */
function rowOf(d: QuestionData, opts: { revSeq?: number; approvedRevNo?: number | null; approvedBy?: string | null } = {}): QuestionNodeRow {
  const name = questionName(d);
  const abstract = renderQuestionAbstract(d);
  const content = renderQuestion(d);
  const revSeq = opts.revSeq ?? 1;
  const approvedRevNo = opts.approvedRevNo === undefined ? null : opts.approvedRevNo;
  return {
    id: 'n1', memoryId: 'm1', loc: `questions:${d.code}`, name, abstract, content, isPlaceholder: false, revSeq, contentRevSeq: revSeq,
    approvedRevNo, approvedBy: approvedRevNo == null ? null : opts.approvedBy ?? 'holger', approvedByInfo: null,
    approvedAt: approvedRevNo == null ? null : new Date(),
    approvalHash: approvedRevNo == null ? null : computeApprovalHash({ title: name, abstract, content }),
    data: JSON.parse(JSON.stringify(d)),
  };
}

describe('answer helpers (#4426 §1)', () => {
  it('currentAnswer is the last entry when it is an answer; everAnswered ignores a later retraction', () => {
    expect(currentAnswer({ answers: [] })).toBeNull();
    expect(everAnswered({ answers: [] })).toBe(false);
    expect(currentAnswer({ answers: [entry()] })?.key).toBe('yes');
    expect(currentAnswer({ answers: [entry(), retraction()] })).toBeNull();
    expect(everAnswered({ answers: [entry(), retraction()] })).toBe(true);
    expect(currentAnswer({ answers: [entry(), retraction(), entry({ key: 'no' })] })?.key).toBe('no');
    expect(everAnswered({ answers: [retraction()] })).toBe(false);
  });
});

describe('codec (§5.1)', () => {
  it('refuses with JSON pointers', () => {
    try {
      parseOrRefuse(askInputSchema, { title: 'two\nlines', options: [{ key: '!', label: 'x' }] });
      throw new Error('accepted');
    } catch (e) {
      expect((e as GraphQLError).extensions.code).toBe('QUESTION_INVALID');
      const pointers = ((e as GraphQLError).extensions.pointers as Array<{ pointer: string }>).map((p) => p.pointer);
      expect(pointers).toEqual(expect.arrayContaining(['/title', '/options/0/key']));
    }
  });

  it('refuses unknown keys, so a client cannot supply an authenticated actor, and "parts" is no key (acceptance 1)', () => {
    expect(codeOf(() => parseOrRefuse(askInputSchema, { title: 't', askedBy: actor }))).toBe('QUESTION_INVALID');
    expect(codeOf(() => parseOrRefuse(askInputSchema, { title: 't', parts: [{ question: 'q' }] }))).toBe('QUESTION_INVALID');
    expect(codeOf(() => parseOrRefuse(askInputSchema, { title: 't', taskId: 'x' }))).toBe('QUESTION_INVALID');
  });

  it('with options: exactly one of recommendation and noRecommendation, naming an option (acceptance 3)', () => {
    const base = question();
    expect(codeOf(() => checkQuestion(base))).toBe('NO_ERROR');
    expect(codeOf(() => checkQuestion({ ...base, recommendation: null }))).toBe('QUESTION_RECOMMENDATION_MISSING');
    expect(codeOf(() => checkQuestion({ ...base, recommendation: { ...base.recommendation!, key: 'maybe' } }))).toBe('QUESTION_INVALID');
    expect(codeOf(() => checkQuestion({ ...base, noRecommendation: { reason: 'r' } }))).toBe('QUESTION_INVALID');
    expect(codeOf(() => checkQuestion({ ...base, options: [...base.options, base.options[0]] }))).toBe('QUESTION_INVALID');
    expect(codeOf(() => checkQuestion({ ...base, recommendation: null, noRecommendation: { reason: 'deliberately none' } }))).toBe('NO_ERROR');
  });

  it('a free-text question holds no recommendation of either kind', () => {
    const free = { ...question(), options: [], recommendation: null, noRecommendation: null };
    expect(codeOf(() => checkQuestion(free))).toBe('NO_ERROR');
    expect(codeOf(() => checkQuestion({ ...free, recommendation: question().recommendation }))).toBe('QUESTION_INVALID');
    expect(codeOf(() => checkQuestion({ ...free, noRecommendation: { reason: 'r' } }))).toBe('QUESTION_INVALID');
  });

  it('defaultAction needs neededBy; the assignee must be a decider; authorizes needs the signed tier; grant needs authorizes', () => {
    expect(codeOf(() => checkQuestion(question({ defaultAction: 'ship' })))).toBe('QUESTION_INVALID');
    expect(codeOf(() => checkQuestion(question({ defaultAction: 'ship', neededBy: '2026-10-09T00:00:00.000Z' })))).toBe('NO_ERROR');
    expect(codeOf(() => checkQuestion(question({ assignee: 'holger' })))).toBe('NO_ERROR');
    expect(codeOf(() => checkQuestion(question({ assignee: 'mallory' })))).toBe('QUESTION_ASSIGNEE_NOT_DECIDER');
    expect(codeOf(() => checkQuestion(question({ authorizes: true, tier: 'answered' })))).toBe('QUESTION_TIER_TOO_LOW');
    expect(codeOf(() => checkQuestion(question({ authorizes: true, tier: 'approved' })))).toBe('QUESTION_TIER_TOO_LOW');
    expect(codeOf(() => checkQuestion(question({ authorizes: true, tier: 'signed' })))).toBe('NO_ERROR');
    expect(codeOf(() => checkQuestion(question({ grant: { who: 'x' } })))).toBe('QUESTION_INVALID');
  });

  it('every answer entry is well formed and names an existing option', () => {
    expect(codeOf(() => checkQuestion(question({ answers: [entry({ key: 'maybe' })] })))).toBe('QUESTION_INVALID');
    expect(codeOf(() => checkQuestion(question({ answers: [entry({ key: null, text: '  ' })] })))).toBe('QUESTION_INVALID');
    expect(codeOf(() => checkQuestion(question({ answers: [entry({ key: null, text: 'free' })] })))).toBe('NO_ERROR');
    expect(codeOf(() => checkQuestion(question({ answers: [entry(), retraction({ key: 'yes' })] })))).toBe('QUESTION_INVALID');
    expect(codeOf(() => checkQuestion(question({ answers: [entry(), retraction({ text: 'no' })] })))).toBe('QUESTION_INVALID');
    expect(codeOf(() => checkQuestion(question({ answers: [entry(), retraction()] })))).toBe('NO_ERROR');
  });

  it('normalizes line endings so stored text renders and hashes one way', () => {
    const parsed = parseOrRefuse(askInputSchema, { title: 't', background: 'a\r\nb\rc' });
    expect(parsed.background).toBe('a\nb\nc');
  });
});

describe('renderer (§5.2, §5.5)', () => {
  it('is deterministic, carries its version, and ends in the lossless semantic block', () => {
    const d = question();
    const content = renderQuestion(d);
    expect(renderQuestion(question())).toBe(content);
    expect(content).toContain('# QA: Ship it?');
    expect(content).toContain('**Recommendation:** yes (by worker w1 (user u1)). ready');
    expect(content).toContain('Rendered by question-md/1.');
    expect(content).toContain('```hadron-question\n');
    expect(extractQuestionBlock(content)).toEqual(JSON.parse(canonicalQuestionJson(d)));
    expect(renderQuestionAbstract(d)).toBe('Question QA (open, normal, answered tier): Ship it?');
    expect(questionName(d)).toBe('QA: Ship it?');
  });

  it('lays the sections out in the fixed order (acceptance 2)', () => {
    const d = question({ neededBy: '2026-10-09T00:00:00.000Z', defaultAction: 'ship it', assignee: 'ada' });
    const content = renderQuestion(d);
    const order = ['# QA:', '**Assignee:** user ada', '**Needed by:** 2026-10-09T00:00:00.000Z. If unanswered: ship it', '## Explanation', '**Why now:**',
      '## What this question is blocking', '## Specs', '- Touches:', '- Must change once answered:', '## Sources', '## Options',
      '  - Why choose: it is ready', '  - Why not: delays us', '  - Risks: a week lost', '**Recommendation:**', '## Answer', '**Answer:** not yet answered.'];
    let at = -1;
    for (const marker of order) {
      const i = content.indexOf(marker, at + 1);
      expect(i, marker).toBeGreaterThan(at);
      at = i;
    }
    expect(content).not.toContain('## Grants');
    expect(renderQuestion(question({ authorizes: true, tier: 'signed' }))).toContain('## Grants');
  });

  it('leaves out an empty section, except Options and Answer', () => {
    const bare = renderQuestion(question({ background: null, whyNow: null, blocks: [], sources: [], specsTouched: [], specsMustChange: [] }));
    for (const gone of ['## Explanation', '## What this question is blocking', '## Specs', '## Sources', '**Assignee:**', '**Needed by:**', '### Earlier entries']) {
      expect(bare).not.toContain(gone);
    }
    expect(bare).toContain('## Options');
    expect(bare).toContain('## Answer');
    expect(renderQuestion({ ...question(), options: [], recommendation: null, noRecommendation: null })).toContain('*Free-text answer.*');
  });

  it('shows the standing answer, and every other entry under Earlier entries, oldest first', () => {
    const d = question({ answers: [entry({ key: 'no', reason: 'wait' }), retraction({ reason: 'oops' }), entry({ key: 'yes', text: 'go' })] });
    const content = renderQuestion(d);
    expect(content).toContain('**Answer:** **yes**: go (by user holger, 2026-10-06T21:00:00.000Z, via portal).');
    const earlier = content.slice(content.indexOf('### Earlier entries'));
    expect(earlier.indexOf('1. Answered **no**')).toBeGreaterThan(-1);
    expect(earlier.indexOf('2. Taken back')).toBeGreaterThan(earlier.indexOf('1. Answered'));
    const taken = renderQuestion(question({ answers: [entry(), retraction()] }));
    expect(taken).toContain('**Answer:** not yet answered.');
    expect(taken).toContain('1. Answered **yes**');
    expect(taken).toContain('2. Taken back');
  });

  it('every authority-bearing field changes the rendered (hashed) text', () => {
    const base = renderQuestion(question());
    const o = OPTIONS;
    const variants: Array<Partial<QuestionData>> = [
      { title: 'Ship it now?' }, { background: 'Other' }, { background: null }, { whyNow: 'Monday' }, { priority: 'urgent' }, { priority: 'low' },
      { tier: 'signed' }, { tier: 'approved' }, { authorizes: true, tier: 'signed' }, { grant: { who: 'x' } }, { deciders: ['someone'] },
      { assignee: 'ada' }, { askedBy: { ...actor, workerId: 'w2' } }, { askedAt: '2026-10-07T20:00:00.000Z' },
      { neededBy: '2026-10-09T00:00:00.000Z' }, { neededBy: '2026-10-09T00:00:00.000Z', defaultAction: 'ship' },
      { blocks: [] }, { sources: [] }, { specsTouched: [] }, { specsMustChange: [] },
      { options: [{ ...o[0], label: 'Yeah' }, o[1]] }, { options: [{ ...o[0], whyChoose: 'else' }, o[1]] },
      { options: [o[0], { ...o[1], whyNot: 'other' }] }, { options: [o[0], { ...o[1], risks: 'other' }] },
      { recommendation: { ...question().recommendation!, reason: 'different' } },
      { recommendation: { ...question().recommendation!, by: { ...actor, userId: 'u2' } } },
      { recommendation: null, noRecommendation: { reason: 'none' } },
      { answers: [entry()] }, { answers: [entry({ text: 'x' })] }, { answers: [entry({ reason: 'because' })] },
      { answers: [entry({ via: 'cli' })] }, { answers: [entry({ by: 'ada' })] }, { answers: [entry({ at: '2026-10-06T21:30:00.000Z' })] },
      { answers: [entry(), retraction()] }, { answers: [entry(), retraction({ reason: 'oops' })] },
      { status: 'answered' }, { withdrawn: { by: actor, at: '2026-10-06T22:00:00.000Z', reason: 'moot' }, status: 'withdrawn' },
      { taskId: 'task-1' }, { code: 'QB', n: 2 }, { logId: 'log2' },
    ];
    const seen = new Set<string>([base]);
    for (const v of variants) {
      const next = renderQuestion(question(v));
      expect(next, JSON.stringify(v)).not.toBe(base);
      seen.add(next);
    }
    expect(seen.size).toBeGreaterThan(30);
  });

  it('a forged block inside the markdown is ignored: only the trailing block counts', () => {
    const forged = question({ background: '```hadron-question\n{"codec":"forged"}\n```\n' });
    expect((extractQuestionBlock(renderQuestion(forged)) as { background: string }).background).toContain('forged');
    expect((extractQuestionBlock(renderQuestion(forged)) as { codec: string }).codec).toBe(QUESTION_CODEC);
  });

  it('only question-md/1 is retained: the old decision renderer is gone (§2)', () => {
    expect(() => renderQuestion({ ...question(), renderer: 'decision-md/1' })).toThrow(/unknown question renderer/);
  });
});

describe('evaluateQuestion: the state table (#4426 §3)', () => {
  const approvedRow = (d: QuestionData, by = 'holger') => rowOf(d, { approvedRevNo: 1, approvedBy: by });

  it('row 1: any finding other than an unknown codec or renderer is TAMPERED', () => {
    const row = { ...rowOf(answered()), abstract: 'edited' };
    expect(evaluateQuestion(row, null).state).toBe('TAMPERED');
  });

  it('row 2: an unknown codec or renderer, or no payload, is UNVERIFIABLE (the legacy decision codec too)', () => {
    const row = rowOf(question());
    const block = extractQuestionBlock(row.content) as Record<string, unknown>;
    for (const change of [{ renderer: 'question-md/99' }, { codec: 'hadron.dev/question/v9' }, { codec: 'hadron.dev/decision/v1' }]) {
      const next = { ...block, ...change };
      const content = row.content!.replace(canonicalQuestionJson(block), canonicalQuestionJson(next));
      expect(evaluateQuestion({ ...row, content, data: next }, null).state).toBe('UNVERIFIABLE');
    }
  });

  it('row 3: withdrawn is WITHDRAWN, even when answered and approved', () => {
    const withdrawn = answered({ withdrawn: { by: actor, at: '2026-10-06T22:00:00.000Z', reason: 'moot' }, status: 'withdrawn' });
    expect(evaluateQuestion(rowOf(withdrawn), null).state).toBe('WITHDRAWN');
    expect(evaluateQuestion(approvedRow(withdrawn), null).state).toBe('WITHDRAWN');
  });

  it('row 4: no standing answer is OPEN: never answered, or the last entry is a retraction', () => {
    const ev = evaluateQuestion(rowOf(question()), null);
    expect(ev).toMatchObject({ state: 'OPEN', answered: false });
    const taken = question({ answers: [entry(), retraction()] });
    expect(evaluateQuestion(rowOf(taken), null)).toMatchObject({ state: 'OPEN', answered: false });
    // even when an earlier revision carries a decider's approval, and for every tier
    for (const tier of ['answered', 'approved', 'signed'] as const) {
      expect(evaluateQuestion(approvedRow(question({ tier, answers: [entry(), retraction()] })), null).state).toBe('OPEN');
    }
  });

  it('row 5: tier answered is DECIDED by the answer alone, with no approval at all', () => {
    expect(evaluateQuestion(rowOf(answered()), null)).toMatchObject({ state: 'DECIDED', answered: true });
    expect(evaluateQuestion(rowOf(question({ answers: [entry(), retraction(), entry({ key: 'no' })] })), null).state).toBe('DECIDED');
  });

  it('row 6: tier approved, approved by a decider, intact is DECIDED', () => {
    expect(evaluateQuestion(approvedRow(answered({ tier: 'approved' })), null).state).toBe('DECIDED');
  });

  it('row 7: tier approved, approved by a decider, superseded by a later edit is STALE', () => {
    expect(evaluateQuestion(rowOf(answered({ tier: 'approved' }), { revSeq: 2, approvedRevNo: 1 }), null).state).toBe('STALE');
  });

  it('row 8: approved without a decider\'s approval, and the signed tier, are ANSWERED_UNCONFIRMED', () => {
    expect(evaluateQuestion(rowOf(answered({ tier: 'approved' })), null).state).toBe('ANSWERED_UNCONFIRMED');
    // A non-decider's approval is no evidence.
    expect(evaluateQuestion(approvedRow(answered({ tier: 'approved' }), 'mallory'), null).state).toBe('ANSWERED_UNCONFIRMED');
    // Signature evidence does not exist yet (#1614 S2b): an approval never makes the signed tier DECIDED (Q11).
    expect(evaluateQuestion(approvedRow(answered({ tier: 'signed', authorizes: true })), null).state).toBe('ANSWERED_UNCONFIRMED');
  });

  it('#1715: an approval by the account a decider was merged into is a decider\'s; by anyone else it is not', () => {
    const d = answered({ tier: 'approved' });
    const decider = d.deciders[0];
    // The merge rewrote approvedBy to the survivor; the stored deciders still name the merged-away id.
    const approvedBySurvivor = approvedRow(d, 'survivor');
    expect(evaluateQuestion(approvedBySurvivor, null).state).toBe('ANSWERED_UNCONFIRMED');
    expect(evaluateQuestion(approvedBySurvivor, null, new Set(['survivor', decider])).state).toBe('DECIDED');
    expect(evaluateQuestion(approvedBySurvivor, null, new Set(['survivor', 'someone-else'])).state).toBe('ANSWERED_UNCONFIRMED');
  });

  it('SUPERSEDED is not a state any more', () => {
    const states: string[] = [];
    for (const d of [question(), answered(), answered({ tier: 'approved' }), answered({ withdrawn: { by: actor, at: 'x', reason: 'r' } })]) {
      states.push(evaluateQuestion(rowOf(d), null).state);
    }
    expect(states).not.toContain('SUPERSEDED');
  });
});

describe('evaluateQuestion: integrity (§5.5)', () => {
  it('TAMPERED for each independent edit with revSeq unchanged: data only, markdown only, block only, title, abstract', () => {
    const d = answered({ tier: 'approved' });
    const ok = rowOf(d, { approvedRevNo: 1 });
    const block = extractQuestionBlock(ok.content)!;
    const dataOnly = { ...ok, data: { ...(ok.data as object), title: 'Changed' } };
    const markdownOnly = { ...ok, content: ok.content!.replace('Ship it?', 'Ship it now?') };
    const blockOnly = { ...ok, content: ok.content!.replace(canonicalQuestionJson(block), canonicalQuestionJson({ ...(block as object), priority: 'urgent' })) };
    const titleOnly = { ...ok, name: 'QA: Something else' };
    const abstractOnly = { ...ok, abstract: 'edited' };
    for (const row of [dataOnly, markdownOnly, blockOnly, titleOnly, abstractOnly]) {
      expect(evaluateQuestion(row, null).state).toBe('TAMPERED');
    }
    // The same edits on a question nobody approved yet: the render and data
    // checks alone must catch each one (the approval hash cannot).
    const fresh = rowOf(question());
    const freshBlock = extractQuestionBlock(fresh.content)!;
    const unapproved: Array<[QuestionNodeRow, string]> = [
      [{ ...fresh, data: { ...(fresh.data as object), title: 'Changed' } }, 'DATA_MISMATCH'],
      [{ ...fresh, content: fresh.content!.replace('Ship it?', 'Ship it now?') }, 'RENDER_MISMATCH'],
      [{ ...fresh, content: fresh.content!.replace(canonicalQuestionJson(freshBlock), canonicalQuestionJson({ ...(freshBlock as object), priority: 'urgent' })) }, 'DATA_MISMATCH'],
      [{ ...fresh, name: 'QA: Something else' }, 'RENDER_MISMATCH'],
      [{ ...fresh, abstract: 'edited' }, 'RENDER_MISMATCH'],
    ];
    for (const [row, finding] of unapproved) {
      expect(evaluateQuestion(row, null)).toMatchObject({ state: 'TAMPERED', findings: expect.arrayContaining([finding]) });
    }
    // All three changed consistently but outside a revision: the approval hash catches it.
    const all = question({ ...d, title: 'Changed' });
    const consistent = { ...rowOf(all), approvedRevNo: 1, approvedBy: 'holger', approvedAt: new Date(), approvalHash: ok.approvalHash };
    expect(evaluateQuestion(consistent, null)).toMatchObject({ state: 'TAMPERED', findings: ['APPROVAL_HASH_MISMATCH'] });
  });

  it('UNVERIFIABLE for an unknown renderer or codec, never TAMPERED (fail closed)', () => {
    const row = rowOf(question());
    const block = extractQuestionBlock(row.content) as Record<string, unknown>;
    for (const change of [{ renderer: 'question-md/99' }, { codec: 'hadron.dev/question/v9' }]) {
      const next = { ...block, ...change };
      const content = row.content!.replace(canonicalQuestionJson(block), canonicalQuestionJson(next));
      expect(evaluateQuestion({ ...row, content, data: next }, null).state).toBe('UNVERIFIABLE');
    }
  });

  it('precedence: corrupt evidence beats a terminal hint; a withdrawal beats an answer', () => {
    const withdrawn = question({ withdrawn: { by: actor, at: '2026-10-06T22:00:00.000Z', reason: 'moot' }, status: 'withdrawn' });
    expect(evaluateQuestion(rowOf(withdrawn), null).state).toBe('WITHDRAWN');
    expect(evaluateQuestion({ ...rowOf(withdrawn), abstract: 'x' }, null).state).toBe('TAMPERED');
  });

  it('a row with no block at all is TAMPERED', () => {
    expect(evaluateQuestion({ ...rowOf(question()), content: 'plain text' }, null)).toMatchObject({ state: 'TAMPERED', findings: expect.arrayContaining(['NO_BLOCK']) });
  });
});
