/** #1895 rollout join point. Explicit lowercase true is the only opt-in. */
export function signingSurfacePolicy(env: NodeJS.ProcessEnv = process.env) {
  const signing = env.PASSKEY_SIGNING_ENABLED === 'true';
  return { signing, registration: signing && env.PASSKEY_REGISTRATION_ENABLED === 'true' };
}

/**
 * #1925 — the switch capability tokens that are ON, in order, for MCP's capabilities line and `GET /capabilities`
 * alike (one source). An off switch is left out, never reported false, so a deployment with the switches off reads
 * exactly like a build without the features (#11049). The token words are ruled (Holger, 2026-10-14).
 */
export function switchCapabilities(policy: { signing: boolean; registration: boolean } = signingSurfacePolicy()): string[] {
  return [...(policy.signing ? ['node-signing'] : []), ...(policy.registration ? ['passkey-registration'] : [])];
}
