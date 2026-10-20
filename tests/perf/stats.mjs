// Evaluation of perf runs (JSON lines of run.mjs, start.mjs, frames.mjs and wpe-run.mjs).
//   node stats.mjs <file.jsonl>... [--plan <plan.json>] [--metric cpu,rx,firstLayout]
//                  [--secondary loaded] [--base A] [--rule lever|correction|probe]
//                  [--where visit=warm] [--group label,visit,start] [--foreign 0.3] [--psi 5]
//                  [--markdown]
// Invalid: status not ok, the metric missing, mean foreign load on the device cores above
// --foreign cores or memory pressure above --psi % while the run was measured (t0 and wall of the
// row, foreign.log next to each file). Comparison per group (default: per section and visit):
// ratio of the medians arm/base per site with a bootstrap interval (95 %), and G, the geometric
// mean of these ratios over the sites, with a bootstrap interval that resamples the runs of every
// site and arm. G < 1 always means the arm is better: for metrics where more is better (fps)
// the ratio is base/arm. Primary metrics (low noise first) get a verdict and a suggested n per
// arm, secondary ones are only shown.
//
// The comparisons come from "compare" of the plan, a list of {base, arms, rule, where, metrics,
// secondary} (metrics and secondary also on the plan level), or from --base and --rule (all other
// configurations are arms). Rule R (rule lever): on the weak profile C at least one primary
// metric with G <= 0.95 and the upper bound below 1, and on every profile no primary metric with
// the upper bound above 1.03. Rule correction: only the latter. Both: veto at G of anonMB (memMB
// without it) above 1.10, and for crashes in a section (all visits): the arm crashes where the
// base never does, or more often with p < 0.05 (one sided Fisher test). Rule probe (same engine
// twice): 1.00 inside the intervals of the primary metrics; of k intervals about 5 % miss by
// chance, so the probe allows as many misses as Binomial(k, 0.05) stays below in 95 % of probes.
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
const list = (text) => (text ? text.split(',').filter(Boolean) : null);
const planFile = option('plan', null);
const plan = planFile ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : {};
const metricOption = list(option('metric', null));
const secondaryOption = list(option('secondary', null));
const baseOption = option('base', null);
const ruleOption = option('rule', null);
const whereOption = option('where', null);
const maxForeign = Number(option('foreign', 0.3));
const maxPsi = Number(option('psi', 5));
const groupKeys = option('group', 'label,visit,start').split(',');
const markdown = flag('markdown');

const PRIMARY = ['cpu', 'rx', 'firstLayout'];
const SECONDARY = ['loaded'];
// Metrics where more is better: their ratio is base/arm, so G < 1 means better for every metric
const MORE_IS_BETTER = new Set(['fps']);
const WEAK = 'C';
const MEMORY_VETO = 1.1;
// Half width of the interval of G that the suggested n aims at, and the most runs per arm
const TARGET = Math.log(1.03);
const MAX_RUNS = 30;

// Foreign load and memory pressure per directory (each job has its own foreign.log and clock)
const samples = new Map();
for (const dir of new Set(args.map((f) => path.dirname(f)))) {
  const list = [];
  for (const name of fs.readdirSync(dir).filter((n) => /^foreign.*\.log$/.test(n)))
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      const [t, load, , psi] = line.split(' ').map(Number);
      if (t) list.push([t, load, Number.isFinite(psi) ? psi : 0]);
    }
  samples.set(dir, list);
}
const rows = args.flatMap((file) =>
  fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ site: '-', ...JSON.parse(line), dir: path.dirname(file) })),
);
const disturbed = (row) => {
  const s = row.t0
    ? samples.get(row.dir).filter(([t]) => t >= row.t0 && t <= row.t0 + row.wall + 1000)
    : [];
  const foreign = s.length ? s.reduce((a, [, v]) => a + v, 0) / s.length : 0;
  const psi = s.length ? Math.max(...s.map(([, , p]) => p)) : 0;
  return foreign > maxForeign || psi > maxPsi;
};
for (const row of rows) row.clean = row.status === 'ok' && !disturbed(row);
for (const dir of new Set(rows.filter((r) => r.t0 && !samples.get(r.dir).length).map((r) => r.dir)))
  console.error(`stats: no foreign.log in ${dir}, its runs are not checked for foreign load`);
