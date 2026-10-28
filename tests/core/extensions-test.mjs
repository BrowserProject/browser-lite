// Extensions (packages/core/src/extensions, engine/src/UserContent.cpp): two small extensions of
// an extension host on the host page. Scripts and CSS go into matching pages only, isolated
// scripts do not see the globals of the page (nor the page theirs) but share its DOM, a main
// world script does, messages go from a script to its extension and back, the dialog handlers
// of both extensions run in install order before the one of the options, and disabling an
// extension takes its CSS out of the open page.
//
//   node tests/core/extensions-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  collect,
  finish,
  launch,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

// The page script runs before the isolated script (document-end): pageSecret is set by then
const PAGE = (name) => `<!doctype html><title>${name}</title>
<style>#box { width: 10px; height: 10px; background: blue }</style>
<div id="box"></div>
<script>
const log = (key, value) => console.log('RESULT ' + key + '=' + String(value).replace(/\\s/g, '_'));
window.pageSecret = 'secret';
log('${name}_main_world', window.mainWorldMark ?? 'none');
addEventListener('load', () => setTimeout(() => {
  log('${name}_width', getComputedStyle(document.getElementById('box')).width);
  log('${name}_dom', document.documentElement.dataset.extA ?? 'none');
  log('${name}_ext_global', typeof extension + ':' + typeof extOnly);
  if ('${name}' === 'match') {
    log('confirm', confirm('Sure?'));
    log('prompt', prompt('Name?', 'x'));
  }
}, 300));
</script>`;

const { url: site } = await serve((req, res) =>
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(PAGE(req.url.startsWith('/match/') ? 'match' : 'other')),
);

const stack = await startStack({ token: 'extensions-token-0123456789abcdef' });
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const results = collect(page);
const result = (key, ms = 30000) => results.wait(key, ms);

await page.goto(stack.app({ manual: '1' }));
const started = await page.evaluate(async (pattern) => {
  const extensions = window.blHost.createExtensionHost();
  window.extLog = [];
  window.extContexts = {};
  await extensions.install({
    id: 'ext-a',
    version: '1.0.0',
    setup(context) {
      window.extContexts.a = context;
      context.addScript({
        matches: [pattern],
        code: `
          document.documentElement.dataset.extA = 'yes';
          window.extOnly = 1;
          extension.onMessage.addListener((m) => console.log('RESULT pushed=' + m.text));
          extension
            .sendMessage({ kind: 'hello', pageSecret: typeof pageSecret, title: document.title })
            .then((answer) => console.log('RESULT answer=' + answer.reply));`,
      });
      context.addStyle({ matches: [pattern], code: '#box { width: 77px !important }' });
      context.onMessage((message, sender) => {
        window.extLog.push(`message:${sender.url.includes('/match/')}:${sender.view.id}`);
        return { reply: `${message.kind}-${message.pageSecret}-${message.title}` };
      });
      context.handle('dialog', (request, next) => {
        window.extLog.push(`a:${request.type}`);
        return next();
      });
    },
  });
  await extensions.install({
    id: 'ext-b',
    version: '1.0.0',
    setup(context) {
      context.addScript({
        matches: ['<all_urls>'],
        world: 'main',
        runAt: 'document-start',
        code: "window.mainWorldMark = 'b';",
      });
      context.handle('dialog', (request, next) => {
        if (request.type !== 'confirm') return next();
        window.extLog.push('b:confirm');
        return true;
      });
    },
  });
  window.extensions = extensions;
  return window.blHost.start({ extensions }).then(
    () => true,
    (error) => String(error),
  );
}, 'http://127.0.0.1/match/*');
check('browser started with the extension host', started === true, started);

await page.evaluate((url) => window.blTest.load(url), `${site}match/page`);
check(
  'main world script before the page scripts',
  (await result('match_main_world', TIMEOUT)) === 'b',
);
check(
  'extension CSS applies (user !important wins)',
  (await result('match_width')) === '77px',
  results.get('match_width'),
);
check('isolated script changed the shared DOM', (await result('match_dom')) === 'yes');
check(
  'page sees neither extension nor the globals of the isolated script',
  (await result('match_ext_global')) === 'undefined:undefined',
  results.get('match_ext_global'),
);
check(
  'isolated script: message answered, page globals invisible to it',
  (await result('answer')) === 'hello-undefined-match',
  results.get('answer'),
);
check('confirm answered by ext-b', (await result('confirm')) === 'true');
check('prompt went through to the handler of the options', (await result('prompt')) === 'answer');
const state = await page.evaluate(() => ({
  log: window.extLog,
  events: window.blHost.events.filter((event) => event.startsWith('dialog:')),
  view: window.blTest.view().id,
}));
check(
  'chain order: ext-a, ext-b, then the options; the message came from the matching frame',
  JSON.stringify(state.log) ===
    JSON.stringify([`message:true:${state.view}`, 'a:confirm', 'b:confirm', 'a:prompt']),
  JSON.stringify(state.log),
);
check(
  'the handler of the options saw only the prompt',
  JSON.stringify(state.events) === JSON.stringify(['dialog:prompt:Name?']),
  JSON.stringify(state.events),
);

await page.evaluate(() =>
  window.extContexts.a.postMessage(window.blTest.view(), { text: 'from-host' }),
);
check('message of the host reaches the isolated script', (await result('pushed')) === 'from-host');

await page.evaluate((url) => window.blTest.load(url), `${site}other/page`);
check('other page: main world script of <all_urls>', (await result('other_main_world')) === 'b');
check('other page: no CSS', (await result('other_width')) === '10px', results.get('other_width'));
check('other page: no isolated script', (await result('other_dom')) === 'none');

// Back to a matching page, then disable ext-a while it is open
results.delete('match_width');
await page.evaluate((url) => window.blTest.load(url), `${site}match/again`);
check(
  'matching page again: CSS',
  (await result('match_width')) === '77px',
  results.get('match_width'),
);
await page.evaluate(() => window.extensions.disable('ext-a'));
await page.evaluate(() =>
  window.blTest.eval(
    "setTimeout(() => console.log('RESULT width_after=' + getComputedStyle(document.getElementById('box')).width), 200)",
  ),
);
check(
  'disabled: its CSS leaves the open page',
  (await result('width_after')) === '10px',
  results.get('width_after'),
);

await page.evaluate(() => window.blHost.stop());
await browser.close();
finish();
