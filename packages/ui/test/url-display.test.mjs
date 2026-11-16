import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayHost, displayURL } from '../dist/index.js';

const ascii = (host) => new URL(`http://${host}/`).hostname;

test('safe internationalized hosts show in Unicode', () => {
  for (const host of [
    '例え.テスト',
    'münchen.de',
    'bücher.example',
    'пример.рф',
    'яндекс.рф',
    'привет.com',
    'παράδειγμα.δοκιμή',
    'مثال.إختبار',
    'उदाहरण.परीक्षा',
    '실례.테스트',
    '中国.cn',
    'ラーメン.jp',
    'sony中国.com',
    'öbb.at',
    'tiếngviệt.vn',
    'ru.рус',
    'ไทย12.com',
    'ไทย๑๒.com',
    'аррӏе.ru',
    'κατι.gr',
  ])
    assert.equal(displayHost(ascii(host)), host, host);
});

test('hosts that could pass for others stay in xn--', () => {
  for (const host of [
    'аpple.com', // Cyrillic a (U+0430) with Latin
    'аррӏе.com', // only Cyrillic letters that look Latin
    'ехаmple.com',
    'κατι.com', // only Greek letters that look Latin
    'օօ.com', // Armenian
    'paypaⅼ.com'.replace('ⅼ', 'ӏ'),
    'faß.de', // deviation characters
    'ɡoogle.com', // IPA
    'ᴅᴇᴍᴏ.com', // small capitals
    'comノlogin.example', // looks like a slash
    'aー.com',
    'q\u0308\u0308.com', // repeated combining mark
    'ไทย1๒.com', // two numbering systems
    '☃.net', // symbols
    'αβγabc.com', // Greek with Latin
    'xyz.пример.com'.replace('xyz', 'аpple'),
  ]) {
    const encoded = ascii(host);
    assert.ok(encoded.includes('xn--'), host);
    assert.equal(displayHost(encoded), encoded, host);
  }
});

test('invalid xn-- labels stay as they are', () => {
  for (const host of ['xn--.com', 'xn--a.com', 'xn--zz-.com', 'xn--ls8h-.example', 'xn--Ab-.com'])
    assert.equal(displayHost(host), host, host);
  // Decodes, but to a label that is not normalized (an upper case letter)
  assert.equal(displayHost('xn--Mnchen-3ya.de'), 'xn--Mnchen-3ya.de');
});

test('ports, plain hosts and addresses', () => {
  assert.equal(displayHost('xn--mnchen-3ya.de:8080'), 'münchen.de:8080');
  assert.equal(displayHost('example.com'), 'example.com');
  assert.equal(displayHost('127.0.0.1:80'), '127.0.0.1:80');
  assert.equal(displayHost('xn--mnchen-3ya.de.'), 'münchen.de.');
});

test('displayURL shows the host in Unicode', () => {
  assert.equal(displayURL('https://xn--r8jz45g.xn--zckzah/'), 'https://例え.テスト/');
  assert.equal(
    displayURL('https://user:p%40ss@xn--mnchen-3ya.de:8443/xn--mnchen-3ya/?q=xn--#x'),
    'https://user:p%40ss@münchen.de:8443/xn--mnchen-3ya/?q=xn--#x',
  );
  assert.equal(displayURL('https://xn--pple-43d.com/a'), 'https://xn--pple-43d.com/a');
  assert.equal(
    displayURL('view-source:https://xn--mnchen-3ya.de/'),
    'view-source:https://münchen.de/',
  );
  assert.equal(displayURL('about:blank'), 'about:blank');
  assert.equal(displayURL('data:text/plain,xn--mnchen-3ya'), 'data:text/plain,xn--mnchen-3ya');
  // What the field shows loads the same address again
  const url = 'https://xn--mnchen-3ya.de/stra%C3%9Fe?x=1';
  assert.equal(displayURL(url), 'https://münchen.de/straße?x=1');
  assert.equal(new URL(displayURL(url)).href, url);
});

test('displayURL shows escaped UTF-8 characters after the host decoded, like Chrome', () => {
  for (const [url, shown] of [
    ['https://de.wikipedia.org/wiki/Z%C3%BCrich', 'https://de.wikipedia.org/wiki/Zürich'],
    [
      'https://en.wikipedia.org/wiki/La_T%C3%A8ne_culture#S%C3%A9quence',
      'https://en.wikipedia.org/wiki/La_Tène_culture#Séquence',
    ],
    [
      'https://example.com/?q=%E4%BE%8B%E3%81%88&x=%F0%9F%98%80',
      'https://example.com/?q=例え&x=😀',
    ],
    ['https://example.com/%D7%A9%D7%9C%D7%95%D7%9D/1', 'https://example.com/שלום/1'],
    ['file:///home/%C3%A9t%C3%A9.txt', 'file:///home/été.txt'],
    ['view-source:https://example.com/%C3%BC', 'view-source:https://example.com/ü'],
    ['blob:https://example.com/%C3%BC', 'blob:https://example.com/ü'],
    // ASCII, and URL syntax among it, stays escaped: the text has to load the same address
    [
      'https://example.com/a%20b%2Fc%3Fd%23e%25f%41',
      'https://example.com/a%20b%2Fc%3Fd%23e%25f%41',
    ],
    // Not UTF-8: a Latin-1 byte, a cut sequence, an overlong form, a surrogate
    ['https://example.com/?q=%FC', 'https://example.com/?q=%FC'],
    ['https://example.com/%C3%BC%C3', 'https://example.com/ü%C3'],
    ['https://example.com/%C3/x', 'https://example.com/%C3/x'],
    ['https://example.com/%C0%AF', 'https://example.com/%C0%AF'],
    ['https://example.com/%ED%A0%80', 'https://example.com/%ED%A0%80'],
    // Invisible, bidi, spaces and lookalikes of the lock icon stay escaped
    ['https://example.com/a%E2%80%AEb', 'https://example.com/a%E2%80%AEb'],
    ['https://example.com/a%E2%80%8Bb%C2%A0c', 'https://example.com/a%E2%80%8Bb%C2%A0c'],
    ['https://example.com/%E3%80%80%EF%BB%BF', 'https://example.com/%E3%80%80%EF%BB%BF'],
    ['https://example.com/%C2%85%E1%85%9F', 'https://example.com/%C2%85%E1%85%9F'],
    ['https://example.com/%F0%9F%94%92x%C3%BC', 'https://example.com/%F0%9F%94%92xü'],
    // The authority and addresses without one stay as they are
    ['https://us%C3%A9r@example.com/', 'https://us%C3%A9r@example.com/'],
    ['data:text/plain,%C3%BC', 'data:text/plain,%C3%BC'],
    ['mailto:a@example.com?subject=%C3%BC', 'mailto:a@example.com?subject=%C3%BC'],
  ]) {
    assert.equal(displayURL(url), shown, url);
    // Enter on the shown text loads the same address
    if (url.startsWith('http')) assert.equal(new URL(displayURL(url)).href, new URL(url).href, url);
  }
});
