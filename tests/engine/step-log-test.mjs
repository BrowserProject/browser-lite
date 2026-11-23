// The debug log's steps of the engine thread ("RunLoop step took N ms") do not count a nested
// event loop twice. A script runs about 300 ms, then waits 1.5 s in an alert whose nested event
// loop does the work of the other views (a frame's script paused for the user runs one too). The
// script's step is about 300 ms with ", N ms in a nested event loop" for the wait; before, the line
// said about 1800 ms, and on 20min.ch's Back a paused ad frame's priority task of 41.7 s held the
// page's React task of 35.6 s, which had a line of its own.
//
//   node tests/engine/step-log-test.mjs [engine-dir]
import { enginePath as resolveEngine, runEngine } from './engine-node.mjs';

const enginePath = resolveEngine(process.argv[2]);
process.env.BL_DEBUG = '1';

const html = `<!DOCTYPE html><script>
setTimeout(() => {
  const end = Date.now() + 300;
  while (Date.now() < end);
  alert('wait');
  console.log('STEP-TEST answered');
}, 500);
</script>`;

const lines = [];
let answered = false;
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error('the alert was not answered within 60 s')),
    60000,
  );
  runEngine({
    enginePath,
    html,
    url: 'https://step-log.test/',
    width: 400,
    height: 300,
    onPrintErr: (text) => lines.push(text),
    onDialog: ({ engine, dialogId }) =>
      setTimeout(() => engine._bl_dialog_answer(dialogId, 0, 0), 1500),
    onConsole: (message) => {
      if (message === 'STEP-TEST answered') {
        answered = true;
        clearTimeout(timer);
        // The step's line comes when the timer's task returns to the event loop
        setTimeout(resolve, 500);
      }
    },
  }).catch(reject);
});
await done;

const steps = lines
  .map((line) =>
    /RunLoop step took (\d+) ms(?: \([a-z ]+\))?(?:, (\d+) ms in a nested event loop)?/.exec(line),
  )
  .filter(Boolean)
  .map((match) => ({ own: Number(match[1]), nested: Number(match[2] ?? 0) }));
const failed = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`);
  if (!ok) failed.push(name);
};
check('the alert was answered', answered, 'no answer');
const alertStep = steps.find((step) => step.nested >= 1300);
check('the nested event loop is counted apart', !!alertStep, `steps ${JSON.stringify(steps)}`);
check(
  "the script's step is its own time",
  alertStep && alertStep.own >= 250 && alertStep.own < 1000,
  `steps ${JSON.stringify(steps)}`,
);
check(
  'no step over 1 s',
  steps.every((step) => step.own < 1000),
  `steps ${JSON.stringify(steps)}`,
);
if (failed.length) {
  console.error(`FAIL step-log: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('OK step-log');
process.exit(0);
