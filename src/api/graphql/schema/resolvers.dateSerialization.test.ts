/**
 * #205 — every GraphQL date field serializes as a parseable ISO 8601 string.
 *
 * The bug (#204, hadron-memory/hadron-portal#244): a date field declared
 * `String!` and fed a Prisma `Date` goes through graphql-js's default String
 * coercion, which honours `Date.valueOf()` — epoch millis — so the wire value
 * is `"1716943200000"`. `new Date("1716943200000")` reads that as a date
 * *string* and yields `Invalid Date`.
 *
 * #204 fixed three fields with per-field `toISO()` resolvers. The #205 audit
 * found 43 more across 24 types, and the whole spec-040 headless family
 * (AppRun, AgentSchedule, AgentWebhook, ActionTicket, QuotaCounter) had no type
 * resolver map at all — there was no place to even forget the entry. The fix is
 * the `DateTime` scalar, so correctness is structural rather than opt-in.
 *
 * Three layers, because each catches a different regression:
 *   1. SCHEMA GUARD — no date-named field may be declared `String` again. This
 *      is the layer that catches a *future* type shipping unwired, which is how
 *      every instance of this bug has actually happened.
 *   2. SCALAR UNIT — the DateTime coercion itself, including the epoch-millis
 *      shapes that are the bug's signature.
 *   3. END-TO-END — real rows queried through the executable schema, proving
 *      the scalar is actually registered in the resolver map (a pure-SDL test
 *      cannot see a missing `DateTime:` entry).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import {
  buildSchema,
  getNamedType,
  isObjectType,
  GraphQLString,
  Kind,
  type GraphQLObjectType,
} from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { dateTimeScalar } from './dateTimeScalar.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null),
}));

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Assert a wire value is a non-null, parseable ISO 8601 timestamp. */
function expectIso(value: unknown, label: string): void {
  expect(value, `${label} should be present`).toBeTypeOf('string');
  expect(ISO_RE.test(value as string), `${label} = ${String(value)} is not ISO 8601`).toBe(true);
  expect(Number.isNaN(Date.parse(value as string)), `${label} is unparseable`).toBe(false);
}

// ───── layer 1: schema guard ────────────────────────────────────────────────

/**
 * Object-type fields whose name reads like a date but which are deliberately
 * NOT `DateTime`. Both are calendar DATES (YYYY-MM-DD), not instants — see the
 * SDL comments on each. Adding to this list is a real decision: a value that
 * names an instant belongs on the scalar.
 */
const NON_INSTANT_DATE_FIELDS = new Set([
  'CalendarEventTime.date', // all-day event boundary; no instant, no timezone
  'UsageActivityBucket.date', // bucket label in the caller's timezone
]);

/** Field names that denote a point in time (the shape this bug rides on). */
const DATE_NAME_RE = /At$|^dateTime$|^timestamp$|^date$|DateTime$/;

describe('#205 schema guard — date fields are DateTime, not String', () => {
  const schema = buildSchema(typeDefs);

  it('declares the DateTime scalar', () => {
    expect(schema.getType('DateTime')).toBeDefined();
  });

  it('has no date-named object field still typed String', () => {
    const offenders: string[] = [];
    for (const type of Object.values(schema.getTypeMap())) {
      if (!isObjectType(type) || type.name.startsWith('__')) continue;
      for (const [fieldName, field] of Object.entries((type as GraphQLObjectType).getFields())) {
        if (getNamedType(field.type) !== GraphQLString) continue;
        if (!DATE_NAME_RE.test(fieldName)) continue;
        const key = `${type.name}.${fieldName}`;
        if (NON_INSTANT_DATE_FIELDS.has(key)) continue;
        offenders.push(`${key}: ${field.type}`);
      }
    }
    // A failure here means a new type shipped with a String date field. Type it
    // `DateTime` — or, if it is genuinely a calendar date and not an instant,
    // add it to NON_INSTANT_DATE_FIELDS with an SDL comment saying why.
    expect(offenders).toEqual([]);
  });

  it('keeps every DateTime field on the shared scalar', () => {
    const dt = schema.getType('DateTime');
    let count = 0;
    for (const type of Object.values(schema.getTypeMap())) {
      if (!isObjectType(type) || type.name.startsWith('__')) continue;
      for (const field of Object.values((type as GraphQLObjectType).getFields())) {
        if (getNamedType(field.type) === dt) count++;
      }
    }
    // Guards against a silent mass-revert of the #205 codemod.
    expect(count).toBeGreaterThan(100);
  });

  it('leaves date-valued ARGUMENTS as String (output-only scope)', () => {
    // Holger, 2026-07-30: inputs keep their hand-rolled parsing so this change
    // cannot alter what clients are allowed to send.
    const args = schema.getQueryType()?.getFields().usageActivity?.args ?? [];
    const from = args.find((a) => a.name === 'from');
    expect(from && getNamedType(from.type)).toBe(GraphQLString);
  });
});

// ───── layer 2: the scalar itself ───────────────────────────────────────────

