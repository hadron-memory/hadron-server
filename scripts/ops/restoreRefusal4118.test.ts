/** #4118: only a PostgreSQL ERROR response is a definitive statement refusal. */
import { describe, expect, it } from 'vitest';
import { DatabaseError } from 'pg';
import { refusedByServer } from './restore-with-rebase.js';

describe('#4118 CREATE refusal classification', () => {
  it.each(['ERROR', 'FATAL', 'PANIC', undefined])('classifies server severity %s', (severity) => {
    const err = new DatabaseError('fixture response', 0, 'error');
    err.severity = severity;
    expect(refusedByServer(err)).toBe(severity === 'ERROR');
  });
  it('never treats a non-server exception as a definitive refusal', () => {
    for (const err of [new Error('socket lost'), { severity: 'ERROR' }, null, 'ERROR']) {
      expect(refusedByServer(err)).toBe(false);
    }
  });
});
