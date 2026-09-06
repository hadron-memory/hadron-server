/**
 * Persona template substitution (#928/#974 — cor:agt:020:01): the ONE
 * definition of how `{{name}}` / `{{role}}` bind into a persona's template
 * prompt. The agent's `personaPrompt` is a TEMPLATE; the Worker's resolved
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
