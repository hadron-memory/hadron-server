#!/usr/bin/env python3
"""#3649 slice A: generate src/lib/grantSignature.fixture.json from cor:acl:140:09's grammar alone.

Independent of the TypeScript builder under test (src/lib/grants/terms.ts, src/lib/signing/grantPayload.ts): Python
hashlib plus a hand-written RFC 8785 subset (string-valued objects and lists, keys in UTF-16 code-unit order). Run with
`python3 -I scripts/generate-grant-signature-fixture.py > src/lib/grantSignature.fixture.json`; the test pins the
output, so a change here that moves a byte fails it.
"""
import base64
import hashlib
import json
import sys

REQ = 'Q2hhbGxlbmdlUmVxdWVzdA'  # the spec's worked-example request id (22 base64url characters)
REQ_B = 'AAAAAAAAAAAAAAAAAAAAAA'
GRANT = 'cm3k9x2b00002ab12cd34ef57'
APP = 'cm3k9x2a00001ab12cd34ef56'
AGENT = '01a05c157fe171208eef57f6ddb9b701'
NODE = '01a10408afb6716c80d6944e8845467b'


def jstr(s):
    # RFC 8785 strings: '"' and '\\' escaped, U+0000..U+001F as \b \f \n \r \t or \u00xx (lowercase), all else literal.
    out = ['"']
    short = {'"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t'}
    for ch in s:
        if ch in short:
            out.append(short[ch])
        elif ord(ch) < 0x20:
            out.append('\\u%04x' % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return ''.join(out)


def jvalue(v):
    if isinstance(v, str):
        return jstr(v)
    return '[' + ','.join(jstr(x) for x in v) + ']'


def jobject(d):
    keys = sorted(d, key=lambda k: k.encode('utf-16-be'))  # RFC 8785 sorts by UTF-16 code units
    return '{' + ','.join(jstr(k) + ':' + jvalue(d[k]) for k in keys) + '}'


def terms_text(t):
    lines = [
        'hadron-grant-terms-v1',
        'app ' + t['appId'],
        'holder %s %s' % (t['holder']['kind'], t['holder']['id']),
        'action ' + t['action'],
        'values ' + jobject(t['values']),
        'starts ' + (t['startsAt'] or 'none'),
        'expires ' + (t['expiresAt'] or 'none'),
        'max-uses ' + ('none' if t['maxUses'] is None else str(t['maxUses'])),
        'reason ' + jstr(t['reason']),
    ]
    return ''.join(l + '\n' for l in lines)


def payload_text(grant_id, version, terms_hash, request_id):
    return 'hadron-grant-signature-v1\ngrant %s\nversion %d\nterms-hash %s\nrequest %s\n' % (
        grant_id, version, terms_hash, request_id)


BASE = {
    'appId': APP, 'holder': {'kind': 'agent', 'id': AGENT}, 'action': 'schedule.create',
    'values': {'entryNode': NODE}, 'startsAt': None, 'expiresAt': '2026-12-31T23:59:59.000Z', 'maxUses': None,
    'reason': 'Run the nightly digest.',
}


def with_(**kw):
    t = json.loads(json.dumps(BASE))
    t.update(kw)
    return t


CASES = [
    ('spec-example', 'the cor:acl:140:09 worked example', BASE, 1, REQ),
    ('spec-reason-line-break', 'the worked example with a line break in the reason', with_(reason='Run the nightly digest.\nWeekdays only.'), 1, REQ),
    ('spec-version-2', 'the worked example at record version 2: same terms hash, different challenge', BASE, 2, REQ),
    ('other-request', 'the worked example for another request: same terms hash, different challenge', BASE, 1, REQ_B),
    ('holder-user', 'a user holder', with_(holder={'kind': 'user', 'id': 'cm3k9x2c00003ab12cd34ef58'}), 1, REQ),
    ('holder-worker', 'a worker holder', with_(holder={'kind': 'worker', 'id': '01a13b5ea46e747da745acb088c5cf76'}), 1, REQ),
    ('holder-app', 'an App holder', with_(holder={'kind': 'app', 'id': 'cm3k9x2d00004ab12cd34ef59'}), 1, REQ),
    ('time-frame-and-count', 'a start, an expiry and a use count', with_(startsAt='2026-11-10T08:00:00.000Z', expiresAt='2027-01-01T00:00:00.000Z', maxUses=10), 1, REQ),
    ('no-time-frame', 'no start and no expiry', with_(expiresAt=None), 1, REQ),
    ('wildcard', 'a wildcard value: the JSON string "*"', with_(values={'entryNode': '*'}), 1, REQ),
    ('list-stored-order', 'a list value, written in stored order', with_(values={'entryNode': ['b1', 'a1']}), 1, REQ),
    ('list-other-order', 'the same list in the other order: a different terms hash', with_(values={'entryNode': ['a1', 'b1']}), 1, REQ),
    ('keys-utf16-order', 'keys sorted by UTF-16 code units: "Z" < "a" < "\\u00e9" < "\\ud835\\udc9c" < "\\uff21"',
     with_(values={'Ａ': 'v5', '\U0001d49c': 'v4', 'é': 'v3', 'a': 'v2', 'Z': 'v1'}), 1, REQ),
    ('reason-escapes', 'quote, backslash, tab, U+0001 and U+001F escaped; U+007F, U+2028, slash and emoji literal',
     with_(reason='say "hi" \\ tab\there \u0001\u001f \u007f   a/b \U0001f600'), 1, REQ),
    ('reason-nfc', 'the reason in NFC', with_(reason='Grüße'), 1, REQ),
    ('reason-nfd', 'the same reason in NFD: never normalized, so a different terms hash', with_(reason='Grüße'), 1, REQ),
    ('reason-surrounding-space', 'leading and trailing spaces kept as stored', with_(reason='  padded  '), 1, REQ),
]

out = []
for name, note, terms, version, req in CASES:
    tt = terms_text(terms)
    th = hashlib.sha256(tt.encode('utf-8')).hexdigest()
    pt = payload_text(GRANT, version, th, req)
    ch = hashlib.sha256(pt.encode('utf-8')).digest()
    out.append({
        'name': name, 'note': note, 'grantId': GRANT, 'recordVersion': version, 'requestId': req, 'terms': terms,
        'termsUtf8': tt, 'termsHash': th, 'payloadUtf8': pt,
        'canonical': base64.b64encode(pt.encode('utf-8')).decode('ascii'),
        'challengeHex': ch.hex(), 'challengeBase64url': base64.urlsafe_b64encode(ch).rstrip(b'=').decode('ascii'),
    })

json.dump({
    'description': 'cor:acl:140:09 grant signature payload conformance fixture (hadron-server#3649 slice A); '
                   'generated by scripts/generate-grant-signature-fixture.py with Python hashlib, not the builder under test',
    'version': 'hadron-grant-signature-v1', 'termsVersion': 'hadron-grant-terms-v1', 'challengeAlgorithm': 'SHA-256',
    'cases': out,
}, sys.stdout, ensure_ascii=False, indent=2)
sys.stdout.write('\n')
