// Cameras and microphones of the pages are the host's (engine/src/media/MediaStreamWasm.cpp,
// capture service of the core): on a host without a camera enumerateDevices lists none and
// getUserMedia rejects with NotFoundError at once, without a prompt, like plain Chromium (before,
// the engine always listed a camera and a microphone, so reCAPTCHA offered its hand gesture
// challenge). Before the permission a page sees at most one device of a kind without id and
// name, like Safari 26. When the host device fails to open, getUserMedia rejects
// (NotReadableError) instead of resolving with a track that ends; a devicechange of the host
// reaches the page.
//
//   node tests/core/capture-devices-test.mjs [engine-dir]
import {
  BROWSER,
  check,
  collect,
  evalPage,
  finish,
  launch,
  openHost,
  permissions,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>capture devices</title><script>
const report = (key, value) => console.log('RESULT ' + key + '=' + value);
window.list = async (key) => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  report(key, devices.map((d) => d.kind + ':' + (d.deviceId ? 'id' : '') + ':' + d.label.replace(/\s/g, '_')).join(',') || 'none');
};
window.capture = async (key, constraints) => {
  const start = performance.now();
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = stream.getTracks()[0];
    await new Promise((resolve) => setTimeout(resolve, 1500));
    report(key, 'ok:' + track.readyState + ':' + Math.round(performance.now() - start));
    window.stream = stream;
  } catch (e) {
    report(key, e.name + ':' + Math.round(performance.now() - start));
  }
};
window.stop = () => window.stream?.getTracks().forEach((track) => track.stop());
navigator.mediaDevices.addEventListener('devicechange', () => report('devicechange', 'fired'));
report('ready', 'yes');
</script>`;

const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);
const stack = await startStack({ token: 'capture-devices-token-0123456789ab' });

const inputs = (list) =>
  list === 'none'
    ? []
    : list
        .split(',')
        .map((entry) => entry.split(':')[0])
        .filter((kind) => kind !== 'audiooutput');
const millis = (value) => Number(value?.split(':').pop());

async function open(browser, contextOptions = {}) {
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    ...contextOptions,
  });
  const page = await context.newPage();
  const results = collect(page);
  await openHost(page, stack.app({ url: siteURL }));
  await results.wait('ready');
  const run = async (key, source) => {
    results.delete(key);
    await evalPage(page, source);
    return results.wait(key, 30000);
  };
  return { page, results, run };
}

// A host without camera (Chromium and Firefox of the tests have no devices without the fake ones)
{
  const browser = await launch();
  const { page, run } = await open(browser);
  const host = await page.evaluate(async () =>
    (await navigator.mediaDevices.enumerateDevices()).map((d) => d.kind),
  );
  const list = await run('nonelist', "list('nonelist')");
  check(
    'no camera on the host: the page lists the same input kinds as the host',
    JSON.stringify(inputs(list).sort()) ===
      JSON.stringify(host.filter((kind) => kind !== 'audiooutput').sort()),
    `page ${list}, host ${host.join(',') || 'none'}`,
  );
  check(
    'no camera on the host: no videoinput',
    !host.includes('videoinput') && !inputs(list).includes('videoinput'),
    list,
  );
  const video = await run('nonevideo', "capture('nonevideo', { video: true })");
  check(
    'no camera: getUserMedia({video}) rejects with NotFoundError at once',
    video?.startsWith('NotFoundError:') && millis(video) < 1000,
    video,
  );
  if (!host.includes('audioinput')) {
    const audio = await run('noneaudio', "capture('noneaudio', { audio: true })");
    check(
      'no microphone: getUserMedia({audio}) rejects with NotFoundError',
      audio?.startsWith('NotFoundError:'),
      audio,
    );
  }
  check(
    'no camera: no permission prompt',
    (await page.evaluate(() => window.blHost.permissionRequests.length)) === 0,
  );
  await browser.close();
}

// A host with a camera and a microphone (the fake ones)
{
  const browser = await launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const { page, results, run } = await open(browser, {
    permissions: permissions(['camera', 'microphone']),
  });
  const before = await run('before', "list('before')");
  check(
    'before the permission: one camera and one microphone without id and name, like Safari',
    before.split(',').sort().join(',') === 'audioinput::,videoinput::',
    before,
  );

  await page.evaluate(() => {
    window.blHost.permissionAnswer = 'grant';
    const original = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = function (constraints) {
      navigator.mediaDevices.getUserMedia = original;
      return Promise.reject(new DOMException('Could not start video source', 'NotReadableError'));
    };
  });
  const failed = await run('failed', "capture('failed', { video: true })");
  check(
    'host camera fails to open: getUserMedia rejects with NotReadableError, no track',
    failed?.startsWith('NotReadableError:'),
    failed,
  );

  const live = await run('live', "capture('live', { video: true })");
  check('host camera opens: a live track', live?.startsWith('ok:live:'), live);
  const after = await run('after', "list('after')");
  check(
    'after the permission: the camera with id and name',
    after.split(',').some((entry) => /^videoinput:id:Camera/.test(entry)),
    after,
  );
  await evalPage(page, 'stop()');

  // The host loses its devices
  results.delete('devicechange');
  await page.evaluate(() => {
    navigator.mediaDevices.enumerateDevices = async () => [];
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  check(
    'devicechange of the host reaches the page',
    (await results.wait('devicechange', 10000)) === 'fired',
  );
  const gone = await run('gone', "list('gone')");
  check('devices gone: the page lists none', gone === 'none', gone);
  const missing = await run('missing', "capture('missing', { video: true })");
  check('devices gone: NotFoundError', missing?.startsWith('NotFoundError:'), missing);
  await browser.close();
}

if (BROWSER !== 'chromium') console.log(`(${BROWSER})`);
finish();
