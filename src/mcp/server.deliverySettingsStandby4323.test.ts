/**
 * #4323 F3: `hadron_delivery_settings_set` takes a `.passthrough()` input, so a raw `standbyEnabled` would reach the
 * shared resolver (which refuses it with BAD_USER_INPUT, pinned at the resolver in resolvers.s7SdlRemoval3696.test.ts).
 * On main the tool is switched off by #3082 (offTeamTool, R4: no test-only path back), so over the real MCP transport
 * the refusal is the unknown-tool answer. This pins, for BOTH booleans, that the call is refused exactly as a name that
 * never existed and writes nothing (App row and team events read back). If the tool is ever switched back on, the
 * answer changes and this fails: then the BAD_USER_INPUT refusal must be re-pinned through the transport.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createMcpServerInstance } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

let appId: string, appUrn: string, userId: string;

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const auth = { userId, appId, roles: ['READER'], clientId: `user:${userId}` } as unknown as AuthContext;
  const server = createMcpServerInstance(auth as never, () => undefined, { kind: 'multi-app' });
  const client = new Client({ name: 'pin-4323', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  try {
    const r = await client.callTool({ name, arguments: args });
    return JSON.stringify(r);
  } catch (e) {
    return `error:${(e as Error).message}`;
  } finally { await client.close(); await server.close(); }
}

beforeAll(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'pin4323', urn: 'pin4323.test' } });
  userId = (await db.user.create({ data: { id: generateId(), handle: 'pin4323-admin' } })).id;
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId, role: 'ADMIN' } });
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: 'pin4323.test:team' } });
  appId = app.id; appUrn = app.urn;
});

describe('#4323 F3: standbyEnabled through the MCP delivery-settings tool', () => {
  it.each([true, false])('standbyEnabled=%s is refused as an unknown tool and writes nothing', async (standbyEnabled) => {
    const snap = async () => ({ app: await db.app.findUniqueOrThrow({ where: { id: appId } }), events: await db.agentTeamEvent.findMany({ where: { appId } }) });
    const before = await snap();
    const baseline = await call('hadron_never_registered_4323', { appRef: appUrn, input: { standbyEnabled } });
    const got = await call('hadron_delivery_settings_set', { appRef: appUrn, input: { standbyEnabled } });
    const norm = (s: string, n: string) => s.split(n).join('<tool>');
    expect(norm(got, 'hadron_delivery_settings_set')).toBe(norm(baseline, 'hadron_never_registered_4323'));
    expect(got).not.toMatch(/"isError":false/);
    expect(await snap()).toEqual(before);
  });
});
