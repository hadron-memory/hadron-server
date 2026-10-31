/**
 * #2439: a failed run's cause in plain words — what happened, who can fix it
 * and where. Derived at read time from the stored failure plus the run's own
 * columns, so it never changes what a run recorded. The text is static and
 * names no memory, id, hash or tool: it discloses nothing the caller does not
 * already read (the bound #2434 applies to memory-naming). The one exception
 * (#2642): a CHANGED reason may name the automation, but only through a label
 * the caller's own authorization already produced (`automationLabel`); the
 * mapper never decides who may see it.
 */
export type PlainRunFailureKind =
  | 'NOT_ADOPTED' | 'MEMORY_UNREADABLE' | 'CHANGED' | 'OVER_BUDGET'
  | 'POLICY_DENIED' | 'NO_AI_CONFIG' | 'TIMED_OUT' | 'CANCELLED' | 'OTHER';

export interface PlainRunFailure { kind: PlainRunFailureKind; summary: string; whoCanFix: string; nextStep: string }

interface RunLike {
  status: string;
  failure: unknown;
}

const REASONS: Record<PlainRunFailureKind, Omit<PlainRunFailure, 'kind'>> = {
  NOT_ADOPTED: {
    summary: 'The run stopped because this automation has not been approved to run. Anything it did before it stopped is kept.',
    whoCanFix: 'The run-as user of the trigger.',
    nextStep: 'Open the automation, preview what it will do, and adopt it. Before running it again, check what this run already did in its details, so nothing is done twice.',
  },
  MEMORY_UNREADABLE: {
    summary: 'The run stopped because the automation uses a memory that is missing or that the user it runs as cannot read. Anything it did before it stopped is kept.',
    whoCanFix: 'An owner or manager of that memory, or the App owner.',
    nextStep: 'Give the run-as user read access to the memory, or move the automation to one they can read. Then adopt it again. Before running it again, check what this run already did in its details.',
  },
  CHANGED: {
    summary: 'The run stopped because the automation was edited or moved after it was approved. Anything it did before it stopped is kept.',
    whoCanFix: 'The run-as user of the trigger.',
    nextStep: 'Preview the changed automation and adopt it again. Before running it again, check what this run already did in its details, so nothing is done twice.',
  },
  OVER_BUDGET: {
    summary: 'The run used up its token or action budget and was stopped.',
    whoCanFix: 'The App owner.',
    nextStep: 'Check the run’s spend against its budget. Simplify the automation, or raise the budget and run it again.',
  },
  POLICY_DENIED: {
    summary: 'The run stopped because a policy does not allow one of the steps it tried.',
    whoCanFix: 'The App owner or an organization admin.',
    nextStep: 'Review the App’s policy for what this automation is allowed to do, then run it again.',
  },
  NO_AI_CONFIG: {
    summary: 'No AI provider is set up for this automation, so it could not run.',
    whoCanFix: 'The App owner or an organization admin.',
    nextStep: 'Add an AI provider key in the App or organization settings, then run it again.',
  },
  TIMED_OUT: {
    summary: 'The run took longer than its time limit and was stopped.',
    whoCanFix: 'The App owner.',
    nextStep: 'Shorten the automation or raise its time limit, then run it again.',
  },
  CANCELLED: {
    summary: 'The run was cancelled before it finished.',
    whoCanFix: 'Whoever cancelled it.',
    nextStep: 'Start a new run if it is still needed.',
  },
  OTHER: {
    summary: 'The run stopped because of an error.',
    whoCanFix: 'The App owner.',
    nextStep: 'Open the run’s details for the technical message, and ask the App owner or the platform team if it is unclear.',
  },
};

const LABEL_MAX = 80;

/** Display text for an authorized trigger name: no control or markup characters, one line, bounded. */
export function plainAutomationLabel(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const t = name.replace(/[\p{C}\p{Zl}\p{Zp}<>"“”`]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const points = Array.from(t);
  return points.length > LABEL_MAX ? `${points.slice(0, LABEL_MAX - 1).join('').trimEnd()}…` : t;
}

export function plainRunFailure(run: RunLike, context?: { automationLabel?: string | null }): PlainRunFailure | null {
  const f = run.failure as { code?: unknown; reason?: unknown } | null;
  if (!f || typeof f !== 'object') return null;
  const code = typeof f.code === 'string' ? f.code : '';
  let kind: PlainRunFailureKind;
  if (f.reason === 'MEMORY_UNREADABLE') kind = 'MEMORY_UNREADABLE';
  else if (code === 'AUTOMATION_UNADOPTED') kind = 'NOT_ADOPTED';
  else if (code === 'AUTOMATION_CHANGED') kind = 'CHANGED';
  // The denial's cause is recorded where it happened; never inferred from balances.
  else if (code === 'ACTIVATION_DENIED' && f.reason === 'DENIED_BUDGET') kind = 'OVER_BUDGET';
  else if (code === 'ACTIVATION_DENIED' && f.reason === 'DENIED_POLICY') kind = 'POLICY_DENIED';
  else if (code === 'ACTIVATION_DENIED' && f.reason === 'DENIED_CANCELLED') kind = 'CANCELLED';
  else if (code === 'NO_AI_CONFIG') kind = 'NO_AI_CONFIG';
  else if (code === 'TIMEOUT' || run.status === 'TIMED_OUT') kind = 'TIMED_OUT';
  else if (code === 'CANCELLED' || run.status === 'CANCELLED') kind = 'CANCELLED';
  else kind = 'OTHER';
  const reason = REASONS[kind];
  if (kind === 'CHANGED') {
    const label = plainAutomationLabel(context?.automationLabel);
    return { kind, ...reason, summary: reason.summary.replace('the automation was', label ? `the automation “${label}” was` : 'this automation was') };
  }
  return { kind, ...reason };
}
