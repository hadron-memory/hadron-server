import { getProjectBaseUrl } from '../lib/baseUrl.js';
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

/** Is an outbound mail provider configured? (#1647: a notice with no sender is UNAVAILABLE, not retried.) */
export function isEmailSenderConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

/**
 * #3047 (same class as #3012 item 1): send one message and require the provider's acknowledgement. A THROWN SDK error's
 * message is free text that can name the recipient (a network error does), and these errors reach the fault log, Sentry
 * and the deletion-notice job's console.error, so only the thrown error's name is kept. A refusal the SDK RESOLVES goes
 * through {@link assertProviderAck}, already name-only. The one place the three non-magic-link senders send.
 */
async function sendAcked(message: Parameters<Resend['emails']['send']>[0]): Promise<void> {
  let result: Awaited<ReturnType<Resend['emails']['send']>>;
  try {
    result = await getResend().emails.send(message);
  } catch (err) {
    throw new Error(`mail provider send failed: ${err instanceof Error ? err.name : 'unknown'}`);
  }
  assertProviderAck(result);
}

/**
 * #1647: tell a user an administrator erased their account. The text deliberately carries NO reason: the reason is an
 * audit record, not something the notice discloses. Throws when the provider refuses, so the caller can count a try.
 */
export async function sendAccountDeletionNotice(to: string): Promise<void> {
  const fromAddress = process.env.EMAIL_FROM || 'Hadron <noreply@hadrongraph.io>';
  await sendAcked({
    from: fromAddress,
    to,
    subject: 'Your Hadron account was deleted',
    html: '<p>A Hadron administrator deleted your account, and your data was erased.</p>' +
      '<p>If you believe this was a mistake, contact Hadron support.</p>',
  });
}

/**
 * The Resend SDK RESOLVES a failure (HTTP 422, network) as `{ data: null, error }` instead of throwing, so a bare
 * `await send()` reads a refused message as delivered. Only a result carrying data is an acknowledgement.
 */
export function assertProviderAck(result: { data?: unknown; error?: { message?: string; name?: string } | null } | null | undefined): void {
  if (!result || result.error || !result.data) {
    // #3012: the provider's free-text message can echo the recipient, and this error reaches the fault log and
    // Sentry, so only the provider's machine name is carried.
    throw new Error(`mail provider did not acknowledge: ${result?.error?.name ?? 'no data'}`);
  }
}

const RATE_LIMITED_BODY = { error: 'rate_limit_exceeded' };

/**
 * Longest address accepted on ANY send path — the single declaration, imported
 * by oauth.ts rather than duplicated there.
 *
 * It used to be declared in both files, and the first version of this change
 * added the constant here while leaving the copy in oauth.ts intact
 * (@copilot, PR #1245). That is worse than the duplication it replaced: the
 * shared recipient limiter's admission and both handlers' validation all
 * depend on these caps agreeing, so two sources of truth reintroduce exactly
 * the cross-route drift the rest of this change exists to remove — while the
 * new constant's presence suggests it had been fixed.
 *
 * There is no test pinning the two together, deliberately: there is one
 * declaration now, so a test would compare a constant to itself.
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
 * Collapse an address to the MAILBOX it actually delivers to, for rate-limit
 * keying only.
 *
 * @codex P1 on PR #1245: `victim+1@gmail.com` and `victim+2@gmail.com` reach
 * one inbox but hashed to independent keys, so an attacker rotating aliases
 * and source IPs — precisely the distributed email-bomb this limiter exists to
 * stop — got five sends per alias and the cap bounded nothing.
 *
 * Two normalizations, and the second is narrower than the first on purpose:
 *
 *  - SUBADDRESSING (`local+tag`) is stripped for every domain. RFC 5233
 *    subaddressing is near-universal among providers that accept `+` at all.
 *  - DOT-INSENSITIVITY is applied ONLY to Gmail (and its googlemail alias),
 *    because it is a Gmail-specific rule. `user.name@corp.example` and
 *    `username@corp.example` are two different people almost everywhere else.
 *
 * The trade-off, stated because it is real rather than theoretical: if some
 * provider treats `+` as a literal character in a local part, two genuinely
 * distinct mailboxes share one budget of 5 per 15 minutes. That is a mild,
 * self-clearing inconvenience for a rare configuration, weighed against an
 * unbounded email bomb aimed at a real person. If it ever bites, the fix is an
 * allowlist of literal-plus domains, not abandoning the collapse.
 *
 * This affects the RATE-LIMIT KEY only. The address that gets mailed is always
 * the one the caller supplied — nothing here rewrites a recipient.
 */
export function canonicalRecipient(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return trimmed;

  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  const plus = local.indexOf('+');
  // A local part that is ENTIRELY a tag (`+tag@x`) must not collapse to the
  // empty string — every such address would then share one key, which is its
  // own denial of service.
  if (plus > 0) local = local.slice(0, plus);

  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const undotted = local.replace(/\./g, '');
    if (undotted.length > 0) local = undotted;
    return `${local}@gmail.com`;
  }

  return `${local}@${domain}`;
}

/**
 * The recipient rate-limit key. The address is HASHED rather than embedded
 * verbatim (@copilot, PR #1238): it is caller-controlled, and the in-process
 * MemoryStore holds every key it sees for the full window, inserting it BEFORE
 * the handler validates anything. Distinct oversized strings would then pin
 * attacker-chosen bytes in a worker's memory for 15 minutes. A digest is
 * fixed-width, so the store's footprint is bounded by the number of distinct
 * senders rather than by what they send.
 */
