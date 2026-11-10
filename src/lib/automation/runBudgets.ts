/** #2479 / cor:agt:010:02: trigger limits narrow current per-run defaults; daily quotas are separate. */
import { GraphQLError } from 'graphql';
export interface TriggerRunBudgets { budgetTokens?: number | null; budgetActions?: number | null }
const DEFAULTS = { budgetTokens: 100_000, budgetActions: 50 };
const ENV = { budgetTokens: 'RUN_DEFAULT_TOKEN_BUDGET', budgetActions: 'RUN_DEFAULT_ACTION_BUDGET' };
/** Read at save/launch, so an operator's later reduction is never overridden by an older trigger. */
export function platformRunBudgets() {
  const positive = (key: keyof typeof DEFAULTS) => {
    const n = Number(process.env[ENV[key]]);
    return Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647 ? n : DEFAULTS[key];
  };
  return { budgetTokens: positive('budgetTokens'), budgetActions: positive('budgetActions') };
}
/** Omitted is unchanged on update; explicit null clears to the launch-time default. */
export function triggerBudgetPatch(input: TriggerRunBudgets): TriggerRunBudgets {
  const defaults = platformRunBudgets();
  const patch: TriggerRunBudgets = {};
  for (const key of ['budgetTokens', 'budgetActions'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0 || value > defaults[key])) {
      throw new GraphQLError(`${key === 'budgetTokens' ? 'Token' : 'Action'} budget must be a positive whole number no greater than the platform per-run default (${defaults[key]}).`, { extensions: { code: 'BAD_USER_INPUT' } });
    }
    patch[key] = value;
  }
  return patch;
}
/** Historical stored limits can exceed a newly lowered default; clamp at launch, never widen. */
export function effectiveRunBudgets(input: TriggerRunBudgets = {}) {
  const defaults = platformRunBudgets();
  const effective = (key: keyof typeof defaults) => {
    const value = input[key];
    if (value == null) return defaults[key];
    if (!Number.isSafeInteger(value) || value <= 0) throw new GraphQLError('Stored run budget must be a positive whole number.', { extensions: { code: 'BAD_USER_INPUT' } });
    return Math.min(value, defaults[key]);
  };
  return { budgetTokens: effective('budgetTokens'), budgetActions: effective('budgetActions') };
}
