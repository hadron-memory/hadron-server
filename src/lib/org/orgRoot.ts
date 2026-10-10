import { GraphQLError } from 'graphql';
import { UrnParseError, hasSchemePrefix, validateUserSlug } from '../urn.js';
import { isId } from '../entityRef/shape.js';

/**
 * Validate a new or renamed org root (#1733, Holger's option (c), team chat
 * #7865). The server's create/rename rule, replacing urn-lib's
 * `validateOrgSlug`, which still requires a dotted root (#692):
 *
 * - **Bare**: no scheme prefix, no colon. `propagateOrgUrnRename` treats the
 *   first colon of a child URN as the org boundary (#376).
 * - **A legal, lowercase, non-reserved atom** (`validateUserSlug`).
 * - **Dotted or undotted.** An unverified org may take an undotted root, so a
 *   user with no domain can create an organization. Org roots and user
 *   handles share one principal pool (`mintPrincipal`), so they never collide,
 *   and a root resolves to its principal by lookup, not by its shape.
 * - **Not ID-shaped.** Entity refs dispatch an ID-shaped string to a primary
 *   key lookup (`entityRef/shape.ts`). A dotted root never matched; an
 *   undotted one can, and would then never resolve as a URN.
 *
 * Dotted roots are meant for verified domains, but no domain verification
 * exists yet, so a dotted root is accepted as before.
 */
export function validateOrgRoot(root: string): void {
  if (hasSchemePrefix(root) || root.includes(':')) {
    throw new UrnParseError(root, 'org-urn-not-bare', root);
  }
  validateUserSlug(root);
  if (isId(root)) {
    throw new GraphQLError(
      `An organization name can't look like an ID (32 hex characters, or "c" plus 24 letters and digits): "${root}".`,
      { extensions: { code: 'ORG_ROOT_ID_SHAPED' } },
    );
  }
}