const armOf = (row) => row.config ?? row.engine ?? '-';
const groupOf = (row) =>
  groupKeys
    .map((k) => row[k])
    .filter((v) => v != null && v !== '')
    .join(' ');

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
// Deterministic random numbers for the bootstrap (same input, same output)
let seed = 12345;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (xs) => xs.map(() => xs[Math.floor(random() * xs.length)]);
/**
 * Geometric mean of the ratios median(arm)/median(base) over the sites, with a 95 % bootstrap
 * interval: every round resamples base and arm of every site on its own. One site gives the
 * interval of its ratio.
 */
function geometric(sites, rounds = 2000) {
  const g = (ratios) => Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length);
  const values = [];
  for (let i = 0; i < rounds; i++)
    values.push(g(sites.map(([base, arm]) => median(pick(arm)) / median(pick(base)))));
  values.sort((a, b) => a - b);
  return {
    g: g(sites.map(([base, arm]) => median(arm) / median(base))),
    lo: quantile(values, 0.025),
    hi: quantile(values, 0.975),
  };
}
/** Runs per arm so that the half width of the interval of G is about 3 % (it shrinks with 1/sqrt n). */
function suggestedRuns({ lo, hi }, n) {
  const half = (Math.log(hi) - Math.log(lo)) / 2;
  return Math.max(2, Math.ceil(n * (half / TARGET) ** 2));
}

// Comparisons: from the plan, from --base/--rule, or none (tables only)
const where = (text) =>
  Object.fromEntries(
    (text ?? '')
      .split(',')
      .filter(Boolean)
      .map((kv) => kv.split('=')),
  );
const comparisons = (
  baseOption
    ? [{ base: baseOption, rule: ruleOption, where: where(whereOption) }]
    : (plan.compare ?? [{ base: null, where: where(whereOption) }])
).map((c) => ({
  ...c,
  metrics: metricOption ?? c.metrics ?? plan.metrics ?? PRIMARY,
  secondary: secondaryOption ?? c.secondary ?? plan.secondary ?? SECONDARY,
}));

const lines = [];
const print = (text) => lines.push(text);
const fmt = (x) => x.toFixed(3);
const interval = (r) => `${fmt(r.g)} [${fmt(r.lo)}, ${fmt(r.hi)}]`;
const memoryMetric = rows.some((r) => r.anonMB != null) ? 'anonMB' : 'memMB';
let suggested = 0;

const ratioName = (metric, arm, base) =>
  MORE_IS_BETTER.has(metric) ? `${base}/${arm}` : `${arm}/${base}`;

