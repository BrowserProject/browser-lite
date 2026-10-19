// Native WPE WebKit (same release as the engine) through WPEWebDriver and cog headless on the same
// replayed sites: what an engine on the server would take. Times from the navigation start.
//   node wpe-run.mjs --out <jsonl> --runs n --sites a,b [--nojit] [--label x]
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const SITES = {
  example: 'https://example.com/',
  wiki: 'https://de.wikipedia.org/wiki/Schweiz',
  cnn: 'https://edition.cnn.com/',
  min20: 'https://www.20min.ch/',
  weather: 'https://weather.com/',
  youtube: 'https://www.youtube.com/',
  github: 'https://github.com/WebKit/WebKit',
};
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const out = arg('out');
const runs = Number(arg('runs', 3));
const sites = arg('sites', 'example').split(',');
const label = arg('label', '');
const nojit = process.argv.includes('--nojit');
const driver = spawn('WPEWebDriver', ['--port=4444'], {
  env: { ...process.env, ...(nojit ? { JSC_useJIT: 'false' } : {}) },
  stdio: 'ignore',
});
process.on('exit', () => driver.kill());
await new Promise((resolve) => setTimeout(resolve, 1000));
const webdriver = async (method, url, body) => {
  const res = await fetch(`http://127.0.0.1:4444${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const json = await res.json();
  if (json.value?.error) throw new Error(`${json.value.error}: ${json.value.message}`);
  return json.value;
};
const cpuSeconds = () =>
  Number(/usage_usec (\d+)/.exec(fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'))[1]) / 1e6;

for (const site of sites)
  for (let run = 0; run < runs; run++) {
    const { sessionId } = await webdriver('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          'wpe:browserOptions': {
            binary: '/usr/bin/cog',
            args: ['--automation', '--platform=headless'],
          },
        },
      },
    });
    await webdriver('POST', `/session/${sessionId}/timeouts`, { pageLoad: 300000, script: 30000 });
    const cpu0 = cpuSeconds();
    const t0 = Date.now();
    let status = 'ok';
    try {
      await webdriver('POST', `/session/${sessionId}/url`, { url: SITES[site] || site });
    } catch (e) {
      status = e.message.slice(0, 80);
    }
    const wall = Date.now() - t0;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const info = await webdriver('POST', `/session/${sessionId}/execute/sync`, {
      script: `const nav = performance.getEntriesByType('navigation')[0] || {};
        const fcp = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
        return { loaded: nav.loadEventEnd, dcl: nav.domContentLoadedEventEnd, fcp: fcp ? fcp.startTime : null, title: document.title };`,
      args: [],
    }).catch((e) => ({ error: e.message }));
    const cpu = cpuSeconds() - cpu0;
    await webdriver('DELETE', `/session/${sessionId}`).catch(() => {});
    const row = {
      kind: 'wpe',
      label,
      engine: nojit ? 'wpe-nojit' : 'wpe-jit',
      cpus: process.env.WPE_CPUS,
      site,
      run,
      status,
      t0,
      wall,
      cpu: +cpu.toFixed(2),
      firstPaint: info.fcp != null ? Math.round(info.fcp) : null,
      dcl: info.dcl ? Math.round(info.dcl) : null,
      loaded: info.loaded ? Math.round(info.loaded) : null,
      title: (info.title || '').slice(0, 60),
    };
    fs.appendFileSync(out, `${JSON.stringify(row)}\n`);
    console.log(
      `${row.engine} ${row.cpus} ${site} #${run}: ${status} fcp ${row.firstPaint} dcl ${row.dcl} load ${row.loaded} ms cpu ${row.cpu} s`,
    );
  }
process.exit(0);
