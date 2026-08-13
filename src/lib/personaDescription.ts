/**
 * The persona `description` string (#950) — ONE definition, shared by the mint
 * path (`createTeamPersona`) and the backfill sweep (`teamPersonaRepair`).
 *
 * It lived in both as a copy with a "keep these in step" comment, which is
 * exactly the arrangement that drifts; the sweep deliberately does not import
 * from the GraphQL layer, so the shared home is here.
 *
 * A role node's own `description` is never used: it describes the
 * role-definition ARTIFACT ("Role definition + name register for …"), which is
 * what that node is, and it would read as a registry document on every persona
 * of the role — identically.
 */

/**
 * Humanize a role slug for prose: `backend-engineer` → `backend engineer`.
 *
 * Roles are loc atoms (`roles:<role>`), so they are hyphenated by convention
 * while the sentence they land in is English — #950's own example spells the
 * result "AI coding agent using backend engineer role", and the personas
 * hand-corrected in production carry the spaced form.
 *
 * Applies ONLY to the synthesized sentence below. `{{role}}` substitution in a
 * prompt template (and in a `data.personaDescription` template) stays the RAW
 * role: those are author-controlled strings, and the persona prompt has always
 * carried the exact role slug — humanizing it there would change what an
 * existing template renders.
 */
export function humanizeRole(role: string): string {
  return role.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Substitute `{{name}}` / `{{role}}` into a template. split/join rather than
 * replaceAll so a name containing replacement-pattern characters ($&, $') is
 * inserted literally. */
export function applyPersonaTemplate(template: string, name: string, role: string): string {
  return template.split('{{name}}').join(name).split('{{role}}').join(role);
}

/**
 * The persona description: a role node's optional `data.personaDescription`
 * template (with the same placeholders as the prompt), else the synthesized
 * sentence.
 */
export function composePersonaDescription(
  roleData: unknown,
  name: string,
  role: string,
): string {
  const template = (roleData as { personaDescription?: unknown } | null)?.personaDescription;
  if (typeof template === 'string' && template.trim() !== '') {
    return applyPersonaTemplate(template, name, role);
  }
  return `AI coding agent using ${humanizeRole(role)} role`;
}
