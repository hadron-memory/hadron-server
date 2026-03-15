import crypto from 'crypto';
import { Resend } from 'resend';
import type { PrismaClient } from '../generated/prisma/index.js';

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
): Promise<void> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000);

  await db.emailVerificationToken.create({
    data: { email: email.toLowerCase(), token, expiresAt },
  });

  const baseUrl =
    process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
  const verifyUrl = `${baseUrl}/auth/email/verify?token=${token}`;

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
): Promise<{ email: string } | null> {
  const record = await db.emailVerificationToken.findUnique({
    where: { token },
  });

  if (!record) return null;
  if (record.usedAt) return null;
  if (record.expiresAt < new Date()) return null;

  await db.emailVerificationToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  return { email: record.email };
}
