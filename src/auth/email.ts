import crypto from 'crypto';
import { Resend } from 'resend';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
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
 * Longest address accepted on a send path. Matches `EMAIL_MAX_LENGTH` in
 * oauth.ts, whose handler already documents that its validation "must match
 * POST /auth/email exactly" — it did not, and this is half of making that true.
 */
export const EMAIL_MAX_LENGTH = 320;

/**
 * THE validator for `POST /auth/email`. One function, used by both the route
 * handler and the limiters' `skip`, because the two asking the same question
 * differently is a bypass rather than an inconsistency.
 *
 * @codex found exactly that on PR #1238: the limiter treated a whitespace-only
 * `client_state` as unsendable and skipped counting, while the handler checked
 * only for a non-empty STRING and sent the mail anyway. `client_state: " "`
 * therefore delivered mail at no cost against either budget — a bypass
 * introduced by the previous round's bypass fix. Two predicates for one
 * question will drift again, so there is now only one.
 */
export type EmailSendRequest =
  | { ok: true; email: string; clientState: string }
  | { ok: false; reason: 'email' | 'client_state' };

export function parseEmailSendRequest(body: unknown): EmailSendRequest {
  const b = body as { email?: unknown; clientState?: unknown; client_state?: unknown } | undefined;

  const rawEmail = b?.email;
  const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) return { ok: false, reason: 'email' };

  // Accept either casing, as the handler always has.
  const rawClientState = b?.clientState ?? b?.client_state;
  if (typeof rawClientState !== 'string' || rawClientState.trim().length === 0) {
    return { ok: false, reason: 'client_state' };
  }

  // Validated on the TRIMMED form, returned RAW — deliberately, and the two
  // must not be conflated. The #505 binding hashes this value at send time and
  // `redeemLoginCode` re-hashes the caller's copy at redemption
  // (authHandoff.ts) WITHOUT trimming. Storing a hash of the trimmed form would
  // therefore make a whitespace-padded nonce unredeemable — a silent auth
  // regression to fix a validation gap. Trimming decides ACCEPTANCE; the bytes
  // that get hashed are unchanged.
  return { ok: true, email, clientState: rawClientState };
}

/**
 * The recipient key. The address is HASHED rather than embedded verbatim
 * (@copilot, PR #1238): it is caller-controlled, and the in-process MemoryStore
 * holds every key it sees for the full window, inserting it BEFORE the handler
 * validates anything. Distinct oversized strings would then pin
 * attacker-chosen bytes in a worker's memory for 15 minutes. A digest is
 * fixed-width, so the store's footprint is bounded by the number of distinct
 * senders rather than by what they send. The length cap in
 * {@link parseEmailSendRequest} bounds it again on the way in.
 *
 * Case-folded first: `Victim@x` and `victim@x` are one mailbox, and a limiter
 * that treats them as two budgets is bypassed by pressing shift.
 */
function recipientKey(email: string): string {
  return `email:${crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
}

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
 * The per-IP cap is PER ROUTE and deliberately so; the per-recipient cap is
 * SHARED across both send paths. That asymmetry is the design, not an
 * oversight (@copilot raised it on PR #1238):
 *
 *  - `/oauth/authorize/email` keeps its own per-IP limiter
 *    (`buildAuthorizeEmailRateLimit`, the same 10 / 15 min), so one source
 *    address can get 10 through each route — 20 across both. A per-IP limit is
 *    a burst brake on ONE attacker, and an attacker willing to alternate
 *    routes is equally willing to use a second IP, which defeats any per-IP
 *    number. It buys ordering and noise reduction, not a bound.
 *  - The guarantee that actually protects a third party — how much mail one
 *    VICTIM receives — is carried by the recipient limiter, and THAT one is a
 *    single shared instance precisely because alternating routes must not
 *    double it.
 *
 * Unifying the per-IP store is worth doing, but it means reworking
 * `buildAuthorizeEmailRateLimit`, which #1239 already has to change for an
 * unrelated abort-refund bypass. Doing both there beats doing half here.
 *
 * The per-email budget is tighter than the per-IP one because a human retrying
 * a typo'd address changes the address.
 *
 * Neither limiter carries a `skip`, and neither uses `skipFailedRequests`.
 * Validation happens ahead of them in {@link validateEmailSendRequest}, so by
 * the time a request reaches here it is one that WILL attempt a send, and the
 * only honest thing to do is count it.
 *
 * `skipFailedRequests` infers "no mail was sent" from the HTTP response, and
 * that inference is forgeable (@codex, PR #1238). express-rate-limit 8.5.2:
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
    message: RATE_LIMITED_BODY,
  });
}

/**
 * Validates `POST /auth/email` and answers 400 BEFORE either limiter runs.
 *
 * Ordering is the entire design. Teaching each limiter to re-ask "would this
 * have been rejected?" is what produced @codex's round-2 P1 — two predicates
 * for one question, drifting on whitespace. Rejecting first means the limiters
 * only ever see requests that WILL attempt a send, so there is nothing to keep
 * in sync: no `skip`, no inference, no second copy of the rule.
 *
 * It also removes a denial of service I had built in the other direction. With
 * validation behind the recipient limiter, an attacker could spend a VICTIM's
 * budget using requests that never sent anything — locking that person out of
 * their own sign-in emails while delivering none. Invalid requests now cost
 * nobody anything.
 */
export function validateEmailSendRequest(req: Request, res: Response, next: NextFunction): void {
  const parsed = parseEmailSendRequest(req.body);
  if (!parsed.ok) {
    res.status(400).json(
      parsed.reason === 'email'
        ? { error: 'Email is required' }
        : { error: 'client_state is required — request the sign-in link through the portal.' },
    );
    return;
  }
  (req as Request & { emailSend?: EmailSendRequest & { ok: true } }).emailSend = parsed;
  next();
}

/**
 * Per-RECIPIENT companion to {@link buildEmailSendPerIpRateLimit}, and the one
 * that bounds what a VICTIM receives rather than what an attacker sends.
 *
 * ONE INSTANCE IS MOUNTED ON EVERY PUBLIC SEND PATH, and that is the whole
 * point. @copilot on PR #1238: with the limiter on `POST /auth/email` alone,
 * `POST /oauth/authorize/email` still reached the same `sendMagicLink` behind
 * only a per-IP brake, so spreading requests across source addresses delivered
 * well past the cap to one inbox — defeating precisely the protection this
 * limiter is documented to provide. Two separately-built limiters would not fix
 * it either: each would carry its own MemoryStore, so one victim would get the
 * budget TWICE. They must share a store, which means sharing an instance.
 *
 * The `skip` here asks only whether a usable ADDRESS is present, because this
 * limiter guards routes with different contracts — `/oauth/authorize/email`
 * carries no `client_state` at all, and reusing the stricter per-route
 * predicate would skip every request on that path and silently protect nothing.
 */
export function buildEmailRecipientRateLimit() {
  return rateLimit({
    windowMs: 15 * 60_000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req: Request) => !hasUsableRecipient(req.body),
    message: RATE_LIMITED_BODY,
    keyGenerator: (req: Request) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      if (typeof email === 'string' && email.trim()) return recipientKey(email);
      // Unreachable while `skip` above holds; kept as the IPv6-safe fallback
      // rather than a shared constant, so these could never collide on one key.
      return ipKeyGenerator(req.ip ?? '');
    },
  });
}

/** A recipient this limiter can meaningfully key on, on ANY send path. */
function hasUsableRecipient(body: unknown): boolean {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim().length > 0 && email.trim().length <= EMAIL_MAX_LENGTH;
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
