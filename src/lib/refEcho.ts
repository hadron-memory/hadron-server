/**
 * #5168: a refusal never quotes the value the caller typed as a reference.
 *
 * The URN library builds its two parse refusals around the input: `UrnNotQualifiedError` says
 * `URN "<value>" is not fully qualified. …` and `UrnParseError` says `URN "<value>" does not match …` (or
 * `Slug "<value>" must be lowercase …`). A token or password pasted into a ref argument by mistake therefore came back
 * verbatim, padded if it was padded, in the caller's terminal, CI log and every client that logs errors. The library is
 * shared with other consumers, so the server conceals the value at its own two error boundaries instead: the GraphQL
 * formatter (`formatGraphQLError`) and the MCP tool boundary (`toolErrorResult`, `withToolErrorBoundary`).
 *
 * The CODE is untouched: `URN_NOT_QUALIFIED` and the parse error's `reason` are Durable
 * (hrn:node:hadronmemory.com:specs:cor:urn:010:02); only the wording, which that rule makes Tunable, loses the value.
 * The remedy text the library appends (the expected shape and segment count) is kept.
 *
 * The rewrite is done ON the instance (its `message`), because the MCP tools render `error.message` through a closure
 * each tool supplies; rewriting the one shared object is what reaches every one of them without touching each tool.
 */
import { UrnNotQualifiedError, UrnParseError, type UrnParseErrorReason } from './urn.js';

/** The parse refusal's text per reason, with nothing the caller typed in it. */
const PARSE_MESSAGES: Record<UrnParseErrorReason, string> = {
  'unknown-type': 'The URN uses an unknown type. The type segment after the scheme prefix ("hrn:" or legacy "urn:") must be one of the registered types.',
  'malformed-grammar': 'The value does not match the expected "hrn:<type>:<path>" URN grammar (legacy "urn:" scheme also accepted).',
  'empty-segment': 'The URN contains an empty path-segment (caused by "::::" or similar). Each "::"-separated piece must be non-empty.',
  'trailing-double-colon': 'The URN ends with "::". Remove the trailing separator.',
  'reserved-word-slug': 'The slug is a reserved word and cannot be used. Reserved words are URN type names (agent, app, memory, …) and memory role markers (system, app-user, priv, …). Pick a different name.',
  'invalid-charset': 'The slug contains characters outside the allowed set. Slugs may use letters, digits, dots, underscores, and hyphens; they must start and end with a letter or digit.',
  'slug-not-lowercase': 'The slug must be lowercase. URN lookups are case-sensitive, so a mixed-case slug would name a distinct entity.',
  'slug-too-long': 'The slug exceeds the 64-character limit. Pick a shorter name.',
  'loc-segment-rejected': 'The URN contains a "loc:" segment. The "loc:" prefix is deprecated; rewrite the URN using the current grammar.',
  'invalid-segment-shape': 'A URN path-segment has the wrong number of ":"-separated parts for its position.',
  'fragment-unsupported': 'The URN carries an unsupported fragment. The only registered fragment is "#data", on a node or apprun URN only. Drop the fragment.',
  'empty-bare-value': 'A bare URN value must contain at least one slug atom.',
  'already-prefixed-bare-value': 'The bare value starts with a scheme prefix ("hrn:" or "urn:"). Pass the bare value; the prefix is composed for you.',
  'org-urn-not-bare': 'An organization URN must be a bare slug: no scheme prefix ("hrn:"/"urn:") and no ":" separator. Submit only the bare "<slug>" (e.g. "acme.com").',
  'root-id-shaped': 'A root cannot look like an entity ID (32 hex characters, or "c" plus 24 lowercase letters and digits). Pick a different name.',
  'handle-has-dot': 'A user handle must not contain a ".".',
  'empty-derived-slug': 'A URN slug cannot be derived from this value: it has no letters or digits. Choose a name with at least one alphanumeric character.',
};

const GENERIC_PARSE_MESSAGE = 'The value is not a valid URN.';

/**
 * The library message of an unqualified-URN refusal with the quoted value removed: `URN "<v>" is not fully
 * qualified. <hint>` becomes `The ref is not a fully qualified URN. <hint>`. The prefix is rebuilt from the instance's
 * own `offendingValue`, so a value that itself contains `is not fully qualified` cannot shift the cut.
 */
function unqualifiedMessage(err: UrnNotQualifiedError): string {
  const prefix = `URN "${err.offendingValue}" is not fully qualified. `;
  const hint = err.message.startsWith(prefix) ? err.message.slice(prefix.length) : '';
  const kind = err.expectedType ? `${err.expectedType} ` : '';
  return `The ref is not a fully qualified ${kind}URN.${hint ? ` ${hint}` : ''}`;
}

/**
 * Refusals whose message this module already rewrote, with the quoted message each one had: their text is the concealed
 * one and is returned as is, and a wrapper still holding the quoted copy is rewritten on a later pass.
 */
const concealed = new WeakMap<object, string>();

/** The concealed text for a URN library refusal, or null when the error is not one. */
export function concealedUrnRefusalMessage(err: unknown): string | null {
  if ((err instanceof UrnNotQualifiedError || err instanceof UrnParseError) && concealed.has(err)) return err.message;
  if (err instanceof UrnNotQualifiedError) return unqualifiedMessage(err);
  if (err instanceof UrnParseError) return PARSE_MESSAGES[err.reason] ?? GENERIC_PARSE_MESSAGE;
  return null;
}

/**
 * Rewrites, in place, the message of every URN library refusal in an error's wrap chain (`originalError`, `cause`), and
 * of the wrapper itself when it merely repeated that message (Apollo's `GraphQLError` copies the original's text).
 * Idempotent: a concealed message is never rewritten again. Returns the error it was given.
 */
export function concealRefEcho<E>(error: E): E {
  try {
    concealChain(error);
  } catch {
    // An object whose properties throw on access is not a URN refusal; the boundary classifies it a fault on its own
    // (toolError's containsDatabaseDiagnostic fails closed on the same object), so there is nothing to conceal.
  }
  return error;
}

function concealChain(error: unknown): void {
  const seen = new Set<unknown>();
  let current: unknown = error;
  const wrappers: { message: string }[] = [];
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const text = concealedUrnRefusalMessage(current);
    if (text !== null) {
      const original = concealed.get(current) ?? (current as Error).message;
      for (const w of wrappers) if (w.message === original) setMessage(w, text);
      if ((current as Error).message !== text) setMessage(current as Error, text);
      if (!concealed.has(current)) concealed.set(current, original);
      break;
    }
    if (typeof (current as { message?: unknown }).message === 'string') wrappers.push(current as { message: string });
    const next = current as { originalError?: unknown; cause?: unknown };
    current = next.originalError ?? next.cause;
  }
}

function setMessage(target: { message: string }, message: string): void {
  target.message = message;
}

/** #5168: the text to show for a caught error that may be a URN library refusal: its concealed text, else its message. */
export function refusalText(err: unknown): string {
  return concealedUrnRefusalMessage(err) ?? (err instanceof Error ? err.message : String(err));
}
