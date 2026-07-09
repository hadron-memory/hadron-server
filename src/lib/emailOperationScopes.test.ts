import { describe, it, expect } from 'vitest';
import {
  CONNECTION_GRANT_SCOPES,
  isConnectionGrantScope,
  scopeForOperation,
  OPERATION_SCOPES,
} from './emailOperationScopes.js';

describe('emailOperationScopes (#593)', () => {
  it('maps read ops to mail.read', () => {
    expect(scopeForOperation('list-messages')).toBe('mail.read');
    expect(scopeForOperation('list-folders')).toBe('mail.read');
  });

  it('maps send/draft ops to mail.send', () => {
    for (const op of ['reply-to-message', 'save-draft', 'update-draft', 'send-draft']) {
      expect(scopeForOperation(op)).toBe('mail.send');
    }
  });

  it('maps calendar ops to their scopes (ready before the tool ships them)', () => {
    expect(scopeForOperation('get-schedule')).toBe('calendar.freebusy');
    expect(scopeForOperation('list-events')).toBe('calendar.read');
  });

  it('FAIL-CLOSED: mailbox-mutation ops are owner-only (no scope maps them)', () => {
    for (const op of ['delete-message', 'move-message', 'mark-read', 'flag-message', 'categorize-message']) {
      expect(scopeForOperation(op)).toBeUndefined();
    }
  });

  it('FAIL-CLOSED: an unknown/typo operation has no scope', () => {
    expect(scopeForOperation('read-all-mail')).toBeUndefined();
    expect(scopeForOperation('')).toBeUndefined();
  });

  it('every mapped scope is in the grantable allow-list', () => {
    for (const scope of Object.values(OPERATION_SCOPES)) {
      expect(isConnectionGrantScope(scope)).toBe(true);
    }
  });

  it('the allow-list validates known scopes and rejects unknown ones', () => {
    for (const s of CONNECTION_GRANT_SCOPES) expect(isConnectionGrantScope(s)).toBe(true);
    expect(isConnectionGrantScope('mail.delete')).toBe(false);
    expect(isConnectionGrantScope('admin')).toBe(false);
  });
});
