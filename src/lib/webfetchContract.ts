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
/** The tool URL the cached pass was read from: a changed WEBFETCH_TOOL_URL invalidates it (blind P3). */
let okFor: string | undefined;
/** One declaration read in flight at a time, so a burst of credentialed calls makes one GET (blind P3). */
let inflight: Promise<void> | undefined;

/** Test hook: forget a cached pass and any read in flight. */
export function resetWebfetchContractCache(): void {
  okUntil = 0;
  okFor = undefined;
  inflight = undefined;
}

function mismatch(): GraphQLError {
  return new GraphQLError(
    `The web fetch tool does not declare ${WEBFETCH_CONTRACT_VERSION} with ${WEBFETCH_REQUIRED_CAPABILITY}; a credentialed request is refused before any credential is read or sent.`,
    { extensions: { code: 'WEBFETCH_TOOL_CONTRACT_MISMATCH' } },
  );
}

type Refusal = 'unreachable' | 'undeclared' | 'wrong_version' | 'missing_capability';

/** Operator line with a fixed shape: the reason only, never the URL, the declared body or the cause text (the cause can name the tool). */
function refuse(reason: Refusal): never {
  console.warn('[webfetchContract] credentialed request refused', { reason });
  throw mismatch();
}

async function readDeclaration(now: number, url: string | undefined): Promise<void> {
  let declared: Awaited<ReturnType<typeof getWebfetchContract>> | undefined;
  try {
    declared = await getWebfetchContract();
  } catch {
    refuse('unreachable');
  }
  const caps = declared?.capabilities;
  if (declared?.contract === undefined && caps === undefined) refuse('undeclared');
  if (declared?.contract !== WEBFETCH_CONTRACT_VERSION) refuse('wrong_version');
  if (!Array.isArray(caps) || !caps.includes(WEBFETCH_REQUIRED_CAPABILITY)) refuse('missing_capability');
  okUntil = now + WEBFETCH_CONTRACT_TTL_MS;
  okFor = url;
}

/**
 * Throw WEBFETCH_TOOL_CONTRACT_MISMATCH unless the configured tool declares the contract. Only a matching answer is cached (5 minutes, for
 * the tool URL it was read from); a failure is never cached, so a tool upgraded a moment later passes on the next call without a restart.
 * The version must match exactly: a future `webfetch@3` is refused until core is taught it (a deliberate, ruled fail-closed choice).
 */
export async function assertWebfetchRedirectSafe(now: number = Date.now()): Promise<void> {
  const url = process.env.WEBFETCH_TOOL_URL;
  if (now < okUntil && okFor === url) return;
  if (!inflight) {
    inflight = readDeclaration(now, url).finally(() => {
      inflight = undefined;
    });
  }
  await inflight;
}
