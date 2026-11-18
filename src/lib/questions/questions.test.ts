/** #1641 — the pure parts of decision nodes: codes, codec, renderer and the one evaluation. */
import { describe, expect, it } from 'vitest';
import { GraphQLError } from 'graphql';
import { bijectiveLetters, decisionCode, lettersToNumber, parseDecisionCitation } from './codes.js';
import { askInputSchema, checkPart, DECISION_CODEC, decisionDataSchema, parseOrRefuse, type DecisionData } from './codec.js';
import { canonicalDecisionJson, decisionName, extractDecisionBlock, renderDecision, renderDecisionAbstract } from './render.js';
import { evaluateDecision, type DecisionNodeRow } from './evaluate.js';
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

  it('preserves the prototype inbox codes DA…DU, then DV, and extends past DZ', () => {
    expect(decisionCode('D', 1)).toBe('DA');
    expect(decisionCode('D', 21)).toBe('DU');
    expect(decisionCode('D', 22)).toBe('DV');
    expect(decisionCode('D', 26)).toBe('DZ');
    expect(decisionCode('D', 27)).toBe('DAA');
  });

  it('parses citations against a prefix', () => {
    expect(parseDecisionCitation('DU-1', 'D')).toEqual({ code: 'DU', n: 21, part: 1 });
    expect(parseDecisionCitation('DAA', 'D')).toEqual({ code: 'DAA', n: 27, part: null });
    expect(parseDecisionCitation('XU', 'D')).toBeNull();
    expect(parseDecisionCitation('D', 'D')).toBeNull();
    expect(parseDecisionCitation('du', 'D')).toBeNull();
  });
});

const actor = { userId: 'u1', workerId: 'w1', appId: null };

function decision(overrides: Partial<DecisionData> = {}): DecisionData {
  return decisionDataSchema.parse({
    codec: DECISION_CODEC, renderer: 'decision-md/1', kind: 'decision', logId: 'log1', code: 'DA', n: 1,
    title: 'Ship it?', urgency: 'normal', tier: 'approved', authorizes: false, grant: null, archival: false,
    deciders: ['holger'], askedBy: actor, askedAt: '2026-10-06T20:00:00.000Z', context: 'Background',
    blocks: [{ ref: 'hadron-server#1641' }], sources: [{ ref: 'team:7326' }], followUps: [{ spec: 'cor:dmo:140' }],
    parts: [{
      n: 1, question: 'Ship?',
      options: [{ key: 'yes', label: 'Yes', meaning: null, cost: null }, { key: 'no', label: 'No', meaning: 'wait', cost: 'a week' }],
      recommendation: { key: 'yes', by: actor, reason: 'ready', attributedTo: null }, noRecommendation: null,
      answer: null, answerHistory: [],
    }],
    status: 'open', withdrawn: null, supersedes: null, supersededBy: null,
    ...overrides,
  });
}

const answer = { key: 'yes', text: null, freeform: false, by: 'holger', at: '2026-10-06T21:00:00.000Z', via: 'portal' as const, source: null, reason: null, claimedBy: null, recordedBy: null };

/** A node row exactly as a door writes it, optionally approved at its current revision by `approvedBy`. */
function rowOf(d: DecisionData, opts: { revSeq?: number; approvedRevNo?: number | null; approvedBy?: string | null } = {}): DecisionNodeRow {
  const name = decisionName(d);
  const abstract = renderDecisionAbstract(d);
  const content = renderDecision(d);
  const revSeq = opts.revSeq ?? 1;
  const approvedRevNo = opts.approvedRevNo === undefined ? null : opts.approvedRevNo;
  return {
    id: 'n1', memoryId: 'm1', loc: `decisions:${d.code}`, name, abstract, content, isPlaceholder: false, revSeq, contentRevSeq: revSeq,
    approvedRevNo, approvedBy: approvedRevNo == null ? null : opts.approvedBy ?? 'holger', approvedByInfo: null,
    approvedAt: approvedRevNo == null ? null : new Date(),
    approvalHash: approvedRevNo == null ? null : computeApprovalHash({ title: name, abstract, content }),
    data: JSON.parse(JSON.stringify(d)),
  };
}

