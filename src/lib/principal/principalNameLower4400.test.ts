/**
 * #4400 (hrn:node:hadronmemory.com:specs:cor:urn:010:01, "The root principal & the pool"): a root name is unique
 * regardless of case. Before #4400 that rested only on every writer lower-casing; these pins go to the database
 * with a raw insert that skips the writer, so they hold only when the database itself refuses.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { mintPrincipal } from './mintPrincipal.js';

beforeEach(async () => {
  await cleanDb(db);
});

/** Insert a principal row as a writer that forgot to lower-case would. */
const rawInsert = (name: string, status = 'active') => db.$executeRaw`
  INSERT INTO principals (id, name, kind, status, created_at, updated_at)
  VALUES (${generateId()}, ${name}, 'org', ${status}, now(), now())`;

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { return String((e as { message?: string }).message ?? e); }
  return 'NOT REFUSED';
};

describe('#4400 principals.name is lower case in the database', () => {
  it('refuses a case variant of an existing name written past the writer', async () => {
    await mintPrincipal(db, { kind: 'user', name: 'example' });
    const said = await refusal(rawInsert('Example'));
    expect(said).toContain('chk_principals_name_lower');
    expect(await db.principal.count({ where: { name: { in: ['example', 'Example'] } } })).toBe(1);
  });

  it('refuses a mixed-case name that has no lower-case twin', async () => {
    expect(await refusal(rawInsert('LonelyName'))).toContain('chk_principals_name_lower');
    expect(await db.principal.count({ where: { name: 'LonelyName' } })).toBe(0);
  });

  it('refuses it in every status: a released or reserved row is in the same namespace', async () => {
    expect(await refusal(rawInsert('Released.Example', 'released'))).toContain('chk_principals_name_lower');
    expect(await refusal(rawInsert('ReservedWord', 'reserved'))).toContain('chk_principals_name_lower');
  });

  it('refuses an UPDATE that would put a stored name into mixed case', async () => {
    const p = await mintPrincipal(db, { kind: 'org', name: 'acme.example' });
    const said = await refusal(db.$executeRaw`UPDATE principals SET name = 'Acme.Example' WHERE id = ${p.id}`);
    expect(said).toContain('chk_principals_name_lower');
  });

  it('GUARD: what the writer stores always passes, also for names outside ASCII', async () => {
    // JavaScript lower-cases in the writer; Postgres lower() judges in the CHECK. A name the writer produced must
    // be a fixed point of the database's lower(), or a legitimate mint would be refused.
    for (const name of ['Plain-Name', 'ACME.Example', 'İstanbul', 'ΟΔΟΣ', 'Straße', 'ÉCOLE.example']) {
      const p = await mintPrincipal(db, { kind: 'org', name });
      const row = await db.principal.findUniqueOrThrow({ where: { id: p.id } });
      expect(row.name).toBe(name.toLowerCase());
    }
  });
});
