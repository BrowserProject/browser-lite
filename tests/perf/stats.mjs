// Evaluation of perf runs (JSON lines of run.mjs and wpe-run.mjs).
//   node stats.mjs <file.jsonl>... [--metric firstLayout] [--base A] [--foreign 0.3] [--psi 5]
//                  [--group profile,net,visit] [--markdown]
// Invalid: status not ok, the metric missing, mean foreign load on the device cores above
// --foreign cores or memory pressure above --psi % (foreign.log next to the files). Comparison:
// ratio of the medians B/A per site with a bootstrap interval (95 %), geometric mean over sites.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const metric = option('metric', 'firstLayout');
const base = option('base', null);
const maxForeign = Number(option('foreign', 0.3));
const maxPsi = Number(option('psi', 5));
const groupKeys = option('group', 'profile,net,visit').split(',');
const markdown = flag('markdown');

const samples = [];
for (const dir of new Set(args.map((f) => path.dirname(f))))
  for (const name of fs.readdirSync(dir).filter((n) => /^foreign.*\.log$/.test(n)))
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      const [t, load, , psi] = line.split(' ').map(Number);
      if (t) samples.push([t, load, Number.isFinite(psi) ? psi : 0]);
    }
const during = (row) => samples.filter(([t]) => t >= row.t0 && t <= row.t0 + row.wall + 1000);

const rows = args.flatMap((f) =>
  fs
    .readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l)),
);
let invalid = 0;
const valid = rows.filter((row) => {
  const s = row.t0 ? during(row) : [];
  const foreign = s.length ? s.reduce((a, [, v]) => a + v, 0) / s.length : 0;
  const psi = s.length ? Math.max(...s.map(([, , p]) => p)) : 0;
  const ok = row.status === 'ok' && row[metric] != null && foreign <= maxForeign && psi <= maxPsi;
  if (!ok) invalid++;
  return ok;
});

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];
// Deterministic random numbers for the bootstrap (same input, same output)
let seed = 12345;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
function bootstrap(a, b, n = 2000) {
  const ratios = [];
  for (let i = 0; i < n; i++) {
    const pick = (xs) => xs.map(() => xs[Math.floor(random() * xs.length)]);
    ratios.push(median(pick(b)) / median(pick(a)));
  }
  return [quantile(ratios, 0.025), quantile(ratios, 0.975)];
}

const lines = [];
const print = (text) => lines.push(text);
const groups = new Map();
for (const row of valid) {
  const key = groupKeys.map((k) => row[k]).join(' ');
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
print(
  markdown
    ? `**${metric}**: ${valid.length} valid runs, ${invalid} invalid\n`
    : `metric ${metric}: ${valid.length} valid runs, ${invalid} invalid`,
);
for (const [key, list] of groups) {
  const configs = [...new Set(list.map((r) => r.config ?? r.engine))];
  const sites = [...new Set(list.map((r) => r.site))];
  if (markdown) {
    print(`\n${key}\n`);
    print(
      `| site | ${configs.map((c) => `${c} (median, n)`).join(' | ')}${
        base
          ? ` | ${configs
              .filter((c) => c !== base)
              .map((c) => `${c}/${base} [95 %]`)
              .join(' | ')}`
          : ''
      } |`,
    );
    print(
      `|---|${configs.map(() => '---').join('|')}${
        base
          ? `|${configs
              .filter((c) => c !== base)
              .map(() => '---')
              .join('|')}`
          : ''
      }|`,
    );
  } else print(`## ${key}`);
  const logRatios = {};
  for (const site of sites) {
    const values = Object.fromEntries(
      configs.map((c) => [
        c,
        list.filter((r) => r.site === site && (r.config ?? r.engine) === c).map((r) => r[metric]),
      ]),
    );
    const cells = configs.map((c) =>
      values[c].length ? `${median(values[c]).toFixed(0)} (${values[c].length})` : '-',
    );
    const ratios = [];
    if (base && values[base]?.length > 1)
      for (const c of configs.filter((c) => c !== base)) {
        if (values[c].length < 2) {
          ratios.push('-');
          continue;
        }
        const ratio = median(values[c]) / median(values[base]);
        const [lo, hi] = bootstrap(values[base], values[c]);
        (logRatios[c] ||= []).push(Math.log(ratio));
        ratios.push(`${ratio.toFixed(3)} [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
      }
    print(
      markdown
        ? `| ${site} | ${cells.join(' | ')}${ratios.length ? ` | ${ratios.join(' | ')}` : ''} |`
        : `  ${site.padEnd(8)} ${configs.map((c, i) => `${c}: ${cells[i]}`).join('  ')}  ${ratios.join('  ')}`,
    );
  }
  for (const [c, logs] of Object.entries(logRatios))
    print(
      `${markdown ? '\n' : '  '}G(${c}/${base}) = ${Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length).toFixed(3)} over ${logs.length} sites`,
    );
}
console.log(lines.join('\n'));
