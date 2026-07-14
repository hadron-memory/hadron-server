import { GraphQLError } from 'graphql';
import type { ResendSender } from '../generated/prisma/index.js';
import { decryptToken, encryptToken } from './tokenCrypto.js';

export interface ResendCredentials {
  apiKey: string;
  from: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_API_KEY_LENGTH = 8_192;
const MAX_FROM_LENGTH = 320;

/** Validate and normalize `Name <email>` or a bare email address. */
export function normalizeResendFrom(raw: string): string {
  const from = raw.trim();
  if (from.length === 0 || from.length > MAX_FROM_LENGTH || /[\r\n]/.test(from)) {
    throw new GraphQLError(`from must be 1-${MAX_FROM_LENGTH} characters with no newlines.`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  const angle = /<([^<>]+)>$/.exec(from);
  const email = (angle?.[1] ?? from).trim();
  if (!EMAIL_RE.test(email)) {
    throw new GraphQLError('from must be an email address or Name <email@example.com>.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return from;
}

/** Validate and encrypt a write-only Resend API key. */
export function encryptResendApiKey(raw: string): string {
  const apiKey = raw.trim();
  if (apiKey.length === 0 || apiKey.length > MAX_API_KEY_LENGTH || /\s/.test(apiKey)) {
    throw new GraphQLError('apiKey must be one non-empty token without whitespace.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return encryptToken(apiKey);
}

/** Decrypt one org sender only at the internal capability-tool call boundary. */
export function decryptResendCredentials(
  row: Pick<ResendSender, 'apiKeyEncrypted' | 'fromAddress'>,
): ResendCredentials {
  return { apiKey: decryptToken(row.apiKeyEncrypted), from: row.fromAddress };
}

/**
 * Platform fallback is operator-controlled and deny-by-default. IDs only:
 * the run already carries the canonical org PK, and accepting names/URNs here
 * would make an environment allowlist depend on mutable identifiers.
 */
export function isPlatformResendAllowed(organizationId: string): boolean {
  return new Set(
    (process.env.RESEND_PLATFORM_ORG_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  ).has(organizationId);
}
