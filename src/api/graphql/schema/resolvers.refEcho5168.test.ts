/**
 * #5168: a refusal for a malformed ref never quotes the value the caller typed.
 *
 * A token pasted into a ref argument by mistake used to come back verbatim in the refusal's message
 * (`URN "<value>" is not fully qualified…`, `ORGANIZATION_NOT_FOUND: <value>`, `No match for orgRef "<value>".`) and in
 * the GraphQL extensions relay (`offendingValue`, `offendingSegment`, `ref`), so it reached the caller's terminal, CI
 * logs and any client that logs errors. The rejection's CODE is Durable and its wording Tunable
 * (hrn:node:hadronmemory.com:specs:cor:urn:010:02, hrn:node:hadronmemory.com:specs:cor:api:140:01), so the fix keeps
 * every code and takes the value out of the text and the extensions.
 *
 * The door pin is QA's probe from the issue, made an acceptance test: every Query and Mutation field with a top-level
 * ref argument (`ref`, `*Ref`, `urn`, `*Urn`; since #5225 item 6 also `id` and `*Id`, and the same names one level
 * inside an input-object argument) is called as a platform ADMIN with a canary shaped like a pasted token, bare and
 * padded, each door on a fresh database. Two assertions per (door, argument, variant):
 *   - no message and no extension value carries the canary;
 *   - the code is the one main answered before the change (gate condition (a): typed codes unchanged), read from the
 *     golden `refEcho5168.codes.json`. A door absent from the golden is a new door and must not echo either.
 * Set `REF_ECHO_5168_RECORD=<path>` to write the observed codes instead of asserting them (how the golden was made, on
 * main 446acb581; the #5225 doors were added from a recording on main 6d8a0dc2c, every earlier code unchanged).
 * #5404 retired the six per-automation read and App memory-write grant doors (`setAutomationReadGrant`, `revokeAutomationReadGrant`,
 * `automationReadGrants`, `setAppMemoryWriteGrant`, `revokeAppMemoryWriteGrant`, `appMemoryWriteGrants`): their 45 rows moved to
 * `DOOR_RETIRED`, the gated answer of a retired door, before any ref is read. No other row moved.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import {
  buildASTSchema, getNamedType, isEnumType, isInputObjectType, isInterfaceType, isListType, isNonNullType, isObjectType,
  isScalarType, isUnionType, parse, type GraphQLField, type GraphQLInputObjectType, type GraphQLType,
} from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError } from '../formatError.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const CANARY_CORE = 'CANARY_5168';
const CANARY_NEEDLE = /canary[_-]5168/i;
const CANARY = `hdr_user_${CANARY_CORE}_0123456789abcdef`;
/**
 * The three values per argument: the canary bare and padded (QA's malformed tier), and a WELL-FORMED but unknown URN
 * carrying it (the issue's second tier, `MEMORY_NOT_FOUND: <urn>`): valid grammar, so it reaches each door's lookup.
 */
const VARIANTS = [
  ['bare', CANARY],
  ['padded', `  ${CANARY}  `],
  ['well-formed', `hrn:mem:acme.test:${CANARY_CORE.toLowerCase().replace(/_/g, '-')}`],
] as const;
// The golden records what each door answers. #5266 moved every row that was not a typed refusal onto one
// (INTERNAL_SERVER_ERROR on revokeAppKey, startSession's session/customer ids, node/object(ref); recordHostSweepRun's
// GRAPHQL_VALIDATION_FAILED): the golden and the probe now hold neither code. The ONE exception is group 2, the
// AiServiceConfig class names below. None of them echoes. A row's code can depend on the probe order within one target (startSession(input.customerId)
// answers SESSION_ID_TAKEN because the probe reuses `id: "x"`, so its second call finds the first call's row); each target gets a fresh database.
/**
 * Group 2 of #5266, kept on purpose: `rethrowAiConfigTyped` emits the error class name as the code, and that is a published CLIENT
 * contract (hadron-portal `src/lib/server/llm/chatError.ts` and `src/routes/app/apps/[appId]/+page.server.ts` match the exact string
 * `AiServiceConfigNotFoundError`; hadron-cli `internal/api/errors.go` lists it and the other four class names). Renaming them starts in the
 * clients, which must accept both codes first; it is a separate change, not filed.
 */
