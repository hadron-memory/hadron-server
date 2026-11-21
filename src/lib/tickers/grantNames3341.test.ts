/**
 * #3341 (follow-ups of #3339): the closed grant-name list lives in four places that no compiler ties
 * together. These pins fail when one drifts: APP_GRANT_NAMES, the GraphQL `AppGrantName` enum, the two
 * name maps, prisma/ticker-invariants.sql (what a fresh database gets), the NEWEST migration that
 * touches `chk_app_grants_shape` (what a migrated database gets), and the live constraint itself.
 * cor:agt:080:24. The applied migration 20261103160000 stays immutable: a later change adds a newer one,
 * and the migration scan below then follows it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { parse, Kind, type EnumTypeDefinitionNode } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { APP_GRANT_NAMES, GRANT_ENUM_TO_NAME, GRANT_NAME_TO_ENUM } from './bounds.js';

const root = new URL('../../../prisma/', import.meta.url);
const CHECK_LIST = /ADD CONSTRAINT chk_app_grants_shape CHECK\s*\(\s*name IN \(([^)]*)\)\s*\)/;
const listOf = (sql: string): string[] => {
  const m = CHECK_LIST.exec(sql);
  if (!m) throw new Error('no chk_app_grants_shape name list found');
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort();
};
const sorted = (xs: readonly string[]) => [...xs].sort();

describe('#3341 the closed grant-name list agrees everywhere it is written', () => {
  it('ticker-invariants.sql (a fresh database) lists exactly APP_GRANT_NAMES', () => {
    expect(listOf(readFileSync(new URL('ticker-invariants.sql', root), 'utf8'))).toEqual(sorted(APP_GRANT_NAMES));
  });
  it('the NEWEST migration that rewrites the CHECK (a migrated database) lists exactly APP_GRANT_NAMES', () => {
    const dirs = readdirSync(new URL('migrations/', root)).filter(d => /^\d{14}_/.test(d)).sort();
    const newest = dirs.filter(d => readFileSync(new URL(`migrations/${d}/migration.sql`, root), 'utf8').includes('chk_app_grants_shape')).pop();
    expect(newest).toBeDefined();
    expect(listOf(readFileSync(new URL(`migrations/${newest}/migration.sql`, root), 'utf8'))).toEqual(sorted(APP_GRANT_NAMES));
  });
  it('the live database constraint lists exactly APP_GRANT_NAMES', async () => {
    const rows = await db.$queryRaw<Array<{ def: string }>>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_app_grants_shape'`;
    expect(rows).toHaveLength(1);
    expect([...rows[0].def.matchAll(/'([^']+)'::text/g)].map(x => x[1]).sort()).toEqual(sorted(APP_GRANT_NAMES));
  });
  it('the GraphQL AppGrantName enum has one value per name, and the two maps agree with it', () => {
    const doc = parse(typeDefs);
    const def = doc.definitions.find((d): d is EnumTypeDefinitionNode => d.kind === Kind.ENUM_TYPE_DEFINITION && d.name.value === 'AppGrantName');
    const enumValues = (def?.values ?? []).map(v => v.name.value).sort();
    expect(enumValues).toEqual(sorted(Object.values(GRANT_NAME_TO_ENUM)));
    expect(sorted(Object.keys(GRANT_NAME_TO_ENUM))).toEqual(sorted(APP_GRANT_NAMES));
    expect(sorted(Object.keys(GRANT_ENUM_TO_NAME))).toEqual(enumValues);
    expect(sorted(Object.values(GRANT_ENUM_TO_NAME))).toEqual(sorted(APP_GRANT_NAMES));
  });
  it('GRANT_ENUM_TO_NAME is the exact inverse of GRANT_NAME_TO_ENUM and equals the literal it replaced', () => {
    expect(GRANT_ENUM_TO_NAME).toEqual({ TICKER_SUBSCRIBE_WORKERS: 'ticker.subscribe-workers', WORKERS_STAFF: 'workers.staff', APP_MEMBERS: 'app.members' });
    for (const [name, wire] of Object.entries(GRANT_NAME_TO_ENUM)) expect(GRANT_ENUM_TO_NAME[wire]).toBe(name);
  });
});
