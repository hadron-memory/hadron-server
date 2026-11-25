/** A database error code safe to log: a Prisma `P####` or a five-character SQLSTATE, else UNKNOWN. Never a message, id or value. */
export function safeErrorCode(err: unknown): string {
  const raw = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof raw === 'string' && /^(P\d{4}|[0-9A-Z]{5})$/.test(raw) ? raw : 'UNKNOWN';
}
