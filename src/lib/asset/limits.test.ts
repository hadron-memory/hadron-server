/**
 * Platform asset-upload limits.
 *
 * This file used to be much longer, and that was the problem. It covered
 * a per-App override mechanism (`App.properties.assets.*`) in nine tests
 * — clamping, ceilings, malformed values — while **nothing ever called
 * the function with an App**: all three call sites passed null, and no
 * code anywhere wrote those properties. Passing tests over unreachable
 * code are worse than no tests, because they make a dead mechanism look
 * alive to a reader and to a reviewer. Removed in #900.
 *
 * What is left is short because the contract is short: the limits are
 * platform-wide constants.
 */

import { describe, it, expect } from 'vitest';
import {
  getEffectiveLimits,
  PLATFORM_DEFAULT_MAX_BYTES,
  PLATFORM_DEFAULT_TIMEOUT_SECONDS,
  PLATFORM_DEFAULT_ALLOWED_MIMES,
} from './limits.js';

describe('getEffectiveLimits', () => {
  it('returns the platform defaults', () => {
    const limits = getEffectiveLimits();
    expect(limits.maxBytes).toBe(PLATFORM_DEFAULT_MAX_BYTES);
    expect(limits.uploadRequestTimeoutSeconds).toBe(PLATFORM_DEFAULT_TIMEOUT_SECONDS);
    expect(limits.allowedMimeTypes).toEqual(PLATFORM_DEFAULT_ALLOWED_MIMES);
  });

  it('hands back a COPY of the allowlist, not the shared array', () => {
    // A caller mutating its result must not edit the platform allowlist
    // for every later upload.
    const first = getEffectiveLimits();
    first.allowedMimeTypes.push('application/x-msdownload');
    expect(getEffectiveLimits().allowedMimeTypes).toEqual(PLATFORM_DEFAULT_ALLOWED_MIMES);
    expect(PLATFORM_DEFAULT_ALLOWED_MIMES).not.toContain('application/x-msdownload');
  });
});

describe('the allowlist itself', () => {
  // These are the types an unscanned upload can currently become a
  // permanent public URL for (#896), so the exclusions are load-bearing
  // rather than incidental.

  it('excludes types a browser executes', () => {
    for (const dangerous of ['text/html', 'image/svg+xml', 'application/javascript']) {
      expect(PLATFORM_DEFAULT_ALLOWED_MIMES).not.toContain(dangerous);
    }
  });

  it('allows only the MACRO-FREE Office variants', () => {
    // .docx/.xlsx/.pptx cannot carry macros; the .docm/.xlsm/.pptm
    // equivalents can, and are deliberately absent.
    expect(PLATFORM_DEFAULT_ALLOWED_MIMES).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    for (const macroEnabled of [
      'application/vnd.ms-word.document.macroEnabled.12',
      'application/vnd.ms-excel.sheet.macroEnabled.12',
      'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
    ]) {
      expect(PLATFORM_DEFAULT_ALLOWED_MIMES).not.toContain(macroEnabled);
    }
  });
});
