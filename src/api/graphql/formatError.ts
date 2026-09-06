/**
 * Typed client errors on the GraphQL wire (#918).
 *
 * A resolver that throws a plain `Error` subclass gets wrapped by Apollo in a
 * `GraphQLError` whose `extensions.code` is `INTERNAL_SERVER_ERROR` — the
 * message survives, the type does not. So a domain error can carry a perfectly
 * good `code` internally and still reach the client as English prose the client
 * has to pattern-match, and which is free to change under it. That was #918:
 * `AssetUploadError` defines `MALWARE_BLOCKED`, `SCAN_PENDING`, `SCAN_BLOCKED`
 * and friends, and none of them reached the wire.
 *
 * This module holds ONE list of the error types that are caller errors rather
 * than server faults, and both consumers read it:
 *
 *   - `formatGraphQLError` maps each to its stable `extensions.code`;
 *   - `isExpectedClientError` tells the Sentry plugin not to report it.
 *
 * They used to be two hand-maintained `instanceof` chains in server.ts, which
 * is a drift hazard the Sentry one even documented ("the same types formatError
 * handles"): adding a mapping without adding the skip meant every typed refusal
 * — every asset NOT_FOUND — was filed as an exception. One list, two readers,
 * so a new entry cannot be half-registered.
 */
import type { GraphQLFormattedError } from 'graphql';
import { UrnNotQualifiedError, UrnParseError } from '../../lib/urn.js';
import { AmbiguousLegacyUrnError } from '../../lib/entityRef/errors.js';
import { AssetUploadError } from '../../controller/operations/beginAssetUpload.js';

interface ClientErrorMapping {
  matches: (err: unknown) => boolean;
  /** The extensions to merge onto the formatted error — `code` and any detail. */
  extensionsFor: (err: unknown) => Record<string, unknown>;
  /**
   * Whether the Sentry plugin should SKIP this error.
   *
   * Deliberately NOT implied by being mapped. Mapping answers *"does the caller
   * get a typed code?"*; this answers *"do we want to hear about it?"*, and
   * those are different questions — @Holger's call, 2026-09-06.
   *
   * Every entry states it, so adding a mapping forces the second question to be
   * answered rather than inherited. That is the anti-drift property the shared
   * list is actually for: one list, two declared columns, no second hand-kept
   * `instanceof` chain in the plugin.
   */
  silenceInSentry: boolean;
}

/** Type-safe definition site; the cast is contained here. */
function mapping<E>(
  matches: (err: unknown) => err is E,
  extensionsFor: (err: E) => Record<string, unknown>,
  { silenceInSentry }: { silenceInSentry: boolean },
): ClientErrorMapping {
  return { matches, extensionsFor: (err) => extensionsFor(err as E), silenceInSentry };
}

const CLIENT_ERROR_MAPPINGS: readonly ClientErrorMapping[] = [
  // Spec 022: surface UrnNotQualifiedError with a stable error code so external
  // callers can branch on it programmatically.
  mapping(
    (err): err is UrnNotQualifiedError => err instanceof UrnNotQualifiedError,
    (err) => ({
      code: 'URN_NOT_QUALIFIED',
      offendingValue: err.offendingValue,
      expectedType: err.expectedType,
    }),
    { silenceInSentry: true },
  ),
  // A malformed-grammar / bad-slug URN is caller error, not a server fault.
  // parseUrn / validateUserSlug (create boundaries, e.g. cloneMemory's
  // targetUrn) throw UrnParseError; without this it would surface as
  // INTERNAL_SERVER_ERROR.
  mapping(
    (err): err is UrnParseError => err instanceof UrnParseError,
    (err) => ({
      code: 'BAD_USER_INPUT',
      reason: err.reason,
      offendingValue: err.offendingSegment,
    }),
    { silenceInSentry: true },
  ),
  // #697: a legacy URN matching >1 live row through the stored alias map fails
  // LOUDLY with this typed code (never a silent wrong resolve).
  mapping(
    (err): err is AmbiguousLegacyUrnError => err instanceof AmbiguousLegacyUrnError,
    (err) => ({ code: 'AmbiguousLegacyUrnError', offendingValue: err.ref }),
    { silenceInSentry: true },
  ),
  // #918: every asset refusal in one branch, taking the code off the instance —
  // MALWARE_BLOCKED, SCAN_PENDING, SCAN_BLOCKED, NOT_FOUND, the MIME/size
  // rejections, and anything the class gains later. Mapping the class rather
  // than enumerating its codes is the point: a new refusal reaches the wire
  // typed without anyone remembering to come back here.
  //
  // Sentry: NOT silenced. Mapping these for the wire and silencing them in the
  // issue stream were proposed together; @Holger split them (2026-09-06) and
  // took only the wire half. The reason is `ASSET_BYTES_GONE` — a row whose
  // object is missing is genuine server-state inconsistency, and dropping it
  // here would remove the only alarm without adding one anywhere else. The
  // right home for that alarm is the purge/janitor path where the
  // inconsistency is DISCOVERED, and it does not exist yet (#1140).
  mapping(
    (err): err is AssetUploadError => err instanceof AssetUploadError,
    (err) => ({ code: err.code }),
    { silenceInSentry: false },
  ),
];

/**
 * Unwrap Apollo's wrapper: a thrown error arrives as a `GraphQLError` with the
 * original on `.originalError`. Errors constructed as GraphQLError directly are
 * their own original.
 */
function unwrap(error: unknown): unknown {
  return (error as { originalError?: unknown })?.originalError ?? error;
}

/**
 * True when the Sentry plugin should skip this error.
 *
 * NOT simply "is it mapped": a mapped error can still be worth reporting, and
 * `AssetUploadError` is (see its entry). Being mapped means the caller gets a
 * typed code; being silenced means we do not want the issue. Each mapping
 * declares the second independently of the first.
 *
 * Callers must pass the UNWRAPPED original (the Sentry plugin already has it);
 * at `didEncounterErrors` time the wrapper still reads INTERNAL_SERVER_ERROR,
 * which is exactly why the type has to be consulted instead of the code.
 */
export function isExpectedClientError(original: unknown): boolean {
  return CLIENT_ERROR_MAPPINGS.some((m) => m.matches(original) && m.silenceInSentry);
}

/** Apollo `formatError`: attach the stable code for every mapped client error. */
export function formatGraphQLError(
  formattedError: GraphQLFormattedError,
  error: unknown,
): GraphQLFormattedError {
  const original = unwrap(error);
  for (const m of CLIENT_ERROR_MAPPINGS) {
    if (!m.matches(original)) continue;
    return {
      ...formattedError,
      // The domain message, not Apollo's decoration of it.
      message: (original as Error).message,
      extensions: { ...formattedError.extensions, ...m.extensionsFor(original) },
    };
  }
  return formattedError;
}
