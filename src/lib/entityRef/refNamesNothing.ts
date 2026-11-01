/**
 * #2975 — the discriminator for a reference-resolution catch that answers
 * "names nothing" with the uniform refusal (cor:api:140:03).
 *
 * A catch around a `resolve<Entity>Ref` call may turn ONLY a name-resolution
 * outcome into that refusal. Everything else is a fault and must propagate to
 * the shared error boundary (cor:api:260:01: an internal error never becomes
 * "not found"; a plain `Error` is a fault whatever its text). A bare
 * `catch { return null }` cannot tell the two apart, so a database fault used
 * to answer exactly like an unknown ref.
 *
 * Names nothing:
 *  - the typed not-found errors, matched on their {@link EntityNotFoundError}
 *    base (AgentNotFoundError, OrganizationNotFoundError, MemoryNotFoundError, …)
 *    so a new subclass needs nothing here;
 *  - the urn-lib grammar errors: a malformed or unqualified ref names nothing.
 *
 * Ambiguity is deliberately NOT decided here. `AmbiguousLegacyUrnError` is a
 * typed refusal on both wires (formatError maps it; the MCP boundary trusts
 * it), so letting it escape tells any caller, outsider included, that an old
 * address is held by two or more live rows. The entity resolvers have no
 * claimant gate to conceal that, so the entity arms keep treating it as names
 * nothing (gate ruling (a) on #2975); a call site with a concealing gate (the
 * node-ref resolvers) rethrows it before calling this. Callers pass
 * `{ ambiguousNamesNothing: true }` to opt in to the concealment.
 */
import { EntityNotFoundError } from './entityNotFound.js';
import { AmbiguousLegacyUrnError } from './errors.js';
import { UrnNotQualifiedError, UrnParseError } from '../urn.js';

export function refNamesNothing(
  error: unknown,
  opts: { ambiguousNamesNothing?: boolean } = {},
): boolean {
  if (error instanceof EntityNotFoundError) return true;
  if (error instanceof UrnParseError || error instanceof UrnNotQualifiedError) return true;
  if (opts.ambiguousNamesNothing && error instanceof AmbiguousLegacyUrnError) return true;
  return false;
}
