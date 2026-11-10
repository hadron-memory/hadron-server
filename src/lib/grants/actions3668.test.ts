/**
 * #3668 S1a — the `actions` table and its ONE writer: an idempotent deploy-time upsert from a list in the server
 * (cor:acl:140:02). The platform list carried no action in S1a (S1b #3707 seeds two: see seed3707.test.ts); nothing else seeds one, and no GraphQL, MCP, CLI or run-tool
 * surface can write one. Synthetic rows below live only inside this isolated test.
 */
import { ApolloServer } from '@apollo/server';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parse } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { cleanDb } from '../../test/helpers.js';
import { dropTestActions } from './grantFixtures3668.js';
import { PLATFORM_ACTIONS, upsertPlatformActions, type ActionDefinition } from './actions.js';

const act = (name: string, over: Partial<ActionDefinition> = {}): ActionDefinition => ({
  name, source: 'PLATFORM', parameters: [{ name: 'entryNode', type: 'node-ref', refusesWildcard: true }], tool: null,
  enforcement: 'SERVER', issuerRule: 'TEST_ONLY', summaryTemplate: 'Create a thing in {app}', ...over,
});
type Row = { name: string; xmin: string; updated_at: Date; summary_template: string };
const rows = () => db.$queryRawUnsafe<Row[]>(`SELECT name, xmin::text AS xmin, updated_at, summary_template FROM actions WHERE name LIKE 'test.s1a.%' ORDER BY name`);

beforeEach(async () => { await cleanDb(db); await dropTestActions(); });
afterAll(async () => { await dropTestActions(); });

describe('the platform list', () => {
  it('#3707 (S1b): the shipped list is exactly the two seeded actions, and a repeat of the upsert changes nothing (terms: seed3707.test.ts)', async () => {
    expect(PLATFORM_ACTIONS.map((a) => a.name).sort()).toEqual(['schedule.create', 'webhook.create']);
    await upsertPlatformActions(db);
    const before = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM actions`);
    expect(await upsertPlatformActions(db)).toEqual({ inserted: 0, updated: 0, unchanged: 2 });
    expect(await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM actions`)).toEqual(before);
  });
});

describe('upsertPlatformActions is idempotent and never deletes', () => {
  it('a first run inserts; a second run changes NOTHING (same tuple versions, same updated_at)', async () => {
    const list = [act('test.s1a.one'), act('test.s1a.two', { enforcement: 'CREDENTIAL', tool: 'hadrontool-x' })];
    expect(await upsertPlatformActions(db, list)).toEqual({ inserted: 2, updated: 0, unchanged: 0 });
    const first = await rows();
    expect(first).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 25));
    expect(await upsertPlatformActions(db, list)).toEqual({ inserted: 0, updated: 0, unchanged: 2 });
    expect(await rows()).toEqual(first);
  });
  it('a changed definition updates ONLY that row', async () => {
    await upsertPlatformActions(db, [act('test.s1a.one'), act('test.s1a.two')]);
    const first = await rows();
    await new Promise((r) => setTimeout(r, 25));
    expect(await upsertPlatformActions(db, [act('test.s1a.one', { summaryTemplate: 'Changed' }), act('test.s1a.two')])).toEqual({ inserted: 0, updated: 1, unchanged: 1 });
    const after = await rows();
    expect(after[0].summary_template).toBe('Changed');
    expect(after[0].updated_at.getTime()).toBeGreaterThan(first[0].updated_at.getTime());
    expect(after[1]).toEqual(first[1]);
  });
  it('a row missing from the list is never deleted (a grant may name it), even with an empty list', async () => {
    await upsertPlatformActions(db, [act('test.s1a.one'), act('test.s1a.two')]);
    await upsertPlatformActions(db, [act('test.s1a.one')]);
    await upsertPlatformActions(db, []);
    expect((await rows()).map((r) => r.name)).toEqual(['test.s1a.one', 'test.s1a.two']);
  });
  it('refuses a malformed definition before writing anything', async () => {
    await expect(upsertPlatformActions(db, [act('test.s1a.ok'), act('')])).rejects.toThrow(/action/i);
    await expect(upsertPlatformActions(db, [act('test.s1a.dup'), act('test.s1a.dup')])).rejects.toThrow(/duplicate/i);
    await expect(upsertPlatformActions(db, [act('test.s1a.bad', { enforcement: 'WISHFUL' as never })])).rejects.toThrow(/enforcement/i);
    expect(await rows()).toEqual([]);
  });
});

