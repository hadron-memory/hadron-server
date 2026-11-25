/**
 * #5050 — `appRuns` types its three ref arguments with ONE scalar, `ID` (hrn:node:hadronmemory.com:specs:cor:api:140:01:
 * the ref family shares one scalar; Vera's FIT on #4995, 7125412022, COMPLIANT for `ID`). Before this change `appRef` and
 * `orgRef` were `String` and `parentRunRef` was `ID`, so no single client variable type fit all three.
 *
 * A paired, BREAKING cutover (ruling 0274, the #4766 pattern): a document that declares `$appRef: String` or
 * `$orgRef: String` no longer validates. The companions hadron-cli#3107 and hadron-portal#2605 move their documents to `ID`
 * and merge only after this one is deployed. The pins below execute the companions' documents as they ship TODAY (refused)
 * and as they ship AFTER (accepted, same rows), and pin that the resolver behaves exactly as before for every ref form.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { buildSchema, getNamedType, isNonNullType, type GraphQLObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { testRunAgentId } from '../../../test/runAgent.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
const ADMIN = { roles: ['ADMIN'] } as Partial<Context>;

async function exec(query: string, variables: Record<string, unknown>, ctx: Partial<Context> = ADMIN) {
  const out = await server.executeOperation({ query, variables }, { contextValue: { db, roles: [], ...ctx } as Context });
  if (out.body.kind !== 'single') throw new Error('incremental response');
  return out.body.singleResult;
}
const ids = (r: { data?: unknown }) => ((r.data as any).appRuns.items as { id: string }[]).map((i) => i.id).sort();
const code = (r: { errors?: readonly { extensions?: Record<string, unknown> }[] }) => r.errors?.[0]?.extensions?.code;
/** The answer without error `locations`: a variable and a literal sit at different columns of their documents. */
const answer = (r: { data?: unknown; errors?: readonly { locations?: unknown }[] }) => ({
  data: r.data,
  errors: r.errors?.map(({ locations: _locations, ...rest }) => rest),
});

/** hadron-cli `internal/api/queries/runs.graphql` `AppRuns`, variable block as shipped before hadron-cli#3107. */
const CLI_BEFORE = `query AppRuns($appRef: String, $orgRef: String, $status: AppRunStatus, $statuses: [AppRunStatus!], $parentRunId: ID,
  $sortBy: AppRunSortField, $sortDir: SortDirection, $limit: Int, $offset: Int) {
  appRuns(appRef: $appRef, orgRef: $orgRef, status: $status, statuses: $statuses, parentRunRef: $parentRunId, sortBy: $sortBy, sortDir: $sortDir, limit: $limit, offset: $offset) { total items { id } } }`;
/** The same document after hadron-cli#3107: `$appRef` and `$orgRef` become `ID`. */
const CLI_AFTER = CLI_BEFORE.replace('$appRef: String', '$appRef: ID').replace('$orgRef: String', '$orgRef: ID');
/** hadron-portal `src/lib/server/queries.ts` `APP_RUNS_QUERY` / `ORG_APP_RUNS_QUERY`, before hadron-portal#2605. */
const PORTAL_APP_BEFORE = `query AppRuns($appRef: String, $statuses: [AppRunStatus!], $sortBy: AppRunSortField, $sortDir: SortDirection, $limit: Int, $offset: Int) {
  appRuns(appRef: $appRef, statuses: $statuses, sortBy: $sortBy, sortDir: $sortDir, limit: $limit, offset: $offset) { items { id } total } }`;
const PORTAL_ORG_BEFORE = `query OrgAppRuns($orgRef: String, $status: AppRunStatus, $sortBy: AppRunSortField, $sortDir: SortDirection, $limit: Int, $offset: Int) {
  appRuns(orgRef: $orgRef, status: $status, sortBy: $sortBy, sortDir: $sortDir, limit: $limit, offset: $offset) { items { id } total } }`;
const PORTAL_APP_AFTER = PORTAL_APP_BEFORE.replace('$appRef: String', '$appRef: ID');
const PORTAL_ORG_AFTER = PORTAL_ORG_BEFORE.replace('$orgRef: String', '$orgRef: ID');

let orgId: string;
let orgUrn: string;
let appId: string;
let appUrn: string;
let parentId: string;
let childId: string;
let otherAppRun: string;

async function newRun(forApp: string, parentRunId: string | null = null) {
  return (await db.appRun.create({
    data: { id: generateId(), organizationId: orgId, appId: forApp, agentId: await testRunAgentId(db, orgId, forApp), triggerKind: 'MANUAL', entryNodeUrn: 'x:y:z', status: 'RUNNING', parentRunId },
  })).id;
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'rs5050', urn: 'rs5050' } });
  orgId = org.id;
  orgUrn = org.urn!;
  const app = await db.app.create({ data: { organizationId: orgId, urn: 'rs5050:app', name: 'App' } });
  appId = app.id;
  appUrn = app.urn;
  const app2 = await db.app.create({ data: { organizationId: orgId, urn: 'rs5050:app2', name: 'App2' } });
  parentId = await newRun(appId);
  childId = await newRun(appId, parentId);
  otherAppRun = await newRun(app2.id);
});

