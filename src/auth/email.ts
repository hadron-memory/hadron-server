import crypto from 'crypto';
import { Resend } from 'resend';
import type { PrismaClient } from '../generated/prisma/index.js';
import { generateId } from '../lib/id.js';

const TOKEN_EXPIRY_MINUTES = 15;

let resend: Resend | null = null;

function getResend(): Resend {
  if (!resend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY env var is required');
    resend = new Resend(apiKey);
  }
  return resend;
}

export async function sendMagicLink(
  email: string,
  db: PrismaClient,
  redirect?: string,
  /** #505: SHA-256 of the portal's request-time browser nonce, persisted so the
   *  handoff code minted at verify time binds to the requesting browser. */
  clientStateHash?: string,
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
