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
 * than server faults, and both consumers read it (#1174 added the whole
 * entity-not-found family the same way — one entry, by base class):
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
import { GraphQLError as GraphQLErrorClass, Kind, type GraphQLError, type GraphQLFormattedError } from 'graphql';
import { publicErrorExtensions } from '../../lib/errorDiagnostics.js';
import { faultRequestId, INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE, logInternalFault } from '../../lib/internalFault.js';
import { UrnNotQualifiedError, UrnParseError } from '../../lib/urn.js';
import { AmbiguousLegacyUrnError } from '../../lib/entityRef/errors.js';
import { EntityNotFoundError } from '../../lib/entityRef/entityNotFound.js';
import { AssetUploadError } from '../../controller/operations/beginAssetUpload.js';
import { QueryTooComplexError } from './admissionComplexity.js';
import { GitCommandError } from '../../integrations/github/execGit.js';

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
  // hadron-internal#3 L4: an over-limit operation is the caller's, not a fault. The refusal already carries its fixed
  // text and `extensions` (code, limit, max, http status), so nothing is added.
  mapping(
    (err): err is QueryTooComplexError => err instanceof QueryTooComplexError,
    () => ({}),
    { silenceInSentry: true },
  ),
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
  // #1578/#1789: git failures carry a FIXED message by design (argv and stderr can hold the installation token), so the
  // text is safe and the code is the class's own. Still reported: a failing sync is ours to know about.
  mapping(
    (err): err is GitCommandError => err instanceof GitCommandError,
    (err) => ({ code: err.code }),
    { silenceInSentry: false },
  ),
  // #1174: every "that ref names nothing" error, by BASE CLASS — the code
  // comes off the instance, so a not-found added later is typed on the wire
  // without touching this file (the AssetUploadError lesson above).
  //
  // Before this, the code existed only inside the message
  // (`ORGANIZATION_NOT_FOUND: nosuch.example`) while `extensions.code` said
  // INTERNAL_SERVER_ERROR, so no client could classify a typo without parsing
  // prose — `conventions:the-error-code-is-the-contract-the-prose-is-not`.
  //
  // Sentry: SILENCED, and that is half the fix rather than a tidy-up. The
  // issue's sharpest argument is about ALERTING — INTERNAL_SERVER_ERROR is
  // what an operator builds a page-me rule on, so a user's typo trips the
  // alarm that should mean the server broke. Mapping the code alone would move
  // that noise from the wire to the issue stream instead of removing it. Every
  // one of these is raised by a `resolve<Entity>Ref` on a CALLER-SUPPLIED ref:
  // the miss is a fact about the ref, not about us — the same call already
  // taken for URN_NOT_QUALIFIED above.
  mapping(
    (err): err is EntityNotFoundError => err instanceof EntityNotFoundError,
    (err) => ({ code: err.code, ref: err.ref }),
    { silenceInSentry: true },
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

/**
 * Whether an error is a typed domain refusal, whose code and text a caller may see (#1789, cor:api:260:01).
 *
 * Trusted: a mapped domain class above, or a GraphQLError this server authored with an explicit code of its own. NOT
 * trusted: a plain Error whatever its prose (an `Error('Forbidden')` is not a refusal by sounding like one: type it, see
 * lib/refusals.ts), or anything wearing Apollo's default INTERNAL_SERVER_ERROR. Prisma and other foreign errors never
 * arrive as a GraphQLError of ours, so they fall to the fault side.
 */
export function isTrustedRefusal(error: unknown): boolean {
  const original = unwrap(error);
  if (CLIENT_ERROR_MAPPINGS.some((m) => m.matches(original))) return true;
  if (original instanceof GraphQLErrorClass) {
    const code = original.extensions?.code;
    return typeof code === 'string' && code !== INTERNAL_ERROR_CODE;
  }
  return false;
}

/** Apollo error boundary: conceal diagnostics and coercion values, retaining public domain codes/fields. */
export function formatGraphQLError(
  formattedError: GraphQLFormattedError,
  error: unknown,
): GraphQLFormattedError {
  // #2087: graphql-js attaches the variable DEFINITION to execution-time coercion
  // failures (including nested/list/custom scalars). Resolver errors have a field
  // path instead; schema validation retains its distinct Apollo code. Never inspect or
  // reconstruct rejected-value prose, and never spread its supplied extensions.
  const executionError = error as GraphQLError | null | undefined;
  if (executionError && executionError.path == null &&
      Array.isArray(executionError.nodes) && executionError.nodes.length === 1 &&
      executionError.nodes[0]?.kind === Kind.VARIABLE_DEFINITION &&
      formattedError.extensions?.code !== 'GRAPHQL_VALIDATION_FAILED') {
    return {
      message: 'Invalid GraphQL variable input.',
      locations: formattedError.locations,
      path: formattedError.path,
      extensions: { code: 'BAD_USER_INPUT' },
    };
  }
  // #2087: supplied diagnostics are unsafe even when Apollo suppresses its own stacks.
  if (formattedError.extensions && ('stacktrace' in formattedError.extensions || 'exception' in formattedError.extensions)) {
    formattedError = { ...formattedError, extensions: publicErrorExtensions(formattedError.extensions) };
  }
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
  // #1789 (cor:api:260:01): anything still carrying Apollo's default wrap code is a fault, not a typed refusal: a
  // refusal either maps above or carries an explicit code of its own (GRAPHQL_VALIDATION_FAILED, UNAUTHENTICATED,
  // FORBIDDEN, ...), and those keep their text. A fault shows the generic code and a request id; the complete exception,
  // including a Prisma message with query arguments (#1688), goes to the log under that id.
  // The wrapper's public code never overrides the classification of what it wraps (LOCAL P2-1): a GraphQLError that
  // wears a code around a foreign driver Error is still a fault. Errors built directly as GraphQLError (Apollo's own
  // validation/parse/bad-request failures) unwrap to themselves and stay trusted through their explicit code.
  // Apollo's own failures (validation, parse, complexity) reach here as a GraphQLError original under a coded wrapper.
  const code = formattedError.extensions?.code;
  const graphqlOriginal = original instanceof GraphQLErrorClass &&
    typeof code === 'string' && code !== INTERNAL_ERROR_CODE;
  if (!graphqlOriginal && !isTrustedRefusal(original)) {
    const requestId = faultRequestId();
    logInternalFault('graphql', Array.isArray(formattedError.path) ? formattedError.path.join('.') : 'request', requestId, original);
    return {
      message: INTERNAL_ERROR_MESSAGE,
      locations: formattedError.locations,
      path: formattedError.path,
      extensions: { code: INTERNAL_ERROR_CODE, requestId },
    };
  }
  return formattedError;
}
