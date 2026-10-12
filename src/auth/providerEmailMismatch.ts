/**
 * Flag (never block) a returning provider sign-in whose stored address differs
 * from the address the provider just verified (#1802).
 *
 * The provider's verified claim at sign-in is the one independent evidence of
 * which address the account holder controls. A mismatch is often legitimate
 * (a Hadron address chosen apart from the provider account), so this only logs
 * it for an operator to review; sign-in proceeds unchanged.
 *
 * The log carries the user id and provider, never either address.
 */
export function flagProviderEmailMismatch(
  provider: 'google' | 'apple',
  user: { id: string; email: string | null },
  claim: { email: string | null; emailVerified: boolean },
): boolean {
  if (!user.email?.trim() || !claim.email?.trim() || !claim.emailVerified) return false;
  if (user.email.trim().toLowerCase() === claim.email.trim().toLowerCase()) return false;
  console.warn(
    `[auth] ${provider} sign-in for user ${user.id}: the stored address differs from the provider's verified address; review per #1802`,
  );
  return true;
}
