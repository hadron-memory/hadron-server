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
 * ref argument (`ref`, `*Ref`, `urn`, `*Urn`) is called as a platform ADMIN with a canary shaped like a pasted token,
 * bare and padded. Two assertions per (door, argument, variant):
 *   - no message and no extension value carries the canary;
 *   - the code is the one main answered before the change (gate condition (a): typed codes unchanged), read from the
 *     golden `refEcho5168.codes.json`. A door absent from the golden is a new door and must not echo either.
 * Set `REF_ECHO_5168_RECORD=<path>` to write the observed codes instead of asserting them (how the golden was made, on
 * main 446acb581).
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import {
  buildASTSchema, getNamedType, isEnumType, isInterfaceType, isListType, isNonNullType, isObjectType, isScalarType,
  isUnionType, parse, type GraphQLField, type GraphQLType,
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
const GOLDEN = fileURLToPath(new URL('./__fixtures__/refEcho5168.codes.json', import.meta.url));

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
beforeAll(() => server.start());
afterAll(() => server.stop());

let admin: string;
beforeEach(async () => {
  await cleanDb(db);
  admin = (await db.user.create({
    data: { id: generateId(), handle: 'ref-echo-admin', email: 'ref-echo-5168@example.test', roles: ['ADMIN'] },
  })).id;
});

const schema = buildASTSchema(typeof typeDefs === 'string' ? parse(typeDefs) : (typeDefs as never), { assumeValidSDL: true });
const isRefArg = (n: string) => /^ref$|Ref$|^urn$|Urn$/.test(n);

function literal(t: GraphQLType): string | null {
  const inner = isNonNullType(t) ? t.ofType : t;
  if (isListType(inner)) return null;
  const base = getNamedType(t);
  if (isEnumType(base)) return base.getValues()[0]!.name;
  if (isScalarType(base)) {
    if (base.name === 'Int' || base.name === 'Float') return '1';
    if (base.name === 'Boolean') return 'false';
    if (base.name === 'JSON') return '{}';
    return '"x"';
  }
  return null;
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

async function probeAll(): Promise<Probe[]> {
  const out: Probe[] = [];
  for (const [kind, root] of [['query', schema.getQueryType()!], ['mutation', schema.getMutationType()!]] as const) {
    for (const f of Object.values(root.getFields()) as GraphQLField<unknown, unknown>[]) {
      const refs = f.args.filter((a) => isRefArg(a.name) && ['ID', 'String'].includes(getNamedType(a.type).name));
      if (refs.length === 0) continue;
      const fill: string[] = [];
      let ok = true;
      for (const o of f.args.filter((a) => !refs.includes(a) && isNonNullType(a.type))) {
        const v = literal(o.type);
        if (v === null) { ok = false; break; }
        fill.push(`${o.name}: ${v}`);
      }
      if (!ok) continue;
      for (const ra of refs) {
        for (const [variant, value] of VARIANTS) {
          const others = refs.filter((r) => r !== ra && isNonNullType(r.type)).map((r) => `${r.name}: "x"`);
          const args = [...fill, `${ra.name}: ${JSON.stringify(value)}`, ...others].join(', ');
          const res = await server.executeOperation(
            { query: `${kind} { ${f.name}(${args}) ${selection(f.type)} }` },
            { contextValue: { db, userId: admin, roles: ['ADMIN'] } as Context },
          );
          const body = res.body.kind === 'single' ? res.body.singleResult : null;
          const errors = body?.errors ?? [];
          const e = errors[0];
          const where = errors.flatMap((err) => echoPaths({ message: err.message, extensions: err.extensions }, 'error'));
          out.push({
            key: `${kind}.${f.name}(${ra.name}) ${variant}`,
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
  }, 600_000);
});
