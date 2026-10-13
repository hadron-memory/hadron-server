# #1630 local passkey spike

Standalone loopback experiment using the DAQ-approved exact pair:
`@simplewebauthn/server` **14.0.3** and `@simplewebauthn/browser` **14.0.0**.
Its own package/lock file isolates these dependencies from Hadron production.
Node 22+; no DB, Hadron auth, app routes, schema or production registration.

```sh
npm ci --prefix scripts/passkey-spike
npm exec --prefix scripts/passkey-spike -- playwright install chromium
npm --prefix scripts/passkey-spike test
# Interactive synthetic-fixture page; stop with Ctrl-C.
npm --prefix scripts/passkey-spike start
```

Open `http://localhost:4380` (optional `PASSKEY_SPIKE_PORT`). The server binds
only 127.0.0.1 and accepts only its exact localhost Host. The page displays the
synthetic S0 `spec-retention-example` text and exact payload. Server and browser
independently recompute its SHA-256; the library receives the raw digest as its
custom challenge, not the hex spelling. RP ID is `localhost`, expected origin
is the exact server URL. Registration requests a discoverable credential and
UV; both verifiers require UV. Credential/pending state exists only in memory,
expires after five minutes (ceremonies after one minute), and is capped.

`probe.mjs` launches Chromium with a virtual CTAP2 authenticator. It registers
through the page's browser SDK, independently checks the resident credential,
asserts the challenge is the S0 digest, signs and verifies on the server.
It then proves refusals for UV=false, a genuinely signed wrong-origin response,
a repeated spent ceremony, and a stored assertion replayed into a new ceremony
(including an equivalent base64 encoding). In-process controls verify that the
UV=false and wrong-origin assertions are cryptographically valid with the
corresponding expectation weakened: the negative case is not a corrupt-signature
false positive. The SDK also rejects wrong-RP and wrong-challenge expectations.
These controls are never HTTP bypasses. No key or assertion bytes are logged.

For an already installed Chromium:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chrome \
  npm --prefix scripts/passkey-spike test
```

The probe closes both servers and Chromium even on failure. It prints browser
version, exact origin, fixture, each leg and explicit limits; ports are ephemeral.

## What this proves and what remains

Local **protocol GO**, with a synthetic authenticator: discoverability, UV,
custom-challenge bytes and server verification/refusals. It proves no real human
presence, device sync, hybrid/cross-device flow or production RP/origin. Holger's
AL device session and a separate production-host proposal remain later legs;
this is not a shipped enrollment flow or an epic-wide production GO.

Replay evidence is limited to the probe's incrementing-counter virtual
credential. A pending attempt is consumed before verification, and the probe
refuses a replay of the same accepted assertion bytes (including encoding
aliases). This is **not sound per-assertion deduplication** under the deterministic
S0 challenge: the fingerprint includes the ES256 signature, whose `(r, n-s)`
twin can still verify in server 14.0.3 but has a different fingerprint. A
counter-zero synced credential supplies no counter backstop. Omitting the
signature instead collides with honest re-signing of the same payload. Also,
the fingerprint check and insertion straddle an await, so concurrent requests
can both pass that check. The probe does not establish resistance to either
case, nor to replay of a completion that was dropped and never recorded.

A per-ceremony nonce needs the separate payload-contract ruling (#10005/#10033);
that work is outside this spike. Local synthetic protocol GO is unaffected,
but does not authorize production replay guarantees. Restarting or expiring
this demo discards all state; it makes no durable replay guarantee.

Primary implementation references:
[server API](https://simplewebauthn.dev/docs/packages/server),
[custom challenges](https://simplewebauthn.dev/docs/advanced/server/custom-challenges),
[Chromium virtual authenticators](https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/).
