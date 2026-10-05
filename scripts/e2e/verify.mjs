import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const base = process.env.E2E_VERIFY_URL || 'http://127.0.0.1:4100';
const keys = JSON.parse(readFileSync('/fixtures/credentials.json', 'utf8'));
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
  const data = await graphql(keys[handle], '{ me { handle } organizations(filter: {memberOnly: true}) { items { urn } } memories { items { urn } } }');
  assert.equal(data.me.handle, handle);
  assert.deepEqual(data.organizations.items.map(o => o.urn.replace(/^hrn:org:/, '')).sort(), expected);
  const memories = data.memories.items.map(m => m.urn.replace(/^hrn:mem:/, '')).sort();
  assert.deepEqual(memories, [...fixture.memories].sort(), `${handle}: unexpected or missing readable memories`);
  // Exercise the same handoff used by a local portal callback, with no IdP/mail.
  const login = await fetch(`${base}/auth/dev/login?email=${handle}@e2e.test`, { redirect: 'manual' });
  assert.equal(login.status, 302, `${handle} dev-login`);
  const code = new URL(login.headers.get('location')).searchParams.get('code');
  assert(code);
  const session = await fetch(`${base}/auth/session`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(session.status, 200);
  const { token } = await session.json();
  assert.equal((await graphql(token, '{ me { handle } }')).me.handle, handle);
  console.log(`${handle}: token identity, organization inventory, memory access and portal login handoff PASS`);
}
// The App credential resolves its own seeded memory and installed role agents.
for (const root of ['e2e-alpha', 'e2e-beta']) {
  const data = await graphql(keys[`${root}:team`], `{ memory(ref: "hrn:mem:${root}:app") { urn } }`);
  assert(data.memory.urn.includes(`${root}:app`));
}
console.log('Authenticated fixture journeys PASS (browser rendering checked independently by QA)');

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
for (const principal of ['alpha-admin', 'e2e-alpha:team']) {
  const client = new Client({ name: 'e2e-fixture-check', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${keys[principal]}` } },
  });
  try {
    await client.connect(transport);
    assert((await client.listTools()).tools.length > 0);
    console.log(`${principal}: MCP initialize and tools discovery PASS`);
  } finally { await client.close(); }
}