describe('the table itself', () => {
  it('constrains the enforcement level and the source, and never holds a blank name', async () => {
    const ins = (name: string, source: string, enforcement: string) => db.$executeRawUnsafe(
      `INSERT INTO actions (name, source, parameters, enforcement, issuer_rule, summary_template, created_at, updated_at)
       VALUES ($1, $2, '[]'::jsonb, $3, 'X', 's', now(), now())`, name, source, enforcement);
    await expect(ins('test.s1a.e', 'PLATFORM', 'WISHFUL')).rejects.toThrow(/chk_actions_shape/);
    await expect(ins('test.s1a.s', '', 'SERVER')).rejects.toThrow(/chk_actions_shape/);
    await expect(ins('', 'PLATFORM', 'SERVER')).rejects.toThrow(/chk_actions_shape/);
    for (const e of ['SERVER', 'CREDENTIAL', 'HARNESS_INSTRUCTION', 'RECORDED_ONLY']) await ins(`test.s1a.${e}`, 'PLATFORM', e);
    await expect(ins('test.s1a.SERVER', 'PLATFORM', 'SERVER')).rejects.toThrow(/23505|actions_pkey/i);
  });
});

describe('no surface writes an action, or a grant (S1a has no writer)', () => {
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  beforeAll(() => server.start());
  afterAll(() => server.stop());
  const ctx: Context = { db, userId: 'u', roles: ['ADMIN'] };
  const run = async (query: string) => {
    const r = await server.executeOperation({ query }, { contextValue: ctx });
    if (r.body.kind !== 'single') throw new Error('single result expected');
    return r.body.singleResult;
  };

  it('answers the unknown-field error for every plausible write over real GraphQL operations', async () => {
    for (const field of ['createAction', 'upsertAction', 'setAction', 'updateAction', 'deleteAction', 'registerAction', 'activateGrant', 'updateGrant', 'deleteGrant']) {
      const out = await run(`mutation { ${field}(input: {}) { id } }`);
      expect(out.errors?.[0]?.message, field).toContain(`Cannot query field "${field}" on type "Mutation"`);
    }
    for (const field of ['grantEvents', 'grantActions', 'action', 'actions']) {
      const out = await run(`query { ${field} { id } }`);
      expect(out.errors?.[0]?.message, field).toContain(`Cannot query field "${field}" on type "Query"`);
    }
  });

  it('adds no Grant/Action type, query or mutation: the action- and grant-named surface is exactly today\'s (the six old tables and the register)', () => {
    const doc = parse(typeDefs as unknown as string);
    const found: string[] = [];
    for (const d of doc.definitions as unknown as Array<{ kind: string; name?: { value: string }; fields?: Array<{ name: { value: string } }> }>) {
      const n = d.name?.value;
      if (!n) continue;
      if (/action|grant/i.test(n)) found.push(`TYPE ${n}`);
      if (n === 'Query' || n === 'Mutation') for (const f of d.fields ?? []) if (/action|grant/i.test(f.name.value)) found.push(`${n}.${f.name.value}`);
    }
    expect(found.sort()).toEqual(BASELINE);
  });

  // A LIMITED regression check (it recognises a few client names and SQL spellings, under src only, and skips src/lib/grants):
  // the real guarantees are the database permission pins (verify-runtime-role.test.ts, revoke-runtime-migrations.test.ts) and the
  // GraphQL surface pins above.
  it('limited scan: no non-test source outside src/lib/grants names the actions table in a write', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== 'generated' && name !== 'node_modules') walk(p); continue; }
        if (!/\.(ts|mjs|js)$/.test(name) || /\.test\.ts$/.test(name) || p.includes(join('src', 'lib', 'grants') + '/')) continue;
        if (/\b(?:db|tx|prisma|client)\.action\.|\b(?:FROM|INTO|UPDATE|JOIN)\s+"?actions\b/i.test(readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(new URL('../../../src', import.meta.url).pathname);
    expect(offenders).toEqual([]);
  });
});

