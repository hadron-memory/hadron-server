/**
 * Prompt variable binding (cor:dmo:150:08): the ONE definition of how a boot
 * prompt's variables bind at read time. S12 (#2049) removed the old
 * name-only helpers and the name-placeholder probe; #1772 step 3 removed the
 * legacy `{{name}}` / `{{role}}` binding once the token audit (#2704) found none
 * left in served text. Those two tokens now render as written, like any text
 * outside the closed set.
 */

/**
 * Platform variables (#2042, cor:dmo:150:08): the CLOSED set a boot prompt may
 * use, filled at each bind for the worker being bound and its session. Values
 * are resolved by the caller (bottom-up: the most customised object with a
 * value delivers it) and passed in; this function only substitutes. Compile
 * never calls it, so one Agent prompt serves every worker and a rename reaches
 * the next bind with no recompile.
 *
 * Exact tokens only. An unknown `{{worker.x}}`
 * stays as written (the set is closed, nothing else resolves here). Substitution
 * is a single pass over the template, so a value that itself contains a token
 * (a name like `{{agent.name}}`) is inserted literally, never re-expanded.
 */
export interface PlatformVariableValues {
  'worker.name': string;
  'worker.role': string;
  'agent.name': string;
  'worker.reportsTo.name': string;
  'worker.signature': string;
  'worker.trailer': string;
  'worker.url': string;
  'session.llmModel': string;
}

/** The closed set's keys, in one place for the audit (#2704). */
export const PLATFORM_VARIABLE_KEYS = [
  'worker.name', 'worker.role', 'agent.name', 'worker.reportsTo.name', 'worker.signature', 'worker.trailer', 'worker.url', 'session.llmModel',
] as const satisfies readonly (keyof PlatformVariableValues)[];

// Exhaustiveness (#2704): a variable added to PlatformVariableValues but not to the list above fails to compile here,
// so the audit can never call a supported token unknown.
const platformVariableKeysAreExhaustive: Exclude<keyof PlatformVariableValues, (typeof PLATFORM_VARIABLE_KEYS)[number]> extends never ? true : never = true;
void platformVariableKeysAreExhaustive;

export function applyPlatformVariables(template: string, values: PlatformVariableValues): string {
  return template.replace(
    /\{\{(worker\.name|worker\.role|agent\.name|worker\.reportsTo\.name|worker\.signature|worker\.trailer|worker\.url|session\.llmModel)\}\}/g,
    (_match, key: string) => values[key as keyof PlatformVariableValues],
  );
}

/**
 * #1772 step 3 review P2: a RECORD replay (a session's or a run's recorded revision, read again) is reconstructed as it was
 * served, so a legacy `{{name}}` / `{{role}}` held by that old revision still binds, from the RECORDED `worker.name` /
 * `worker.role`, in the same single pass as the closed set. Live reads never call this: only a retained record can hold a
 * revision written before the token migration (#2704), and its audit sees current text, not history. A record whose
 * values lack either key leaves the tokens as written rather than printing "undefined".
 */
export function applyRecordedVariables(template: string, values: PlatformVariableValues): string {
  const name = values['worker.name'];
  const role = values['worker.role'];
  const legacy = typeof name === 'string' && typeof role === 'string' ? { name, role } : null;
  return template.replace(
    /\{\{(name|role|worker\.name|worker\.role|agent\.name|worker\.reportsTo\.name|worker\.signature|worker\.trailer|worker\.url|session\.llmModel)\}\}/g,
    (match, key: string) => (key === 'name' || key === 'role' ? (legacy ? legacy[key] : match) : values[key as keyof PlatformVariableValues]),
  );
}
