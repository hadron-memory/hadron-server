/**
 * #4684 (builder conditions from Victor's FIT, rulings 0155 and 0156): each Google provider's authorize URL is byte-identical to
 * what it was before the shared builder. One literal per provider, captured from main before the refactor: the parameter order
 * (client_id, response_type, redirect_uri, scope, state, access_type, prompt, then login_hint), each provider's OWN client id,
 * redirect URI and scopes, and a no-hint start with no `login_hint` at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGmailAuthUrl } from './gmail/auth.js';
import { buildGoogleCalAuthUrl } from './googleCal/auth.js';
import { buildGoogleDriveAuthUrl } from './googleDrive/auth.js';

const ENV = ['GMAIL_CLIENT_ID', 'GOOGLE_CAL_CLIENT_ID', 'GOOGLE_DRIVE_CLIENT_ID', 'BASE_URL'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.GMAIL_CLIENT_ID = 'gmail-client.example';
  process.env.GOOGLE_CAL_CLIENT_ID = 'cal-client.example';
  process.env.GOOGLE_DRIVE_CLIENT_ID = 'drive-client.example';
  process.env.BASE_URL = 'https://hadron.example';
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const A = 'https://accounts.google.com/o/oauth2/v2/auth?';
const TAIL = '&state=state-1&access_type=offline&prompt=consent';
const GMAIL = `${A}client_id=gmail-client.example&response_type=code&redirect_uri=https%3A%2F%2Fhadron.example%2Fauth%2Fgmail%2Fcallback&scope=openid+email+profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.send${TAIL}`;
const CAL = `${A}client_id=cal-client.example&response_type=code&redirect_uri=https%3A%2F%2Fhadron.example%2Fauth%2Fgoogle-cal%2Fcallback&scope=openid+email+profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.readonly${TAIL}`;
const DRIVE = `${A}client_id=drive-client.example&response_type=code&redirect_uri=https%3A%2F%2Fhadron.example%2Fauth%2Fgoogle-drive%2Fcallback&scope=openid+email+profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.readonly+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file${TAIL}`;

describe.each([
  ['gmail', buildGmailAuthUrl, GMAIL],
  ['google-cal', buildGoogleCalAuthUrl, CAL],
  ['google-drive', buildGoogleDriveAuthUrl, DRIVE],
] as const)('#4684 %s authorize URL is byte-identical to the pre-refactor one', (_name, build, expected) => {
  it('a start with no hint is exactly today\'s URL, with no login_hint', () => {
    expect(build('state-1')).toBe(expected);
    expect(build('state-1')).not.toContain('login_hint');
  });

  it('a hint appends only login_hint, last', () => {
    expect(build('state-1', 'me@example.com')).toBe(`${expected}&login_hint=me%40example.com`);
  });
});
