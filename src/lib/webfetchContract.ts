import { GraphQLError } from 'graphql';
import { getWebfetchContract } from './webfetchClient.js';

/**
 * #4882 (follow-up to #4775 / #4873, ruling option (a) in #139232, posture ruled in #139534): the fail-closed gate that stops a
 * credential being sent to a webfetch tool that may follow a redirect. The tool declares what it honours at `GET /ops/contract`
 * (hadrontool-webfetch#13); core refuses a secret-bearing `web_request` unless it declares this contract AND the capability below.
 * A tool that declares nothing (404, unreachable, malformed, unset) is a mismatch. Specs: cor:int:030:01, cor:sec:030:01.
 *
 * The refusal text is fixed: it never carries a URL, the declared body or any request data.
 */
export const WEBFETCH_CONTRACT_VERSION = 'webfetch@2' as const;
export const WEBFETCH_REQUIRED_CAPABILITY = 'redirects-none' as const;
export const WEBFETCH_CONTRACT_TTL_MS = 5 * 60_000;

let okUntil = 0;

/** Test hook: forget a cached pass. */
export function resetWebfetchContractCache(): void {
  okUntil = 0;
}

function mismatch(): GraphQLError {
  return new GraphQLError(
    `The web fetch tool does not declare ${WEBFETCH_CONTRACT_VERSION} with ${WEBFETCH_REQUIRED_CAPABILITY}; a credentialed request is refused before any credential is read or sent.`,
    { extensions: { code: 'WEBFETCH_TOOL_CONTRACT_MISMATCH' } },
  );
}

/**
 * Throw WEBFETCH_TOOL_CONTRACT_MISMATCH unless the configured tool declares the contract. Only a matching answer is cached (5 minutes);
 * a failure is never cached, so a tool upgraded a moment later passes on the next call without a restart.
 */
export async function assertWebfetchRedirectSafe(now: number = Date.now()): Promise<void> {
  if (now < okUntil) return;
  let declared;
  try {
    declared = await getWebfetchContract();
  } catch {
    throw mismatch();
  }
  const caps = declared?.capabilities;
  if (declared?.contract !== WEBFETCH_CONTRACT_VERSION || !Array.isArray(caps) || !caps.includes(WEBFETCH_REQUIRED_CAPABILITY)) {
    throw mismatch();
  }
  okUntil = now + WEBFETCH_CONTRACT_TTL_MS;
}
