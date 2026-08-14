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

/** Substitute `{{name}}` / `{{role}}` into a template. split/join rather than
 * replaceAll so a name containing replacement-pattern characters ($&, $') is
 * inserted literally. */
export function applyPersonaTemplate(template: string, name: string, role: string): string {
  return template.split('{{name}}').join(name).split('{{role}}').join(role);
}
