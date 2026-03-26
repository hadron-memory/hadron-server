import { getRandomValues } from 'crypto';

/**
 * Generate a UUIDv7 without dashes.
 * Time-sortable (48-bit ms timestamp prefix), globally unique, 32 hex characters.
 */
export function generateId(): string {
  const bytes = getRandomValues(new Uint8Array(16));

  // First 48 bits = milliseconds since epoch
  const now = Date.now();
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // Version 7 (0111 in bits 48-51)
  bytes[6] = (bytes[6] & 0x0f) | 0x70;

  // Variant 10xx (bits 64-65)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return Buffer.from(bytes).toString('hex');
}
