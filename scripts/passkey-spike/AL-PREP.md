# Temporary AL session — preparation, no deployment authorization

Holger's hosting choices are settled; the one-hour session is **not booked**.
This document is preparation, not authorization to change alpha, DNS, routing or
any device settings. Source: [#2037](https://github.com/hadron-memory/hadron-server/issues/2037),
Marco's relay of Holger's 2026-10-17 ruling (team chat #20335), and
[#1865](https://github.com/hadron-memory/hadron-server/pull/1865)'s hosting review
(Rook #10476 / Xylon #10479). Eden confirmed the agreed hostname and
Cloudflare proxy setting after Marco's content check (team chat #20348).

| Choice | Settled plan | Why / remaining input |
| --- | --- | --- |
| Q1: ceremony origin | **`passkey-al.hadronmemory.com`, Cloudflare-proxied like `srv.`**, not the `srv.hadronmemory.com` ceremony origin; RP stays **`hadronmemory.com`** | No production-session cookies on the ceremony origin. The name is agreed; Holger/ops adds its DNS record with the agreed proxy setting; exact HTTPS origin/TLS and cookie isolation must be verified before use. A dedicated host alone does not exclude parent-domain cookies. |
| Q2: exposure | **Fresh random base path** ending in `/` | Meets the reviewed exposure condition without reopening the random-path/allowlist choice. Keep the path private before use; it is not authentication. |
| Q3: process | **Option A: temporary container behind Traefik** | Isolates the throwaway process/state, uses existing TLS/proxy infrastructure, and has a small removal surface; no Hadron restart or migration. |

The exact ceremony origin is **`https://passkey-al.hadronmemory.com`**.
Serve only the chosen `AL_BASE_PATH` on that origin. Neither option
uses the portal, auth tokens, Postgres, or production enrollment/signing records.
The fixture is synthetic v1/S0, not production v3. Do not sign into production
from the AL browser session. Before exposure, the authorized operator checks that
requests to the AL origin carry no production-session cookies or auth headers
(use a clean browser profile where needed); record only the result, never cookie
values. If isolation cannot be established, stop rather than falling back to
`srv.`. Remove throwaway provider passkeys afterwards.

## Failed-attempt lessons and per-device preflight

The previous attempt ran out of time: five-minute sessions and 60-second pairing
codes were too short; [#1984](https://github.com/hadron-memory/hadron-server/pull/1984)
made both configurable. Holger also reported device-setting friction and **did
not use Apple Passwords for the Mac flow**. The Mac leg spent about 30 minutes
before the provider was chosen. Do not repeat an Apple-first prompt hunt or count the page's provider
label as proof of which provider actually handled a ceremony.

**Device record supplied by Holger via Marco (team chat #20401):** the Mac
uses 1Password; the iPhone offers both 1Password and Apple Passwords, with Apple
Passwords enabled on the phone **for this test**. This updates the earlier
unknown record (#20341); it does not make Apple the Mac provider. Complete the
remaining unknowns before booking. Record choices/settings, not account secrets.

| Device | OS + browser version | Actual passkey provider/version | Enabled extension / AutoFill setting, unlock + sync readiness | Rehearsed picker clicks |
| --- | --- | --- | --- | --- |
| Mac | **macOS 26.3.1 (a) (25D771280a); Chrome, version unknown** | **1Password**; version unknown | **1Password extension state, same-account sync, unlock and Bluetooth/other settings unknown — Holger confirms** | Select 1Password and the current TAG; record actual Chrome prompt labels during preflight |
| iPhone | **iOS 27.0.1**; browser/version unknown | **1Password AND Apple Passwords**; Apple Passwords enabled for the test; 1Password version unknown | Confirm 1Password AutoFill readiness, whether both devices share one 1Password account, unlock and Bluetooth/other settings — **still unknown** | Select **1Password for sync**, **Apple Passwords for the planned phone QR leg**; record actual prompt labels |

### Provider selection for each scheduled leg

| Leg | Mac selection | iPhone selection | What it can prove |
| --- | --- | --- | --- |
| Mac registration + local signing | **1Password**, current TAG | Not used | Mac provider/UV/binding |
| Mac → iPhone synced credential | **1Password** registration; same synthetic session | **1Password**, same TAG; do **not** accept Apple Passwords here | 1Password sync only after same-account readiness is confirmed |
| Phone registration → desktop QR/hybrid | **Use a phone / another device**; bypass local 1Password selection | **Apple Passwords**, current fresh-session TAG | Phone Apple credential through QR, **not Apple/iCloud sync from Mac** |
| Optional extra QR/provider retry, only inside the remaining time box | Explicitly agreed flow, fresh session | **1Password only if named before starting this separate leg** | Separate evidence, never relabelled as Apple evidence |
| Apple/iCloud Mac → iPhone sync | **Not scheduled under the recorded Mac 1Password setup** | Apple Passwords alone is insufficient | NOT RUN unless Holger separately opts into Apple on Mac and completes that preflight |

Because the phone offers both providers, cancel a prompt for the wrong provider
and explicitly switch to the matrix's selection. Record the **actual** provider
beside each result; neither the page label nor the phone's enabled-provider list
proves which one signed. Do not infer a shared 1Password account or Bluetooth
readiness from the fact that both apps/providers are present.

The provider on registration and signing must be named per leg. Confirm the
provider app is installed/unlocked, the intended browser extension or iOS AutoFill
provider is enabled, the intended sync account is available on both devices, and
Bluetooth/proximity is available for the QR leg. Changes are made by Holger with
his consent; record and restore any temporary setting changes. No device access
or physical rehearsal is claimed by this documentation update.

**Picker procedure to rehearse and record before starting the hour:**

1. On Mac, unlock the chosen provider and confirm its browser extension is active.
   On the AL page select Register, then explicitly choose that provider in the
   save-passkey prompt, choose the intended vault/account and save the current
   `synthetic-retention-user-TAG`. On Sign, select that same provider and TAG.
   If the OS offers Apple Passwords by default, cancel or open its alternate
   provider/device picker; do not accept Apple as Holger's normal provider.
2. **For 1Password (the Mac and phone-sync selections)**, its browser prompt
   offers the save-passkey flow; for another credential choose **Other options** (or Down Arrow), then
   the current TAG. On iPhone the documented setup is **Settings → General →
   AutoFill & Passwords → AutoFill Passwords and Passkeys → 1Password**; unlock
   1Password, choose the current passkey and Continue. Verify these labels on
   the recorded OS version; if they differ, write the actual steps before the
   appointment rather than spending the session searching.
3. For QR/hybrid, on desktop Sign choose **another device / use a phone** to
   display the WebAuthn QR. Scan with the phone camera, choose the intended
   provider (**Apple Passwords for the scheduled phone QR leg**), complete
   proximity and device verification. Distinguish this from the AL **pairing code**, which joins the
   synthetic browser session; neither replaces the other.
4. If another provider is chosen, fill its actual save/select/unlock steps in the
   table first. If the required provider cannot be selected, stop that leg as
   **setup blocked**; do not silently substitute Apple or another provider.

Picker references, checked 2026-10-17:
[1Password browser passkeys](https://support.1password.com/save-use-passkeys/) and
[1Password iPhone AutoFill/passkeys](https://support.1password.com/ios-autofill/).
These are picker references, **not proof of the still-unknown extension,
account, settings or actual ceremony selection**.
Apple/iCloud sync below is a separate explicitly chosen test leg; if Holger does
not opt into it, record **NOT RUN**, not a pass or an implicit provider change.

## One-hour run order and stop / fallback

Before booking: Holger supplies the device/provider table and the exact picker
steps; Holger/ops has separately authorized and prepared the dedicated DNS/TLS,
random path, Traefik network and isolated container. Record the deployed commit
and the evidence owner (Greta's evidence location below; confirm who operates it
when scheduling). No alpha action is authorized by this checklist.

Use `AL_SESSION_TTL_SECONDS=1800` and `AL_PAIRING_TTL_SECONDS=300` for the selected
Compose deployment (30 minutes / five minutes; the old defaults are 300/60).
Ceremony options still expire after one minute: request them just before use.
Start a **fresh synthetic session per independent leg**, issuing a pairing code
only when the other device is ready. A join never extends the original session.
The 30-minute lifetime is not a promise that one session covers the whole hour.

| Minute | Run / evidence |
| --- | --- |
| 0–10 | Check exact HTTPS origin, RP, cookie isolation and displayed TTLs; read the filled device/provider table aloud and verify picker choices. Stop if a prerequisite is unknown. |
| 10–20 | Fresh session: register and sign on Mac using the chosen provider; capture provider prompt/TAG and both verify JSON results. |
| 20–35 | Join from iPhone and explicitly choose **1Password**, same synced TAG; sign and compare `credentialIdHash`. Same-account readiness must be confirmed. Record Apple/iCloud Mac sync as NOT RUN under the current setup. |
| 35–45 | Fresh session: phone registration with **Apple Passwords**, then desktop QR/hybrid signing via that phone (not local Mac 1Password); capture actual prompts, required UV, binding and hash. |
| 45–50 | At most one bounded retry or an explicitly agreed remaining provider leg; preserve separate evidence and do not relabel a different-provider pass. |
| 50–60 | Stop new ceremonies, classify every leg (PASS / FAIL / setup blocked / NOT RUN), save redacted evidence, remove AL TAGs and restore settings. Authorized operator removes the temporary service/router and verifies cleanup; unfinished cleanup stays an owned action. |

**Stop / fallback rule:** allow at most five minutes of provider/pairing setup
troubleshooting per leg and one fresh-session retry, within that leg's time box.
If still blocked, move to an already-preflighted leg only with Holger's agreement;
mark the blocked leg honestly. At minute 50 stop new tests to protect cleanup.
Wrong origin/RP, UV=false, unexpected production cookies or any completed
verification failure stops the affected run immediately for evidence and Holger's
GO/NO-GO decision. Never relax UV/origin/RP checks, switch to `srv.`, or deploy
option B as an unapproved fallback. If hosting or all physical legs are blocked,
stop and reschedule; previously recorded synthetic rehearsal may explain the
workflow but cannot replace a real-device PASS. An omitted Apple or QR leg keeps
the corresponding #1630 coverage outstanding; no full feature GO is inferred.

## A — selected: temporary container behind Traefik on the dedicated AL origin

Prepared: `Dockerfile`, its build-context ignore file, and `al.compose.yml`. Run from the approved checkout only after separate deployment authorization. Set `AL_ORIGIN=https://passkey-al.hadronmemory.com` and `AL_HOST=passkey-al.hadronmemory.com`; set AL_BASE_PATH to the chosen random path and AL_ENTRYPOINT/AL_PROXY_NETWORK to the verified existing Traefik settings. `docker compose -f scripts/passkey-spike/al.compose.yml up -d --build` builds Node 22 plus the exact approved SDK pair, creates one read-only non-root container on the proxy network, and adds a higher-priority Host+path router. No host port is published, no volume or DB is mounted, and the rest of the host's routing stays with its existing service. No server deployment/restart or migration is needed.

Touches alpha: temporary image, container and Docker router labels/network membership only. Existing TLS termination stays in place; the dedicated origin must already route to alpha with valid TLS before the booked hour. The required new DNS record is Holger/ops work, not an open hosting choice. Trade-off: isolated process and easy removal, but needs Docker build capacity and verified proxy entrypoint/network. Docker is unavailable in the prep workstation, so the image has not been built here; the locked Node application itself was tested locally. Do not claim an image/deployment smoke test until it runs.

Remove: `docker compose -f scripts/passkey-spike/al.compose.yml down` removes the container and its router labels, erasing all in-memory credentials. Remove temporary image afterwards if desired. Verify the path returns its ordinary 404 and the rest of the origin still works. Holger/ops owns the dedicated DNS/TLS record disposition; remove or retain it only as separately agreed. Do not remove unrelated DNS or certificates.

## B — archived alternative, not selected or an automatic fallback

Retained for reference only; changing the ruled container plan requires a new explicit decision. Prepared: `al-host.service`, `al-host.env.example`, `al-host-traefik.yml.example`, and this standalone directory plus `src/lib/signaturePayload.fixture.json`. Install under `/opt/hadron-passkey-al` as a dedicated unprivileged account, install the locked package with `npm ci --omit=dev`, fill the explicit origin and private Docker host-gateway bind address, then start the temporary systemd unit. Add the prepared Host+path router to the existing Traefik file provider, with the existing HTTPS entrypoint and private gateway address. No Hadron server change/restart or migration.

Touches alpha: temporary `/opt` directory, dedicated account, environment file, systemd unit and one dynamic proxy snippet. Trade-off: no image build; more host cleanup and relies on an existing Node 22 runtime and file provider. Bind only the private proxy-facing address, not public interfaces; do not add an Internet-facing port. This is not the scheduled plan; if A is blocked, stop/reschedule rather than switching to B without authorization.

Remove: delete the proxy snippet and confirm the path no longer resolves to the demo, stop/remove the unit, remove `/opt/hadron-passkey-al`, env file and dedicated account. State disappears on stop. Existing application/proxy services remain running.

## Shared live preflight and evidence

Greta owns evidence under `sprints:sprint-2:qa:hadron-server-1630:al-session`. Confirm the evidence owner at scheduling (Greta was the original assignment). Confirm HTTPS URL exactly, RP `hadronmemory.com`, browser versions, OS versions, and no portal session required. Capture each verify JSON (verified, userVerified, credentialIdHash, origin, rpID, counter, backupEligible, backedUp, deviceType), actual provider chosen, and screenshot of provider prompt/result. Provider in the page is a human label, not cryptographic provider identification. Do not capture private-key material, raw cookie or pairing codes. All physical legs require UV=true; wrong origin/RP or UV=false is a failure. Distinguish user cancellation/environment setup failure from a completed assertion that violates the rule. A failed actual-device leg is reported to Holger for the feature GO/NO-GO decision; it is never silently replaced by the synthetic dry run.

By default the demo session lasts five minutes, options one minute; pair codes are single-use and last 60 seconds. The page displays the configured session/pairing lifetimes. For the resumed AL session, after Holger authorizes the deployment/rebuild, set `AL_SESSION_TTL_SECONDS=1800 AL_PAIRING_TTL_SECONDS=300` with Compose (30-minute session/cookie, five-minute pairing). The host-process equivalents are `PASSKEY_SPIKE_SESSION_TTL_SECONDS=1800` and `PASSKEY_SPIKE_PAIRING_TTL_SECONDS=300`. Each accepts whole seconds from 1 through 86400; invalid values refuse startup. Pair codes and joined cookies never outlive the original session; joining does not renew it. Options remain one minute. Rebuilding discards existing in-memory sessions. Record the actual deployed head and configured timing relative to #1865/#1984 before resuming; do not deploy before Holger says go. Register afresh after expiry. For every leg, choose the page's evidence label AND explicitly select the real provider in the browser/system prompt. If the prompt selected a different provider, mark that attempt misrouted and repeat; do not count it as the requested leg.

### Apple/iCloud sync — explicit opt-in coverage, not the default leg

Run only if Holger explicitly chooses this provider for this leg; he does not normally use Apple Passwords. Otherwise record NOT RUN. On Mac, choose Apple's Passwords/iCloud Keychain rather than 1Password (use the prompt's other-options/Passwords picker; temporarily disable the 1Password extension for this leg if it intercepts). Register with Touch ID/device authentication. Create a pairing code. On iPhone, open the exact same HTTPS page, paste/join within the displayed pairing lifetime, select Apple's Passwords/iCloud Keychain, then sign using Face ID/Touch ID/device passcode. Compare credentialIdHash in the Mac registration and phone signing responses; they must match. Signing uses an empty allowCredentials list (discoverable selection). A second registration is refused by the server; use a new browser session after expiry to register again. Capture both verify results and the actual provider. If quick, repeat in reverse with a fresh session. Expected: both verified, UV=true, exact origin/RP, backup flags captured, synced credential counter captured. Fail: credentialIdHash differs, the registered credential cannot sign on the other device, UV=false, wrong origin/RP, or provider ambiguous. Pairing failure/expiry is a setup retry, not a sync pass or fail.

### 2 — cross-device QR/hybrid

Fresh session: register a passkey on the phone with the intended provider, create pairing code, join from the desktop page. Desktop Sign → choose another device/iPhone/use a phone, displaying the WebAuthn QR prompt. Scan using phone, complete the Bluetooth/proximity prompt and phone verification. Do not accidentally accept the desktop's locally synced credential; capture the QR and actual phone prompt/provider. Expected: desktop receives verified assertion, UV=true, exact origin/RP, flags/counter captured. Fail: completed flow fails verification or loses required UV/origin/RP. No QR choice or failed proximity flow is a device/browser capability failure to record, not synthetic success.

### 1Password provider on Mac and iPhone — only if selected in preflight

Confirm the browser extension is enabled on Mac and 1Password is enabled/selected as the iOS passkey credential provider. Choose 1Password explicitly for registration and signing; record whether unlock used biometric or master password without recording the password. Register on Mac, sign there, then pair the same session on iPhone and sign using the 1Password provider. Expected: actual provider is 1Password on each device; UV=true after unlock (presence alone is insufficient), exact origin/RP; capture backupEligible/backedUp and counter, expected commonly zero but report the actual value. Fail: UV=false, wrong binding, same credential unavailable across devices, or verification refusal. A nonzero counter is evidence to assess, not an automatic protocol failure.

### Hardware key — follow-up, not today's gate

When Holger's key arrives: fresh session, select the physical key, set/use its PIN, register then sign. Expected verified + UV=true with exact origin/RP. Presence-only with no PIN must be refused. Until then report **untested, follow-up planned after delivery; not a production gate per Holger #10454**. No calendar appointment is claimed booked.

## Loopback dry run actually executed

Chromium 145.0.7632.6, virtual CTAP2 authenticator, RP localhost and ephemeral exact loopback origin. Passed prefixed-page register/sign, discoverable credential, UV, S0 digest, concurrent identical assertion reservation, independent session/user-handle tokens, isolated browser refusal, one-use pairing and a copied virtual credential signing in a second browser. Passed valid UV=false and wrong-origin negative controls, wrong-RP/challenge controls, spent/replayed assertions and base64 aliases. Explicit hosted config/Host/path smoke tests passed. Vitest file discovery excludes nested node_modules.

Leg 1 dry run emulates the two-browser workflow by copying a virtual credential; this does not prove iCloud sync. Leg 2 exercises assertion/verification UI but the local virtual browser has no real phone QR/hybrid leg. Leg 3 exercises UV/backup/counter reporting, without the real 1Password extension/provider. These are rehearsal coverage and stated limits, not three device PASS results. Real-provider/physical dry runs cannot be completed before Holger supplies the devices; if literal physical loopback rehearsal is required before the meeting, that portion slips. No alpha state has been touched.

Remaining replay limit: synchronous reservation closes identical concurrent submissions, but the deterministic S0 fixture is not a production replay design (ES256 signature twins/counter-zero replay remain outside this spike). Production uses the separately ruled v3 request binding. No production GO is claimed by this preparation.


## Review follow-up before rescheduled AL

Bindi P2s are fixed: every authentication requests discoverable selection with
`allowCredentials: []`; verify still checks the selected response id against the
registered credential. Both verifies return SHA-256 of the raw credential ID,
so compare `credentialIdHash` across Mac/phone/provider evidence. Registration
options and verify reject a second registration, including options pre-issued
before first completion; a synchronous in-flight reservation also prevents two
completions replacing each other. These are tested synthetically, and do not
claim a real-device session has run. Rook's hosting conditions remain: dedicated
subdomain without production-session cookies and the chosen random base path,
proxy-network confirmation, and delete each throwaway credential from Apple
Passwords/iCloud and 1Password on both devices after capture.


## Rescheduled-session setup hygiene

The Compose router PathPrefix and application cookie/routing base path use the
same required AL_BASE_PATH. Holger's random-path choice is configuration, with
no new image or source head; use a fresh unpredictable path, ending in `/`.
The random-path choice is settled; an allowlist is not a substitute to select
during this attempt without a new decision. A random path mitigates casual cap exhaustion; it
is not authentication and must not be published in public evidence before use.
The host-process template's PASSKEY_SPIKE_BASE_PATH and proxy snippet PathPrefix
must likewise be set to the same chosen value.

Each synthetic session has a distinct `synthetic-retention-user-TAG` picker name
unrelated to its cookie or WebAuthn user handle. Capture that name beside the
credentialIdHash. Before starting the next leg, delete the just-tested TAG from
Apple Passwords/iCloud Keychain on Mac/iPhone and from 1Password where used;
verify it no longer appears in the picker (sync may take time). If an older TAG
is offered, cancel and choose the current one; don't report that setup mistake
as the device leg's verification failure. After the last leg remove every AL
TAG and close the temporary browser session.

The concurrent registration pin uses an in-process wait before mandatory SDK
verification, never an HTTP bypass: a second completion must refuse while the
first verifier is paused. Removing the registering check makes that pin fail;
the real verifier still runs and verifies the winning credential.
