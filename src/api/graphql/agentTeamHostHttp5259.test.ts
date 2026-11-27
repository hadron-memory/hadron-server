/**
 * #5259 — joinAgentTeamHost over the real `/graphql` handler: the server half of #5210's measurement U6 (is a sign-in
 * token from `hadron auth login` admitted to the person-only key mutations?). A user key whose OAuth grant includes
 * `account` (what `hadron auth login` requests) is admitted and joins; one limited to `mcp` is refused at /graphql before
 * any resolver runs. And the raw key appears in the join's response body only, never in a log line.
 * Not a measurement of the CLI: hadron-server#5210 owns U6.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../middleware/auth.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../../test/startServerFixture.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let http: Server;
let base: string;

beforeAll(async () => {
  http = httpServer(await createServerOnCleanDb());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await closeServerIfStarted(http); });

const JOIN = 'mutation($appRef: String!) { joinAgentTeamHost(input: { appRef: $appRef, hostId: "mac1" }) { rawKey host { hostId } } }';

async function post(key: string, appRef: string): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: JOIN, variables: { appRef } }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* the assertions below show the text */ }
  return { status: res.status, text, json };
}

let appId: string;
const keys: Record<string, string> = {};

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'TH HTTP', urn: `thhttp-${n}.example` } });
  const manager = await db.user.create({ data: { handle: `th-http-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } })).id;
  for (const [name, oauthScopes] of [['account', ['mcp', 'account']], ['mcpOnly', ['mcp']]] as const) {
    keys[name] = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
    await db.userApiKey.create({ data: { userId: manager.id, oauthScopes: [...oauthScopes], keyHash: hashUserApiKey(keys[name]!), keyPreview: keys[name]!.slice(-4) } });
  }
});

describe('U6, the server half: who reaches joinAgentTeamHost through /graphql', () => {
  it('a user key granted `account` (as `hadron auth login` asks) is admitted, and joins', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }));
    let res: Awaited<ReturnType<typeof post>>;
    try {
      res = await post(keys.account!, appId);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(res.status).toBe(200);
    expect(res.json.errors).toBeUndefined();
    expect(res.json.data.joinAgentTeamHost.host).toEqual({ hostId: 'mac1' });
    const raw = res.json.data.joinAgentTeamHost.rawKey as string;
    expect(raw).toMatch(/^hdr_app_[0-9a-f]{64}$/);
    expect(lines.join('\n')).not.toContain(raw);
    expect(lines.join('\n')).not.toContain('hdr_app_');
  });

  it('a user key limited to `mcp` is refused at /graphql, and nothing is written', async () => {
    const res = await post(keys.mcpOnly!, appId);
    expect(res.status).toBe(403);
    expect(res.json.errors?.[0]?.extensions).toMatchObject({ reason: 'OAUTH_SCOPE_INSUFFICIENT', requiredScope: 'account' });
    expect(res.json.data).toBeUndefined();
    expect(await db.agentTeamHost.count()).toBe(0);
    expect(await db.appKey.count({ where: { appId } })).toBe(0);
  });
});
