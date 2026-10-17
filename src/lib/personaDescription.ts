/**
 * Persona template substitution (#928/#974 — cor:agt:020:01): the ONE
 * definition of how `{{name}}` / `{{role}}` bind into a persona's template
 * prompt. The agent's `systemPrompt` is a TEMPLATE; the Worker's resolved
 * `prompt` field binds it with the casting's name and role at read time.
 *
 * (The #950-era `composePersonaDescription` / `humanizeRole` helpers were
 * removed with the persona-as-agent model: castWorker mints no Agent, so
 * nothing synthesizes a persona description anymore.)
 */

/** THE name token `applyPersonaTemplate` binds — exact, whitespace-sensitive. */
export const PERSONA_NAME_TOKEN = '{{name}}';

/** Substitute `{{name}}` / `{{role}}` into a template. split/join rather than
 * replaceAll so a name containing replacement-pattern characters ($&, $') is
 * inserted literally. */
export function applyPersonaTemplate(template: string, name: string, role: string): string {
  return template.split(PERSONA_NAME_TOKEN).join(name).split('{{role}}').join(role);
}

/**
 * Does a template bind the worker's name? Detection MUST share the composer's
 * exact token semantics (#985 review, Codex/Copilot): a whitespace-tolerant
 * probe would report `{{ name }}` as bound while `applyPersonaTemplate`
 * leaves it literal — flagging safe precisely the template that silently
 * produces a nameless worker. Every surface answering "does this template
 * name the worker?" (`TeamRole.hasNamePlaceholder`, `castWorkerPreview`)
 * goes through here.
 */
export function templateBindsName(template: string | null | undefined): boolean {
  return !!template && template.includes(PERSONA_NAME_TOKEN);
}

/**
 * Platform variables (#2042, cor:dmo:150:08): the CLOSED set a boot prompt may
 * use, filled at each bind for the worker being bound and its session. Values
 * are resolved by the caller (bottom-up: the most customised object with a
 * value delivers it) and passed in; this function only substitutes. Compile
 * never calls it, so one Agent prompt serves every worker and a rename reaches
 * the next bind with no recompile.
 *
 * Exact tokens only, like `applyPersonaTemplate`. An unknown `{{worker.x}}`
 * stays as written (the set is closed, nothing else resolves here). Substitution
 * is a single pass over the template, so a value that itself contains a token
 * (a name like `{{agent.name}}`) is inserted literally, never re-expanded.
 * The old `{{name}}` / `{{role}}` placeholders stay until S12 (#1772).
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

export function applyPlatformVariables(template: string, values: PlatformVariableValues): string {
  return template.replace(
    /\{\{(worker\.name|worker\.role|agent\.name|worker\.reportsTo\.name|worker\.signature|worker\.trailer|worker\.url|session\.llmModel)\}\}/g,
    (_m, key: keyof PlatformVariableValues) => values[key],
  );
}
