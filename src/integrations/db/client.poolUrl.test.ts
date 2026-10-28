import { describe, expect, it } from 'vitest';
import { poolDatasourceUrl } from './poolUrl.js';

const original = 'postgresql://user:secret%40value@db.example:5432/hadron?schema=custom&sslmode=require&options=-c%20search_path%3Dpublic';
describe('opt-in pool datasource URL', () => {
  it('returns the original bytes when neither setting is configured, including undefined URL', () => {
    expect(poolDatasourceUrl(original, {})).toBe(original);
    expect(poolDatasourceUrl(undefined, {})).toBeUndefined();
    expect(poolDatasourceUrl('defer-validation-to-Prisma', {})).toBe('defer-validation-to-Prisma');
  });
  it('sets independently configured pool parameters and preserves unrelated URL state', () => {
    const configured = new URL(poolDatasourceUrl(original, { DB_POOL_CONNECTION_LIMIT: '7', DB_POOL_TIMEOUT_SECONDS: '19' })!);
    const before = new URL(original);
    expect(configured.searchParams.get('connection_limit')).toBe('7');
    expect(configured.searchParams.get('pool_timeout')).toBe('19');
    for (const key of ['schema', 'sslmode', 'options']) expect(configured.searchParams.get(key)).toBe(before.searchParams.get(key));
    expect(configured.username).toBe(before.username);
    expect(configured.password === before.password).toBe(true);
    expect(configured.host).toBe(before.host);
    expect(configured.pathname).toBe(before.pathname);
    expect(new URL(poolDatasourceUrl(original, { DB_POOL_CONNECTION_LIMIT: '3' })!).searchParams.has('pool_timeout')).toBe(false);
    expect(new URL(poolDatasourceUrl(original, { DB_POOL_TIMEOUT_SECONDS: '4' })!).searchParams.has('connection_limit')).toBe(false);
  });
  it('keeps explicit URL parameters, even when only one of the two is present', () => {
    const both = original + '&connection_limit=2&pool_timeout=0';
    expect(poolDatasourceUrl(both, { DB_POOL_CONNECTION_LIMIT: '7', DB_POOL_TIMEOUT_SECONDS: '19' })).toBe(both);
    const one = new URL(poolDatasourceUrl(original + '&connection_limit=2', { DB_POOL_CONNECTION_LIMIT: '7', DB_POOL_TIMEOUT_SECONDS: '19' })!);
    expect(one.searchParams.get('connection_limit')).toBe('2');
    expect(one.searchParams.get('pool_timeout')).toBe('19');
    const other = new URL(poolDatasourceUrl(original + '&pool_timeout=0', { DB_POOL_CONNECTION_LIMIT: '7' })!);
    expect(other.searchParams.get('pool_timeout')).toBe('0');
    expect(other.searchParams.get('connection_limit')).toBe('7');
  });
  it.each(['', '0', '-1', '1.5', 'abc', 'Infinity', '1e2', ' 3 ', '9007199254740992'])('refuses invalid configured values without reflecting the input (%s)', bad => {
    for (const name of ['DB_POOL_CONNECTION_LIMIT', 'DB_POOL_TIMEOUT_SECONDS']) {
      expect(() => poolDatasourceUrl(original, { [name]: bad })).toThrow(`${name} must be a positive safe integer`);
    }
  });
  it('validates both settings even when a URL override would otherwise win', () => {
    expect(() => poolDatasourceUrl(original + '&pool_timeout=5', { DB_POOL_CONNECTION_LIMIT: '7', DB_POOL_TIMEOUT_SECONDS: 'bad' })).toThrow('DB_POOL_TIMEOUT_SECONDS must be a positive safe integer');
  });
  it('refuses missing or malformed URL only for opt-in settings, using fixed errors', () => {
    for (const url of [undefined, 'postgresql://user:private-password@bad host/db']) {
      try { poolDatasourceUrl(url, { DB_POOL_CONNECTION_LIMIT: '7' }); throw new Error('accepted'); }
      catch (e) { expect((e as Error).message).toBe('DATABASE_URL must be a valid PostgreSQL URL when pool settings are configured'); }
    }
  });
});
