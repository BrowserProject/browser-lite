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
    'аpple.com', // Cyrillic а with Latin
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

test('displayURL changes only the host', () => {
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
  assert.equal(new URL(displayURL(url)).href, url);
});
