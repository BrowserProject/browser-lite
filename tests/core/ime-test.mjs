// Text from input methods through the IME field of the core, like an Android keyboard (Gboard)
// sends it: committed text, a Backspace as a deletion inside the field (keydown 229 and
// deleteContentBackward, no Backspace key), a suggestion that replaces the word, a composition
// and a composition on the word again. After a click or a plain key the field shows the page's
// text before the caret (nothing of a password). The enter key of the keyboard like in Chrome on
// Android: next in a field that a field of its form follows, where Gboard's Next key moves to
// that field, go in the last one, return in a text area. The keyboard's text hints are the page
// field's: autocapitalize, autocorrect and spellcheck, inherited from the form, none in email,
// URL and password fields.
//
//   node tests/core/ime-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  chromiumOnly,
  collect,
  evalPage,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 120000);

const PAGE = `<!doctype html>
<html><head><title>IME test</title>
<style>
  body { margin: 0; font: 16px sans-serif; }
  #a { position: absolute; left: 20px; top: 20px; width: 300px; height: 30px; font-size: 16px; }
  #t { position: absolute; left: 20px; top: 80px; width: 300px; height: 60px; font-size: 16px; }
</style></head>
<body>
<!-- Before the other fields, so none of them is the next field of a field below -->
<input id="caps" autocapitalize="characters" style="position: absolute; left: 20px; top: 360px; width: 300px; height: 30px">
<form autocapitalize="off" autocorrect="off" spellcheck="false">
  <input id="inherit" style="position: absolute; left: 20px; top: 400px; width: 300px; height: 30px">
</form>
<input id="mail" type="email" style="position: absolute; left: 20px; top: 440px; width: 300px; height: 30px">
<div id="ed" contenteditable autocapitalize="words" style="position: absolute; left: 20px; top: 480px; width: 300px; height: 30px">Hi. there</div>
<input id="a" value="hello world" autocomplete="off">
<textarea id="t">abc</textarea>
<form id="login" action="/login">
  <input id="user" style="position: absolute; left: 20px; top: 160px; width: 300px; height: 30px">
  <input id="pass" type="password" value="secret" style="position: absolute; left: 20px; top: 200px; width: 300px; height: 30px">
  <button style="position: absolute; left: 340px; top: 200px">Sign in</button>
</form>
<input id="solo" style="position: absolute; left: 20px; top: 240px; width: 300px; height: 30px">
<input id="hinted" form="own" enterkeyhint="next" style="position: absolute; left: 20px; top: 280px; width: 300px; height: 30px">
<input id="after" form="own" style="position: absolute; left: 20px; top: 320px; width: 300px; height: 30px">
<form id="own"></form>
<script>
  window.enterLog = [];
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterLog.push('enter:' + e.target.id); });
  document.addEventListener('submit', (e) => { e.preventDefault(); enterLog.push('submit:' + e.target.id); });
</script>
<script>console.log('RESULT ready=1');</script>
</body></html>`;

const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  else res.writeHead(404).end();
});

