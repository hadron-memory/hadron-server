/**
 * #1631 PR2 (cor:aut:040:07, 040:09): end a first passkey's cooling-off window early.
 *
 * Only a fresh sign-in by a method DIFFERENT from the one used to register the passkey ends it, on the server-hosted
 * "end the window early" page (two magic links are not different methods; a different identity provider, or a
 * browser-bound magic link after an identity-provider registration, is). The acting user is the fresh sign-in's user
 * (the ONE qualifying row on this browser, as for registration) and must own the in-window passkey (Rook, #1631
 * 6316353964). The window's end is recorded with the platform clock; its pending signatures then stop being pending.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';

/** True once the acting user's in-window first passkey has its window ended early; false is the one refusal. */
export async function endWindowEarly(db: PrismaClient, input: { signInBrowserHash: string }): Promise<{ passkeyId: string } | null> {
  throw new Error('not implemented');
}