describe('#5050 appRuns ref arguments share the ID scalar', () => {
  it('appRef, orgRef and parentRunRef are all the nullable ID scalar', () => {
    const field = (buildSchema(typeDefs).getQueryType() as GraphQLObjectType).getFields().appRuns;
    const shape = Object.fromEntries(
      ['appRef', 'orgRef', 'parentRunRef'].map((n) => {
        const arg = field.args.find((a) => a.name === n)!;
        return [n, `${getNamedType(arg.type).name}${isNonNullType(arg.type) ? '!' : ''}`];
      }),
    );
    expect(shape).toEqual({ appRef: 'ID', orgRef: 'ID', parentRunRef: 'ID' });
  });

  it('the CLI document after hadron-cli#3107 validates and lists by App, by org and by parent', async () => {
    const byApp = await exec(CLI_AFTER, { appRef: appUrn });
    expect(byApp.errors).toBeUndefined();
    expect(ids(byApp)).toEqual([parentId, childId].sort());
    const byOrg = await exec(CLI_AFTER, { orgRef: orgUrn });
    expect(byOrg.errors).toBeUndefined();
    expect(ids(byOrg)).toEqual([parentId, childId, otherAppRun].sort());
    const byParent = await exec(CLI_AFTER, { appRef: appUrn, parentRunId: parentId });
    expect(ids(byParent)).toEqual([childId]);
  });

  it('the portal documents after hadron-portal#2605 validate and list', async () => {
    const app = await exec(PORTAL_APP_AFTER, { appRef: appId });
    expect(app.errors).toBeUndefined();
    expect(ids(app)).toEqual([parentId, childId].sort());
    const org = await exec(PORTAL_ORG_AFTER, { orgRef: orgId });
    expect(org.errors).toBeUndefined();
    expect(ids(org)).toEqual([parentId, childId, otherAppRun].sort());
  });

  it('BREAKING: the documents the CLI and portal ship today no longer validate (String variable in an ID position)', async () => {
    for (const [name, doc, vars] of [
      ['cli', CLI_BEFORE, { appRef: appUrn }],
      ['portal app', PORTAL_APP_BEFORE, { appRef: appId }],
      ['portal org', PORTAL_ORG_BEFORE, { orgRef: orgId }],
    ] as const) {
      const out = await exec(doc, vars);
      expect(code(out), name).toBe('GRAPHQL_VALIDATION_FAILED');
      expect(out.errors?.[0]?.message, name).toMatch(/Variable "\$(appRef|orgRef)" of type "String" used in position expecting type "ID"/);
      expect(out.data, name).toBeUndefined();
    }
  });

  it('the resolver answers every ref form exactly as before: id, URN, unknown, and an Int literal coerced by ID', async () => {
    const q = 'query($a: ID, $o: ID) { appRuns(appRef: $a, orgRef: $o) { total items { id } } }';
    expect(ids(await exec(q, { a: appId }))).toEqual([parentId, childId].sort());
    expect(ids(await exec(q, { a: appUrn }))).toEqual([parentId, childId].sort());
    expect(ids(await exec(q, { o: orgId }))).toEqual([parentId, childId, otherAppRun].sort());
    expect(ids(await exec(q, { o: orgUrn }))).toEqual([parentId, childId, otherAppRun].sort());
    // An unknown App ref answers as it did under String (the resolver sees the same string either way).
    const unknown = await exec(q, { a: 'rs5050:nope' });
    const unknownLiteral = await exec('{ appRuns(appRef: "rs5050:nope") { total items { id } } }', {});
    expect(answer(unknown)).toEqual(answer(unknownLiteral));
    expect(code(unknown)).toBe('NOT_FOUND');
    // ID accepts an Int input and hands the resolver its string form; a number names no App, as the string "5050" does.
    const intLiteral = await exec('{ appRuns(appRef: 5050) { total items { id } } }', {});
    const stringOfInt = await exec(q, { a: '5050' });
    expect(answer(intLiteral)).toEqual(answer(stringOfInt));
  });

  it('a reader outside the org is refused exactly as before', async () => {
    const stranger = await db.user.create({ data: { email: 'stranger-rs5050@example.com', name: 'S' } });
    const ctx = { userId: stranger.id, roles: [] } as Partial<Context>;
    const viaId = await exec('query($a: ID) { appRuns(appRef: $a) { total } }', { a: appUrn }, ctx);
    const viaLiteral = await exec(`{ appRuns(appRef: "${appUrn}") { total } }`, {}, ctx);
    expect(viaId.errors?.length).toBeGreaterThan(0);
    expect(answer(viaId)).toEqual(answer(viaLiteral));
  });
});