const browser = await launch();
const stack = await startStack();
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const results = collect(page, /RESULT (\w+)=(.*?)(\s+\(|$)/);
check('host page started a browser', await openHost(page, stack.app({ url: siteURL })));
check('page ready', (await results.wait('ready', TIMEOUT)) === '1');

const at = async (x, y) => {
  const origin = await canvasOrigin(page);
  return [origin.x + x, origin.y + y];
};
// The value of a page field, reported through the console
let reads = 0;
const value = async (id) => {
  const key = `value${++reads}`;
  await evalPage(
    page,
    `console.log('RESULT ${key}=' + JSON.stringify(document.getElementById('${id}').value))`,
  );
  const raw = await results.wait(key, 10000);
  return raw == null ? null : JSON.parse(raw);
};
const valueIs = async (id, expected) => {
  await waitFor(async () => (await value(id)) === expected, 10000);
  return value(id);
};
const imeValue = () => page.evaluate(() => document.querySelector('[data-bl-ime]').value);
// What Chrome on Android does for a keyboard's deleteSurroundingText: keydown 229 (Unidentified),
// then the text before the caret of the focused field goes, an input event of deleteContentBackward
const keyboardBackspace = async () => {
  await page.evaluate(() => {
    const ime = document.querySelector('[data-bl-ime]');
    const init = { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true };
    ime.dispatchEvent(new KeyboardEvent('keydown', init));
    document.execCommand('delete');
    ime.dispatchEvent(new KeyboardEvent('keyup', init));
  });
};

// The caret at the end of the input (a click right of its text); the text before the caret
// reaches the IME field after the click
await page.mouse.click(...(await at(300, 35)));
await waitFor(async () => (await imeValue()) === 'hello world', 10000);
await page.keyboard.insertText('x');
await page.keyboard.insertText('y');
let text = await valueIs('a', 'hello worldxy');
check('committed text reaches the page', text === 'hello worldxy', JSON.stringify(text));
check(
  'the IME field keeps the typed text after the text before the caret',
  (await imeValue()) === 'hello worldxy',
  await imeValue(),
);

await keyboardBackspace();
await keyboardBackspace();
text = await valueIs('a', 'hello world');
check(
  'a Backspace of the keyboard after typing deletes in the page',
  text === 'hello world',
  JSON.stringify(text),
);

// A suggestion replaces the word before the caret
await page.keyboard.insertText(' helo');
await page.evaluate(() => {
  const ime = document.querySelector('[data-bl-ime]');
  ime.setSelectionRange(ime.value.length - 4, ime.value.length);
});
await page.keyboard.insertText('hello ');
text = await valueIs('a', 'hello world hello ');
check('a suggestion replaces the typed word', text === 'hello world hello ', JSON.stringify(text));

// A plain key moves the caret: the field shows the page's text before it again, the keyboard
// sends a real Backspace
await page.keyboard.press('Home');
await page.keyboard.press('ArrowRight');
const imeValueIs = async (expected) => {
  await waitFor(async () => (await imeValue()) === expected, 10000);
  return imeValue();
};
let ime = await imeValueIs('h');
check('after a plain key the IME field shows the text before the caret', ime === 'h', ime);
await page.keyboard.press('End');
ime = await imeValueIs('hello world hello ');
check('the IME field follows the caret', ime === 'hello world hello ', ime);
await page.keyboard.press('Backspace');
text = await valueIs('a', 'hello world hello');
check('a Backspace key still deletes', text === 'hello world hello', JSON.stringify(text));

// A click into the textarea: the field shows its text before the caret
await page.mouse.click(...(await at(300, 130)));
ime = await imeValueIs('abc');
check('a click into another field shows its text before the caret', ime === 'abc', ime);
await page.keyboard.insertText('de');
await keyboardBackspace();
text = await valueIs('t', 'abcd');
check('Backspace of the keyboard in a textarea', text === 'abcd', JSON.stringify(text));

if (chromiumOnly('compositions through CDP')) {
  const cdp = await page.context().newCDPSession(page);
  const compose = (params) =>
    cdp.send('Input.imeSetComposition', { selectionStart: -1, selectionEnd: -1, ...params });
  // A composing keyboard: the word is a composition until it is committed
  await compose({ text: 'wor' });
  await page.keyboard.insertText('world');
  text = await valueIs('t', 'abcdworld');
  check('a committed composition reaches the page', text === 'abcdworld', JSON.stringify(text));
  check(
    'the IME field keeps the composed word',
    (await imeValue()) === 'abcdworld',
    await imeValue(),
  );
  await keyboardBackspace();
  text = await valueIs('t', 'abcdworl');
  check('Backspace of the keyboard after a composition', text === 'abcdworl', JSON.stringify(text));
  // Android keyboards compose the word before the caret again (setComposingRegion): the page
  // ends up with the new word once, not after the old one
  const length = (await imeValue()).length;
  await compose({ text: 'dwor', replacementStart: length - 5, replacementEnd: length });
  await page.keyboard.insertText('dwarf');
  text = await valueIs('t', 'abcdwarf');
  check('a composition over typed text replaces it', text === 'abcdwarf', JSON.stringify(text));
  await cdp.detach();
}

// The enter key of the on-screen keyboard. Chrome on Android sends its action key as an Enter
// without the code of a physical key; the IME field is a textarea, which showed the return key
// for every field of the page.
const enterKey = async (code) => {
  await page.evaluate((code) => {
    const ime = document.querySelector('[data-bl-ime]');
    for (const type of ['keydown', 'keyup'])
      ime.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code,
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
  }, code);
};
const hint = () => page.evaluate(() => document.querySelector('[data-bl-ime]').enterKeyHint);
const hintIs = async (expected) => {
  await waitFor(async () => (await hint()) === expected, 10000);
  return hint();
};
const tapField = async (y, expected) => {
  await page.mouse.click(...(await at(150, y)));
  return hintIs(expected);
};
let fieldState = 0;
const pageState = async () => {
  const key = `state${++fieldState}`;
  await evalPage(
    page,
    `console.log('RESULT ${key}=' + document.activeElement.id + '|' + enterLog.splice(0).join(','))`,
  );
  return results.wait(key, 10000);
};
const stateIs = async (expected) => {
  let state = '';
  await waitFor(async () => (state = await pageState()) === expected, 5000);
  return state;
};
await pageState();
let enter = await tapField(175, 'next');
check('enter key: next in a field that another field of its form follows', enter === 'next', enter);
await enterKey('');
let state = await stateIs('pass|');
check(
  'enter key: Next moves to the next field, no Enter reaches the page',
  state === 'pass|',
  state,
);
enter = await hintIs('go');
check('enter key: go in the last field of a form (a submit button follows)', enter === 'go', enter);
await enterKey('');
state = await stateIs('pass|enter:pass,submit:login');
check(
  'enter key: Go is the Enter key of the page',
  state === 'pass|enter:pass,submit:login',
  state,
);
await tapField(175, 'next');
await page.keyboard.press('Enter');
state = await stateIs('user|enter:user,submit:login');
check(
  'enter key: a hardware Enter in a field with Next stays the Enter key of the page',
  state === 'user|enter:user,submit:login',
  state,
);
enter = await tapField(255, 'go');
check('enter key: go in a field without a form and a field after it', enter === 'go', enter);
await tapField(295, 'next');
await enterKey('');
state = await stateIs('hinted|enter:hinted');
check(
  "enter key: the page's own enterkeyhint next gets the Enter key like in Chrome",
  state === 'hinted|enter:hinted',
  state,
);
enter = await tapField(110, '');
check('enter key: return in a text area', enter === '', JSON.stringify(enter));

// The text hints of the page's field
const traits = () =>
  page.evaluate(() => {
    const ime = document.querySelector('[data-bl-ime]');
    return [ime.getAttribute('autocapitalize'), ime.getAttribute('autocorrect'), ime.spellcheck]
      .map(String)
      .join(' ');
  });
const traitsAt = async (x, y, expected) => {
  await page.mouse.click(...(await at(x, y)));
  await waitFor(async () => (await traits()) === expected, 10000);
  return traits();
};
let hints = await traitsAt(150, 255, 'sentences on true');
check(
  'hints: a text field starts sentences with a capital and corrects',
  hints === 'sentences on true',
  hints,
);
hints = await traitsAt(150, 215, 'none off false');
check('hints: none in a password field', hints === 'none off false', hints);
ime = await imeValueIs('');
check('the IME field shows nothing of a password', ime === '', JSON.stringify(ime));
hints = await traitsAt(150, 375, 'characters on true');
check("hints: the field's autocapitalize", hints === 'characters on true', hints);
hints = await traitsAt(150, 415, 'none off false');
check("hints: those of the field's form", hints === 'none off false', hints);
hints = await traitsAt(150, 455, 'none off false');
check('hints: no capital and correction in an email field', hints === 'none off false', hints);
hints = await traitsAt(300, 495, 'words on true');
check('hints: those of an editable element', hints === 'words on true', hints);
ime = await imeValueIs('Hi. there');
check('the IME field shows the text of an editable element', ime === 'Hi. there', ime);

await browser.close();
finish();
