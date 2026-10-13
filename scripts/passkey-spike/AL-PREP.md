# Temporary AL session — preparation, no deployment authorization

Two prepared alternatives, both serving only `/__passkey-al/` on the **exact HTTPS ceremony origin Holger chooses**, RP `hadronmemory.com`. `ops:alpha` currently records the server API origin as `srv.hadronmemory.com`; the spec's apex URL is an example. Confirm the chosen host and its existing HTTPS route before deploying. Neither option uses the portal, auth tokens, Postgres, or any production enrollment/signing record. The fixture is synthetic v1/S0, not production v3. A browser may retain the throwaway passkey; remove it from the provider afterwards.

## A — separate temporary container behind the existing Traefik origin (recommended)

Prepared: `Dockerfile`, its build-context ignore file, and `al.compose.yml`. Run from this checkout after Holger's pick. Set AL_ORIGIN, AL_HOST, AL_ENTRYPOINT and AL_PROXY_NETWORK to his origin and the existing Traefik settings. `docker compose -f scripts/passkey-spike/al.compose.yml up -d --build` builds Node 22 plus the exact approved SDK pair, creates one read-only non-root container on the proxy network, and adds a higher-priority Host+path router. No host port is published, no volume or DB is mounted, and the rest of the host's routing stays with its existing service. No server deployment/restart or migration is needed.

Touches alpha: temporary image, container and Docker router labels/network membership only. Existing TLS termination stays in place; the origin must already route to alpha, otherwise DNS/routing is an additional choice and this is not a minutes-only deployment. Trade-off: isolated process and easy removal, but needs Docker build capacity and verified proxy entrypoint/network. Docker is unavailable in the prep workstation, so the image has not been built here; the locked Node application itself was tested locally. Do not claim an image/deployment smoke test until it runs.

Remove: `docker compose -f scripts/passkey-spike/al.compose.yml down` removes the container and its router labels, erasing all in-memory credentials. Remove temporary image afterwards if desired. Verify the path returns its ordinary 404 and the rest of the origin still works. No permanent new hostname, DNS record or TLS certificate is required.

## B — temporary isolated Node process on alpha with a Traefik file-provider path

Prepared: `al-host.service`, `al-host.env.example`, `al-host-traefik.yml.example`, and this standalone directory plus `src/lib/signaturePayload.fixture.json`. Install under `/opt/hadron-passkey-al` as a dedicated unprivileged account, install the locked package with `npm ci --omit=dev`, fill the explicit origin and private Docker host-gateway bind address, then start the temporary systemd unit. Add the prepared Host+path router to the existing Traefik file provider, with the existing HTTPS entrypoint and private gateway address. No Hadron server change/restart or migration.

Touches alpha: temporary `/opt` directory, dedicated account, environment file, systemd unit and one dynamic proxy snippet. Trade-off: no image build; more host cleanup and relies on an existing Node 22 runtime and file provider. Bind only the private proxy-facing address, not public interfaces; do not add an Internet-facing port. If Node 22/file-provider support is absent, this option is not ready in minutes and A is preferred.

Remove: delete the proxy snippet and confirm the path no longer resolves to the demo, stop/remove the unit, remove `/opt/hadron-passkey-al`, env file and dedicated account. State disappears on stop. Existing application/proxy services remain running.

## Shared live preflight and evidence

Greta owns evidence under `sprints:sprint-2:qa:hadron-server-1630:al-session`. Confirm HTTPS URL exactly, RP `hadronmemory.com`, browser versions, OS versions, and no portal session required. Capture each verify JSON (verified, userVerified, origin, rpID, counter, backupEligible, backedUp, deviceType), actual provider chosen, and screenshot of provider prompt/result. Provider in the page is a human label, not cryptographic provider identification. Do not capture private-key material, raw cookie or pairing codes. All physical legs require UV=true; wrong origin/RP or UV=false is a failure. Distinguish user cancellation/environment setup failure from a completed assertion that violates the rule. A failed actual-device leg is reported to Holger for the feature GO/NO-GO decision; it is never silently replaced by the synthetic dry run.

