// site-test.mjs survives the death of its host browser: the browser process is killed while the
// first site runs, the run goes on with a new browser, the next site loads and every site gets a
// result line. Local data: pages, no internet needed.
//
//   node tests/compat/host-crash-test.mjs [engine-dir]
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { check, engineDir, finish, root, timeLimit, waitFor } from '../lib/index.mjs';

timeLimit();

const first = 'data:text/html,<title>first</title>first page';
const second = 'data:text/html,<title>second</title>second page';
const run = spawn(
  process.execPath,
  [path.join(root, 'tests', 'compat', 'site-test.mjs'), engineDir, first, second],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
run.stdout.on('data', (data) => {
  output += data;
});
run.stderr.on('data', (data) => {
  output += data;
});
const exited = new Promise((resolve) => run.once('exit', resolve));

// The host browser is a direct child of site-test.mjs (the servers of the stack are node)
const hostBrowser = () =>
  spawnSync('ps', ['-o', 'pid=,args=', '--ppid', String(run.pid)], { encoding: 'utf8' })
    .stdout.split('\n')
    .map((line) => line.trim().match(/^(\d+) (.*)$/))
    .find((match) => match && /chrom|firefox|webkit/i.test(match[2]))?.[1];

let pid;
await waitFor(() => (pid = hostBrowser()), 120000, 200);
check('host browser started', !!pid);
if (pid) {
  // While the first site starts the engine
  await new Promise((resolve) => setTimeout(resolve, 3000));
  process.kill(Number(pid), 'SIGKILL');
}
await exited;

const lines = output.split('\n');
const resultLine = (site) =>
  lines.find((line) => /^(ok {2}|FAIL) /.test(line) && line.includes(site));
check('result line for the site of the crash', !!resultLine(first), resultLine(first) ?? '');
check(
  'the next site loads in a new host browser',
  /^ok {2}/.test(resultLine(second) ?? '') && resultLine(second).includes('title: "second"'),
  resultLine(second) ?? '',
);
check('run ends without an uncaught error', !/triggerUncaughtException|^\s+at /m.test(output));
if (!resultLine(second)) console.log(output.split('\n').slice(-30).join('\n'));
finish();