/** Table of one metric for one comparison; returns the G of every group and arm. */
function table(comparison, metric, primary) {
  const { base } = comparison;
  const selected = rows.filter((row) =>
    Object.entries(comparison.where ?? {}).every(([k, v]) => String(row[k]) === String(v)),
  );
  const valid = selected.filter((row) => row.clean && row[metric] != null);
  const results = [];
  if (!valid.length) return results;
  const invalid = selected.length - valid.length;
  const kind = primary ? 'primary' : 'secondary';
  print(
    markdown
      ? `\n**${metric}** (${kind}): ${valid.length} valid runs, ${invalid} invalid\n`
      : `\nmetric ${metric} (${kind}): ${valid.length} valid runs, ${invalid} invalid`,
  );
  const groups = new Map();
  for (const row of valid) {
    const key = groupOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const [key, group] of groups) {
    const configs = [...new Set(group.map(armOf))];
    const arms = base ? (comparison.arms ?? configs.filter((c) => c !== base)) : [];
    const sites = [...new Set(group.map((r) => r.site))];
    if (markdown) {
      print(`\n${key}\n`);
      print(
        `| site | ${configs.map((c) => `${c} (median, n)`).join(' | ')}${arms.map((c) => ` | ${ratioName(metric, c, base)} [95 %]`).join('')} |`,
      );
      print(`|---|${configs.map(() => '---').join('|')}${arms.map(() => '|---').join('')}|`);
    } else print(`## ${key}`);
    const values = (site, config) =>
      group.filter((r) => r.site === site && armOf(r) === config).map((r) => r[metric]);
    const pairs = Object.fromEntries(arms.map((c) => [c, []]));
    for (const site of sites) {
      const cells = configs.map((c) => {
        const v = values(site, c);
        if (!v.length) return '-';
        const m = median(v);
        // Small values (CPU per frame, CPU per second) keep three significant digits
        const shown = m !== 0 && Math.abs(m) < 10 ? m.toPrecision(3) : m.toFixed(0);
        return `${metric === 'cpu' ? m.toFixed(2) : shown} (${v.length})`;
      });
      const ratios = arms.map((c) => {
        const pair = MORE_IS_BETTER.has(metric)
          ? [values(site, c), values(site, base)]
          : [values(site, base), values(site, c)];
        if (pair.some((v) => v.length < 2 || v.some((x) => x <= 0))) return '-';
        pairs[c].push(pair);
        return interval(geometric([pair]));
      });
      print(
        markdown
          ? `| ${site} | ${cells.join(' | ')}${ratios.map((r) => ` | ${r}`).join('')} |`
          : `  ${String(site).padEnd(8)} ${configs.map((c, i) => `${c}: ${cells[i]}`).join('  ')}  ${ratios.join('  ')}`,
      );
    }
    for (const arm of arms) {
      if (!pairs[arm].length) continue;
      const result = geometric(pairs[arm]);
      const n = Math.min(...pairs[arm].flatMap(([b, a]) => [b.length, a.length]));
      const need = suggestedRuns(result, n);
      if (primary) suggested = Math.max(suggested, need);
      results.push({ group: key, profile: group[0].profile, arm, ...result });
      print(
        `${markdown ? '\n' : '  '}G(${ratioName(metric, arm, base)}) = ${interval(result)} over ${pairs[arm].length} sites, n ${n} per arm${primary ? `, suggested n ${Math.min(need, MAX_RUNS)}${need > MAX_RUNS ? ` (would need ${need})` : ''}` : ''}`,
      );
    }
  }
  return results;
}

/** Rule R for one result of a primary metric: null when it passes, else the reason. */
function check(rule, r) {
  if (rule === 'probe') return r.lo <= 1 && r.hi >= 1 ? null : '1.00 outside the interval';
  return r.hi <= 1.03 ? null : 'upper bound above 1.03';
}
const wins = (r) => r.g <= 0.95 && r.hi < 1;

const logChoose = (n, k) => {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
  return s;
};
/** One sided Fisher test: probability that a or more of the a + b crashes fall into the arm. */
function fisher(a, n1, b, n2) {
  let p = 0;
  for (let x = a; x <= Math.min(a + b, n1); x++)
    p += Math.exp(logChoose(n1, x) + logChoose(n2, a + b - x) - logChoose(n1 + n2, a + b));
  return p;
}
/** Misses of 1.00 that k intervals of 95 % stay at or below in 95 % of probes: Binomial(k, 0.05). */
function allowedMisses(k) {
  let sum = 0;
  for (let m = 0; m < k; m++) {
    sum += Math.exp(logChoose(k, m) + m * Math.log(0.05) + (k - m) * Math.log(0.95));
    if (sum >= 0.95) return m;
  }
  return k;
}
/** Crash vetoes of an arm against the base, per section over all its runs and visits. */
function crashVetoes(arm, base) {
  const reasons = [];
  for (const label of new Set(rows.map((r) => r.label))) {
    const count = (config) => {
      const runs = rows.filter((r) => r.label === label && armOf(r) === config);
      return [runs.filter((r) => r.status === 'crashed').length, runs.length];
    };
    const [a, n1] = count(arm);
    const [b, n2] = count(base);
    if (!a || !n2) continue;
    const p = fisher(a, n1, b, n2);
    if (b === 0 || p < 0.05)
      reasons.push(`${label}: ${a} of ${n1} runs crashed, ${base} ${b} of ${n2} (p ${fmt(p)})`);
  }
  return reasons;
}

