// Runs the native WTF tests (wtf-tests.cpp, built next to the engine as wtf-tests.js and
// wtf-tests.wasm) in node. They check fixes of WTF in engine/patches that no page can
// reach deterministically, for example patch 0046 (RunLoop timer schedule).
//   node tests/engine/wtf-test.mjs [engine-dir]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const engineDir = path.resolve(
  process.argv[2] || path.join(import.meta.dirname, '..', '..', 'build', 'webcore', 'bin'),
);
const program = path.join(engineDir, 'wtf-tests.js');
if (!existsSync(program)) {
  console.log(`FAIL ${program} missing (tools/build-webcore.sh builds it with the engine)`);
  process.exit(1);
}

const run = spawnSync(process.execPath, [program], { encoding: 'utf8', timeout: 60000 });
// Emscripten prints the whole minified engine line on an abort: keep only the readable lines
const lines = `${run.stdout}${run.stderr}`.split('\n').filter((line) => line && line.length < 400);
for (const line of lines) console.log(`  ${line}`);
const ok = run.status === 0 && lines.includes('WTF tests ok');
console.log(ok ? 'All checks ok' : `FAIL exit ${run.status ?? run.signal}`);
process.exit(ok ? 0 : 1);
