import { describe, it, expect } from 'vitest';
import {
  APP_SELECTION_ERROR_CODES,
  appSelectionError,
  extractErrorCode,
  type AppSelectionErrorEnvelope,
} from './app-selection-errors.js';

describe('appSelectionError envelope builder (spec 026 §T008)', () => {
  it('produces an MCP tool-error envelope with isError=true', () => {
    const e = appSelectionError(
      APP_SELECTION_ERROR_CODES.APP_NOT_FOUND,
      "No accessible App matches 'foo'.",
    );
    expect(e.isError).toBe(true);
    expect(e.content).toHaveLength(1);
    expect(e.content[0].type).toBe('text');
  });

  it('prefixes the message with [<code>] for inline machine-readable parsing', () => {
    const e = appSelectionError(
      APP_SELECTION_ERROR_CODES.APP_IDENTIFIER_AMBIGUOUS,
      "Multiple Apps match 'juno'.",
    );
    expect(e.content[0].text).toBe(
      "[app_identifier_ambiguous] Multiple Apps match 'juno'.",
    );
  });

  it('exports each of the 5 spec-026 codes', () => {
    const codes = Object.values(APP_SELECTION_ERROR_CODES);
    expect(codes).toEqual([
      'app_identifier_ambiguous',
      'app_not_found',
      'app_unavailable',
      'app_member_revoked',
      'no_active_app',
    ]);
  });
});

describe('extractErrorCode (test helper)', () => {
  it('parses each of the 5 known codes from envelope text', () => {
    for (const code of Object.values(APP_SELECTION_ERROR_CODES)) {
      const env = appSelectionError(code, 'msg');
      expect(extractErrorCode(env)).toBe(code);
    }
  });

  it('returns null for an envelope without a recognized prefix', () => {
    const env: AppSelectionErrorEnvelope = {
      isError: true,
      content: [{ type: 'text', text: 'plain message with no prefix' }],
    };
    expect(extractErrorCode(env)).toBeNull();
  });

  it('returns null for an unknown prefix (forward-compat: rejects fabricated codes)', () => {
    const env: AppSelectionErrorEnvelope = {
      isError: true,
      content: [{ type: 'text', text: '[some_other_code] msg' }],
    };
    expect(extractErrorCode(env)).toBeNull();
  });
});
