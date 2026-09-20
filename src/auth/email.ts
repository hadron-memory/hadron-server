import crypto from 'crypto';
import { Resend } from 'resend';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import type { PrismaClient } from '../generated/prisma/index.js';
import { generateId } from '../lib/id.js';

/** Magic-link lifetime. Exported so the OAuth email-entry pages (#804)
 *  can surface the same number without hardcoding a drift-prone copy. */
export const TOKEN_EXPIRY_MINUTES = 15;

let resend: Resend | null = null;

function getResend(): Resend {
  if (!resend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY env var is required');
    resend = new Resend(apiKey);
  }
  return resend;
}

const RATE_LIMITED_BODY = { error: 'rate_limit_exceeded' };

/**
 * #560: `POST /auth/email` calls Resend for any caller-supplied address. It had
 * no brake, which makes it an email bomb aimed at arbitrary third parties, a
 * Resend cost drain, and a signup-enumeration oracle.
 *
 * It is NOT gated by anything today, and the nearby claim that it is deserves
 * correcting rather than inheriting: the #505 `client_state` nonce is
 * mandatory, but it is caller-supplied and only ever hashed and stored on the
 * token row — nothing validates it against a pre-registered value. Any string
 * satisfies it. Its job is binding the handoff code to one browser
 * (session-fixation defense), not authenticating the sender, so it stops
 * nobody from driving this endpoint in a loop.
 *
 * TWO limiters, because they answer different threats and either alone leaves
 * the other open:
 *
 *  - per-IP bounds how much damage one attacker does;
 *  - per-EMAIL bounds how much mail one VICTIM receives, which a per-IP limit
 *    cannot do — distributing the same target across many IPs is exactly how
 *    an email bomb is actually sent.
 *
 * Numbers match `buildAuthorizeEmailRateLimit` (10 / 15 min / IP) so the two
 * send paths do not drift apart; the per-email budget is deliberately tighter,
 * since a human retrying a typo'd address changes the address.
 *
 * Validation failures are excluded by {@link isUnsendableRequest}, evaluated
 * BEFORE the handler — deliberately NOT by `skipFailedRequests`.
 *
 * `skipFailedRequests` infers "no mail was sent" from the HTTP response, and
 * that inference is forgeable (Codex, PR #1238). express-rate-limit 8.5.2:
 *
 *   if (closePromise) { void closePromise.then(async () => {
 *     if (!response.writableEnded) await decrementKey();
 *   }); }
 *
 * A client that hangs up mid-request produces no response, so the counter is
 * REFUNDED — while Node, which cannot cancel an already-running handler, goes
 * on to deliver the mail. Sending and then aborting in a loop therefore costs
 * an attacker nothing and bypasses both limiters completely; reproduced before
 * this was changed, in the integration test.
 *
 * So these limiters count what they ADMITTED rather than what they managed to
 * answer. The cost is that a Resend outage now consumes budget, which is the
 * right side to err on: the alternative is a brake an attacker turns off by
 * closing a socket.
 *
 * Same in-process MemoryStore caveat as the OAuth limiters: counters are
 * per-worker, acceptable because the limit exists to stop abuse-shaped bursts
 * rather than to enforce an exact quota.
 */
export function buildEmailSendPerIpRateLimit() {
  return rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: isUnsendableRequest,
    message: RATE_LIMITED_BODY,
  });
}

/**
 * True for requests `POST /auth/email` will reject with 400 before attempting
 * any send. Read off the PARSED BODY, so the verdict is settled before the
 * handler runs and cannot be changed afterwards by how — or whether — the
 * response completes.
 *
 * It mirrors the handler's own two preconditions. If those ever diverge the
 * failure is a validation 400 that still costs budget, which is noisy but
 * safe; the reverse (budget-free requests that send mail) is the one that must
 * not happen, and it cannot here, because anything reaching the send has
 * already been counted.
 */
function isUnsendableRequest(req: Request): boolean {
  const body = req.body as
    | { email?: unknown; clientState?: unknown; client_state?: unknown }
    | undefined;
  const email = body?.email;
  const clientState = body?.clientState ?? body?.client_state;
  const hasEmail = typeof email === 'string' && email.trim().length > 0;
  const hasClientState = typeof clientState === 'string' && clientState.trim().length > 0;
  return !hasEmail || !hasClientState;
}

