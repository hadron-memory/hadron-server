/**
 * #2042 (#1772 S4, cor:dmo:150:08) — the platform variables of a boot prompt:
 * the closed set the platform fills in at each bind, for the worker being bound
 * and its session, or, with no worker, from the Agent and the chat's model.
 *
 * ONE definition of the set and of how it binds, shared by the worker briefing
 * (`composeWorkerPrompt`, `castWorkerPreview`) and the chat path. Phase 1 binds
 * the new names ALONGSIDE the legacy `{{name}}` / `{{role}}` placeholders of
 * `personaDescription.ts`; S12 (#2049) removes the legacy pair.
 *
 * Binding is a single left-to-right pass with a function replacer, so a value
 * is inserted literally: it is never re-scanned for variables and `$&`-style
 * replacement patterns in it mean nothing. Tokens are exact and
 * whitespace-sensitive, like the legacy ones. Nothing outside the set resolves
 * here — `{{field}}` and `{{node-loc.field}}` belong to ordinary node reads.
 */

/** The closed set (cor:dmo:150:08). */
export const PLATFORM_VARIABLES = [
  'worker.name',
  'worker.role',
  'agent.name',
  'worker.reportsTo.name',
  'worker.signature',
  'worker.trailer',
  'worker.url',
  'session.llmModel',
] as const;

export type PlatformVariable = (typeof PLATFORM_VARIABLES)[number];

/**
 * The values of one bind. A string fills the variable (empty included); null
 * leaves it written as-is, for a dry run that has nothing to fill it from yet.
 */
export type PlatformVariableValues = Record<PlatformVariable, string | null>;

const TOKEN = new RegExp(
  `\\{\\{(${[...PLATFORM_VARIABLES.map((v) => v.replace(/\./g, '\\.')), 'name', 'role'].join('|')})\\}\\}`,
  'g',
);

/**
 * Bind a prompt template: the platform variables, and the legacy `{{name}}` /
 * `{{role}}` pair as the worker's name and role (the same values
 * `worker.name` / `worker.role` carry).
 */
export function bindPlatformVariables(template: string, values: PlatformVariableValues): string {
  return template.replace(TOKEN, (token, key: string) => {
    const variable: PlatformVariable = key === 'name' ? 'worker.name' : key === 'role' ? 'worker.role' : (key as PlatformVariable);
    return values[variable] ?? token;
  });
}

/**
 * The values with no worker (a chatbot chat): the Agent's own name and role,
 * the Agent's portal URL, and the chat's model. Worker-only attributes are
 * empty, never unfilled (cor:dmo:150:08, R10).
 */
export function agentOnlyVariableValues(
  agent: { name: string; personaRole: string | null },
  opts: { url: string | null; llmModel: string | null },
): PlatformVariableValues {
  return {
    'worker.name': agent.name,
    'worker.role': agent.personaRole ?? '',
    'agent.name': agent.name,
    'worker.reportsTo.name': '',
    'worker.signature': '',
    'worker.trailer': '',
    'worker.url': opts.url ?? '',
    'session.llmModel': opts.llmModel ?? '',
  };
}
