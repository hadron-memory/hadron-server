import { GraphQLError } from 'graphql';
import { UrnParseError, validateOrgSlug } from '../urn.js';

/**
 * Validate a new or renamed org root (#1733, Holger's option (c), team chat
 * #7865). The rule itself lives in urn-lib (`validateOrgSlug`, 0.0.17+): a bare,
 * legal, lowercase, non-reserved atom, dotted or undotted, that is neither
 * ID-shaped nor the scheme words `hrn` / `urn`. This server used its own copy
 * of the rule while the lib still required a dotted root (#692); with the lib
 * released there is one rule and this is a thin wrapper.
 *
 * The one thing kept here is the GraphQL error code: an ID-shaped root is
 * surfaced as `ORG_ROOT_ID_SHAPED`, the code clients already match on, not as a
 * bare `UrnParseError`.
 *
 * Org roots and user handles share one principal pool (`mintPrincipal`), so
 * they never collide, and a root resolves to its principal by lookup, not by
 * its shape. No domain verification exists, so a dotted root means nothing.
 */
export function validateOrgRoot(root: string): void {
  try {
    validateOrgSlug(root);
  } catch (e) {
    if (e instanceof UrnParseError && e.reason === 'root-id-shaped') {
      throw new GraphQLError(
        `An organization name can't look like an ID (32 hex characters, or "c" plus 24 letters and digits): "${root}".`,
        { extensions: { code: 'ORG_ROOT_ID_SHAPED' } },
      );
    }
    throw e;
  }
}
