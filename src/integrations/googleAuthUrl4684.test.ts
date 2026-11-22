/**
 * #4684 bullet 2: ONE shared Google authorize-URL builder. It takes each provider's client id, redirect URI and scopes as inputs
 * and never defaults one provider's value for another's; the parameter order is fixed (client_id, response_type, redirect_uri,
 * scope, state, access_type, prompt) with login_hint appended last only when a hint is given. Red on main: the module does not exist.
 */
import { describe, expect, it } from 'vitest';
import { buildGoogleAuthUrl } from './googleAuthUrl.js';

const base = { clientId: 'c1', redirectUri: 'https://x.example/cb', scopes: ['openid', 'email'], state: 's1' };
const keys = (url: string) => [...new URL(url).searchParams.keys()];

describe('#4684 buildGoogleAuthUrl', () => {
  it('builds the fixed parameter order, with no login_hint when there is no hint', () => {
    const url = buildGoogleAuthUrl(base);
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    expect(keys(url)).toEqual(['client_id', 'response_type', 'redirect_uri', 'scope', 'state', 'access_type', 'prompt']);
    expect(url).toBe('https://accounts.google.com/o/oauth2/v2/auth?client_id=c1&response_type=code&redirect_uri=https%3A%2F%2Fx.example%2Fcb&scope=openid+email&state=s1&access_type=offline&prompt=consent');
  });

  it('appends login_hint LAST, percent-encoded, only when a hint is given (an empty string is a hint, as before)', () => {
    expect(keys(buildGoogleAuthUrl({ ...base, loginHint: 'a@b.example' }))).toEqual([
      'client_id', 'response_type', 'redirect_uri', 'scope', 'state', 'access_type', 'prompt', 'login_hint']);
    expect(buildGoogleAuthUrl({ ...base, loginHint: 'a@b.example' })).toMatch(/&login_hint=a%40b\.example$/);
    expect(keys(buildGoogleAuthUrl({ ...base, loginHint: '' }))).toContain('login_hint');
    expect(keys(buildGoogleAuthUrl({ ...base, loginHint: undefined }))).not.toContain('login_hint');
  });

  it('takes every provider-specific value from its inputs: changing each one changes only its own parameter', () => {
    const url = (o: Partial<typeof base>) => new URL(buildGoogleAuthUrl({ ...base, ...o })).searchParams;
    expect(url({ clientId: 'c2' }).get('client_id')).toBe('c2');
    expect(url({ redirectUri: 'https://y.example/cb' }).get('redirect_uri')).toBe('https://y.example/cb');
    expect(url({ scopes: ['a', 'b', 'c'] }).get('scope')).toBe('a b c');
    expect(url({ state: 's2' }).get('state')).toBe('s2');
  });

  it('keeps access_type=offline and prompt=consent (without them Google returns no refresh token)', () => {
    const p = new URL(buildGoogleAuthUrl(base)).searchParams;
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('response_type')).toBe('code');
  });
});