/** Per-recipient companion to {@link buildEmailSendPerIpRateLimit}. */
export function buildEmailSendPerAddressRateLimit() {
  return rateLimit({
    windowMs: 15 * 60_000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: isUnsendableRequest,
    message: RATE_LIMITED_BODY,
    keyGenerator: (req: Request) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      // Case-folded so `Victim@x.com` and `victim@x.com` share one budget —
      // they are the same mailbox, and a limiter that treats them as two is
      // bypassed by changing the capitalization.
      if (typeof email === 'string' && email.trim()) return `email:${email.trim().toLowerCase()}`;
      // No usable address: fall back to the IP so these requests cannot all
      // collide on one shared key and lock each other out. `ipKeyGenerator`
      // is the library's own IPv6-safe normalizer — keying on a raw v6
      // address would let an attacker walk their own /64 for a fresh budget
      // per request.
      return ipKeyGenerator(req.ip ?? '');
    },
  });
}

export async function sendMagicLink(
  email: string,
  db: PrismaClient,
  redirect?: string,
  /** #505: SHA-256 of the portal's request-time browser nonce, persisted so the
   *  handoff code minted at verify time binds to the requesting browser. */
  clientStateHash?: string,
  /** #804 Option-C: a strict server-local path (caller MUST have validated it
   *  with `isServerLocalPath`) appended to the verify URL as `return_to`. At
   *  verify time this routes sign-in through the server-origin cookie path
   *  (hadron_token + 302 to return_to) instead of the portal handoff — the
   *  OAuth /oauth/authorize email leg. Mutually exclusive with
   *  `clientStateHash` in practice: Option-C links open out-of-band (possibly
   *  a different browser), so a browser binding is impossible by design. */
  returnTo?: string,
): Promise<void> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000);

  await db.emailVerificationToken.create({
    data: {
      id: generateId(),
      email: email.toLowerCase(),
      token,
      expiresAt,
      clientStateHash: clientStateHash ?? null,
    },
  });

  // `||` (not `??`) so empty-string BASE_URL / PORT — e.g. shell `BASE_URL= node ...`
  // or `vi.stubEnv('PORT', '')` — fall back instead of producing `http://localhost:`.
  // Symmetric with src/mcp/server.ts:getDeploymentInfo and src/auth/github.ts.
  // Centralization across the four `BASE_URL` consumers is a known follow-up
  // (see src/auth/oauth.ts docstring + CLAUDE.md BASE_URL row).
  const baseUrl =
    process.env.BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
  let verifyUrl = `${baseUrl}/auth/email/verify?token=${token}`;
  if (redirect) verifyUrl += `&redirect=${encodeURIComponent(redirect)}`;
  if (returnTo) verifyUrl += `&return_to=${encodeURIComponent(returnTo)}`;

  const fromAddress = process.env.EMAIL_FROM || 'Hadron <noreply@hadrongraph.io>';

  await getResend().emails.send({
    from: fromAddress,
    to: email,
    subject: 'Sign in to Hadron',
    html: `
      <p>Click the link below to sign in to Hadron:</p>
      <p><a href="${verifyUrl}">Sign in to Hadron</a></p>
      <p>This link expires in ${TOKEN_EXPIRY_MINUTES} minutes.</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  });
}

export async function verifyMagicLink(
  token: string,
  db: PrismaClient,
): Promise<{ email: string; clientStateHash: string | null } | null> {
  // Atomic single-use claim (PR-511 Copilot review): a read-then-update lets two
  // concurrent requests both observe usedAt=null and both mint a login code. The
  // conditional updateMany is the lock — exactly one caller flips usedAt and sees
  // count=1; the others get 0 and are rejected. Mirrors the AuthCode /token and
  // authHandoff redemptions.
  const claim = await db.emailVerificationToken.updateMany({
    where: { token, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claim.count !== 1) return null;

  const record = await db.emailVerificationToken.findUnique({ where: { token } });
  if (!record) return null; // unreachable after a successful claim; keeps types honest

  return { email: record.email, clientStateHash: record.clientStateHash };
}
