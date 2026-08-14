// Persona agent slugs + the dot reservation (#974 — specs cor:agt:020:06 and
// cor:urn:010:03).
//
// A persona's agent slug is never chosen by anyone: the server derives it as
// `<team-app-slug>.<persona-name-slug>`, and the `.` is RESERVED to exactly
// that position — user-supplied agent and App slugs must not contain one. With
// the reservation in force a persona slug can only collide with another persona
// slug of the same (team App, personaName), which the persona-name uniqueness
// index already forbids: the derived slug is collision-free by construction, so
// persona minting needs no bump/suffix machinery.
//
// This is a REGISTRATION policy (enforced at create/rename), not a parse rule —
// the v2 slug charset admits `.` in any name-part and is unchanged
// (cor:urn:010:03). Nothing here may become a parse dependency: "which team"
// and "which persona" are answered by the `teamAppId` / `personaName` columns,
// never by splitting the slug.
import { GraphQLError } from 'graphql';
import { deriveSlugFromName, MAX_ATOM_LEN } from './urn.js';

/** What kind of slug is being validated — used only in the refusal message. */
export type SlugKind = 'agent' | 'App';

/**
 * Reject a user-supplied agent/App slug that contains a `.` (cor:urn:010:03).
 * Call it on the DERIVED slug, after `deriveSlugFromName`, so a display name
 * carrying a dot ("Acme Inc. Bot" ⇒ `acme-inc.-bot`) is refused too — that
 * derivation is still a user-supplied slug by another route.
 */
export function assertDotFreeSlug(slug: string, kind: SlugKind): void {
  if (!slug.includes('.')) return;
  throw new GraphQLError(
    `A ${kind} slug may not contain "." — the dot is reserved for server-derived team-persona slugs (<team-app-slug>.<persona-name>). Offending slug: "${slug}".`,
    { extensions: { code: 'BAD_USER_INPUT', offendingValue: slug } },
  );
}

/**
 * The slug atom of an entity URN — everything after the FIRST colon. Owner
 * atoms (a dotted org root or a dot-free user handle) never contain a colon
 * themselves, so the first colon is the owner/slug boundary.
 */
export function slugFromEntityUrn(urn: string): string {
  const i = urn.indexOf(':');
  return i === -1 ? urn : urn.slice(i + 1);
}

/**
 * Slugify a persona display name for use as the RIGHT constituent of the
 * compound. Dots are folded to `-` first so persona-name slugification can
 * never emit one (cor:agt:020:06 — a persona slug contains exactly one dot,
 * the separator).
 */
export function personaNameSlug(personaName: string): string {
  return deriveSlugFromName(personaName.replace(/\./g, '-'));
}

/**
 * Derive a persona's agent slug: `<team-app-slug>.<persona-name-slug>`
 * (cor:agt:020:06). The team App's slug is the LEFT constituent — the entity
 * `Agent.teamAppId` scopes to — never the Team Agent's.
 *
 * Refuses rather than truncating when the compound would exceed the atom limit:
 * a truncated compound is no longer injective, and injectivity is the whole
 * collision-freedom argument.
 */
export function derivePersonaAgentSlug(teamAppUrn: string, personaName: string): string {
  const teamSlug = slugFromEntityUrn(teamAppUrn);
  if (teamSlug.includes('.')) {
    // Only reachable on a database that predates the dot reservation (the
    // migration guard asserts there are none). Refuse loudly — a dotted team
    // slug would make the compound ambiguous.
    throw new GraphQLError(
      `Team App slug "${teamSlug}" contains a "." — persona slugs cannot be derived from it (cor:urn:010:03).`,
      { extensions: { code: 'BAD_USER_INPUT', offendingValue: teamSlug } },
    );
  }
  const nameSlug = personaNameSlug(personaName);
  const compound = `${teamSlug}.${nameSlug}`;
  if (compound.length > MAX_ATOM_LEN) {
    throw new GraphQLError(
      `The derived persona slug "${compound}" is longer than the ${MAX_ATOM_LEN}-character limit — use a shorter persona name or a shorter team App slug.`,
      { extensions: { code: 'BAD_USER_INPUT', offendingValue: compound } },
    );
  }
  return compound;
}
