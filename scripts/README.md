# D1b OAuth prototype — test scripts and walkthroughs

Tests for the user-level auth + OAuth 2.1 work on
[`raghvind/oauth-prototype-d1b`](https://github.com/baragaun/hadron-server/tree/raghvind/oauth-prototype-d1b).

See the design artifact for the full spec:
`hadron-concept/design-discussions/hadron-platform/2026-05-17-user-level-auth/artifact-raghvind-task.md`.

There are three layers of testing, in order of complexity. Layers 1 and 2
are fully automated and prove spec compliance. Layer 3 verifies a real
remote MCP client (Claude Desktop / VS Code Copilot) can use the server
through a tunnel.

---

## Prereq — start the server

```sh
pnpm dev
# wait for: hadron-server listening on http://localhost:4000
```

You'll see an unrelated startup-sync error about `memories.urn_normalized_at`
on most dev DBs — it's benign, the server keeps running and all the
endpoints work.

---

## Layer 1 — minimum target smoke test

Walks: pick a real user → mint a JWT → call `Mutation.createUserApiKey`
via GraphQL → use the returned `hdr_user_<…>` token against `POST /mcp`
→ verify MCP `initialize` returns 200 and the DB row's `lastUsedAt` updates.

```sh
pnpm exec tsx scripts/test-user-api-key.ts
```

Expected last line: `PASS: D1b minimum target reachable end-to-end.`

---

## Layer 2 — OAuth target smoke test

Walks the full OAuth 2.1 dance against the local server, including:
PRM (RFC 9728) → AS metadata (RFC 8414) → `/mcp` 401 with
`WWW-Authenticate` carrying PRM URL → server-domain cookie via JWT
(skips the GitHub round-trip) → consent (skipped — directly POSTs
approve) → `/oauth/token` with PKCE S256 + RFC 8707 resource verify →
authenticated `/mcp` → replay rejection on second token redemption.

```sh
pnpm exec tsx scripts/test-oauth-dance.ts
```

Expected last line: `PASS: D1b OAuth target reachable end-to-end.`

---

## Layer 3 — Real remote MCP client via cloudflared tunnel

The bonus target from the artifact. Verifies a spec-compliant MCP
client (Claude Desktop or VS Code Copilot Chat) can walk the OAuth
dance end-to-end against the prototype.

### Why cloudflared (and not ngrok)

Both work for the public-internet exposure, but **ngrok's free domains
may be on Anthropic's URL allowlist; cloudflared's `*.trycloudflare.com`
have been observed working**. Either way, the tunnel is essential —
remote MCP clients connect from cloud IPs, so localhost is unreachable
to them.

### 3.1 Start cloudflared

```sh
# In a NEW terminal — keep `pnpm dev` running in another
cloudflared tunnel --url http://localhost:4000
```

It prints a URL like `https://invest-recovery-drove-regulated.trycloudflare.com`.
Copy it. The full MCP endpoint URL is that URL with `/mcp` on the end.

> ⚠️ Free `trycloudflare.com` tunnels are ephemeral and can die after
> idle / restart. If you see Cloudflare HTML error pages on a `curl`
> probe, restart the tunnel for a fresh URL.

### 3.2 Smoke-check the tunnel

Before opening a client, confirm the tunnel reaches all four
discovery / auth endpoints:

```sh
TUNNEL=https://<your-tunnel>.trycloudflare.com

curl -s $TUNNEL/health
# expect: {"ok":true}

curl -s $TUNNEL/.well-known/oauth-protected-resource | jq
# expect: HTTPS URLs in `resource` and `authorization_servers`
# (if you see http:// URLs, app.set('trust proxy', true) isn't working)

curl -s $TUNNEL/.well-known/oauth-authorization-server | jq
# expect: registration_endpoint present, token_endpoint_auth_methods_supported=["none"]
# (both are required for Claude Desktop / VS Code to attempt OAuth)

curl -si -X POST $TUNNEL/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{}}' | grep -i www-authenticate
# expect: WWW-Authenticate: Bearer realm="hadron", error="invalid_token", resource_metadata="https://..."
# The resource_metadata URL must be HTTPS for Claude Desktop to follow it.
```

### 3.3a Claude Desktop

1. Claude Desktop → **Settings → Connectors → Add Custom Connector**
2. Paste: `https://<your-tunnel>.trycloudflare.com/mcp`
3. Click Add

What you should observe in the hadron-server terminal (because the
request-logger middleware is enabled in `src/server.ts`):

```
[req] POST /mcp                                   ua=Claude-User
[req] POST /mcp                                   ua=python-httpx/0.28.1
[req] GET /.well-known/oauth-protected-resource   ua=python-httpx/0.28.1
[req] GET /.well-known/oauth-authorization-server ua=python-httpx/0.28.1
[req] POST /oauth/register                        ua=python-httpx/0.28.1
[req] GET /oauth/authorize?response_type=code&...  ua=Mozilla/...  ← your browser opens
[req] GET /auth/github?return_to=...              ua=Mozilla/...  ← bounces to GitHub
[req] GET /auth/github/callback?code=...          ua=Mozilla/...  ← signed in
[req] GET /oauth/authorize?response_type=code&... ua=Mozilla/...  ← back on consent page
[req] POST /oauth/authorize                       origin=http://localhost:4000  ← Approve
[req] POST /oauth/token                           ua=python-httpx/0.28.1  ← Anthropic exchanges code
[req] POST /mcp  (multiple)                       ua=Claude-User  ← authenticated, listing tools
```

After the consent page disappears and Claude Desktop returns to its
main UI, ask Claude in a conversation: *"list my Hadron memories using
the hadron tools"*. It should call MCP tools through the tunnel and
return results.

**For the record, Claude Desktop's `redirect_uri` is**
`https://claude.ai/api/mcp/auth_callback`. Captured dynamically by DCR.

### 3.3b VS Code Copilot Chat (Agent mode)

1. VS Code → Cmd-Shift-P → **MCP: Add Server**
2. Choose **HTTP** transport
3. Paste: `https://<your-tunnel>.trycloudflare.com/mcp`
4. Give it a name like `hadron`
5. Choose **Workspace** or **User** scope

Or hand-edit `.vscode/mcp.json`:

```json
{
  "servers": {
    "hadron": {
      "type": "http",
      "url": "https://<your-tunnel>.trycloudflare.com/mcp"
    }
  }
}
```

No auth fields — VS Code's MCP client detects the 401 and walks the
same OAuth + DCR dance.

In Copilot Chat, switch to **Agent mode** (dropdown next to chat
input) and type `#` to see Hadron tools listed.

### Common failures and what they mean

| Symptom | Likely cause |
|---|---|
| `Couldn't reach the MCP server` in Claude Desktop, **no requests** in server log | Anthropic's backend filtered the tunnel URL before attempting it. Try cloudflared if you tried ngrok. Worst case, file a support ticket with the `ofid_…` reference. |
| Server log shows discovery requests then silence (no `/oauth/register`, no `/oauth/authorize`) | AS metadata likely missing `registration_endpoint` or `token_endpoint_auth_methods_supported`. The current code has both — but if you've modified the OAuth module, re-check. |
| `curl` shows `http://` URLs in PRM / WWW-Authenticate | `app.set('trust proxy', true)` isn't taking effect. Check it's in `src/server.ts` before the `cors()` middleware. |
| Consent page → 400 `invalid_redirect_uri` | The client's redirect_uri isn't in the matching `OAuthClient` row's `redirect_uris`. With DCR working, this shouldn't happen — DCR writes the URI at registration time. |
| `/oauth/token` → 400 `PKCE verification failed` | Code-verifier doesn't match challenge. Check the client is sending the exact same verifier it generated the challenge from. |
| `/oauth/token` → 400 `invalid_grant` "Code already redeemed" | Single-use enforcement working as intended. Re-run the OAuth dance to get a fresh code. |

---

## Cleanup

To revoke tokens minted during testing:

```sql
-- Soft-revoke (preserves the row for audit):
UPDATE user_api_keys SET revoked_at = NOW() WHERE label LIKE 'oauth:%' OR label = 'd1b-smoke-test';

-- Or hard-delete:
DELETE FROM user_api_keys WHERE label LIKE 'oauth:%' OR label = 'd1b-smoke-test';
DELETE FROM auth_codes WHERE created_at > '2026-05-18'::date;
DELETE FROM oauth_clients WHERE client_id LIKE 'dcr_%';
```

Don't drop the seeded `test` or `claude-desktop` rows in `oauth_clients`
— `test` is used by `scripts/test-oauth-dance.ts`.