describe('#205 DateTime scalar coercion', () => {
  it('serializes a Prisma Date to ISO', () => {
    const d = new Date('2026-07-30T12:34:56.789Z');
    expect(dateTimeScalar.serialize(d)).toBe('2026-07-30T12:34:56.789Z');
  });

  it('serializes epoch millis (number) to ISO — the bug shape', () => {
    const d = new Date('2026-07-30T12:34:56.789Z');
    expect(dateTimeScalar.serialize(d.getTime())).toBe('2026-07-30T12:34:56.789Z');
  });

  it('serializes an epoch-millis STRING to ISO — the exact #204 wire value', () => {
    const out = dateTimeScalar.serialize('1716943200000');
    expectIso(out, 'epoch-millis string');
    expect(out).toBe(new Date(1716943200000).toISOString());
  });

  it('passes an existing ISO string through untouched', () => {
    // Shape-mappers and provider payloads already hand over ISO strings;
    // re-parsing them would drop a non-UTC offset the provider chose.
    expect(dateTimeScalar.serialize('2026-07-30T12:34:56+02:00')).toBe(
      '2026-07-30T12:34:56+02:00',
    );
  });

  it('rejects an unparseable string instead of forwarding it (PR #834 review)', () => {
    // Passing junk through would hand the client the exact Invalid Date this
    // scalar exists to prevent, under a field documented as a timestamp.
    expect(() => dateTimeScalar.serialize('not-a-date')).toThrow(/unparseable/i);
  });

  it('reads an empty string as absent, not malformed', () => {
    // A provider sending "" where the tool contract says null means "no
    // value" — null loses no signal; throwing would fail a fine nullable field.
    expect(dateTimeScalar.serialize('')).toBeNull();
    expect(dateTimeScalar.serialize('   ')).toBeNull();
  });

  it('rejects out-of-range epoch millis instead of leaking a RangeError', () => {
    // new Date(n).toISOString() throws a raw RangeError beyond ±8.64e15 ms;
    // that must surface as a GraphQLError, not an unhandled RangeError.
    expect(() => dateTimeScalar.serialize(1e20)).toThrow(/out-of-range/i);
    expect(() => dateTimeScalar.serialize(8.64e15 + 1)).toThrow(/out-of-range/i);
    expect(() => dateTimeScalar.serialize('999999999999999999999')).toThrow(
      /out-of-range/i,
    );
  });

  it('still accepts the extremes Date can represent', () => {
    expect(dateTimeScalar.serialize(8.64e15)).toBe('+275760-09-13T00:00:00.000Z');
    expect(dateTimeScalar.serialize(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('maps null and undefined to null', () => {
    expect(dateTimeScalar.serialize(null)).toBeNull();
    expect(dateTimeScalar.serialize(undefined)).toBeNull();
  });

  it('throws on an invalid Date rather than emitting "Invalid Date"', () => {
    expect(() => dateTimeScalar.serialize(new Date('nope'))).toThrow(/invalid Date/i);
  });

  it('throws on a value that can never be a timestamp', () => {
    expect(() => dateTimeScalar.serialize({ nope: true })).toThrow(/cannot serialize/i);
    expect(() => dateTimeScalar.serialize(Number.NaN)).toThrow(/cannot serialize/i);
  });

  it('parses ISO input and rejects junk (unused today, but well-formed)', () => {
    expect(dateTimeScalar.parseValue('2026-07-30T12:34:56Z')).toBe('2026-07-30T12:34:56Z');
    expect(() => dateTimeScalar.parseValue('not-a-date')).toThrow(/not a valid ISO/i);
    expect(() => dateTimeScalar.parseValue(42)).toThrow(/must be an ISO/i);
    expect(
      dateTimeScalar.parseLiteral({ kind: Kind.STRING, value: '2026-07-30T12:34:56Z' } as never, {}),
    ).toBe('2026-07-30T12:34:56Z');
    expect(() =>
      dateTimeScalar.parseLiteral({ kind: Kind.INT, value: '42' } as never, {}),
    ).toThrow(/must be an ISO/i);
  });
});

// ───── layer 3: end-to-end through the executable schema ────────────────────

const server = new ApolloServer<Context>({ typeDefs, resolvers });

async function run(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>) {
  const res = await server.executeOperation(
    { query, variables },
    { contextValue: { db, ...ctx } as Context },
  );
  if (res.body.kind !== 'single') throw new Error('unexpected incremental result');
  return res.body.singleResult;
}

/**
 * The spec-040 headless family, end to end. These five types are the reason
 * #205 exists: they shipped across #493/#494/#502/#510 with no type resolver
 * map at all, so every one of their date fields was epoch-millis on the wire.
 */
describe('#205 e2e — spec-040 headless types return ISO dates', () => {
  let org: { id: string; urn: string };
  let app: { id: string };
  let admin: { id: string };
  const ctx = (): Partial<Context> => ({ roles: ['READER'], userId: admin.id });

  beforeEach(async () => {
    await cleanDb(db);
    org = await db.organization.create({
      data: { id: generateId(), name: 'dt-org', urn: 'dt-org' },
    });
    app = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'dt-app', urn: 'dt-org::dt-app' },
    });
    admin = await db.user.create({
      data: { githubId: 9711, githubUsername: 'dt-admin', roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    });
  });

  it('AppRun.startedAt / finishedAt / createdAt', async () => {
    await db.appRun.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        appId: app.id,
        triggerKind: 'MANUAL',
        entryNodeUrn: 'dt-org::mem::tasks:go',
        status: 'COMPLETED' as const,
        startedAt: new Date('2026-07-30T10:00:00.000Z'),
        finishedAt: new Date('2026-07-30T10:00:05.000Z'),
      },
    });
    const r = await run(
      `query ($a: String) { appRuns(appRef: $a) { items { startedAt finishedAt createdAt } } }`,
      ctx(),
      { a: app.id },
    );
    expect(r.errors).toBeUndefined();
    const [item] = (r.data?.appRuns as { items: Record<string, unknown>[] }).items;
    expect(item.startedAt).toBe('2026-07-30T10:00:00.000Z');
    expect(item.finishedAt).toBe('2026-07-30T10:00:05.000Z');
    expectIso(item.createdAt, 'AppRun.createdAt');
  });

  it('AgentSchedule.runAt / nextRunAt / createdAt', async () => {
    const at = new Date('2026-08-01T09:00:00.000Z');
    await db.agentSchedule.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        appId: app.id,
        name: 'nightly',
        runAt: at,
        nextRunAt: at,
        entryNodeUrn: 'dt-org::mem::tasks:go',
      },
    });
    const r = await run(
      `query ($a: String!) { agentSchedules(appRef: $a) { items { runAt nextRunAt lastRunAt createdAt } } }`,
      ctx(),
      { a: app.id },
    );
    expect(r.errors).toBeUndefined();
    const [item] = (r.data?.agentSchedules as { items: Record<string, unknown>[] }).items;
    expect(item.runAt).toBe('2026-08-01T09:00:00.000Z');
    expect(item.nextRunAt).toBe('2026-08-01T09:00:00.000Z');
    expect(item.lastRunAt).toBeNull(); // nullable date stays null, not "null"
    expectIso(item.createdAt, 'AgentSchedule.createdAt');
  });

  it('AgentWebhook.lastCalledAt / createdAt', async () => {
    await db.agentWebhook.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        appId: app.id,
        name: 'hook',
        secret: generateId(),
        entryNodeUrn: 'dt-org::mem::tasks:go',
        lastCalledAt: new Date('2026-07-29T08:15:00.000Z'),
      },
    });
    const r = await run(
      `query ($a: String!) { agentWebhooks(appRef: $a) { items { lastCalledAt createdAt } } }`,
      ctx(),
      { a: app.id },
    );
    expect(r.errors).toBeUndefined();
    const [item] = (r.data?.agentWebhooks as { items: Record<string, unknown>[] }).items;
    expect(item.lastCalledAt).toBe('2026-07-29T08:15:00.000Z');
    expectIso(item.createdAt, 'AgentWebhook.createdAt');
  });

  it('QuotaCounter.resetAt (materialized rows)', async () => {
    const r = await run(
      `query ($o: String!) { quotaCounters(orgRef: $o) { action resetAt } }`,
      ctx(),
      { o: org.id },
    );
    expect(r.errors).toBeUndefined();
    const rows = r.data?.quotaCounters as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expectIso(row.resetAt, `QuotaCounter(${row.action}).resetAt`);
  });
});

