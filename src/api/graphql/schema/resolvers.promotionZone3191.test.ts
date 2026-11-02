/**
 * #3191 (time-zone audit slice 1): the promotion claim statements in `linkMemoryToUser` write `updated_at` and judge
 * `anonymous_expires_at` (both zone-less `timestamp(3)`, UTC by convention) against a bare `clock_timestamp()`, which a
 * non-UTC session reads in its own zone. The JS pre-checks use a timestamptz and are correct, so the SQL expiry check is only
 * decisive when a row expires between the pre-check and the claim: a hook after the deciding lock (and its in-transaction
 * check) moves the expiry, exactly as a lock wait would. Both claims run: encrypted (request key) and plaintext (no key).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { MODELS_WITHOUT_ID } from '../../../integrations/db/client.js';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import { withTestOperationKey } from '../../../test/operationKey.js';

const ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'] as const;
const dataKey = Buffer.alloc(32, 31).toString('base64');
const HOUR = 3_600_000;
const raw = new Map<string, PrismaClient>();
const clients = new Map<string, PrismaClient>();
/** A zone client carries the repo's id injection, which the resolver's own creates rely on. */
function zoneClient(zone: string): PrismaClient {
  let client = clients.get(zone);
  if (!client) {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('options', `-c TimeZone=${zone}`);
    const base = new PrismaClient({ datasourceUrl: url.toString() });
    raw.set(zone, base);
    client = base.$extends({ query: { $allModels: { async create({ model, args, query }) {
      const data = args.data as Record<string, unknown>;
      if (!MODELS_WITHOUT_ID.has(model) && !data.id) data.id = generateId();
      return query(args);
    } } } }) as unknown as PrismaClient;
    clients.set(zone, client);
  }
  return client;
}
afterAll(async () => { await Promise.all([...raw.values()].map(c => c.$disconnect())); });

let memoryId: string;
let appId: string;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Zone3191', urn: 'zone3191.test' } });
  appId = (await db.app.create({ data: { name: 'Zone', urn: 'zone3191.test:app', organizationId: org.id } })).id;
  const agent = await db.agent.create({ data: { name: 'Zone', urn: 'zone3191.test:agent', organizationId: org.id } });
  memoryId = (await db.memory.create({ data: { name: 'Anon', urn: 'zone3191.test:anon', organizationId: org.id,
    appId, userMemoryOfAgentId: agent.id, class: 'app', anonymousExpiresAt: new Date(Date.now() + 24 * HOUR) } })).id;
});

/** Run the promotion on `client`; `atClaim` fires inside the transaction right before the claim UPDATE, `afterClaim` right after it. */
async function promote(client: PrismaClient, encrypted: boolean, hooks: { atClaim?: (tx: any) => Promise<void>; afterClaim?: (tx: any) => Promise<void> } = {}) {
  const transaction = client.$transaction.bind(client) as any;
  const spy = vi.spyOn(client, '$transaction').mockImplementation((async (input: any, options: any) => {
    if (typeof input !== 'function') return transaction(input, options);
    return transaction((tx: any) => input(new Proxy(tx, { get(target, property) {
      if (property !== '$executeRaw') return Reflect.get(target, property);
      return async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const claim = strings.join('').includes('UPDATE memories SET urn');
        if (claim) await hooks.atClaim?.(target);
        const result = await target.$executeRaw(strings, ...values);
        if (claim) await hooks.afterClaim?.(target);
        return result;
      };
    } })), options);
  }) as typeof client.$transaction);
  try {
    const call = () => resolvers.Mutation.linkMemoryToUser({}, { memoryId, externalUserId: 'zone-owner' }, { db: client, appId, roles: [] } as any);
    return await (encrypted ? withTestOperationKey(dataKey, appId, call) : call());
  } finally { spy.mockRestore(); }
}

describe.each(ZONES)('#3191 promotion claim under session zone %s', zone => {
  describe.each([{ path: 'encrypted', encrypted: true }, { path: 'plaintext', encrypted: false }])('$path claim', ({ encrypted }) => {
    it('refuses a row that expired an hour ago between the pre-check and the claim', async () => {
      const client = zoneClient(zone);
      await expect(promote(client, encrypted, {
        atClaim: tx => tx.memory.update({ where: { id: memoryId }, data: { anonymousExpiresAt: new Date(Date.now() - HOUR) } }),
      })).rejects.toMatchObject({ extensions: { code: 'MEMORY_WRITE_CONFLICT' } });
      expect(await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).toMatchObject({ class: 'app', userId: null });
    });

    it('promotes a row that still has an hour to live', async () => {
      await db.memory.update({ where: { id: memoryId }, data: { anonymousExpiresAt: new Date(Date.now() + HOUR) } });
      await promote(zoneClient(zone), encrypted);
      expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).anonymousExpiresAt).toBeNull();
    });

    it('stamps updated_at at UTC now, not shifted by the session zone', async () => {
      let stamped: Date | undefined;
      const before = Date.now();
      await promote(zoneClient(zone), encrypted, {
        afterClaim: async tx => { [{ updated_at: stamped }] = await tx.$queryRaw`SELECT updated_at FROM memories WHERE id = ${memoryId}`; },
      });
      // Prisma reads the naive column as UTC whatever the session zone, so a shifted stamp shows as an offset.
      expect(stamped).toBeDefined();
      expect(Math.abs(stamped!.getTime() - before)).toBeLessThan(60_000);
    });
  });
});
