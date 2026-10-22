/**
 * #2238 — `Memory.subscriptions` must list only live subscriptions.
 *
 * `MEMORY_INCLUDE.subscriptions` had no `deletedAt: null`, so a soft-deleted
 * subscription still came back through `memory(ref)` (and every count built on
 * it), while `ORG_INCLUDE.subscriptions` already filtered it. Driven over real
 * `/graphql` with a real UserApiKey, asserting row IDs (a length-only check can
 * hide wrong-row filtering). Controls: two live rows keep their createdAt order,
 * an all-tombstone memory lists none, the organization side keeps its parity,
 * and a caller who cannot read the memory still gets nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { mintUserApiKey } from '../../middleware/auth.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null, writtenNodes: [] }),
}));
vi.mock('../../integrations/github/pushMemoryToGit.js', () => ({
  pushMemoryToGit: vi.fn().mockResolvedValue({ error: null }),
}));

type Gql = { data: any; errors: { message: string }[] | undefined };

let server: Server;
let baseUrl: string;
const key: Record<string, string> = {};
const ids: Record<string, string> = {};

async function gql(principal: string, query: string, variables: Record<string, unknown>): Promise<Gql> {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key[principal]}` },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as Gql;
}

const MEMORY_SUBS = 'query($ref: ID!) { memory(ref: $ref) { id subscriptions { id organization { id } } } }';
const ORG_SUBS = 'query($ref: ID!) { organization(ref: $ref) { id subscriptions { id memory { id } } } }';

beforeAll(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const mkOrg = (label: string) =>
    db.organization.create({ data: { id: generateId(), name: label, urn: `subs-2238-${label}-${suffix}` } });
  const mkUser = (label: string) =>
    db.user.create({
      data: { id: generateId(), handle: `${label}-${suffix}`, githubUsername: `${label}-${suffix}`, roles: ['READER'] },
    });

  const home = await mkOrg('home');
  const early = await mkOrg('early');
  const gone = await mkOrg('gone');
  const late = await mkOrg('late');
  const outsiderOrg = await mkOrg('outsider');
  const owner = await mkUser('owner');
  const outsider = await mkUser('outsider');
  // The owner administers every org, so each subscription's `organization` resolves and the org side is readable.
  for (const org of [home, early, gone, late]) {
    await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'OWNER' } });
  }
  await db.orgMember.create({ data: { organizationId: outsiderOrg.id, userId: outsider.id, role: 'OWNER' } });
  for (const [label, userId] of [['owner', owner.id], ['outsider', outsider.id]] as const) {
    key[label] = (await mintUserApiKey(db, { userId, label, createdBy: userId, issuedVia: 'test', oauthScopes: ['account'] })).rawKey;
  }

  const mkMemory = (label: string) =>
    db.memory.create({
      data: { id: generateId(), organizationId: home.id, urn: `${home.urn}:${label}`, name: label, class: 'knowledge', visibility: 'ORGANIZATION' },
    });
  const mixed = await mkMemory('mixed');
  const tombstoned = await mkMemory('tombstoned');

  // createdAt is explicit so ordering is asserted, not left to insert timing; the tombstone sits between the live rows.
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
  const mkSub = (memoryId: string, organizationId: string, minute: number, deleted: boolean) =>
    db.memorySubscription.create({
      data: { memoryId, organizationId, createdAt: at(minute), ...(deleted ? { deletedAt: at(minute + 30), deletedBy: owner.id } : {}) },
    });
  ids.mixed = mixed.id;
  ids.tombstoned = tombstoned.id;
  ids.early = early.id;
  ids.gone = gone.id;
  ids.late = late.id;
  ids.earlySub = (await mkSub(mixed.id, early.id, 1, false)).id;
  ids.goneSub = (await mkSub(mixed.id, gone.id, 2, true)).id;
  ids.lateSub = (await mkSub(mixed.id, late.id, 3, false)).id;
  ids.goneOnlySub = (await mkSub(tombstoned.id, gone.id, 4, true)).id;

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('Memory.subscriptions lists only live rows (#2238)', () => {
  it('drops the tombstone and keeps both live rows in createdAt order', async () => {
    const r = await gql('owner', MEMORY_SUBS, { ref: ids.mixed });
    expect(r.errors).toBeUndefined();
    expect(r.data.memory.subscriptions).toEqual([
      { id: ids.earlySub, organization: { id: ids.early } },
      { id: ids.lateSub, organization: { id: ids.late } },
    ]);
  });

  it('an all-tombstone memory lists none', async () => {
    const r = await gql('owner', MEMORY_SUBS, { ref: ids.tombstoned });
    expect(r.errors).toBeUndefined();
    expect(r.data.memory).toEqual({ id: ids.tombstoned, subscriptions: [] });
  });

  it('organization-side parity: the deleting org lists neither tombstone, a live org still lists its row', async () => {
    const gone = await gql('owner', ORG_SUBS, { ref: ids.gone });
    expect(gone.errors).toBeUndefined();
    expect(gone.data.organization).toEqual({ id: ids.gone, subscriptions: [] });
    const early = await gql('owner', ORG_SUBS, { ref: ids.early });
    expect(early.errors).toBeUndefined();
    expect(early.data.organization.subscriptions).toEqual([{ id: ids.earlySub, memory: { id: ids.mixed } }]);
  });

  it('a caller who cannot read the memory still gets no memory and no subscription ids', async () => {
    const r = await gql('outsider', MEMORY_SUBS, { ref: ids.mixed });
    expect(r.data.memory).toBeNull();
    expect(JSON.stringify(r)).not.toContain(ids.earlySub);
    expect(JSON.stringify(r)).not.toContain(ids.lateSub);
  });
});