/**
 * A field that #204 already fixed with a per-field resolver, re-checked after
 * those resolvers were deleted in favour of the scalar — the regression this
 * PR could plausibly have introduced.
 */
describe('#205 e2e — types that had per-field toISO resolvers still return ISO', () => {
  let org: { id: string };
  let admin: { id: string };

  beforeEach(async () => {
    await cleanDb(db);
    org = await db.organization.create({
      data: { id: generateId(), name: 'dt-org2', urn: 'dt-org2' },
    });
    admin = await db.user.create({
      data: { githubId: 9712, githubUsername: 'dt-admin2', roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    });
  });

  it('Organization.createdAt / updatedAt and OrgMember.createdAt', async () => {
    const r = await run(
      `query ($o: ID!) { organization(ref: $o) { createdAt updatedAt members { createdAt } } }`,
      { roles: ['READER'], userId: admin.id } as Partial<Context>,
      { o: org.id },
    );
    expect(r.errors).toBeUndefined();
    const o = r.data?.organization as { createdAt: unknown; updatedAt: unknown; members: { createdAt: unknown }[] };
    expectIso(o.createdAt, 'Organization.createdAt');
    expectIso(o.updatedAt, 'Organization.updatedAt');
    // OrgMember.createdAt had NO resolver before #205 — epoch millis on the wire.
    expectIso(o.members[0]?.createdAt, 'OrgMember.createdAt');
  });
});
