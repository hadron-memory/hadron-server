/**
 * #2439: a failed run's cause in plain words — what happened, who can fix it
 * and where. Derived at read time from the stored failure plus the run's own
 * columns, so it never changes what a run recorded. The text is static and
 * names no memory, id, hash or tool: it discloses nothing the caller does not
 * already read (the bound #2434 applies to memory-naming).
 */
export type PlainRunFailureKind =
  | 'NOT_ADOPTED' | 'MEMORY_UNREADABLE' | 'CHANGED' | 'OVER_BUDGET'
  | 'NO_AI_CONFIG' | 'TIMED_OUT' | 'CANCELLED' | 'OTHER';

export interface PlainRunFailure { kind: PlainRunFailureKind; summary: string; whoCanFix: string; nextStep: string }

interface RunLike {
  status: string;
  failure: unknown;
  budgetTokens: number | null;
  budgetActions: number | null;
}

const REASONS: Record<PlainRunFailureKind, Omit<PlainRunFailure, 'kind'>> = {
  NOT_ADOPTED: {
    summary: 'This automation has not been approved to run yet, so nothing ran.',
    whoCanFix: 'The run-as user of the trigger.',
    nextStep: 'Open the automation, preview what it will do, and adopt it. Then run it again.',
  },
  MEMORY_UNREADABLE: {
    summary: 'The automation uses a memory that the user it runs as cannot read, so nothing ran.',
    whoCanFix: 'An owner or manager of that memory, or the App owner.',
    nextStep: 'Give the run-as user read access to the memory, or move the automation to one they can read. Then adopt it again and run it.',
  },
  CHANGED: {
    summary: 'The automation was edited after it was approved, so it stopped before doing anything.',
    whoCanFix: 'The run-as user of the trigger.',
    nextStep: 'Preview the changed automation and adopt it again. Then run it again.',
  },
  OVER_BUDGET: {
    summary: 'The run used up its token or action budget and was stopped.',
    whoCanFix: 'The App owner.',
    nextStep: 'Check the run’s spend against its budget. Simplify the automation, or raise the budget and run it again.',
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

const exhausted = (n: number | null) => n != null && n <= 0;

export function plainRunFailure(run: RunLike): PlainRunFailure | null {
  const f = run.failure as { code?: unknown; reason?: unknown } | null;
  if (!f || typeof f !== 'object') return null;
  const code = typeof f.code === 'string' ? f.code : '';
  let kind: PlainRunFailureKind;
  if (f.reason === 'MEMORY_UNREADABLE') kind = 'MEMORY_UNREADABLE';
  else if (code === 'AUTOMATION_UNADOPTED') kind = 'NOT_ADOPTED';
  else if (code === 'AUTOMATION_CHANGED') kind = 'CHANGED';
  else if (code === 'ACTIVATION_DENIED' && (exhausted(run.budgetActions) || exhausted(run.budgetTokens))) kind = 'OVER_BUDGET';
  else if (code === 'NO_AI_CONFIG') kind = 'NO_AI_CONFIG';
  else if (code === 'TIMEOUT' || run.status === 'TIMED_OUT') kind = 'TIMED_OUT';
  else if (code === 'CANCELLED' || run.status === 'CANCELLED') kind = 'CANCELLED';
  else kind = 'OTHER';
  return { kind, ...REASONS[kind] };
}
