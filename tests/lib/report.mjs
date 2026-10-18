// Check results of a test: check() prints one line per check, finish() the summary and the exit
// code. An engine crash (trap, abort) in a watched page always fails the test.
import { TIMEOUT } from './env.mjs';

let failed = 0;
const engineCrashes = [];

/** Prints `ok` or `FAIL` with the name; a failed check makes the test fail. */
export function check(name, ok, info = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok) failed++;
}

/** Ends the test: summary line, exit code 1 when a check failed or the engine crashed. */
export function finish() {
  if (engineCrashes.length) check('engine without crash', false, engineCrashes.join(' | '));
  console.log(failed ? `${failed} check(s) failed` : 'All checks ok');
  process.exit(failed ? 1 : 0);
}

/** Hard limit for the whole test, so a hanging browser never blocks a run. */
export function timeLimit(ms = TIMEOUT + 120000) {
  setTimeout(() => {
    console.log('FAIL time limit of the whole test');
    process.exit(1);
  }, ms).unref();
}

/**
 * Logs page errors; errors from the engine (Aborted(...) or a stack in engine.wasm) count as a
 * crash. Returns a function that stops watching (before an intended crash).
 */
export function watchErrors(page, prefix = '   page error:') {
  const onError = (error) => {
    console.log(prefix, error.message);
    if (/^Aborted\(/.test(error.message) || /engine\.wasm/.test(error.stack || ''))
      engineCrashes.push(`${error.message} (${(error.stack || '').split('\n')[1]?.trim() || ''})`);
  };
  page.on('pageerror', onError);
  return () => page.off('pageerror', onError);
}