const CLIENT_CONTRACT_CLASS_CODES = new Set([
  'AiServiceConfigNotFoundError', 'DuplicateAiServiceConfigNameError', 'UnknownAiProviderError', 'NoAiConfigAvailableError', 'AiConfigValidationError',
]); // the five error classes `rethrowAiConfigTyped` emits by name
const GOLDEN = fileURLToPath(new URL('./__fixtures__/refEcho5168.codes.json', import.meta.url));

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
beforeAll(() => server.start());
afterAll(() => server.stop());

let admin: string;
/**
 * A clean database and the one admin, before every DOOR (#5225): a door that succeeds with a placeholder (`id: "x"`)
 * leaves a row that would change what a later door answers, so the codes would depend on the order doors are probed.
 */
async function freshDb() {
  await cleanDb(db);
  admin = (await db.user.create({
    data: { id: generateId(), handle: 'ref-echo-admin', email: 'ref-echo-5168@example.test', roles: ['ADMIN'] },
  })).id;
}
beforeEach(freshDb);

const schema = buildASTSchema(typeof typeDefs === 'string' ? parse(typeDefs) : (typeDefs as never), { assumeValidSDL: true });
const isRefArg = (n: string) => /^ref$|Ref$|^urn$|Urn$/.test(n);
/** #5225 item 6: an id-named argument or input field (`id`, `*Id`) is a reference too. */
const isIdArg = (n: string) => /^id$|Id$/.test(n);
const isProbed = (n: string) => isRefArg(n) || isIdArg(n);
/** An ID or String, or a list of them (a single value coerces to a one-item list): the shape a reference takes. */
const isRefShaped = (t: GraphQLType) => ['ID', 'String'].includes(getNamedType(t).name);

/** A literal for a REQUIRED argument or input field; null when none can be made (the door is skipped). */
function literal(t: GraphQLType, depth = 0): string | null {
  const inner = isNonNullType(t) ? t.ofType : t;
  if (isListType(inner)) return '[]';
  const base = getNamedType(t);
  if (isEnumType(base)) return base.getValues()[0]!.name;
  if (isScalarType(base)) {
    if (base.name === 'Int' || base.name === 'Float') return '1';
    if (base.name === 'Boolean') return 'false';
    if (base.name === 'JSON') return '{}';
    // #5266 group 3: a required DateTime gets a valid ISO 8601 literal, so the door's own resolver runs ("x" failed GraphQL validation).
    if (base.name === 'DateTime') return '"2026-01-01T00:00:00.000Z"';
    return '"x"';
  }
  if (isInputObjectType(base)) return inputObject(base, depth + 1);
  return null;
}

/** An input object with every required field filled; `set` overrides named fields (their values are literals). */
function inputObject(t: GraphQLInputObjectType, depth: number, set: Record<string, string> = {}): string | null {
  if (depth > 3) return null;
  const parts: string[] = [];
  for (const field of Object.values(t.getFields())) {
    if (field.name in set) { parts.push(`${field.name}: ${set[field.name]}`); continue; }
    if (!isNonNullType(field.type)) continue;
    const v = literal(field.type, depth);
    if (v === null) return null;
    parts.push(`${field.name}: ${v}`);
  }
  return `{ ${parts.join(', ')} }`;
}

const selection = (t: GraphQLType) => {
  const b = getNamedType(t);
  return isObjectType(b) || isInterfaceType(b) || isUnionType(b) ? '{ __typename }' : '';
};

interface Probe { key: string; code: string; echoed: boolean; message: string; where: string[] }

