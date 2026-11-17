// The `DateTime` GraphQL scalar — the schema-level fix for issue #205.
//
// Why this exists: every date field on the API used to be declared `String!`
// and fed a Prisma `Date`. graphql-js's default `String` coercion calls
// `serializeObject(value)` first, which honours `valueOf()` — and `Date`'s
// `valueOf()` returns epoch **milliseconds as a Number**. The result is then
// `String(...)`-ified, so the wire value is `"1716943200000"`, not an ISO
// timestamp. `new Date("1716943200000")` parses that as a date *string* (not a
// number) and yields `Invalid Date` — the portal bug fixed narrowly in #204
// (hadron-memory/hadron-portal#244).
//
// #204 patched the three worst fields with per-field `toISO()` resolvers. The
// audit in #205 found 43 more across 24 types — and the whole spec-040 headless
// family (`AppRun`, `AgentSchedule`, `AgentWebhook`, `ActionTicket`,
// `QuotaCounter`) shipped with no type resolver map at all, so nobody had a
// place to forget the entry. Per-field resolvers make correctness opt-in and
// re-breakable by every new type; a scalar makes it structural — a field typed
// `DateTime` cannot serialize as epoch-millis no matter what the resolver
// returns.
//
// Original scope (Holger, 2026-07-30): output fields only; existing String
// date inputs keep their parsing. #2784 adds new optional DateTime window
// inputs on usageEvents/usageEventsPage without changing any existing input.
//
// Wire compatibility: a `DateTime` still travels as a JSON string, so no
// runtime client breaks. Schema-driven codegen clients do see a new named
// scalar — hadron-cli (genqlient) needs a `DateTime: string` binding.
//
// The guarantee is "parseable by Date.parse", not "byte-for-byte ISO UTC":
// values Hadron mints go through `Date.toISOString()`, while a provider
// pass-through value (calendar / mail / drive) keeps the provider's own
// representation so a non-UTC offset survives. Anything unparseable is
// rejected rather than forwarded — see serializeDateTime.
import { GraphQLScalarType, GraphQLError, Kind } from 'graphql';

/** Digits-only string — an epoch-millis value that already lost its Date type. */
const EPOCH_MILLIS = /^-?\d+$/;

/**
 * Epoch millis → ISO, rejecting anything `Date` can't represent.
 *
 * `new Date(n).toISOString()` throws a raw `RangeError: Invalid time value`
 * outside ±8.64e15 ms, so a finite-but-absurd number (or a long digit string)
 * would escape as an unhandled RangeError rather than a GraphQLError. Checking
 * `getTime()` catches non-finite and out-of-range in one test.
 */
function fromEpochMillis(millis: number, raw: unknown): string {
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) {
    throw new GraphQLError(
      `DateTime cannot serialize an out-of-range timestamp: ${String(raw)}`,
    );
  }
  return date.toISOString();
}

/**
 * Coerce a resolver's return value to a timestamp string every client can parse.
 *
 * The contract is `Date.parse`-able, which is what #205 is actually about.
 * Hadron-minted values (Prisma `Date`s) always come out as ISO 8601 UTC. A
 * string is only passed through when it already parses — that preserves the
 * representation a provider chose, including a non-UTC offset that
 * round-tripping through `toISOString()` would flatten to Z.
 *
 * An UNPARSEABLE string throws rather than passing through. The earlier
 * lenient-passthrough version justified itself as "don't turn a provider quirk
 * into a failed query", but that argument only ever covered *parseable* odd
 * formatting: forwarding genuine junk hands the client the exact `Invalid Date`
 * this scalar exists to prevent, under a field documented as a timestamp. A
 * GraphQL error on that one field is the honest outcome (PR #834 review).
 *
 * @param value Raw field value: `Date` (Prisma), a parseable timestamp string
 *   (shape-mappers and provider payloads), epoch millis as number or
 *   digit-string, or nullish.
 * @returns A `Date.parse`-able string, or `null` for a nullish input.
 */
function serializeDateTime(value: unknown): string | null {
  if (value == null) return null;

  if (value instanceof Date) {
    // An invalid Date would stringify to "Invalid Date" and poison the client
    // exactly the way epoch-millis did — surface it as a server error instead.
    if (Number.isNaN(value.getTime())) {
      throw new GraphQLError('DateTime cannot serialize an invalid Date');
    }
    return value.toISOString();
  }

  if (typeof value === 'number') return fromEpochMillis(value, value);

  if (typeof value === 'string') {
    // Absent, not malformed. The capability-tool contracts use `null` for a
    // missing timestamp, but a provider sending "" instead is unambiguously
    // "no value" — reading it as null loses no signal, where throwing would
    // fail an otherwise fine nullable field over a formatting nit.
    if (value.trim() === '') return null;
    // The #205 failure mode, already stringified somewhere upstream. Recover it
    // rather than passing the client a value it will parse as Invalid Date.
    if (EPOCH_MILLIS.test(value)) return fromEpochMillis(Number(value), value);
    if (Number.isNaN(Date.parse(value))) {
      throw new GraphQLError(
        `DateTime cannot serialize an unparseable timestamp: ${value}`,
      );
    }
    return value;
  }

  throw new GraphQLError(
    `DateTime cannot serialize a value of type ${typeof value}`,
  );
}

/**
 * ISO 8601 timestamp scalar (issue #205).
 *
 * `parseValue` / `parseLiteral` serve the optional usage-event window inputs
 * (#2784). They accept an ISO string and hand back the same string,
 * matching what the `String`-typed date arguments already deliver to resolvers
 * — so adopting the scalar on an input would not change resolver code.
 */
export const dateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  description:
    'A timestamp string, e.g. "2026-07-30T12:34:56.789Z". Guaranteed parseable ' +
    'by Date.parse / new Date() — never epoch milliseconds. Values Hadron mints ' +
    'are ISO 8601 UTC; a value passed through from an external provider keeps ' +
    "that provider's representation (which may carry a non-UTC offset).",
  serialize: serializeDateTime,

  /** Accept an ISO string from a variable; hand resolvers the string unchanged. */
  parseValue(value: unknown): string {
    if (typeof value !== 'string') {
      throw new GraphQLError('DateTime must be an ISO 8601 string');
    }
    if (Number.isNaN(Date.parse(value))) {
      throw new GraphQLError(`DateTime is not a valid ISO 8601 string: ${value}`);
    }
    return value;
  },

  /** Accept an inline ISO string literal; hand resolvers the string unchanged. */
  parseLiteral(ast): string {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError('DateTime must be an ISO 8601 string', { nodes: ast });
    }
    if (Number.isNaN(Date.parse(ast.value))) {
      throw new GraphQLError(
        `DateTime is not a valid ISO 8601 string: ${ast.value}`,
        { nodes: ast },
      );
    }
    return ast.value;
  },
});
