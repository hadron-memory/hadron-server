/**
 * #421: the production strength guard for `JWT_SECRET`.
 *
 * `JWT_SECRET` signs every sign-in token and webhook platform token, and it
 * is the fallback for the team-attention HMAC signer
 * (`TEAM_ATTENTION_TOKEN_SECRET`), the OAuth CSRF HMAC (`CSRF_SECRET`) and
 * the team-chat monitor checkpoints. A weak value makes all of them
 * forgeable, so production refuses to boot without a strong one. Checking
 * `JWT_SECRET` itself covers every fallback: whichever consumer falls back,
 * it falls back to this value. A strong dedicated secret never excuses a
 * weak `JWT_SECRET`, because sign-in tokens use it regardless.
 *
 * The threshold is 32 UTF-8 bytes (HS256's key size), counted in bytes
 * because the key is the UTF-8 encoding. It is a length floor, not an
 * entropy measurement.
 *
 * Dev and test are unchanged: short non-empty fixture secrets keep working,
 * and a missing secret still fails at the point of use. Nothing is generated
 * or defaulted in any environment.
 *
 * The refusal names the variable and the rule only. It never carries the
 * secret, a derived value, or the configured length.
 */

export const JWT_SECRET_MIN_BYTES = 32;

export function assertProductionSigningSecret(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const secret = env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < JWT_SECRET_MIN_BYTES) {
    throw new Error(
      `JWT_SECRET is missing or shorter than ${JWT_SECRET_MIN_BYTES} bytes (UTF-8); ` +
        'production refuses to boot without a strong signing secret. ' +
        'It also backs the team-attention and OAuth CSRF fallbacks.',
    );
  }
}
