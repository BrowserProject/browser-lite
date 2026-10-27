// HTTP authentication (engine/src/HttpAuth.cpp, handler `authenticate` of the core): a local
// server answers 401 with Basic and Digest. The prompt comes with realm and scheme, cancel shows
// the body of the 401, wrong credentials ask again (retry), right ones load the page, and further
// requests to the realm (same directory, another directory, Digest) do not ask. No prompt for
// credentials: 'omit', cross-origin loads and requests with their own Authorization header (which
// keeps working); a prompt whose load goes away is aborted (auth-cancel).
//
//   node tests/core/auth-test.mjs [engine-dir]
import crypto from 'node:crypto';
import {
  TIMEOUT,
  check,
  finish,
  hostEvents,
  launch,
  load,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitEvent,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

const USER = 'ann';
const PASSWORD = 'open sesame';
const BASIC_REALM = 'Basic Area';
const DIGEST_REALM = 'Digest Area';
const md5 = (text) => crypto.createHash('md5').update(text).digest('hex');
const page = (title, script = '') =>
  `<!doctype html><title>${title}</title><body>${title}<script>${script}</script>`;

function basicOK(req) {
  const expected = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
  return req.headers.authorization === expected;
}

// RFC 7616 with qop=auth and MD5, what curl sends
function digestOK(req) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Digest ')) return false;
  const params = Object.fromEntries(
    [...header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [
      m[1],
      m[2] ?? m[3],
    ]),
  );
  if (params.username !== USER || params.realm !== DIGEST_REALM) return false;
  const ha1 = md5(`${USER}:${DIGEST_REALM}:${PASSWORD}`);
  const ha2 = md5(`${req.method}:${params.uri}`);
  const expected = params.qop
    ? md5(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`)
    : md5(`${ha1}:${params.nonce}:${ha2}`);
  return expected === params.response;
}

function deny(res, scheme, realm, name) {
  const challenge =
    scheme === 'Digest'
      ? `Digest realm="${realm}", qop="auth", nonce="${crypto.randomBytes(8).toString('hex')}", opaque="bl"`
      : `Basic realm="${realm}"`;
  res
    .writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'WWW-Authenticate': challenge })
    .end(page(`DENIED|${name}`));
}

const html = (res, body) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
const text = (res, body) => res.writeHead(200, { 'Content-Type': 'text/plain' }).end(body);

// Another origin with a protected resource (cross-origin loads must not ask)
const { url: otherRoot } = await serve((req, res) => {
  if (basicOK(req)) return text(res, 'other-ok');
  deny(res, 'Basic', 'Other Area', 'other');
});

const FIRST = `
const out = [];
const status = (url, init) => fetch(url, init).then((r) => r.status + ':' + r.type, (e) => 'error:' + e.name);
(async () => {
  out.push('omit=' + await status('/api/data', { credentials: 'omit' }));
  out.push('header=' + await fetch('/api/data', { headers: { Authorization: 'Basic ' + btoa('${USER}:${PASSWORD}') } }).then((r) => r.status + ':' + r.statusText, (e) => 'error:' + e.name));
  out.push('cross=' + await status('${otherRoot}secret', { mode: 'no-cors', credentials: 'include' }));
  const image = new Image();
  image.src = '${otherRoot}image.png';
  await new Promise((resolve) => { image.onload = image.onerror = resolve; });
  document.title = 'FIRST|' + out.join('|');
})();`;

const { url: siteRoot } = await serve((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/plain') return html(res, page('PLAIN', FIRST));
  if (path === '/api/data')
    return basicOK(req) ? text(res, 'api-ok') : deny(res, 'Basic', 'API', 'api');
  if (path.startsWith('/basic/') || path.startsWith('/members/')) {
    if (!basicOK(req)) return deny(res, 'Basic', BASIC_REALM, 'basic');
    if (path === '/members/data.txt') return text(res, 'members-data');
    // A same origin fetch into another directory of the realm
    return html(
      res,
      page(
        'loading',
        `fetch('/members/data.txt').then((r) => r.text()).then((t) => { document.title = 'BASIC|${path}|' + t; });`,
      ),
    );
  }
  if (path.startsWith('/digest/'))
    return digestOK(req)
      ? html(res, page(`DIGEST|${path}`))
      : deny(res, 'Digest', DIGEST_REALM, 'digest');
  if (path === '/wait/') return deny(res, 'Basic', 'Wait Area', 'wait');
  res.writeHead(404).end();
});

const stack = await startStack({ token: 'auth-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext();
const tab = await context.newPage();
watchErrors(tab);
check('host page started', await openHost(tab, stack.app({ url: `${siteRoot}plain` })));

const requests = () => tab.evaluate(() => window.blHost.authRequests);
const answers = (list) => tab.evaluate((list) => window.blHost.authAnswers.push(...list), list);
const title = (match, ms = TIMEOUT) => waitEvent(tab, match, ms);

// 1. No prompt: credentials 'omit', cross-origin fetch and image, an own Authorization header
const first = await title(/^title:FIRST\|/);
check(
  'omit gets the 401, an own Authorization header works, cross-origin does not ask',
  first === 'title:FIRST|omit=401:basic|header=200:OK|cross=0:opaque',
  first,
);
check('no prompt for those', (await requests()).length === 0, JSON.stringify(await requests()));

// 2. Cancel shows the body of the 401
await answers([null]);
await load(tab, `${siteRoot}basic/`);
check('cancel: the page shows the 401 body', !!(await title('title:DENIED|basic')));
const [asked] = await requests();
check(
  'the prompt has url, origin, realm and scheme',
  asked?.url === `${siteRoot}basic/` &&
    asked.origin === siteRoot.slice(0, -1) &&
    asked.realm === BASIC_REALM &&
    asked.scheme === 'basic' &&
    asked.retry === false &&
    asked.view === 1,
  JSON.stringify(asked),
);

// 3. Wrong credentials ask again, right ones load; the fetch into /members/ does not ask
await answers([
  { username: USER, password: 'wrong' },
  { username: USER, password: PASSWORD },
]);
await load(tab, `${siteRoot}basic/`);
check(
  'right credentials load the page and its fetch of the same realm',
  !!(await title('title:BASIC|/basic/|members-data')),
);
const afterBasic = await requests();
check(
  'wrong credentials asked once more with retry',
  afterBasic.length === 3 && afterBasic[1].retry === false && afterBasic[2].retry === true,
  JSON.stringify(afterBasic),
);

// 4. Same directory (sent ahead) and another directory of the realm: no prompt
await load(tab, `${siteRoot}basic/again`);
check(
  'same directory loads without asking',
  !!(await title('title:BASIC|/basic/again|members-data')),
);
await load(tab, `${siteRoot}members/page`);
check(
  'another directory of the realm loads',
  !!(await title('title:BASIC|/members/page|members-data')),
);
check('no prompt for them', (await requests()).length === 3);

// 5. Digest: asks once, then the realm is known
await answers([{ username: USER, password: PASSWORD }]);
await load(tab, `${siteRoot}digest/`);
check('Digest: right credentials load the page', !!(await title('title:DIGEST|/digest/')));
await load(tab, `${siteRoot}digest/second`);
check('Digest: a second page loads', !!(await title('title:DIGEST|/digest/second')));
const afterDigest = await requests();
check(
  'Digest asked once with scheme digest',
  afterDigest.length === 4 &&
    afterDigest[3].scheme === 'digest' &&
    afterDigest[3].realm === DIGEST_REALM,
  JSON.stringify(afterDigest.slice(3)),
);

// 6. The load goes away while the prompt is open: the request is aborted
await answers(['wait']);
await load(tab, `${siteRoot}wait/`);
check('prompt for the waiting realm', !!(await title('auth:Wait Area')));
await load(tab, `${siteRoot}digest/third`);
check('navigating away aborts the prompt', !!(await title('auth-aborted:Wait Area')));
check('and the new page loads', !!(await title('title:DIGEST|/digest/third')));

if (process.env.E2E_VERBOSE) console.log((await hostEvents(tab)).join('\n'));
await browser.close();
finish();
