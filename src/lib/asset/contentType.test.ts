/**
 * verifyDeclaredContentType — does a file's first bytes match the type it
 * claims?
 *
 * The bar this has to clear is narrow and deliberate: reject a file whose
 * signature contradicts its declared type, and ABSTAIN on everything
 * else. A false reject breaks a legitimate upload with a baffling error;
 * a false accept only leaves us where we already were. So the abstention
 * cases below are as load-bearing as the rejection ones.
 */

import { describe, it, expect } from 'vitest';
import { verifyDeclaredContentType, MAGIC_BYTES_WINDOW } from './contentType.js';

const pdf = Buffer.from('%PDF-1.7\n');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const webp = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP'),
]);
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
// MZ — a Windows executable, the thing this exists to catch.
const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0, 0]);

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('verifyDeclaredContentType — matches', () => {
  it.each([
    ['application/pdf', pdf],
    ['image/png', png],
    ['image/jpeg', jpeg],
    ['image/webp', webp],
    [DOCX, zip],
    [XLSX, zip],
  ])('accepts a real %s', (mime, bytes) => {
    expect(verifyDeclaredContentType(bytes, mime)).toBe('match');
  });
});

describe('verifyDeclaredContentType — mismatches', () => {
  it('rejects an executable declared as a PDF', () => {
    expect(verifyDeclaredContentType(exe, 'application/pdf')).toBe('mismatch');
  });

  it('rejects an executable declared as a PNG', () => {
    expect(verifyDeclaredContentType(exe, 'image/png')).toBe('mismatch');
  });

  it('rejects an executable declared as a docx', () => {
    expect(verifyDeclaredContentType(exe, DOCX)).toBe('mismatch');
  });

  it('rejects a PNG declared as a JPEG', () => {
    // Not a security issue on its own, but it means the declared type is
    // simply wrong, and the hotlink pins response-content-type from it.
    expect(verifyDeclaredContentType(png, 'image/jpeg')).toBe('mismatch');
  });

  it('rejects a RIFF container that is not WEBP', () => {
    // The offset-8 check is the whole point — a RIFF/WAVE would pass a
    // naive "starts with RIFF" test.
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WAVE'),
    ]);
    expect(verifyDeclaredContentType(wav, 'image/webp')).toBe('mismatch');
  });
});

describe('verifyDeclaredContentType — abstains rather than guessing', () => {
  it.each(['text/plain', 'text/csv', 'text/markdown', 'application/json'])(
    'does not judge %s, which has no signature',
    (mime) => {
      expect(verifyDeclaredContentType(Buffer.from('anything at all'), mime)).toBe(
        'unverifiable',
      );
    },
  );

  it('abstains on an unknown type rather than rejecting it', () => {
    expect(verifyDeclaredContentType(pdf, 'application/x-not-on-the-list')).toBe(
      'unverifiable',
    );
  });

  it('abstains when the file is too short to carry the signature', () => {
    // A 2-byte "PDF" cannot be judged — refusing it would be a guess.
    expect(verifyDeclaredContentType(Buffer.from([0x25, 0x50]), 'application/pdf')).toBe(
      'unverifiable',
    );
  });

  it('abstains on an empty or unreadable object', () => {
    expect(verifyDeclaredContentType(null, 'application/pdf')).toBe('unverifiable');
    expect(verifyDeclaredContentType(Buffer.alloc(0), 'application/pdf')).toBe(
      'unverifiable',
    );
  });

  it('abstains on a short file whose bytes are still CONSISTENT with the type', () => {
    // "%P" is the start of "%PDF" — it may yet be one.
    expect(verifyDeclaredContentType(Buffer.from([0x25, 0x50]), 'application/pdf')).toBe(
      'unverifiable',
    );
  });
});

describe('verifyDeclaredContentType — short but already contradicted', () => {
  it('rejects a 2-byte file that cannot be a PDF, despite being short', () => {
    // The distinction that matters: "too short to finish checking" is not
    // the same as "too short to tell". MZ contradicts %PDF at byte 0.
    expect(verifyDeclaredContentType(Buffer.from([0x4d, 0x5a]), 'application/pdf')).toBe(
      'mismatch',
    );
  });

  it('rejects a 6-byte executable declared as PNG, whose signature is 8 bytes', () => {
    expect(
      verifyDeclaredContentType(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0, 0]), 'image/png'),
    ).toBe('mismatch');
  });
});

describe('MAGIC_BYTES_WINDOW', () => {
  it('is wide enough for the longest signature (webp, offset 8 + 4)', () => {
    expect(MAGIC_BYTES_WINDOW).toBeGreaterThanOrEqual(12);
  });
});