function recipientKey(email: string): string {
  return `email:${crypto.createHash('sha256').update(canonicalRecipient(email)).digest('hex')}`;
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
 * Both limiter instances are SHARED across the public send routes. One source
 * address gets one 10 / 15 min budget whether it uses `/auth/email`,
 * `/oauth/authorize/email`, or alternates between them; the recipient cap
 * likewise follows the mailbox across both paths. Each route validates its
 * own no-send cases before entering these shared limiters.
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

  const baseUrl = getProjectBaseUrl();
  let verifyUrl = `${baseUrl}/auth/email/verify?token=${token}`;
  if (redirect) verifyUrl += `&redirect=${encodeURIComponent(redirect)}`;
  if (returnTo) verifyUrl += `&return_to=${encodeURIComponent(returnTo)}`;

  const fromAddress = process.env.EMAIL_FROM || 'Hadron <noreply@hadrongraph.io>';

  // #2988: the SDK resolves a refused send as `{ data: null, error }`; an unchecked await reported it as sent.
  // Throwing lets both callers answer a fault, and the token that can no longer be delivered is removed.
  const startedAt = Date.now();
  let result: Awaited<ReturnType<Resend['emails']['send']>> | undefined;
  try {
    result = await getResend().emails.send({
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
    assertProviderAck(result);
    logMagicLinkSend('acked', startedAt, { providerId: result.data?.id });
  } catch (err) {
    // The provider's free-text message can echo the recipient, so only a machine name is kept: the provider's own
    // for a refusal, the thrown error's for a send that threw.
    const providerError = result ? result.error?.name : err instanceof Error ? err.name : undefined;
    logMagicLinkSend(result ? 'refused' : 'error', startedAt, { providerError });
    try {
      await db.emailVerificationToken.deleteMany({ where: { token } });
    } catch {
      // #3012: a failed cleanup must not replace the send failure; the token expires on its own.
    }
    if (result) throw err; // assertProviderAck's message is already name-only
    // A thrown SDK error's message is free text too (a network error can name the recipient).
    throw new Error(`mail provider send failed: ${providerError ?? 'unknown'}`);
  }
}

/**
 * #2988: one line per sign-in send, so a "no email arrived" report is answerable from the log alone: the provider's
 * message id (look it up in Resend's Emails log), how long the provider call took, and whether it was acknowledged.
 * Never the address, the token or the link, and never the provider's free-text message.
 */
function logMagicLinkSend(
  outcome: 'acked' | 'refused' | 'error',
  startedAt: number,
  extra: { providerId?: string; providerError?: string },
): void {
  // eslint-disable-next-line no-console
  console.warn(
    '[auth] auth.magic_link.send',
    JSON.stringify({ event: 'auth.magic_link.send', outcome, durationMs: Date.now() - startedAt, ...extra }),
  );
}

/**
 * #1631 PR1b slice 2: the passkey ceremony's email leg. The link proves the inbox to the ONE browser that started
 * the leg and signs the person in to nothing, so the text says so rather than "sign in".
 */
export async function sendCeremonySignInLink(to: string, verifyUrl: string): Promise<void> {
  const fromAddress = process.env.EMAIL_FROM || 'Hadron <noreply@hadrongraph.io>';
  await sendAcked({
    from: fromAddress,
    to,
    subject: 'Confirm it is you, to manage your Hadron passkeys',
    html: `
      <p>Someone asked to confirm this address to manage passkeys on Hadron.</p>
      <p><a href="${verifyUrl}">Confirm it is you</a></p>
      <p>Open it in the same browser you started from. This link expires in ${TOKEN_EXPIRY_MINUTES} minutes and does not sign you in.</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  });
}

/** What a passkey registration notice says (cor:aut:040:02). */
export interface PasskeyNoticeContent {
  kind: 'first' | 'later';
  label: string;
  registeredAt: Date;
  /** A first passkey's cancel link (cor:aut:040:07-08); absent for a later one. */
  cancelUrl?: string;
  windowEndsAt?: Date;
}

/**
 * #1631 PR2: the registration notice's subject and HTML. Pure, so its escaping and its cancel link are pinned without a
 * mail provider. The label is the user's input and is escaped (Rook, #1631 6316353964).
 */
export function passkeyNoticeEmail(n: PasskeyNoticeContent): { subject: string; html: string } {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const when = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const what = `<p>A passkey named <strong>${esc(n.label)}</strong> was added to your Hadron account on ${when(n.registeredAt)}.</p>`;
  if (n.kind === 'first' && n.cancelUrl) {
    return {
      subject: 'A passkey was added to your Hadron account',
      html: `${what}
<p>Anything it signs stays pending until ${n.windowEndsAt ? when(n.windowEndsAt) : 'its cooling-off window ends'}.</p>
<p><strong>If this wasn't you</strong>, remove it now. No sign-in is needed, and it also signs out any sessions it started:</p>
<p><a href="${esc(n.cancelUrl)}">Remove this passkey</a></p>
<p>The link works once, and only until the cooling-off window ends.</p>`,
    };
  }
  return {
    subject: 'A passkey was added to your Hadron account',
    html: `${what}
<p>It was vouched for by a passkey you already hold. If this wasn't you, revoke it from your account's passkey page.</p>`,
  };
}

/** Send a registration notice. Throws when the provider refuses, so the caller can count a try. */
export async function sendPasskeyRegisteredNotice(to: string, n: PasskeyNoticeContent): Promise<void> {
  const { subject, html } = passkeyNoticeEmail(n);
  const fromAddress = process.env.EMAIL_FROM || 'Hadron <noreply@hadrongraph.io>';
  await sendAcked({ from: fromAddress, to, subject, html });
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
