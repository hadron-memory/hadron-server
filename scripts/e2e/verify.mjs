import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const base = process.env.E2E_VERIFY_URL || 'http://127.0.0.1:4100';
const keys = JSON.parse(readFileSync('/fixtures/credentials.json', 'utf8'));
const principals = JSON.parse(readFileSync('/fixtures/principals.json', 'utf8'));
const { users } = await import('./catalog.ts');
async function graphql(token, query) {
  const res = await fetch(`${base}/graphql`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data;
}
for (const [handle, fixture] of Object.entries(users)) {
  const expected = fixture.memberships.map(m => m.split(':')[0]).sort();
  const data = await graphql(keys[handle], '{ me { id handle email identityProvider roles appMemberships { app { urn } } } organizations(filter: {memberOnly: true}) { items { urn } } memories { items { urn } } }');
  assert.equal(data.me.id, principals[handle].id);
  assert.equal(data.me.handle, principals[handle].handle);
  assert.equal(data.me.email, `${handle}@e2e.test`);
  assert.equal(data.me.identityProvider, fixture.provider ?? 'EMAIL');
  assert.deepEqual([...data.me.roles].sort(), [...fixture.roles ?? ['READER']].sort());
  assert.deepEqual(data.me.appMemberships.map(row => row.app.urn.replace(/^hrn:app:/, '')).sort(), [...fixture.apps ?? []].sort());
  assert.deepEqual(data.organizations.items.map(o => o.urn.replace(/^hrn:org:/, '')).sort(), expected);
  const memories = data.memories.items.map(m => m.urn.replace(/^hrn:mem:/, '')).sort();
  assert.deepEqual(memories, [...fixture.memories].sort(), `${handle}: unexpected or missing memory records`);
  // Exercise the same handoff used by a local portal callback, with no IdP/mail.
  const login = await fetch(`${base}/auth/dev/login?email=${handle}@e2e.test`, { redirect: 'manual' });
  assert.equal(login.status, 302, `${handle} dev-login`);
  const code = new URL(login.headers.get('location')).searchParams.get('code');
  assert(code);
  const session = await fetch(`${base}/auth/session`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(session.status, 200);
  const { token, isNew } = await session.json();
  // README: later dev-login sessions use the existing-user handoff. fresh-user's
  // isNew=true is proven once, at provisioning; every login here is a returning one.
  assert.equal(isNew, false, `${handle} dev-login must report an existing user`);
  assert.equal((await graphql(token, '{ me { handle } }')).me.handle, principals[handle].handle);
  console.log(`${handle}: token identity, org/App membership, memory record inventory and portal login handoff PASS`);
}
// Free-standing strict-owner fixtures stay private even from platform admins.
for (const cls of ['personal', 'private']) {
  const urn = `hrn:mem:personal-owner:${cls}`;
  const query = `{ memory(ref: "${urn}") { urn } }`;
  assert.equal((await graphql(keys['personal-owner'], query)).memory.urn, urn);
  for (const principal of ['platform-admin', 'alpha-admin', 'outsider', 'e2e-alpha:team']) {
    assert.equal((await graphql(keys[principal], query)).memory, null, `${principal} must not read ${urn}`);
  }
}
assert.equal((await graphql(keys['platform-admin'], '{ memory(ref: "hrn:mem:e2e-alpha:knowledge") { urn } }')).memory.urn,
  'hrn:mem:e2e-alpha:knowledge', 'Platform admin direct-read reach is distinct from its empty default list');
console.log('Free-standing strict-owner memory controls and org-less platform admin PASS');
// The App credential resolves its own seeded memory and installed role agents.
for (const root of ['e2e-alpha', 'e2e-beta']) {
  const data = await graphql(keys[`${root}:team`], `{ me { id } authContext { principalType user { id } } memory(ref: "hrn:mem:${root}:app") { urn } }`);
  assert.equal(data.me, null, 'App key must not acquire a User identity');
  assert.equal(data.authContext.principalType, 'APP');
  assert.equal(data.authContext.user, null);
  assert.equal(data.memory.urn, `hrn:mem:${root}:app`);
}
console.log('Authenticated fixture journeys PASS (browser rendering checked independently by QA)');

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
for (const principal of ['alpha-admin', 'multi-app', 'e2e-alpha:team']) {
  const client = new Client({ name: 'e2e-fixture-check', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${keys[principal]}` } },
  });
  try {
    await client.connect(transport);
    assert((await client.listTools()).tools.length > 0);
    if (principal === 'multi-app') {
      const listed = await client.callTool({ name: 'hadron_list_apps', arguments: {} });
      const text = listed.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      assert(!listed.isError);
      // Match the App URNs, not the tool's prose, so a copy edit is not a failure.
      assert.deepEqual([...new Set(text.match(/hrn:app:[\w.-]+:[\w.-]+/g))].sort(), ['hrn:app:e2e-alpha:team', 'hrn:app:e2e-beta:team']);
      for (const root of ['e2e-alpha', 'e2e-beta']) {
        const selected = await client.callTool({ name: 'hadron_set_active_app', arguments: { app: `hrn:app:${root}:team` } });
        assert(!selected.isError);
        const after = await client.callTool({ name: 'hadron_list_memories', arguments: {} });
        assert(!after.isError);
        const scopeLine = after.content.filter(item => item.type === 'text').map(item => item.text).join('\n').split('\n')[0];
        assert(scopeLine.includes(`active App hrn:app:${root}:team`), scopeLine);
      }
      console.log('multi-app: MCP App enumeration and switching between both Apps PASS');
    }
    console.log(`${principal}: MCP initialize and tools discovery PASS`);
  } finally { await client.close(); }
}