describe('codec (§5.1)', () => {
  it('refuses with JSON pointers', () => {
    try {
      parseOrRefuse(askInputSchema, { title: 'two\nlines', parts: [{ question: '  ' }] });
      throw new Error('accepted');
    } catch (e) {
      expect((e as GraphQLError).extensions.code).toBe('DECISION_INVALID');
      const pointers = ((e as GraphQLError).extensions.pointers as Array<{ pointer: string }>).map((p) => p.pointer);
      expect(pointers).toEqual(expect.arrayContaining(['/title', '/parts/0/question']));
    }
  });

  it('refuses unknown keys, so a client cannot supply an authenticated actor', () => {
    expect(codeOf(() => parseOrRefuse(askInputSchema, { title: 't', parts: [{ question: 'q' }], askedBy: actor }))).toBe('DECISION_INVALID');
  });

  it('a part needs a recommendation naming an option, or a stated noRecommendation (never both)', () => {
    const base = decision().parts[0];
    expect(codeOf(() => checkPart({ ...base, recommendation: null }, '/parts/0'))).toBe('DECISION_RECOMMENDATION_MISSING');
    expect(codeOf(() => checkPart({ ...base, recommendation: { ...base.recommendation!, key: 'maybe' } }, '/parts/0'))).toBe('DECISION_INVALID');
    expect(codeOf(() => checkPart({ ...base, noRecommendation: { reason: 'r' } }, '/parts/0'))).toBe('DECISION_INVALID');
    expect(codeOf(() => checkPart({ ...base, options: [...base.options, base.options[0]] }, '/parts/0'))).toBe('DECISION_INVALID');
    expect(codeOf(() => checkPart({ ...base, recommendation: null, noRecommendation: { reason: 'deliberately none' } }, '/parts/0'))).toBe('NO_ERROR');
  });

  it('normalizes line endings so stored text renders and hashes one way', () => {
    const parsed = parseOrRefuse(askInputSchema, { title: 't', context: 'a\r\nb\rc', parts: [{ question: 'q' }] });
    expect(parsed.context).toBe('a\nb\nc');
  });
});

describe('renderer (§5.2, §5.5)', () => {
  it('is deterministic, carries its version, and ends in the lossless semantic block', () => {
    const d = decision();
    const content = renderDecision(d);
    expect(renderDecision(decision())).toBe(content);
    expect(content).toContain('# DA: Ship it?');
    expect(content).toContain('## DA-1: Ship?');
    expect(content).toContain('**Recommendation:** yes (by worker w1 (user u1)). ready');
    expect(content).toContain('Rendered by decision-md/1.');
    expect(extractDecisionBlock(content)).toEqual(JSON.parse(canonicalDecisionJson(d)));
  });

  it('every authority-bearing field changes the rendered (hashed) text', () => {
    const base = renderDecision(decision());
    const variants: Array<Partial<DecisionData>> = [
      { tier: 'signed' }, { authorizes: true, tier: 'signed' }, { deciders: ['someone'] }, { urgency: 'urgent' },
      { blocks: [] }, { sources: [] }, { followUps: [] }, { archival: true }, { grant: { who: 'x' } },
      { askedBy: { ...actor, workerId: 'w2' } }, { supersedes: { nodeId: 'n0', code: 'D0' } },
      { parts: [{ ...decision().parts[0], answer }] },
      { parts: [{ ...decision().parts[0], options: [{ key: 'yes', label: 'Yes', meaning: null, cost: 'free' }, decision().parts[0].options[1]] }] },
      { parts: [{ ...decision().parts[0], recommendation: { ...decision().parts[0].recommendation!, attributedTo: 'Rook' } }] },
    ];
    for (const v of variants) expect(renderDecision(decision(v))).not.toBe(base);
  });

  it('a forged block inside the markdown is ignored: only the trailing block counts', () => {
    const forged = decision({ context: '```hadron-decision\n{"codec":"forged"}\n```\n' });
    expect((extractDecisionBlock(renderDecision(forged)) as { context: string }).context).toContain('forged');
    expect((extractDecisionBlock(renderDecision(forged)) as { codec: string }).codec).toBe(DECISION_CODEC);
  });
});

