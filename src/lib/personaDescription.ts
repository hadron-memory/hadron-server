/**
 * Prompt variable binding (cor:dmo:150:08): the ONE definition of how a boot
 * prompt's variables bind at read time. S12 (#2049) removed the old
 * name-only helpers and the name-placeholder probe; the legacy `{{name}}` /
 * `{{role}}` tokens still bind, in the same pass, through `applyPlatformVariables`
 * until the live-node token audit.
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
 * The old `{{name}}` / `{{role}}` placeholders stay until the live-node token audit (#1772).
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

export function applyPlatformVariables(
  template: string,
  values: PlatformVariableValues,
  /** The legacy `{{name}}` / `{{role}}` placeholders, bound in the SAME pass (blind review P2-1): a second pass over
   * an already-substituted prompt would read an inserted value as template source. Omit for text that has none (a
   * worker override keeps its legacy tokens as written). */
  legacy?: { name: string; role: string },
): string {
  return template.replace(
    /\{\{(name|role|worker\.name|worker\.role|agent\.name|worker\.reportsTo\.name|worker\.signature|worker\.trailer|worker\.url|session\.llmModel)\}\}/g,
    (match, key: string) => {
      if (key === 'name' || key === 'role') return legacy ? legacy[key] : match;
      return values[key as keyof PlatformVariableValues];
    },
  );
}