/** The paths (`message`, `extensions.appRef`, …) whose string carries the canary. */
function echoPaths(v: unknown, path: string, out: string[] = []): string[] {
  if (typeof v === 'string') { if (CANARY_NEEDLE.test(v)) out.push(path); }
  else if (Array.isArray(v)) v.forEach((x, i) => echoPaths(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => echoPaths(x, `${path}.${k}`, out));
  return out;
}

/**
 * One probed position: a top-level argument (`field(arg)`) or, #5225 item 6, a reference field one level inside an
 * input-object argument (`field(arg.field)`). `build` renders the whole argument list with the value in that position.
 */
interface Target { label: string; build: (value: string) => string }

function targetsOf(f: GraphQLField<unknown, unknown>): Target[] {
  const refs = f.args.filter((a) => isProbed(a.name) && isRefShaped(a.type));
  const out: Target[] = [];
  const fillExcept = (skip: Set<string>): string[] | null => {
    const fill: string[] = [];
    for (const o of f.args.filter((a) => !skip.has(a.name) && isNonNullType(a.type))) {
      const v = refs.includes(o) ? '"x"' : literal(o.type);
      if (v === null) return null;
      fill.push(`${o.name}: ${v}`);
    }
    return fill;
  };
  for (const ra of refs) {
    const fill = fillExcept(new Set([ra.name]));
    if (fill) out.push({ label: ra.name, build: (v) => [...fill, `${ra.name}: ${JSON.stringify(v)}`].join(', ') });
  }
  for (const arg of f.args) {
    const inner = isNonNullType(arg.type) ? arg.type.ofType : arg.type;
    if (!isInputObjectType(inner)) continue;
    const fill = fillExcept(new Set([arg.name]));
    if (!fill) continue;
    const fields = Object.values(inner.getFields()).filter((x) => isProbed(x.name) && isRefShaped(x.type));
    for (const field of fields) {
      const others = Object.fromEntries(fields.filter((x) => x !== field && isNonNullType(x.type)).map((x) => [x.name, '"x"']));
      // Rendered with a placeholder, then the value substituted, so `inputObject` stays a pure literal builder.
      const obj = inputObject(inner, 1, { ...others, [field.name]: '__VALUE__' });
      if (obj === null) continue;
      out.push({
        label: `${arg.name}.${field.name}`,
        build: (v) => [...fill, `${arg.name}: ${obj.replace('__VALUE__', () => JSON.stringify(v))}`].join(', '),
      });
    }
  }
  return out;
}

async function probeAll(): Promise<Probe[]> {
  const out: Probe[] = [];
  for (const [kind, root] of [['query', schema.getQueryType()!], ['mutation', schema.getMutationType()!]] as const) {
    for (const f of Object.values(root.getFields()) as GraphQLField<unknown, unknown>[]) {
      const targets = targetsOf(f);
      for (const t of targets) {
        // One database per target (blind seat F2 on #5255): a NO_ERROR on one target must not leave rows a later target's
        // probe collides with, so no code depends on the schema's field or argument order.
        await freshDb();
        for (const [variant, value] of VARIANTS) {
          const res = await server.executeOperation(
            { query: `${kind} { ${f.name}(${t.build(value)}) ${selection(f.type)} }` },
            { contextValue: { db, userId: admin, roles: ['ADMIN'] } as Context },
          );
          const body = res.body.kind === 'single' ? res.body.singleResult : null;
          const errors = body?.errors ?? [];
          const e = errors[0];
          const where = errors.flatMap((err) => echoPaths({ message: err.message, extensions: err.extensions }, 'error'));
          out.push({
            key: `${kind}.${f.name}(${t.label}) ${variant}`,
            code: e ? String(e.extensions?.code ?? 'none') : 'NO_ERROR',
            echoed: where.length > 0,
            where,
            message: e?.message?.slice(0, 200) ?? '',
          });
        }
      }
    }
  }
  return out;
}

describe('#5168: a malformed ref is refused without quoting it, on every door with a top-level ref', () => {
  it('no door echoes the value, and every door keeps the code it answered before', async () => {
    const probes = await probeAll();
    expect(probes.length).toBeGreaterThan(500);

    const record = process.env.REF_ECHO_5168_RECORD;
    if (record) {
      writeFileSync(record, JSON.stringify(Object.fromEntries(probes.map((p) => [p.key, p.code])), null, 2) + '\n');
      return;
    }

    const echoing = probes.filter((p) => p.echoed).map((p) => `${p.key} [${p.code}] ${p.where.join(',')} ${p.message}`);
    expect(echoing).toEqual([]);

    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
    const moved = probes
      .filter((p) => p.key in golden && golden[p.key] !== p.code)
      .map((p) => `${p.key}: ${golden[p.key]} -> ${p.code}`);
    expect(moved).toEqual([]);

    // #5266: no door answers a raw fault or a validation failure for a bad reference, and no class name is a code except group 2's.
    const untyped = probes.filter((p) => p.code === 'INTERNAL_SERVER_ERROR' || p.code === 'GRAPHQL_VALIDATION_FAILED').map((p) => `${p.key}: ${p.code}`);
    expect(untyped).toEqual([]);
    const classNames = probes.filter((p) => /Error$/.test(p.code) && !CLIENT_CONTRACT_CLASS_CODES.has(p.code)).map((p) => `${p.key}: ${p.code}`);
    expect(classNames).toEqual([]);
    expect(Object.entries(golden).filter(([, c]) => c === 'INTERNAL_SERVER_ERROR' || c === 'GRAPHQL_VALIDATION_FAILED')).toEqual([]);
  }, 600_000);
});
