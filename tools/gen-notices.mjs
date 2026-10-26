// Writes THIRD_PARTY_NOTICES.txt of the engine to stdout: browser-lite, WebKit with the list of
// our patches, code adapted from other projects, every dependency of deps/sources.txt (licenses
// in tools/licenses.txt) and the Emscripten system libraries.
//
// License texts come from the pinned sources themselves: the archives in third_party/downloads
// (downloaded and checked against deps/sources.txt when missing), the pinned commits of git
// sources and of WebKit (fetched without checkout, a few MB) and the emsdk of the toolchain
// image. Runs inside the toolchain image (tar with xz, unzip, git, $EMSDK).
//
//   node tools/gen-notices.mjs > THIRD_PARTY_NOTICES.txt
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pins, root, version } from './pins.mjs';

const read = (file) => readFileSync(path.join(root, file), 'utf8');
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });

const repository = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY ?? 'BrowserProject/browser-lite'}`;
const commit = process.env.GITHUB_SHA ?? gitHead();
const emscripten = process.env.EMSDK && path.join(process.env.EMSDK, 'upstream/emscripten');
if (!emscripten || !existsSync(emscripten))
  fail('$EMSDK not set or without upstream/emscripten (run inside the toolchain image)');
const downloads =
  process.env.BL_DOWNLOADS ??
  path.join(process.env.BL_THIRD_PARTY ?? path.join(root, 'third_party'), 'downloads');

function fail(message) {
  console.error(`gen-notices: ${message}`);
  process.exit(1);
}

function gitHead() {
  try {
    return run('git', ['-c', 'safe.directory=*', '-C', root, 'rev-parse', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

const temps = [];
process.on('exit', () => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// A pinned git commit fetched without blobs and trees; git show loads only what it reads.
function gitSource(url, ref, expected) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bl-notices-'));
  temps.push(dir);
  const git = (...args) => run('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  for (let attempt = 1; ; attempt++) {
    try {
      git('fetch', '-q', '--depth', '1', '--filter=tree:0', url, ref);
      break;
    } catch (error) {
      if (attempt === 4) fail(`git fetch ${url} ${ref} failed: ${error.stderr ?? error}`);
    }
  }
  const actual = git('rev-parse', 'FETCH_HEAD').trim();
  if (actual !== expected) fail(`${url}: commit ${actual} instead of ${expected}`);
  return (file) => git('show', `${expected}:${file}`);
}

async function download(url, file, sha256) {
  const sha = (data) => createHash('sha256').update(data).digest('hex');
  if (existsSync(file) && sha(readFileSync(file)) === sha256) return;
  console.error(`gen-notices: downloading ${url}`);
  let data;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data = Buffer.from(await response.arrayBuffer());
      break;
    } catch (error) {
      if (attempt === 4) fail(`${url}: ${error.message ?? error}`);
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
    }
  }
  if (sha(data) !== sha256) fail(`${url}: SHA256 mismatch`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function archiveReader(type, file) {
  if (type === 'zip') return (entry) => run('unzip', ['-p', file, entry]);
  if (type === 'file') return () => readFileSync(file, 'utf8');
  const entries = run('tar', ['-tf', file]).split('\n');
  return (entry) => {
    const member = entries.find((e) => e.replace(/^[^/]*\//, '') === entry);
    if (!member) fail(`${path.basename(file)}: ${entry} not found`);
    return run('tar', ['-xOf', file, member]);
  };
}

// "<path>[:<from>-<to>]" read with reader, or an absolute path of the toolchain image
function licenseText(spec, reader) {
  const match = /^(.*?)(?::(\d+)-(\d+))?$/.exec(spec);
  const [, file, from, to] = match;
  let text = file.startsWith('/') ? readFileSync(file, 'utf8') : reader(file);
  if (from)
    text = text
      .split('\n')
      .slice(Number(from) - 1, Number(to))
      .join('\n');
  return text;
}

function parseTable(file) {
  return read(file)
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => line.trim().split(/\s+/));
}

// Output helpers: identical license texts are printed once
const out = [];
const printed = new Map();
const rule = '-'.repeat(80);
function heading(title) {
  out.push('', '='.repeat(80), title, '='.repeat(80), '');
}
function entry(title, fields, texts) {
  out.push(rule, title);
  for (const [key, value] of Object.entries(fields)) if (value) out.push(`${key}: ${value}`);
  for (const text of texts) {
    const key = text.replace(/\s+/g, ' ').trim();
    if (!key) fail(`empty license text for ${title}`);
    out.push('');
    if (printed.has(key)) out.push(`(Same license text as printed for ${printed.get(key)} above.)`);
    else {
      printed.set(key, title);
      out.push(text.trim());
    }
  }
  out.push('');
}

// browser-lite itself
const ownLicense = read('LICENSE');
const bsd2Body = ownLicense.slice(
  ownLicense.indexOf('Redistribution and use'),
  ownLicense.indexOf('SUCH DAMAGE.') + 'SUCH DAMAGE.'.length,
);
out.push(
  `browser-lite engine ${version}: third party notices`,
  '',
  'Files:    engine.js, engine.wasm, engine.data, lazy/',
  `Version:  ${version}`,
  `Source:   ${repository}${commit ? ` (commit ${commit})` : ''}`,
  `Built of: WebKit ${pins.WEBKIT_TAG} (${pins.WEBKIT_COMMIT}), Emscripten ${pins.EMSDK_VERSION}`,
  '',
  'The engine is WebKit compiled to WebAssembly, linked with the libraries listed below. The',
  'complete corresponding source code is the source repository above at this version: it pins',
  'WebKit and every library (versions.env, deps/sources.txt), contains all changes to WebKit',
  '(engine/patches) and the scripts to build the engine (docs/build.md).',
);

heading('1. browser-lite');
entry('browser-lite', { License: 'BSD-2-Clause' }, [ownLicense]);

heading('2. WebKit');
const patches = readdirSync(path.join(root, 'engine/patches'))
  .filter((name) => name.endsWith('.patch'))
  .sort();
const patchList = patches.map((name) => {
  const files = [...read(`engine/patches/${name}`).matchAll(/^diff --git a\/(\S+) b\//gm)].map(
    (m) => `       ${m[1]}`,
  );
  const subject = name
    .replace(/\.patch$/, '')
    .replace(/^(\d+)-/, '$1 ')
    .replaceAll('-', ' ');
  return [`  ${subject}`, ...files].join('\n');
});
const webkit = gitSource(pins.WEBKIT_REPO, pins.WEBKIT_COMMIT, pins.WEBKIT_COMMIT);
const webkitLicenses = [
  ['WebCore (LGPL 2.1)', 'LGPL-2.1-or-later', 'Source/WebCore/LICENSE-LGPL-2.1'],
  ['WebCore (LGPL 2)', 'LGPL-2.0-or-later', 'Source/WebCore/LICENSE-LGPL-2'],
  ['JavaScriptCore', 'LGPL-2.0-or-later', 'Source/JavaScriptCore/COPYING.LIB'],
  ['WebCore (Apple)', 'BSD-2-Clause', 'Source/WebCore/LICENSE-APPLE'],
  ['WebKitLegacy', 'BSD-2-Clause', 'Source/WebKitLegacy/LICENSE'],
  ['WTF: code from LLVM', 'Apache-2.0 WITH LLVM-exception', 'Source/WTF/LICENSE-LLVM.txt'],
  ['WTF: code from libc++', 'Apache-2.0 WITH LLVM-exception', 'Source/WTF/LICENSE-libc++.txt'],
  ['WTF: SIMDe', 'MIT', 'Source/WTF/LICENSE-simde.txt'],
  ['WTF: Dragonbox', 'Apache-2.0 WITH LLVM-exception', 'Source/WTF/LICENSE-dragonbox.txt'],
  ['WTF: double-conversion', 'BSD-3-Clause', 'Source/WTF/wtf/dtoa/LICENSE'],
  ['WTF: simdutf', 'Apache-2.0 OR MIT', 'Source/WTF/wtf/simdutf/LICENSE-simdutf.txt'],
  ['WTF: fast_float', 'Apache-2.0 OR MIT', 'Source/WTF/wtf/fast_float/LICENSE'],
  ['Skia', 'BSD-3-Clause', 'Source/ThirdParty/skia/LICENSE'],
  ['ANGLE (headers)', 'BSD-3-Clause', 'Source/ThirdParty/ANGLE/LICENSE'],
];
out.push(
  `WebKit ${pins.WEBKIT_TAG}, commit ${pins.WEBKIT_COMMIT}`,
  `Source: ${pins.WEBKIT_REPO.replace(/\.git$/, '')}/tree/${pins.WEBKIT_COMMIT}`,
  '',
  'WebKit is licensed under the GNU Lesser General Public License (LGPL) 2.1 or 2.0 and under',
  'BSD style licenses, each source file states its license. browser-lite changes WebKit with',
  'the following patches from engine/patches (applied in this order, the files they change',
  'below each patch). The changed files are licensed like the WebKit files they change.',
  '',
  ...patchList,
  '',
);
for (const [title, spdx, file] of webkitLicenses)
  entry(`WebKit: ${title}`, { License: spdx, File: file }, [webkit(file)]);

heading('3. Code adapted from other projects');
const engineFiles = readdirSync(path.join(root, 'engine/src'), { recursive: true })
  .map((file) => `engine/src/${file}`)
  .filter((file) => /\.(cpp|h|js)$/.test(file))
  .sort();
const theogbob = engineFiles.filter((f) => read(f).includes('theogbob/WebkitWasm'));
if (theogbob.length)
  entry(
    'WebkitWasm (github.com/theogbob/WebkitWasm)',
    { License: 'BSD-2-Clause', Files: theogbob.join(', ') },
    [`Copyright (c) 2026 theogbob\n\n${bsd2Body}`],
  );
const headers = new Map();
for (const file of engineFiles) {
  const block = /\/\*([\s\S]*?)\*\//.exec(read(file))?.[1];
  if (!block?.includes('Copyright')) continue;
  const text = block
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, ''))
    .join('\n')
    .trim();
  headers.set(text, [...(headers.get(text) ?? []), file]);
}
for (const [text, files] of headers) {
  const holders = [
    ...text.matchAll(/^Copyright \(C\) [\d, -]+ (.+?)\.? All rights reserved/gim),
  ].map((m) => m[1]);
  entry(
    `Code of ${[...new Set(holders)].join(', ') || 'other projects'}`,
    { Files: files.join(', ') },
    [text],
  );
}

heading('4. Libraries');
const sources = parseTable('deps/sources.txt').map(([name, type, ver, url, hash]) => ({
  name,
  type,
  version: ver,
  url,
  hash,
}));
const licenses = new Map(
  parseTable('tools/licenses.txt').map((t) => [
    t[0],
    { spdx: t.slice(1, -1).join(' '), files: t.at(-1).split(',') },
  ]),
);
const missing = sources.filter((s) => !licenses.has(s.name)).map((s) => s.name);
const extra = [...licenses.keys()].filter((name) => !sources.some((s) => s.name === name));
if (missing.length || extra.length)
  fail(
    `tools/licenses.txt does not match deps/sources.txt (missing: ${missing}, unknown: ${extra})`,
  );
// Reader of the files of a source: its archive (downloaded and checked) or its pinned commit
const readers = new Map();
async function sourceReader(source) {
  if (!readers.has(source.name)) {
    if (source.type === 'git')
      readers.set(source.name, gitSource(source.url, `refs/tags/${source.version}`, source.hash));
    else {
      const file = path.join(downloads, path.basename(source.url));
      await download(source.url, file, source.hash);
      readers.set(source.name, archiveReader(source.type, file));
    }
  }
  return readers.get(source.name);
}
for (const source of sources) {
  const license = licenses.get(source.name);
  if (license.spdx === '-') continue;
  const texts = [];
  // "<spec>@<name>": the license file comes from another source (a font file has none inside)
  for (const spec of license.files) {
    const [file, other] = spec.split('@');
    const from = other ? sources.find((s) => s.name === other) : source;
    if (!from) fail(`tools/licenses.txt: ${source.name} refers to the unknown source ${other}`);
    texts.push(licenseText(file, await sourceReader(from)));
  }
  entry(
    `${source.name} ${source.version}`,
    {
      License: license.spdx,
      Source: source.url,
      [source.type === 'git' ? 'Commit' : 'SHA256']: source.hash,
    },
    texts,
  );
}

heading('5. Emscripten system libraries');
const emVersion = readFileSync(path.join(emscripten, 'emscripten-version.txt'), 'utf8')
  .trim()
  .replaceAll('"', '');
const emscriptenLicenses = [
  ['Emscripten (runtime JavaScript, system library glue)', 'MIT OR NCSA', 'LICENSE'],
  ['musl libc', 'MIT', 'system/lib/libc/musl/COPYRIGHT'],
  ['libc++', 'Apache-2.0 WITH LLVM-exception', 'system/lib/libcxx/LICENSE.TXT'],
  ['libc++abi', 'Apache-2.0 WITH LLVM-exception', 'system/lib/libcxxabi/LICENSE.TXT'],
  ['compiler-rt', 'Apache-2.0 WITH LLVM-exception', 'system/lib/compiler-rt/LICENSE.TXT'],
  ['LLVM libc', 'Apache-2.0 WITH LLVM-exception', 'system/lib/llvm-libc/LICENSE.TXT'],
];
for (const [title, spdx, file] of emscriptenLicenses)
  entry(`${title}, Emscripten ${emVersion}`, { License: spdx }, [
    readFileSync(path.join(emscripten, file), 'utf8'),
  ]);

process.stdout.write(`${out.join('\n').replace(/[ \t]+$/gm, '')}\n`);
