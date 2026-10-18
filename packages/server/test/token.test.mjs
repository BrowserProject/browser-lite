import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { authorizeToken, signToken, verifyToken } from '../dist/token.js';

const SECRET = 'secret-0123456789abcdef0123456789abcdef';
const req = (headers = {}) => ({ headers });
const url = (query = '') => new URL(`http://x/wisp/${query}`);

// Token in the documented format, signed by hand
function handMade(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
}

test('signed tokens verify until they expire', () => {
  const token = signToken({ secret: SECRET, ttlSeconds: 60, subject: 'user-1' });
  assert.match(token, /^[\w-]+\.[\w-]+$/);
  assert.deepEqual(verifyToken(SECRET, token), { subject: 'user-1' });
  assert.deepEqual(verifyToken(SECRET, signToken({ secret: SECRET, ttlSeconds: 1 })), {});
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual(verifyToken(SECRET, handMade({ exp: now + 30, sub: 'b' })), { subject: 'b' });
  assert.equal(verifyToken(SECRET, handMade({ exp: now - 1, sub: 'b' })), null, 'expired');
  assert.equal(verifyToken(SECRET, handMade({ sub: 'b' })), null, 'without expiry');
});

test('tampered, foreign and malformed tokens fail', () => {
  const token = signToken({ secret: SECRET, ttlSeconds: 60, subject: 'a' });
  const [payload, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ exp: 9999999999, sub: 'admin' })).toString(
    'base64url',
  );
  assert.equal(verifyToken(SECRET, `${forged}.${mac}`), null);
  assert.equal(verifyToken(`${SECRET}x`, token), null);
  assert.equal(verifyToken(SECRET, `${payload}.${mac}.x`), null);
  assert.equal(verifyToken(SECRET, payload), null);
  assert.equal(verifyToken(SECRET, ''), null);
  assert.equal(verifyToken(SECRET, undefined), null);
});

test('short secrets and invalid ttl throw', () => {
  assert.throws(() => signToken({ secret: 'short', ttlSeconds: 60 }), TypeError);
  assert.throws(() => verifyToken('short', 'x.y'), TypeError);
  assert.throws(() => signToken({ secret: SECRET, ttlSeconds: 0 }), TypeError);
  assert.throws(() => signToken({ secret: SECRET, ttlSeconds: Number.NaN }), TypeError);
});

test('authorizeToken: static token in query or bearer header', () => {
  const authorize = authorizeToken({ token: 'static-token-0123456789' });
  assert.equal(authorize(req(), url('?token=static-token-0123456789')), true);
  assert.equal(authorize(req({ authorization: 'Bearer static-token-0123456789' }), url()), true);
  assert.equal(authorize(req(), url('?token=wrong')), false);
  assert.equal(authorize(req(), url()), false);
  assert.equal(authorize(req({ authorization: 'Basic static-token-0123456789' }), url()), false);
});

test('authorizeToken: signed tokens, and both kinds together', () => {
  const signed = authorizeToken({ secret: SECRET });
  const token = signToken({ secret: SECRET, ttlSeconds: 60 });
  assert.equal(signed(req(), url(`?token=${token}`)), true);
  assert.equal(signed(req({ authorization: `Bearer ${token}` }), url()), true);
  assert.equal(signed(req(), url('?token=static-token-0123456789')), false);
  const both = authorizeToken({ token: 'static-token-0123456789', secret: SECRET });
  assert.equal(both(req(), url(`?token=${token}`)), true);
  assert.equal(both(req(), url('?token=static-token-0123456789')), true);
  assert.equal(both(req(), url('?token=nope')), false);
});

test('authorizeToken needs a usable token or secret', () => {
  assert.throws(() => authorizeToken({}), TypeError);
  assert.throws(() => authorizeToken({ token: 'short' }), TypeError);
  assert.throws(() => authorizeToken({ secret: 'short' }), TypeError);
});
