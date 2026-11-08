/**
 * #3742 (Grants S1d, cor:acl:140:02 Summary / cor:acl:140:07 What the signer reads): the one function that writes a grant's
 * summary. STUB for the red-first commit: it renders nothing and checks nothing.
 */
import type { ActionParameter } from './actions.js';

export type GrantSummaryReason = 'MISSING_VALUE' | 'UNSUPPORTED_TYPE' | 'WILDCARD' | 'LIST' | 'UNKNOWN_PLACEHOLDER' | 'MALFORMED_TEMPLATE' | 'NOT_CANONICAL';

export class GrantSummaryError extends Error {
  readonly code = 'GRANT_SUMMARY_UNRENDERABLE' as const;
  constructor(readonly reason: GrantSummaryReason, message: string) { super(message); this.name = 'GrantSummaryError'; }
}

export interface SummaryAction { parameters: readonly ActionParameter[]; summaryTemplate: string }
export interface SummaryInput {
  action: SummaryAction;
  app: { urn: string };
  values: Readonly<Record<string, unknown>>;
  refs: Readonly<Record<string, { urn: string }>>;
}

export function summaryPlaceholders(_template: string): string[] { return []; }
export function renderGrantSummary(_input: SummaryInput): string { return ''; }
