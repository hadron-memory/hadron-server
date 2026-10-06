# S1 passkey spike preparation (#1630)

Run `node scripts/passkey-spike/preview.mjs`, then open
`http://localhost:4380` (optional `PASSKEY_SPIKE_PORT`). The loopback-only
server displays the synthetic S0 Retention vector. The server and browser
independently check its digest. Registration/signing are disabled until
Holger decides the WebAuthn library; this is not ceremony evidence.

Next: approved library, ephemeral credential and challenge store, required
UV/discoverability, register → sign raw S0 digest → server verification,
local browser proof, then a separate production-host proposal. No production
schema. Synthetic authenticators do not establish human presence or sync/hybrid
support; Holger's devices cover those legs under AL. Production registration
requires Holger's explicit go (RP=hadronmemory.com).