const verdicts = [];
for (const comparison of comparisons) {
  if (comparison.base)
    print(
      `\n${markdown ? '### ' : '# '}Arms ${comparison.arms?.join(', ') ?? 'all'} against ${comparison.base}${comparison.rule ? `, rule ${comparison.rule}` : ''}${Object.keys(comparison.where ?? {}).length ? ` (${JSON.stringify(comparison.where)})` : ''}`,
    );
  const failures = new Map();
  const fail = (arm, reason) => {
    if (!failures.has(arm)) failures.set(arm, []);
    if (reason && !failures.get(arm).includes(reason)) failures.get(arm).push(reason);
  };
  // Weak groups per arm and whether a primary metric wins there clearly
  const weak = new Map();
  // Probe: intervals per arm and the ones that miss 1.00
  const checks = new Map();
  const misses = new Map();
  for (const metric of comparison.metrics)
    for (const r of table(comparison, metric, true)) {
      fail(r.arm);
      checks.set(r.arm, (checks.get(r.arm) ?? 0) + 1);
      const reason = comparison.rule && check(comparison.rule, r);
      const text = reason && `${metric} ${r.group}: ${reason}, G ${interval(r)}`;
      if (reason && comparison.rule === 'probe')
        misses.set(r.arm, [...(misses.get(r.arm) ?? []), text]);
      else if (reason) fail(r.arm, text);
      if (r.profile === WEAK) {
        const key = `${r.arm}\n${r.group}`;
        weak.set(key, weak.get(key) || wins(r));
      }
    }
  for (const metric of comparison.secondary) table(comparison, metric, false);
  const memory = table(comparison, memoryMetric, false);
  if (!comparison.rule) continue;
  for (const arm of comparison.arms ?? [])
    if (!checks.has(arm)) fail(arm, 'no valid runs of a primary metric to compare');
  if (comparison.rule === 'probe')
    for (const [arm, missed] of misses) {
      const allowed = allowedMisses(checks.get(arm));
      const summary = `${missed.length} of ${checks.get(arm)} intervals miss 1.00, ${allowed} allowed by chance`;
      if (missed.length <= allowed) {
        print(`\n${arm}: ${summary}: ${missed.join('; ')}`);
        continue;
      }
      fail(arm, summary);
      for (const text of missed) fail(arm, text);
    }
  else
    for (const arm of failures.keys()) {
      for (const reason of crashVetoes(arm, comparison.base)) fail(arm, `crash veto ${reason}`);
      for (const r of memory)
        if (r.arm === arm && r.g > MEMORY_VETO)
          fail(arm, `memory veto ${memoryMetric} ${r.group}: G ${fmt(r.g)}`);
    }
  if (comparison.rule === 'lever') {
    for (const [key, won] of weak) {
      const [arm, group] = key.split('\n');
      if (!won) fail(arm, `${group}: no primary metric with G <= 0.95 and upper bound below 1`);
    }
    for (const arm of failures.keys())
      if (![...weak.keys()].some((key) => key.startsWith(`${arm}\n`)))
        fail(arm, `no runs on the weak profile ${WEAK}`);
  }
  for (const [arm, reasons] of failures)
    verdicts.push(
      `${arm} against ${comparison.base}, rule ${comparison.rule}: ${reasons.length ? `FAIL\n${reasons.map((r) => `  - ${r}`).join('\n')}` : 'PASS'}`,
    );
}
if (verdicts.length) {
  print(markdown ? '\n### Verdict\n' : '\n# Verdict');
  print(markdown ? `\`\`\`\n${verdicts.join('\n')}\n\`\`\`` : verdicts.join('\n'));
}
if (suggested)
  print(
    `\nSuggested runs per arm for a half width of 3 % of G on every primary metric: ${Math.min(suggested, MAX_RUNS)}${suggested > MAX_RUNS ? ` (would need ${suggested}, capped)` : ''}`,
  );
console.log(lines.join('\n'));
