import { describe, it, expect } from 'vitest';
import { userMessageFor } from './user-messages.js';
import type { EvaluationError } from './errors.js';

function err(code: EvaluationError['code']): EvaluationError {
  return { code, message: 'developer-message', detail: {} };
}

describe('edge-conditions / userMessageFor', () => {
  it('returns a stable id for MEMORY_ENCRYPTED_NO_KEY and a user-facing message naming the password', () => {
    const m = userMessageFor(err('MEMORY_ENCRYPTED_NO_KEY'));
    expect(m.id).toBe('edge-conditions.error.memory_encrypted_no_key');
    expect(m.text.toLowerCase()).toContain('password');
  });

  it('groups validation-class codes under invalid_condition', () => {
    for (const code of [
      'INVALID_JSON',
      'INVALID_JSONLOGIC',
      'DISALLOWED_OPERATOR',
      'UNKNOWN_SCOPE',
      'RESERVED_NAME',
      'AST_TOO_LARGE',
      'AST_TOO_DEEP',
    ] as const) {
      const m = userMessageFor(err(code));
      expect(m.id).toBe('edge-conditions.error.invalid_condition');
      expect(m.text).toMatch(/agent/i);
    }
  });

  it('surfaces TYPE_MISMATCH separately', () => {
    const m = userMessageFor(err('TYPE_MISMATCH'));
    expect(m.id).toBe('edge-conditions.error.type_mismatch');
  });

  it('returns the fallback for unknown codes', () => {
    // Cast through unknown so tests intentionally exercise the default branch.
    const m = userMessageFor({ code: 'UNRECOGNIZED' as EvaluationError['code'], message: 'x', detail: {} });
    expect(m.id).toBe('edge-conditions.error.unknown');
  });

  it('every message text reads as plain language (not jargon)', () => {
    // Sanity: no message returns a stack-trace-shaped or developer message.
    const codes: EvaluationError['code'][] = [
      'MEMORY_ENCRYPTED_NO_KEY',
      'INVALID_JSON',
      'TYPE_MISMATCH',
    ];
    for (const code of codes) {
      const m = userMessageFor(err(code));
      // No "Error:" prefix, no curly braces, no "code:".
      expect(m.text).not.toMatch(/Error:|^\{|code:/);
      // Has an actionable phrase or a clear actor.
      expect(m.text).toMatch(/\b(please|needs?|review|try|contact)\b/i);
    }
  });
});
