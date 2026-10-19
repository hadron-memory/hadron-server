/**
 * #1631 S2a PR1 — the ceremony routes' fail-closed gate.
 *
 * Mounted only when `signingSurfacePolicy().registration` is on (#1895); while off nothing is
 * mounted, so the paths are ordinary 404s with no switch oracle. When on, a start route is opened
 * only by a server-origin ceremony proof (`consumeCeremony`), never by a bearer header, an API/App
 * key, a JWT copied into a cookie, or a cross-site form POST. The proof-establishing sign-in leg is
 * not built yet, so until it lands EVERY caller is refused with one uniform 403: no body or header
 * says whether a proof was missing, forged, expired or consumed.
 */
import type { Express } from 'express';
import { signingSurfacePolicy } from '../lib/signing/surface.js';

export const PASSKEY_CEREMONY_START_PATHS = ['/passkeys/register/start', '/passkeys/revoke/start'] as const;

/** Mount the start routes when the registration switch is on; the switch is read once, at mount. */
export function mountPasskeyCeremonyRoutes(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  if (!signingSurfacePolicy(env).registration) return;
  for (const path of PASSKEY_CEREMONY_START_PATHS) {
    app.post(path, (_req, res) => {
      res.status(403).type('application/json').set('Cache-Control', 'no-store').send('{"error":"forbidden"}');
    });
  }
}
