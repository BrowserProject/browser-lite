// Regular expressions in the host (patch 0073, engine/src/HostRegExp.cpp): with BL_HOST_REGEXP=all
// every pattern of the page runs in a RegExp of the host's worker, with the default (auto) only
// those measured expensive. Both give the same results as Chromium for captures, named groups,
// indices, the flags g, y, m, s, u, v and i, lookbehind, Latin-1 and UTF-16 input, replace,
// split and a cookie regexp that backtracks a lot (20min.ch). A pattern measured expensive keeps
// running in the host after a memory release deleted its bytecode (its cost belongs to its source
// and flags), instead of being measured in the interpreter again.
//
//   node tests/core/regexp-test.mjs [engine-dir]
import {
  check,
  collect,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

// Runs in the engine page and in Chromium: one line per case
function regexpCases() {
  const out = [];
  const s =
    'The Quick brown fox, 2026-11-03; jumps über 𝒳 the lazy dog.\nSecond line: foo=bar; baz=qux';
  const cookie = `${Array.from({ length: 60 }, (_, i) => `c${i}=${'x'.repeat(40)}`).join('; ')}; dataLayerLogger=on`;
  const run = (name, fn) => {
    try {
      out.push(`${name}:${JSON.stringify(fn())}`);
    } catch (e) {
      out.push(`${name}!${e.name}`);
    }
  };
  run('exec', () => /(\d{4})-(\d\d)-(\d\d)/.exec(s));
  run('named', () => s.match(/(?<y>\d{4})-(?<m>\d\d)/).groups);
  run('indices', () => /(?<w>q\w+)/di.exec(s).indices);
  run('global', () => s.match(/o\w?/g));
  run('matchAll', () => [...s.matchAll(/(\w+)=(\w+)/g)].map((m) => [m.index, m[1], m[2]]));
  run('replace', () => s.replace(/(\w+)=(\w+)/g, '$2=$1'));
  run('replaceFn', () => s.replace(/[aeiou]/gi, (m, i) => m.toUpperCase() + i));
  run('split', () => s.split(/\s*[;,]\s*/));
  run('sticky', () => {
    const r = /\w+/y;
    r.lastIndex = 4;
    return [r.exec(s)?.[0], r.lastIndex];
  });
  run('stickyMiss', () => {
    const r = /\w+/y;
    r.lastIndex = 3;
    return [r.exec(s), r.lastIndex];
  });
  run('multiline', () => s.match(/^\w+/gm));
  run('dotAll', () => [/line.(\w+)$/s.test(s), /fox.*Second/s.test(s), /fox.*Second/.test(s)]);
  run('unicode', () => s.match(/\p{L}+/gu).slice(0, 8));
  run('surrogate', () => /(.)\s+the/u.exec(s));
  run('surrogateLegacy', () => /(.)\s+the/.exec(s));
  run('unicodeSets', () => s.match(/[\p{L}--[a-z]]+/gv));
  run('lookbehind', () => s.match(/(?<=foo=)\w+/)[0]);
  run('negativeLookbehind', () => s.match(/(?<!\w)b\w+/g));
  run('backreference', () => /(\w)\1/.exec('aabbcc'));
  run('alternativeGroups', () => /(a)|(b)/.exec('b'));
  run('lastIndex', () => {
    const r = /o/g;
    r.exec(s);
    r.exec(s);
    return r.lastIndex;
  });
  run('noMatch', () => /zzz(\d)/.exec(s));
  run('emptyMatches', () => 'abc'.replace(/x*/g, '-'));
  run('ignoreCase', () => [/ÜBER/i.test(s), /QUICK BROWN/i.test(s)]);
  run('latin1', () => /é(\w)/.exec('cafés'));
  run('test', () => [/fox/.test(s), /cat/.test(s)]);
  run('search', () => s.search(/dog/));
  run('long', () => `${'ab'.repeat(5000)}X`.match(/(ab)+X/)[0].length);
  run('cookie', () => {
    let match = null;
    // Repeated: the default mode hands it to the host after a few measured calls
    for (let i = 0; i < 12; i++) match = cookie.match(/(^|[^;]+)\s*dataLayerLogger\s*=\s*([^;]+)/);
    return [match.index, match[1].length, match[2]];
  });
  run('cookieMissing', () => cookie.match(/(^|[^;]+)\s*sessionId\s*=\s*([^;]+)/));
  run('syntaxError', () => new RegExp('(?<a>x)(?<a>y)'));
  return out.join('\n');
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>RegExp</title><script>
${regexpCases.toString()}
console.log('RESULT cases=' + encodeURIComponent(regexpCases()));
</script>`;
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
});

const expected = regexpCases().split('\n');
const stack = await startStack();
const browser = await launch();
for (const mode of ['all', 'auto']) {
  const page = await browser.newPage();
  const results = collect(page);
  await openHost(page, stack.app({ url: siteURL, env: `BL_HOST_REGEXP=${mode}` }));
  const raw = await results.wait('cases');
  const lines = raw ? decodeURIComponent(raw).split('\n') : [];
  check(`${mode}: every case ran`, lines.length === expected.length, `${lines.length}`);
  const differ = expected.filter((line, i) => lines[i] !== line);
  check(
    `${mode}: results like Chromium`,
    raw !== null && !differ.length,
    differ.map((line) => `${line} | ${lines[expected.indexOf(line)]}`).join(' ; '),
  );
  await page.close();
}

// Times of 4 calls of the cookie regexp: the first (measured in the interpreter), after 8 more
// (in the host) and right after a memory release that deleted all compiled code
const RELEASE_PAGE = `<!doctype html><meta charset="utf-8"><title>Release</title><script>
const cookie = Array.from({ length: 100 }, (_, i) => 'c' + i + '=' + 'x'.repeat(40)).join('; ') + '; dataLayerLogger=on';
const calls = (n) => {
  const start = performance.now();
  for (let i = 0; i < n; i++) cookie.match(/(^|[^;]+)\\s*dataLayerLogger\\s*=\\s*([^;]+)/);
  return Math.round(performance.now() - start);
};
const measured = calls(4);
calls(8);
console.log('RESULT before=' + measured + ',' + calls(4));
window.after = () => console.log('RESULT after=' + calls(4));
</script>`;
const { url: releaseURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(RELEASE_PAGE);
});
{
  const page = await browser.newPage();
  const results = collect(page);
  await openHost(page, stack.app({ url: releaseURL }));
  const [measured, hosted] = ((await results.wait('before')) ?? '').split(',').map(Number);
  check(
    'measured calls cost more than calls in the host',
    measured > hosted * 3,
    `${measured} ${hosted}`,
  );
  // Like under memory pressure: WebCore::releaseMemory, which deletes the code of every RegExp
  await page.evaluate(() => window.blTest.memory(3));
  await page.evaluate(() => window.blTest.eval('after()'));
  const after = Number(await results.wait('after'));
  check(
    'after a memory release it runs in the host at once',
    after <= hosted * 2 + 3,
    `${measured} ${hosted} ${after}`,
  );
  await page.close();
}

await browser.close();
finish();
