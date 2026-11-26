/** #85 (cor:api:140:02 r7): signed-out callers get UNAUTHENTICATED before any App or organization ref resolves. */
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildASTSchema, parse } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { signJwt } from '../../auth/jwt.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../../test/startServerFixture.js';
import { typeDefs } from './schema/typeDefs.js';
import { signedOutRefDoors } from './signedOutRefDoorsPlugin.js';

vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let server: Server;
let base: string;
let orgId: string;
let orgUrn: string;
let appId: string;
let strangerToken: string;

async function ask(query: string, bearer?: string) {
  const response = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ query }),
  });
  return { status: response.status, text: await response.text() };
}

const doors = (ref: string) => [
  `mutation { createAppKey(appRef: "${ref}") { rawKey } }`,
  `mutation { regenerateAppKey(appRef: "${ref}") { rawKey } }`,
  `mutation { updateOrganization(ref: "${ref}", name: "x") { id } }`,
  `mutation { deleteOrganization(ref: "${ref}") }`,
  `mutation { linkGithubApp(orgRef: "${ref}", installationId: 1) { id } }`,
  `mutation { unlinkGithubApp(orgRef: "${ref}") { id } }`,
];

beforeAll(async () => {
  server = createHttpServer(await createServerOnCleanDb());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await closeServerIfStarted(server); });

beforeEach(async () => {
  await cleanDb(db);
  orgUrn = `so85-${generateId().slice(0, 8)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'so85', urn: orgUrn } });
  orgId = org.id;
  const app = await db.app.create({ data: { id: generateId(), name: 'so85app', urn: `so85app-${generateId().slice(0, 8)}`, organizationId: orgId } as never });
  appId = app.id;
  const stranger = await db.user.create({ data: { handle: `so85-stranger-${generateId().slice(0, 6)}`, roles: ['READER'] } });
  strangerToken = await signJwt({ sub: stranger.id, roles: ['READER'] });
});

describe('#85 signed-out ref doors', () => {
  it('derives the door list from the schema and covers every anchor of the issue', () => {
    const list = signedOutRefDoors(buildASTSchema(parse(typeDefs), { assumeValidSDL: true }));
    for (const door of ['createAppKey', 'regenerateAppKey', 'updateOrganization', 'deleteOrganization', 'linkGithubApp', 'updateOrgGithubApp', 'unlinkGithubApp', 'createUserInvitation', 'removeOrgMember']) {
      expect(list, door).toContain(door);
    }
    expect(list).toEqual([...list].sort());
  });

  it('a signed-out caller gets one byte-identical UNAUTHENTICATED for a real, a missing and a malformed ref', async () => {
    for (let i = 0; i < doors('x').length; i += 1) {
      const answers = await Promise.all([appId, orgId, orgUrn, generateId(), 'hrn:org:no-such', '@@ not a ref @@']
        .map(async (ref) => ask(doors(ref)[i]!)));
      const first = answers[0]!;
      expect(first.text, `door ${i}`).toContain('UNAUTHENTICATED');
      for (const a of answers) expect(a, `door ${i}`).toEqual(first);
    }
  });

  it('writes nothing for a signed-out caller', async () => {
    const before = await db.appKey.count();
    await ask(doors(appId)[0]!);
    await ask(doors(orgId)[2]!);
    expect(await db.appKey.count()).toBe(before);
    expect((await db.organization.findUniqueOrThrow({ where: { id: orgId } })).name).toBe('so85');
  });

  it('a signed-in caller keeps the answers it had: a real and a missing ref are not UNAUTHENTICATED', async () => {
    for (const ref of [orgId, generateId()]) {
      for (const q of doors(ref)) {
        const a = await ask(q, strangerToken);
        expect(a.text).not.toContain('UNAUTHENTICATED');
      }
    }
  });

  it('a mutation with no ref argument is not affected for a signed-out caller', async () => {
    const a = await ask('mutation { __typename }');
    expect(a.status).toBe(200);
    expect(a.text).toContain('Mutation');
  });
});