// The grant- and action-named GraphQL surface at the S1a branch point (main e3c514d1): the six existing grant tables and
// the action-register vocabulary, which stays untouched until #3669. A new entry here is a new surface: it needs its own gate.
// #3711 (S2b) adds Query.appGrants and Mutation.revokeGrant / withdrawGrant (the manager's list, revoke and the requester's withdrawal); revokeGrant is
// therefore no longer an unknown field and leaves the plausible-write loop below. Still no surface activates a grant.
// #3789 (S2a-read, gated T3 Hardened) added the read-only Query.grant/grants (#3800 adds Query.myGrants) and their types. Still no writer.
// #3649 slice B added grant signing requests: requestGrantSignature / withdrawGrantSigningRequest write a REQUEST row,
// never a grant or an action, and grantSigningRequest reads one. Still no grant writer.
// #3649 slice D added the READ projection of a grant's signatures: GrantSignature, GrantSignatureState, GrantSignatureStatus
// (Grant.signatureStatus). Types only, no query or mutation; still no grant writer.
const BASELINE = [
  'Mutation.createAgentOrgGrant', 'Mutation.createConnectionGrant', 'Mutation.createGrant', 'Mutation.createPrincipalGrant', 'Mutation.grantApp', 'Mutation.grantAppKeyScope',
  'Mutation.grantCredits', 'Mutation.mintActionTickets', 'Mutation.recordAppAction', 'Mutation.requestGrantSignature', 'Mutation.revokeAgentOrgGrant', 'Mutation.revokeAppGrant',
  'Mutation.revokeAppMemoryWriteGrant', 'Mutation.revokeAutomationReadGrant', 'Mutation.revokeAutomationTeamSnapshotGrant', 'Mutation.revokeConnectionGrant',
  'Mutation.revokeGrant', 'Mutation.revokePrincipalGrant', 'Mutation.setAppMemoryWriteGrant', 'Mutation.setAutomationReadGrant', 'Mutation.setAutomationTeamSnapshotGrant', 'Mutation.withdrawGrant', 'Mutation.withdrawGrantSigningRequest',
  'Query.actionRegisterIndex', 'Query.actionTickets', 'Query.appGrants', 'Query.appMemoryWriteGrants', 'Query.automationReadGrants', 'Query.automationTeamSnapshotGrant',
  'Query.automationTeamSnapshotGrants', 'Query.connectionGrant', 'Query.connectionGrants', 'Query.effectiveActionPolicy', 'Query.grant', 'Query.grantSigningRequest', 'Query.grants', 'Query.myGrants', 'Query.principalGrant', 'Query.principalGrants',
  'TYPE AccessGrant', 'TYPE ActionRegisterIndexEntry', 'TYPE ActionRegisterIndexPage', 'TYPE ActionRegisterIndexState', 'TYPE ActionTicket', 'TYPE ActionTicketsPage',
  'TYPE AgentOrgGrant', 'TYPE AppGrant', 'TYPE AppGrantName', 'TYPE AppMemoryWriteGrant', 'TYPE AutomationReadGrant', 'TYPE AutomationTeamSnapshotGrant',
  'TYPE AutomationTeamSnapshotGrantPage', 'TYPE ConnectionGrant', 'TYPE ConnectionGrantsPage', 'TYPE CreateGrantInput', 'TYPE EffectiveActionPolicy', 'TYPE Grant', 'TYPE GrantAnnouncement',
  'TYPE GrantCreditsInput', 'TYPE GrantHolderKind', 'TYPE GrantSignature', 'TYPE GrantSignatureState', 'TYPE GrantSignatureStatus', 'TYPE GrantSigningRequest', 'TYPE GrantSigningRequestState', 'TYPE GrantsPage', 'TYPE MintActionTicketsInput', 'TYPE PrProtocolAction', 'TYPE PrincipalGrant', 'TYPE PrincipalGrantsPage', 'TYPE RecordAppActionResult',
  'TYPE SkillExportAction', 'TYPE TickAction', 'TYPE TickActionState',
];
