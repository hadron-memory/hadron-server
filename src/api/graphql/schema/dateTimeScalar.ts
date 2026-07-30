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
// Scope (Holger, 2026-07-30): OUTPUT fields only. Date-valued *input*
// arguments stay `String` and keep their existing hand-rolled parsing, so this
// change cannot alter what any client is allowed to send.
//
// Wire compatibility: a `DateTime` still travels as a JSON string, so no
// runtime client breaks. Schema-driven codegen clients do see a new named
// scalar — hadron-cli (genqlient) needs a `DateTime: string` binding.
import { GraphQLScalarType, GraphQLError, Kind } from 'graphql';

/** Digits-only string — an epoch-millis value that already lost its Date type. */
const EPOCH_MILLIS = /^-?\d+$/;

/**
 * Coerce a resolver's return value to an ISO 8601 string.
 *
 * Deliberately lenient rather than validating: this runs on every date field of
 * every response, including provider pass-through values (Google Calendar,
 * Exchange, Drive) that Hadron does not mint. Rejecting an odd-but-parseable
 * provider timestamp would turn a cosmetic formatting quirk into a failed
 * query, so a non-numeric string is returned untouched. Only a value of a type
 * that can never be a timestamp throws — that is a server bug, not bad data.
 *
 * @param value Raw field value: `Date` (Prisma), ISO string (shape-mappers and
 *   provider payloads), epoch millis as number or digit-string, or nullish.
 * @returns ISO 8601 string, or `null` for a nullish input.
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

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new GraphQLError(`DateTime cannot serialize the number ${value}`);
    }
    return new Date(value).toISOString();
  }

  if (typeof value === 'string') {
    // The #205 failure mode, already stringified somewhere upstream. Recover it
    // rather than passing the client a value it will parse as Invalid Date.
    if (EPOCH_MILLIS.test(value)) return new Date(Number(value)).toISOString();
    return value;
  }

  throw new GraphQLError(
    `DateTime cannot serialize a value of type ${typeof value}`,
  );
}

/**
 * ISO 8601 timestamp scalar (issue #205).
 *
 * Output-only in practice: `parseValue` / `parseLiteral` exist so the scalar is
 * well-formed and usable as an input type later, but no argument is declared
 * `DateTime` today. They accept an ISO string and hand back the same string,
 * matching what the `String`-typed date arguments already deliver to resolvers
 * — so adopting the scalar on an input would not change resolver code.
 */
export const dateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  description:
    'An ISO 8601 timestamp, e.g. "2026-07-30T12:34:56.789Z". Always serialized ' +
    'as an ISO string — never epoch milliseconds — so Date.parse / new Date() ' +
    'work on it directly.',
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
