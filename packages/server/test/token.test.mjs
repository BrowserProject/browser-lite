import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { authorizeToken, signToken, verifyToken } from '../dist/token.js';

const SECRET = 'secret-0123456789abcdef0123456789abcdef';
const req = (headers = {}) => ({ headers });
// The subprotocol entry WispTransport sends
const offered = (token) => ({
  'sec-websocket-protocol': `wisp, bl-token.${Buffer.from(token).toString('base64url')}`,
});

// Token in the documented format, signed by hand
function handMade(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
}

test('signed tokens verify for their audience until they expire', () => {
  const token = signToken({ secret: SECRET, ttlSeconds: 60, audience: 'relay', subject: 'user-1' });
  assert.match(token, /^[\w-]+\.[\w-]+$/);
  assert.deepEqual(verifyToken(SECRET, token, 'relay'), { subject: 'user-1' });
  assert.equal(verifyToken(SECRET, token, 'profile'), null, 'other audience');
  const short = signToken({ secret: SECRET, ttlSeconds: 1, audience: 'relay' });
  assert.deepEqual(verifyToken(SECRET, short, 'relay'), {});
  const now = Math.floor(Date.now() / 1000);
  const valid = handMade({ exp: now + 30, aud: 'relay', sub: 'b' });
  assert.deepEqual(verifyToken(SECRET, valid, 'relay'), { subject: 'b' });
  const expired = handMade({ exp: now - 1, aud: 'relay', sub: 'b' });
  assert.equal(verifyToken(SECRET, expired, 'relay'), null, 'expired');
  assert.equal(verifyToken(SECRET, handMade({ aud: 'relay' }), 'relay'), null, 'without expiry');
  assert.equal(verifyToken(SECRET, handMade({ exp: now + 30 }), 'relay'), null, 'no audience');
});

test('tampered, foreign and malformed tokens fail', () => {
  const token = signToken({ secret: SECRET, ttlSeconds: 60, audience: 'relay', subject: 'a' });
  const [payload, mac] = token.split('.');
  const forged = Buffer.from(
    JSON.stringify({ exp: 9999999999, aud: 'relay', sub: 'admin' }),
  ).toString('base64url');
  assert.equal(verifyToken(SECRET, `${forged}.${mac}`, 'relay'), null);
  assert.equal(verifyToken(`${SECRET}x`, token, 'relay'), null);
  assert.equal(verifyToken(SECRET, `${payload}.${mac}.x`, 'relay'), null);
  assert.equal(verifyToken(SECRET, payload, 'relay'), null);
  assert.equal(verifyToken(SECRET, '', 'relay'), null);
  assert.equal(verifyToken(SECRET, undefined, 'relay'), null);
});

test('short secrets, missing audience and invalid ttl throw', () => {
  const audience = 'relay';
  assert.throws(() => signToken({ secret: 'short', ttlSeconds: 60, audience }), TypeError);
  assert.throws(() => signToken({ secret: SECRET, ttlSeconds: 60 }), TypeError);
  assert.throws(() => verifyToken('short', 'x.y', audience), TypeError);
  assert.throws(() => verifyToken(SECRET, 'x.y'), TypeError);
  assert.throws(() => signToken({ secret: SECRET, ttlSeconds: 0, audience }), TypeError);
  assert.throws(() => signToken({ secret: SECRET, ttlSeconds: Number.NaN, audience }), TypeError);
});

test('authorizeToken: static token as subprotocol or bearer header, never in the URL', () => {
  const authorize = authorizeToken({ token: 'static-token-0123456789' });
  assert.equal(authorize(req(offered('static-token-0123456789'))), true);
  assert.equal(authorize(req({ authorization: 'Bearer static-token-0123456789' })), true);
  assert.equal(authorize(req(offered('wrong'))), false);
  assert.equal(authorize(req({ 'sec-websocket-protocol': 'wisp' })), false);
  assert.equal(authorize(req()), false);
  assert.equal(authorize(req({ authorization: 'Basic static-token-0123456789' })), false);
  const withQuery = { headers: {}, url: '/wisp/?token=static-token-0123456789' };
  assert.equal(authorize(withQuery, new URL(`http://x${withQuery.url}`)), false);
  const special = authorizeToken({ token: 'with/slash+plus=equals ä' });
  assert.equal(special(req(offered('with/slash+plus=equals ä'))), true);
});

test('authorizeToken: signed tokens of the audience, and both kinds together', () => {
  const signed = authorizeToken({ secret: SECRET, audience: 'relay' });
  const token = signToken({ secret: SECRET, ttlSeconds: 60, audience: 'relay' });
  const profileToken = signToken({ secret: SECRET, ttlSeconds: 60, audience: 'profile' });
  assert.equal(signed(req(offered(token))), true);
  assert.equal(signed(req({ authorization: `Bearer ${token}` })), true);
  assert.equal(signed(req(offered(profileToken))), false, 'other audience');
  assert.equal(signed(req(offered('static-token-0123456789'))), false);
  const both = authorizeToken({
    token: 'static-token-0123456789',
    secret: SECRET,
    audience: 'relay',
  });
  assert.equal(both(req(offered(token))), true);
  assert.equal(both(req(offered('static-token-0123456789'))), true);
  assert.equal(both(req(offered('nope'))), false);
});

test('authorizeToken needs a usable token, or a secret with an audience', () => {
  assert.throws(() => authorizeToken({}), TypeError);
  assert.throws(() => authorizeToken({ token: 'short' }), TypeError);
  assert.throws(() => authorizeToken({ secret: 'short', audience: 'relay' }), TypeError);
  assert.throws(() => authorizeToken({ secret: SECRET }), TypeError);
});
