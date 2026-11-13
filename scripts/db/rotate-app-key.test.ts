/**
 * #4003 (S8 of #3991) — the App key rotation tool: usage, a refused root writes nothing, a good run mints n+1.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../src/test/helpers.js';
import { generateId } from '../../src/lib/id.js';
import { appKeyCache, ensureAppKey } from '../../src/lib/secrets/appKeys.js';
import { main } from './rotate-app-key.js';

const ROOT = 'a1'.repeat(32);
let appId: string;
let lines: string[] = [];
const io = (env: NodeJS.ProcessEnv = process.env) => ({ env, log: (l: string) => lines.push(l) });
const keys = () => db.secretAppKey.findMany({ where: { appId }, orderBy: { keyVersion: 'asc' } });

beforeEach(async () => {
  await cleanDb(db);
  process.env.SECRET_ROOT_KEY = ROOT;
  appKeyCache.clear();
  const org = await db.organization.create({ data: { id: generateId(), name: 'rotate tool org', urn: 'rotate-tool-org.test' } });
  appId = (await createDbAppWithKey(db, 'rotate-tool', org.id)).app.id;
  await db.$transaction((tx) => ensureAppKey(tx, appId));
  lines = [];
});
afterEach(() => { delete process.env.SECRET_ROOT_KEY; appKeyCache.clear(); });

describe('rotate-app-key tool', () => {
  it.each([[[]], [['--app']], [['--app', '--x']], [['some-app-id']], [['--app', 'a', 'b']]])('usage %j exits 2', async (argv) => {
    expect(await main(argv as string[], io())).toBe(2);
  });

  it('no DATABASE_URL exits 2', async () => {
    expect(await main(['--app', appId], io({}))).toBe(2);
  });

  it('rotates: exits 0 and leaves key 2 active, key 1 retired', async () => {
    expect(await main(['--app', appId], io())).toBe(0);
    expect(lines.some((l) => l.includes('key_version=2'))).toBe(true);
    expect((await keys()).map((k) => [k.keyVersion, k.retiredAt === null])).toEqual([[1, false], [2, true]]);
  });

  it('a root other than the recorded one exits 1 and writes nothing', async () => {
    process.env.SECRET_ROOT_KEY = 'f6'.repeat(32);
    expect(await main(['--app', appId], io())).toBe(1);
    expect(lines.some((l) => l.includes('refused'))).toBe(true);
    expect((await keys()).map((k) => [k.keyVersion, k.retiredAt === null])).toEqual([[1, true]]);
    expect(lines.join('\n')).not.toContain('f6f6');
  });
});