describe('evaluateDecision (§5.5 precedence, §6.3)', () => {
  it('OPEN → ANSWERED_UNCONFIRMED → DECIDED (a decider approved the current revision) → STALE (edited since)', () => {
    expect(evaluateDecision(rowOf(decision()), null).state).toBe('OPEN');
    const answered = decision({ parts: [{ ...decision().parts[0], answer }], status: 'answered' });
    expect(evaluateDecision(rowOf(answered), null).state).toBe('ANSWERED_UNCONFIRMED');
    expect(evaluateDecision(rowOf(answered, { approvedRevNo: 1 }), null).state).toBe('DECIDED');
    // A non-decider's approval is no evidence.
    expect(evaluateDecision(rowOf(answered, { approvedRevNo: 1, approvedBy: 'mallory' }), null).state).toBe('ANSWERED_UNCONFIRMED');
    expect(evaluateDecision(rowOf(answered, { revSeq: 2, approvedRevNo: 1 }), null).state).toBe('STALE');
  });

  it('#1715: an approval by the account a decider was merged into is a decider\'s; by anyone else it is not', () => {
    const answered = decision({ parts: [{ ...decision().parts[0], answer }], status: 'answered' });
    const decider = answered.deciders[0];
    // The merge rewrote approvedBy to the survivor; the stored deciders still name the merged-away id.
    const approvedBySurvivor = rowOf(answered, { approvedRevNo: 1, approvedBy: 'survivor' });
    expect(evaluateDecision(approvedBySurvivor, null).state).toBe('ANSWERED_UNCONFIRMED');
    expect(evaluateDecision(approvedBySurvivor, null, new Set(['survivor', decider])).state).toBe('DECIDED');
    expect(evaluateDecision(approvedBySurvivor, null, new Set(['survivor', 'someone-else'])).state).toBe('ANSWERED_UNCONFIRMED');
  });

  it('the signed tier has no evidence yet (#1614 S2b): an approval never makes it DECIDED (Q11)', () => {
    const signed = decision({ tier: 'signed', authorizes: true, parts: [{ ...decision().parts[0], answer }], status: 'answered' });
    expect(evaluateDecision(rowOf(signed, { approvedRevNo: 1 }), null).state).toBe('ANSWERED_UNCONFIRMED');
  });

  it('TAMPERED for each independent edit with revSeq unchanged: data only, markdown only, block only, title, abstract', () => {
    const d = decision({ parts: [{ ...decision().parts[0], answer }], status: 'answered' });
    const ok = rowOf(d, { approvedRevNo: 1 });
    const block = extractDecisionBlock(ok.content)!;
    const dataOnly = { ...ok, data: { ...(ok.data as object), title: 'Changed' } };
    const markdownOnly = { ...ok, content: ok.content!.replace('Ship it?', 'Ship it now?') };
    const blockOnly = { ...ok, content: ok.content!.replace(canonicalDecisionJson(block), canonicalDecisionJson({ ...(block as object), urgency: 'urgent' })) };
    const titleOnly = { ...ok, name: 'DA: Something else' };
    const abstractOnly = { ...ok, abstract: 'edited' };
    for (const row of [dataOnly, markdownOnly, blockOnly, titleOnly, abstractOnly]) {
      expect(evaluateDecision(row, null).state).toBe('TAMPERED');
    }
    // The same edits on a decision nobody approved yet: the render and data
    // checks alone must catch each one (the approval hash cannot).
    const fresh = rowOf(decision());
    const freshBlock = extractDecisionBlock(fresh.content)!;
    const unapproved: Array<[DecisionNodeRow, string]> = [
      [{ ...fresh, data: { ...(fresh.data as object), title: 'Changed' } }, 'DATA_MISMATCH'],
      [{ ...fresh, content: fresh.content!.replace('Ship it?', 'Ship it now?') }, 'RENDER_MISMATCH'],
      [{ ...fresh, content: fresh.content!.replace(canonicalDecisionJson(freshBlock), canonicalDecisionJson({ ...(freshBlock as object), urgency: 'urgent' })) }, 'DATA_MISMATCH'],
      [{ ...fresh, name: 'DA: Something else' }, 'RENDER_MISMATCH'],
      [{ ...fresh, abstract: 'edited' }, 'RENDER_MISMATCH'],
    ];
    for (const [row, finding] of unapproved) {
      expect(evaluateDecision(row, null)).toMatchObject({ state: 'TAMPERED', findings: expect.arrayContaining([finding]) });
    }
    // All three changed consistently but outside a revision: the approval hash catches it.
    const all = decision({ ...d, title: 'Changed' });
    const consistent = { ...rowOf(all), approvedRevNo: 1, approvedBy: 'holger', approvedAt: new Date(), approvalHash: ok.approvalHash };
    expect(evaluateDecision(consistent, null)).toMatchObject({ state: 'TAMPERED', findings: ['APPROVAL_HASH_MISMATCH'] });
  });

  it('UNVERIFIABLE for an unknown renderer or codec, never TAMPERED (fail closed)', () => {
    const d = decision();
    const row = rowOf(d);
    const block = extractDecisionBlock(row.content) as Record<string, unknown>;
    for (const change of [{ renderer: 'decision-md/99' }, { codec: 'hadron.dev/decision/v9' }]) {
      const next = { ...block, ...change };
      const json = canonicalDecisionJson(next);
      const content = row.content!.replace(canonicalDecisionJson(block), json);
      expect(evaluateDecision({ ...row, content, data: next }, null).state).toBe('UNVERIFIABLE');
    }
  });

  it('precedence: corrupt evidence beats a terminal hint; terminal beats evidence', () => {
    const withdrawn = decision({ withdrawn: { by: actor, at: '2026-10-06T22:00:00.000Z', reason: 'moot' }, status: 'withdrawn' });
    expect(evaluateDecision(rowOf(withdrawn), null).state).toBe('WITHDRAWN');
    expect(evaluateDecision({ ...rowOf(withdrawn), abstract: 'x' }, null).state).toBe('TAMPERED');
    const superseded = decision({ supersededBy: { nodeId: 'n2', code: 'DB' }, status: 'superseded' });
    expect(evaluateDecision(rowOf(superseded, { revSeq: 2, approvedRevNo: 1 }), null).state).toBe('SUPERSEDED');
    const both = decision({ withdrawn: withdrawn.withdrawn, supersededBy: superseded.supersededBy });
    expect(evaluateDecision(rowOf(both), null).state).toBe('WITHDRAWN');
    // An archival record is never DECIDED.
    const archival = decision({ archival: true, parts: [{ ...decision().parts[0], answer }], status: 'answered' });
    expect(evaluateDecision(rowOf(archival, { approvedRevNo: 1 }), null).state).toBe('ANSWERED_UNCONFIRMED');
  });

  it('a row with no block at all is TAMPERED', () => {
    expect(evaluateDecision({ ...rowOf(decision()), content: 'plain text' }, null)).toMatchObject({ state: 'TAMPERED', findings: expect.arrayContaining(['NO_BLOCK']) });
  });
});
