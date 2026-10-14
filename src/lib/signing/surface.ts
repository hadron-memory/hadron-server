/** #1895 rollout join point. Explicit lowercase true is the only opt-in. */
export function signingSurfacePolicy(env: NodeJS.ProcessEnv = process.env) {
  const signing = env.PASSKEY_SIGNING_ENABLED === 'true';
  return { signing, registration: signing && env.PASSKEY_REGISTRATION_ENABLED === 'true' };
}