The demo session lasts five minutes, options one minute; pair codes are single-use and last 60 seconds. Register afresh after expiry. For every leg, choose the page's evidence label AND explicitly select the real provider in the browser/system prompt. If the prompt selected a different provider, mark that attempt misrouted and repeat; do not count it as the requested leg.

### 1 — iCloud Keychain, Mac → iPhone sync

On Mac, choose Apple's Passwords/iCloud Keychain rather than 1Password (use the prompt's other-options/Passwords picker; temporarily disable the 1Password extension for this leg if it intercepts). Register with Touch ID/device authentication. Create a pairing code. On iPhone, open the exact same HTTPS page, paste/join within 60 seconds, select Apple's Passwords/iCloud Keychain, then sign using Face ID/Touch ID/device passcode. Show that the credential registered on Mac is the one used on phone; no second registration before signing. Capture both verify results and the actual provider. If quick, repeat in reverse with a fresh session. Expected: both verified, UV=true, exact origin/RP, backup flags captured, synced credential counter captured. Fail: the registered credential cannot sign on the other device, UV=false, wrong origin/RP, or provider ambiguous. Pairing failure/expiry is a setup retry, not a sync pass or fail.

### 2 — cross-device QR/hybrid

Fresh session: register a passkey on the phone with the intended provider, create pairing code, join from the desktop page. Desktop Sign → choose another device/iPhone/use a phone, displaying the WebAuthn QR prompt. Scan using phone, complete the Bluetooth/proximity prompt and phone verification. Do not accidentally accept the desktop's locally synced credential; capture the QR and actual phone prompt/provider. Expected: desktop receives verified assertion, UV=true, exact origin/RP, flags/counter captured. Fail: completed flow fails verification or loses required UV/origin/RP. No QR choice or failed proximity flow is a device/browser capability failure to record, not synthetic success.

### 3 — 1Password provider on Mac and iPhone

Confirm the browser extension is enabled on Mac and 1Password is enabled/selected as the iOS passkey credential provider. Choose 1Password explicitly for registration and signing; record whether unlock used biometric or master password without recording the password. Register on Mac, sign there, then pair the same session on iPhone and sign using the 1Password provider. Expected: actual provider is 1Password on each device; UV=true after unlock (presence alone is insufficient), exact origin/RP; capture backupEligible/backedUp and counter, expected commonly zero but report the actual value. Fail: UV=false, wrong binding, same credential unavailable across devices, or verification refusal. A nonzero counter is evidence to assess, not an automatic protocol failure.

### Hardware key — follow-up, not today's gate

When Holger's key arrives: fresh session, select the physical key, set/use its PIN, register then sign. Expected verified + UV=true with exact origin/RP. Presence-only with no PIN must be refused. Until then report **untested, follow-up planned after delivery; not a production gate per Holger #10454**. No calendar appointment is claimed booked.

## Loopback dry run actually executed

Chromium 145.0.7632.6, virtual CTAP2 authenticator, RP localhost and ephemeral exact loopback origin. Passed prefixed-page register/sign, discoverable credential, UV, S0 digest, concurrent identical assertion reservation, independent session/user-handle tokens, isolated browser refusal, one-use pairing and a copied virtual credential signing in a second browser. Passed valid UV=false and wrong-origin negative controls, wrong-RP/challenge controls, spent/replayed assertions and base64 aliases. Explicit hosted config/Host/path smoke tests passed. Vitest file discovery excludes nested node_modules.

Leg 1 dry run emulates the two-browser workflow by copying a virtual credential; this does not prove iCloud sync. Leg 2 exercises assertion/verification UI but the local virtual browser has no real phone QR/hybrid leg. Leg 3 exercises UV/backup/counter reporting, without the real 1Password extension/provider. These are rehearsal coverage and stated limits, not three device PASS results. Real-provider/physical dry runs cannot be completed before Holger supplies the devices; if literal physical loopback rehearsal is required before the meeting, that portion slips. No alpha state has been touched.

Remaining replay limit: synchronous reservation closes identical concurrent submissions, but the deterministic S0 fixture is not a production replay design (ES256 signature twins/counter-zero replay remain outside this spike). Production uses the separately ruled v3 request binding. No production GO is claimed by this preparation.
