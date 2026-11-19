/** #1895 rollout join point. Explicit lowercase true is the only opt-in. */
export function signingSurfacePolicy(env: NodeJS.ProcessEnv = process.env) {
  const signing = env.PASSKEY_SIGNING_ENABLED === 'true';
  return { signing, registration: signing && env.PASSKEY_REGISTRATION_ENABLED === 'true' };
}

/**
 * #1925 — the switch capability tokens that are ON, in order, for MCP's capabilities line and `GET /capabilities`
 * alike (one source). An off switch is left out, never reported false, so a deployment with the switches off reads
 * exactly like a build without the features (#11049). The token words are ruled (Holger, 2026-10-14). `grant-signing`
 * (#3649 slice C) rides the same signing switch: the grant signing ceremony is mounted exactly when node signing is.
 */
export function switchCapabilities(policy: { signing: boolean; registration: boolean } = signingSurfacePolicy()): string[] {
  return [...(policy.signing ? ['node-signing', 'grant-signing'] : []), ...(policy.registration ? ['passkey-registration'] : [])];
}

/** The ServerInfo fields a switch owns (#4068): the ONE table the GraphQL schema gate and the resolver both read. */
export const SERVER_INFO_SWITCH_FIELDS = {
  signing: 'signing',
  passkeyRegistration: 'registration',
  passkeyRevokeUrl: 'registration',
} as const;

/**
 * #4068 — which ServerInfo fields exist on this deployment, decided in ONE place so the schema (field removed) and the
 * resolver (token returned) cannot drift: a schema-on, resolver-off split would null a `String!`/`Boolean!`.
 * Registration implies signing (cor:api:020:01: "registration is never on without signing"), so registration with
 * signing off leaves BOTH absent. Presence only: the revoke URL's value (#4051) is not decided here.
 */
export function serverInfoFieldPresence(policy: { signing: boolean; registration: boolean } = signingSurfacePolicy()): Record<keyof typeof SERVER_INFO_SWITCH_FIELDS, boolean> {
  const on = { signing: policy.signing, registration: policy.signing && policy.registration };
  return {
    signing: on[SERVER_INFO_SWITCH_FIELDS.signing],
    passkeyRegistration: on[SERVER_INFO_SWITCH_FIELDS.passkeyRegistration],
    passkeyRevokeUrl: on[SERVER_INFO_SWITCH_FIELDS.passkeyRevokeUrl],
  };
}
