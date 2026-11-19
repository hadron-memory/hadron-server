/**
 * #1641 §5.5 / §6.3 — THE one evaluation of a question's state. Every reader
 * (`Question.state`, `verifyQuestion`, the list filters, and every future
 * relying consumer) calls {@link evaluateQuestion}; no other code derives a
 * question's state, and `data.status` is never read for it.
 *
 * Precedence, first match wins (#4426 §3): TAMPERED → UNVERIFIABLE →
 * WITHDRAWN → OPEN (no standing answer) → DECIDED (tier answered, or an intact
 * decider approval) → STALE → ANSWERED_UNCONFIRMED. A terminal or open hint
 * can never mask corrupt evidence.
 *
 * Integrity is the semantic block re-rendered with its OWN declared renderer
 * and compared with the whole content, plus the block compared with the
 * `data` cache, plus the approval hash's live check (`checkNodeIntegrity`) —
 * never `approvalStateOf`'s revision equality alone
 * (findings:mint-approval-revision-equality-misses-tamper).
 */
import type { ApprovalHashFields } from '../approvalHash.js';
import { checkNodeIntegrity, type NodeApprovalRow, type NodeIntegrityState } from '../nodeApproval.js';
import { QUESTION_CODEC, currentAnswer, questionDataSchema, type QuestionData } from './codec.js';
import { canonicalQuestionJson, questionName, extractQuestionBlock, isKnownRenderer, renderQuestion, renderQuestionAbstract } from './render.js';

export type QuestionState =
  | 'OPEN'
  | 'ANSWERED_UNCONFIRMED'
  | 'DECIDED'
  | 'STALE'
  | 'TAMPERED'
  | 'UNVERIFIABLE'
  | 'WITHDRAWN';

/** Why a question is TAMPERED or UNVERIFIABLE, for `verifyQuestion`. */
export type QuestionIntegrityFinding =
  | 'NO_BLOCK'
  | 'BLOCK_INVALID'
  | 'UNKNOWN_CODEC'
  | 'UNKNOWN_RENDERER'
  | 'RENDER_MISMATCH'
  | 'DATA_MISMATCH'
  | 'APPROVAL_HASH_MISMATCH';

export interface QuestionEvaluation {
  state: QuestionState;
  /** The authenticated payload (the block), when it parsed; null otherwise. */
  question: QuestionData | null;
  findings: QuestionIntegrityFinding[];
  approval: {
    integrity: NodeIntegrityState;
    /** The approval is by one of the question's deciders. */
    byDecider: boolean;
    revision: number | null;
  };
  /** An answer stands: the last entry of the answer list is an answer (#4426). */
  answered: boolean;
}

/** The node fields an evaluation reads. */
export type QuestionNodeRow = NodeApprovalRow & { data: unknown };

/**
 * Evaluate one question. Pure: the caller supplies the node row (plaintext;
 * question logs never live in encrypted memories, §5.4) and the retained
 * snapshot of its approved revision, if any.
 *
 * `approverIdentities` (#1715): every id that now means the approver, their
 * own plus every account merged into it (src/lib/userMerges.ts). A merge
 * rewrites `approvedBy` to the surviving account but never the question's
 * stored deciders, so the approval is a decider's when any of these is named.
 * Omitted, the approver is only `approvedBy` itself.
 */
export function evaluateQuestion(
  node: QuestionNodeRow,
  approvedSnapshot: ApprovalHashFields | ApprovalHashFields[] | null,
  approverIdentities?: ReadonlySet<string>,
): QuestionEvaluation {
  const findings: QuestionIntegrityFinding[] = [];
  const live: ApprovalHashFields = { title: node.name, abstract: node.abstract, content: node.content };
  const integrity = checkNodeIntegrity(node, live, approvedSnapshot);
  if (integrity.state === 'TAMPERED') findings.push('APPROVAL_HASH_MISMATCH');

  let question: QuestionData | null = null;
  let unverifiable = false;
  const block = extractQuestionBlock(node.content);
  if (block == null) {
    findings.push('NO_BLOCK');
  } else {
    const codec = (block as { codec?: unknown }).codec;
    const renderer = (block as { renderer?: unknown }).renderer;
    // The data cache must equal the block whatever the versions: a mismatch
    // is evidence of a write outside the doors.
    let blockJson: string | null = null;
    let dataJson: string | null = null;
    try {
      blockJson = canonicalQuestionJson(block);
      dataJson = canonicalQuestionJson(node.data);
    } catch {
      findings.push('BLOCK_INVALID');
    }
    if (blockJson != null && dataJson != null && blockJson !== dataJson) findings.push('DATA_MISMATCH');
    if (codec !== QUESTION_CODEC) {
      findings.push('UNKNOWN_CODEC');
      unverifiable = true;
    } else if (typeof renderer !== 'string' || !isKnownRenderer(renderer)) {
      findings.push('UNKNOWN_RENDERER');
      unverifiable = true;
    } else {
      const parsed = questionDataSchema.safeParse(block);
      if (!parsed.success) {
        findings.push('BLOCK_INVALID');
      } else {
        // Compare with the block AS STORED: the codec's transforms (line
        // endings) must not make a doctored block look canonical.
        if (canonicalQuestionJson(parsed.data) !== blockJson) findings.push('BLOCK_INVALID');
        // The title and abstract are hashed with the content, so they are
        // rendered too and checked the same way.
        else if (
          renderQuestion(parsed.data) !== node.content ||
          questionName(parsed.data) !== node.name ||
          renderQuestionAbstract(parsed.data) !== node.abstract
        ) findings.push('RENDER_MISMATCH');
        question = parsed.data;
      }
    }
  }

  const tampered = findings.some((f) => f !== 'UNKNOWN_CODEC' && f !== 'UNKNOWN_RENDERER');
  const approver = node.approvedBy == null ? null : (approverIdentities ?? new Set([node.approvedBy]));
  const byDecider = question != null && approver != null && question.deciders.some((id) => approver.has(id));
  const answered = question != null && currentAnswer(question) != null;
  const approval = { integrity: integrity.state, byDecider, revision: node.approvedRevNo };
  const result = (state: QuestionState): QuestionEvaluation => ({ state, question, findings, approval, answered });

  if (tampered) return result('TAMPERED');
  if (unverifiable || question == null) return result('UNVERIFIABLE');
  if (question.withdrawn) return result('WITHDRAWN');
  // Row 4 before the evidence rows on purpose: a question whose answer was
  // taken back is OPEN again even if an earlier revision was approved.
  if (!answered) return result('OPEN');
  // The default tier needs no evidence: a decider's answer alone settles it.
  if (question.tier === 'answered') return result('DECIDED');
  // Evidence by tier. The approved tier's evidence is a decider's approval;
  // the signed tier's is a decider's passkey signature (#1614 S2b), which
  // does not exist yet, so a signed question has no evidence and stays
  // ANSWERED_UNCONFIRMED (Q11). An approval never counts for the signed tier.
  if (question.tier === 'approved' && byDecider) {
    if (integrity.state === 'SUPERSEDED') return result('STALE');
    if (integrity.state === 'INTACT') return result('DECIDED');
  }
  return result('ANSWERED_UNCONFIRMED');
}
