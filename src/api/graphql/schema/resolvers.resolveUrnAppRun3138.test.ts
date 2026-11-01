/** #3138: resolveUrn's apprun lookup must not turn an operational fault into not-found. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../../server.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { mintUserApiKey } from '../../../middleware/auth.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null, writtenNodes: [] }) }));
vi.mock('../../../integrations/github/pushMemoryToGit.js', () => ({ pushMemoryToGit: vi.fn().mockResolvedValue({ error: null }) }));

let server: Server | undefined;
let baseUrl: string;
let key: string;
let appUrn: string;
let absentRunUrn: string;
let runUrn: string;
let runId: string;
let outsiderKey: string;
let ambiguousRunUrn: string;
type Reply = { status: number; data: { resolveUrn: { kind: string; id: string } | null } | null | undefined; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> };

async function resolve(urn: string, token = key): Promise<Reply> {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: 'query($urn:String!){resolveUrn(urn:$urn){kind id}}', variables: { urn } }),
  });
  const body = await response.json() as Omit<Reply, 'status'>;
  return { status: response.status, data: body.data, errors: body.errors };
}

beforeAll(async () => {
  await cleanDb(db);
  const suffix = generateId();
  const org = await db.organization.create({ data: { name: 'apprun 3138', urn: `apprun3138-${suffix}.example` } });
  const user = await db.user.create({ data: { handle: `apprun3138-${suffix}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'OWNER' } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'run app', urn: `${org.urn}:runs` } });
  appUrn = app.urn;
  absentRunUrn = `hrn:apprun:${appUrn}:${generateId()}`;
  runId = generateId();
  await db.appRun.create({ data: { id: runId, organizationId: org.id, appId: app.id, triggerKind: 'MANUAL', entryNodeUrn: `hrn:node:${org.urn}:f:e`, status: 'COMPLETED' } });
  runUrn = `hrn:apprun:${appUrn}:${runId}`;
  const outsider = await db.user.create({ data: { handle: `outsider3138-${suffix}`, roles: ['READER'] } });
  outsiderKey = (await mintUserApiKey(db, { userId: outsider.id, label: '3138 outsider', createdBy: outsider.id, issuedVia: 'test', oauthScopes: ['account'] })).rawKey;
  for (const slug of ['alias-a', 'alias-b']) {
    await db.app.create({ data: { organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, legacyUrn: `${org.urn}:old` } });
  }
  ambiguousRunUrn = `hrn:apprun:${org.urn}:old:${runId}`;
  key = (await mintUserApiKey(db, { userId: user.id, label: '3138 wire', createdBy: user.id, issuedVia: 'test', oauthScopes: ['account'] })).rawKey;
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
});

describe('#3138 resolveUrn apprun fault boundary', () => {
  it('an App lookup outage is INTERNAL_SERVER_ERROR, never a silent not-found', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = db.app.findFirst.bind(db.app);
    let injected = false;
    vi.spyOn(db.app, 'findFirst').mockImplementation(async (args) => {
      if (!injected && typeof args?.where?.urn === 'string') {
        injected = true;
        throw new Error('3138 database outage private-detail');
      }
      return original(args);
    });
    const response = await resolve(absentRunUrn);
    expect(injected, 'the apprun ref resolver reached the injected App lookup').toBe(true);
    expect(response.status).toBe(200);
    expect(response.data?.resolveUrn ?? null).toBeNull();
    expect(response.errors, 'an operational fault is not a silent not-found').toHaveLength(1);
    expect(response.errors?.[0]?.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    expect(response.errors?.[0]?.message).toBe('Internal server error.');
    expect(response.errors?.[0]?.extensions?.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(JSON.stringify(response)).not.toContain('private-detail');
  });

  it('a readable run resolves', async () => {
    expect(await resolve(runUrn)).toEqual({ status: 200, data: { resolveUrn: { kind: 'apprun', id: runId } }, errors: undefined });
  });

  it('an unreadable run stays indistinguishable from missing', async () => {
    expect(await resolve(runUrn, outsiderKey)).toEqual({ status: 200, data: { resolveUrn: null }, errors: undefined });
  });

  it('an ambiguous owning App stays null with no error', async () => {
    expect(await resolve(ambiguousRunUrn)).toEqual({ status: 200, data: { resolveUrn: null }, errors: undefined });
  });

  it('a genuine missing run stays null with no error', async () => {
    expect(await resolve(absentRunUrn)).toEqual({ status: 200, data: { resolveUrn: null }, errors: undefined });
  });

  it('a genuine missing App stays null with no error', async () => {
    const unknownApp = `hrn:apprun:apprun3138-absent.example:runs:${generateId()}`;
    expect(await resolve(unknownApp)).toEqual({ status: 200, data: { resolveUrn: null }, errors: undefined });
  });
});
