// End-to-end smoke test for the D1b "minimum" target:
//   1. Pick an existing user from the dev DB
//   2. Sign a JWT for that user
//   3. Call Mutation.createUserApiKey via GraphQL
//   4. Use the returned raw hdr_user_ key against POST /mcp
//
// Run with: pnpm exec tsx scripts/test-user-api-key.ts
// Requires hadron-server running on http://localhost:4000.

import { PrismaClient } from '../src/generated/prisma/index.js';
import { signJwt } from '../src/auth/jwt.js';

const SERVER = process.env.SERVER_URL ?? 'http://localhost:4000';

async function main() {
  const db = new PrismaClient();

  const user = await db.user.findFirst({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  if (!user) throw new Error('No users in dev DB — sign in via /auth/github first.');
  console.log(`[1] Using user: id=${user.id} handle=${user.handle ?? '(none)'} email=${user.email ?? '(none)'}`);

  const jwt = await signJwt({
    sub: user.id,
    roles: user.roles as ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[],
    githubUsername: user.githubUsername ?? undefined,
    email: user.email ?? undefined,
    githubId: user.githubId ?? undefined,
  });
  console.log(`[2] Signed JWT (${jwt.length} chars)`);

  const mutationRes = await fetch(`${SERVER}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      query: `
        mutation Mint($label: String) {
          createUserApiKey(label: $label) {
            rawKey
            key { id keyPreview label createdAt }
          }
        }
      `,
      variables: { label: 'd1b-smoke-test' },
    }),
  });
  const mutationJson = await mutationRes.json() as any;
  if (mutationJson.errors) {
    console.error('[3] Mutation errors:', JSON.stringify(mutationJson.errors, null, 2));
    process.exit(1);
  }
  const { rawKey, key } = mutationJson.data.createUserApiKey;
  console.log(`[3] Minted UserApiKey id=${key.id} preview=${key.keyPreview} label=${key.label}`);
  console.log(`    rawKey prefix: ${rawKey.slice(0, 15)}... length=${rawKey.length}`);

  const mcpRes = await fetch(`${SERVER}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${rawKey}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1,
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'd1b-smoke-test', version: '0.0.1' },
      },
    }),
  });
  const mcpText = await mcpRes.text();
  console.log(`[4] POST /mcp status: ${mcpRes.status}`);
  console.log(`    body (first 400 chars): ${mcpText.slice(0, 400)}`);

  if (mcpRes.status !== 200) {
    console.error('FAIL: /mcp did not return 200 — user-key auth path is not accepted.');
    process.exit(1);
  }

  // Confirm DB-side lastUsedAt updated (fire-and-forget — give it a moment)
  await new Promise((r) => setTimeout(r, 300));
  const reloaded = await db.userApiKey.findUnique({ where: { id: key.id } });
  console.log(`[5] DB row: lastUsedAt=${reloaded?.lastUsedAt?.toISOString() ?? '(null — fire-and-forget may have missed)'}`);

  await db.$disconnect();
  console.log('\nPASS: D1b minimum target reachable end-to-end.');
}

main().catch((err) => {
  console.error('UNCAUGHT:', err);
  process.exit(1);
});
