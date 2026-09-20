/**
 * #560 — the recipient rate-limit key collapses to the mailbox that actually
 * receives the mail.
 *
 * @codex P1 on PR #1245: `victim+1@gmail.com` and `victim+2@gmail.com` reach
 * one inbox but hashed independently, so an attacker rotating aliases and
 * source IPs got five sends per alias and the per-recipient cap bounded
 * nothing — against exactly the distributed email-bomb it exists to stop.
 *
 * A unit test rather than a wire test, because what is under test is a pure
 * function and the wire behaviour it feeds is already pinned in
 * 560-auth-email-rate-limit.test.ts. The cases that matter here are the ones
 * that must NOT collapse: over-canonicalizing merges two real people onto one
 * budget, which is a denial of service in the other direction.
 */

import { describe, it, expect } from 'vitest';
import { canonicalRecipient } from './email.js';

describe('canonicalRecipient — collapses aliases', () => {
  it.each([
    ['plus tag', 'victim+1@example.com', 'victim+2@example.com'],
    ['plus tag, empty', 'victim+@example.com', 'victim@example.com'],
    ['case', 'Victim@Example.com', 'victim@example.com'],
    ['surrounding space', '  victim@example.com  ', 'victim@example.com'],
    ['gmail dots', 'v.i.c.t.i.m@gmail.com', 'victim@gmail.com'],
    ['gmail dots + tag', 'vic.tim+news@gmail.com', 'victim@gmail.com'],
    ['googlemail alias', 'victim@googlemail.com', 'victim@gmail.com'],
  ])('%s → one key', (_label, a, b) => {
    expect(canonicalRecipient(a)).toBe(canonicalRecipient(b));
  });
});

describe('canonicalRecipient — does NOT over-collapse', () => {
  it('keeps dots significant outside Gmail', () => {
    // The narrower rule, and the reason dot-stripping is Gmail-only:
    // `user.name@corp` and `username@corp` are two different people almost
    // everywhere else, and merging them lets one starve the other's budget.
    expect(canonicalRecipient('user.name@corp.example')).not.toBe(
      canonicalRecipient('username@corp.example'),
    );
  });

  it('keeps different mailboxes apart', () => {
    expect(canonicalRecipient('alice@example.com')).not.toBe(
      canonicalRecipient('bob@example.com'),
    );
  });

  it('keeps the same local part on different domains apart', () => {
    expect(canonicalRecipient('victim@a.example')).not.toBe(
      canonicalRecipient('victim@b.example'),
    );
  });

  it('does not collapse every all-tag local part onto one key', () => {
    // `+a@x` and `+b@x` have nothing before the `+`. Stripping naively yields
    // an empty local part, so EVERY such address would share one budget —
    // a denial of service created by the fix for one.
    expect(canonicalRecipient('+a@example.com')).not.toBe(
      canonicalRecipient('+b@example.com'),
    );
  });

  it('does not collapse an all-dots Gmail local part onto one key', () => {
    // Same hazard on the Gmail branch: `...@gmail.com` undots to empty.
    expect(canonicalRecipient('...@gmail.com')).not.toBe(
      canonicalRecipient('....@gmail.com'),
    );
  });

  it('leaves a malformed address alone rather than inventing structure', () => {
    expect(canonicalRecipient('not-an-address')).toBe('not-an-address');
    expect(canonicalRecipient('@example.com')).toBe('@example.com');
    expect(canonicalRecipient('victim@')).toBe('victim@');
  });
});
