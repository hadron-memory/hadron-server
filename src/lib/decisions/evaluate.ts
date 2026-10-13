/**
 * #1641 §5.5 / §6.3 — THE one evaluation of a decision's state. Every reader
 * (`Decision.state`, `verifyDecision`, the list filters, and every future
 * relying consumer) calls {@link evaluateDecision}; no other code derives a
 * decision's state, and `data.status` is never read for it.
 *
 * Precedence, first match wins (§5.5): TAMPERED → UNVERIFIABLE → WITHDRAWN →
 * SUPERSEDED → STALE → DECIDED → ANSWERED_UNCONFIRMED → OPEN. A terminal or
 * open hint can never mask corrupt evidence.
 *
 * Integrity is the semantic block re-rendered with its OWN declared renderer
 * and compared with the whole content, plus the block compared with the
 * `data` cache, plus the approval hash's live check (`checkNodeIntegrity`) —
 * never `approvalStateOf`'s revision equality alone
 * (findings:mint-approval-revision-equality-misses-tamper).
 */
import type { ApprovalHashFields } from '../approvalHash.js';
import { checkNodeIntegrity, type NodeApprovalRow, type NodeIntegrityState } from '../nodeApproval.js';
import { DECISION_CODEC, decisionDataSchema, type DecisionData } from './codec.js';
import { canonicalDecisionJson, decisionName, extractDecisionBlock, isKnownRenderer, renderDecision, renderDecisionAbstract } from './render.js';

export type DecisionState =
  | 'OPEN'
  | 'ANSWERED_UNCONFIRMED'
  | 'DECIDED'
  | 'STALE'
  | 'TAMPERED'
  | 'UNVERIFIABLE'
  | 'WITHDRAWN'
  | 'SUPERSEDED';

/** Why a decision is TAMPERED or UNVERIFIABLE, for `verifyDecision`. */
export type DecisionIntegrityFinding =
  | 'NO_BLOCK'
  | 'BLOCK_INVALID'
  | 'UNKNOWN_CODEC'
  | 'UNKNOWN_RENDERER'
  | 'RENDER_MISMATCH'
  | 'DATA_MISMATCH'
  | 'APPROVAL_HASH_MISMATCH';

export interface DecisionEvaluation {
  state: DecisionState;
  /** The authenticated payload (the block), when it parsed; null otherwise. */
  decision: DecisionData | null;
  findings: DecisionIntegrityFinding[];
  approval: {
    integrity: NodeIntegrityState;
    /** The approval is by one of the decision's deciders. */
    byDecider: boolean;
    revision: number | null;
  };
  allAnswered: boolean;
}

/** The node fields an evaluation reads. */
export type DecisionNodeRow = NodeApprovalRow & { data: unknown };

/**
 * Evaluate one decision. Pure: the caller supplies the node row (plaintext;
 * decision logs never live in encrypted memories, §5.4) and the retained
 * snapshot of its approved revision, if any.
 *
 * `approverIdentities` (#1715): every id that now means the approver, their
 * own plus every account merged into it (src/lib/userMerges.ts). A merge
 * rewrites `approvedBy` to the surviving account but never the decision's
 * stored deciders, so the approval is a decider's when any of these is named.
 * Omitted, the approver is only `approvedBy` itself.
 */
export function evaluateDecision(
  node: DecisionNodeRow,
  approvedSnapshot: ApprovalHashFields | null,
  approverIdentities?: ReadonlySet<string>,
): DecisionEvaluation {
  const findings: DecisionIntegrityFinding[] = [];
  const live: ApprovalHashFields = { title: node.name, abstract: node.abstract, content: node.content };
  const integrity = checkNodeIntegrity(node, live, approvedSnapshot);
  if (integrity.state === 'TAMPERED') findings.push('APPROVAL_HASH_MISMATCH');

  let decision: DecisionData | null = null;
  let unverifiable = false;
  const block = extractDecisionBlock(node.content);
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
      blockJson = canonicalDecisionJson(block);
      dataJson = canonicalDecisionJson(node.data);
    } catch {
      findings.push('BLOCK_INVALID');
    }
    if (blockJson != null && dataJson != null && blockJson !== dataJson) findings.push('DATA_MISMATCH');
    if (codec !== DECISION_CODEC) {
      findings.push('UNKNOWN_CODEC');
      unverifiable = true;
    } else if (typeof renderer !== 'string' || !isKnownRenderer(renderer)) {
      findings.push('UNKNOWN_RENDERER');
      unverifiable = true;
    } else {
      const parsed = decisionDataSchema.safeParse(block);
      if (!parsed.success) {
        findings.push('BLOCK_INVALID');
      } else {
        // Compare with the block AS STORED: the codec's transforms (line
        // endings) must not make a doctored block look canonical.
        if (canonicalDecisionJson(parsed.data) !== blockJson) findings.push('BLOCK_INVALID');
        // The title and abstract are hashed with the content, so they are
        // rendered too and checked the same way.
        else if (
          renderDecision(parsed.data) !== node.content ||
          decisionName(parsed.data) !== node.name ||
          renderDecisionAbstract(parsed.data) !== node.abstract
        ) findings.push('RENDER_MISMATCH');
        decision = parsed.data;
      }
    }
  }

  const tampered = findings.some((f) => f !== 'UNKNOWN_CODEC' && f !== 'UNKNOWN_RENDERER');
  const approver = node.approvedBy == null ? null : (approverIdentities ?? new Set([node.approvedBy]));
  const byDecider = decision != null && approver != null && decision.deciders.some((id) => approver.has(id));
  const allAnswered = decision != null && decision.parts.every((p) => p.answer != null);
  const approval = { integrity: integrity.state, byDecider, revision: node.approvedRevNo };
  const result = (state: DecisionState): DecisionEvaluation => ({ state, decision, findings, approval, allAnswered });

  if (tampered) return result('TAMPERED');
  if (unverifiable || decision == null) return result('UNVERIFIABLE');
  if (decision.withdrawn) return result('WITHDRAWN');
  if (decision.supersededBy) return result('SUPERSEDED');
  // Evidence by tier. The approved tier's evidence is a decider's approval;
  // the signed tier's is a decider's passkey signature (#1614 S2b, slice S3),
  // which does not exist yet, so a signed decision has no evidence and stays
  // ANSWERED_UNCONFIRMED (Q11). An approval never counts for the signed tier.
  if (decision.tier === 'approved' && byDecider) {
    if (integrity.state === 'SUPERSEDED') return result('STALE');
    if (integrity.state === 'INTACT' && allAnswered && !decision.archival) return result('DECIDED');
  }
  if (allAnswered) return result('ANSWERED_UNCONFIRMED');
  return result('OPEN');
}
