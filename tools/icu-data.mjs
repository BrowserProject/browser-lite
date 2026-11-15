// Splits the ICU data archive (icudt<N>l.dat of the sysroot) for the engine build:
//  - the items matching engine/icu-core.txt stay in a smaller archive that is linked into
//    engine.wasm (icudata.c defines icudt<N>_dat with #embed);
//  - every other item becomes a file <files>/icudt<N>l/<tree>/<item>, which the engine mounts at
//    /icu and loads on first use (engine/src/LazyFiles.cpp). icudata.c also lists them with their
//    sizes (bl_icu_files).
//
//   node tools/icu-data.mjs <icudt.dat> <core-list> <out-dir> <files-dir> [<item>=<file>...]
//
// <item>=<file> replaces the data of an item (relative to the package, "brkitr/word.brk") with
// break rules compiled by tools/icu-word-rules.cpp; the item keeps its data header.
//
// Archive format (ICU common/ucmndata.h): a data header (headerSize, magic 0xda27, UDataInfo with
// the format "CmnD"), then the table of contents: count, entries of (name offset, data offset)
// relative to the table, the names ("icudt78l/coll/zh.res", sorted), the items 16-byte aligned.
// An item ends where the next begins (ICU computes lengths the same way).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [input, coreList, outDir, filesDir, ...replacements] = process.argv.slice(2);
if (!filesDir) {
  console.error(
    'Usage: icu-data.mjs <icudt.dat> <core-list> <out-dir> <files-dir> [<item>=<file>...]',
  );
  process.exit(2);
}

function readArchive(bytes) {
  const headerSize = bytes.readUInt16LE(0);
  if (bytes[2] !== 0xda || bytes[3] !== 0x27 || bytes.toString('latin1', 12, 16) !== 'CmnD')
    throw new Error(`${input} is no ICU common data archive`);
  if (bytes[8] !== 0) throw new Error('big endian archives are not supported');
  const toc = bytes.subarray(headerSize);
  const count = toc.readUInt32LE(0);
  const items = [];
  for (let i = 0; i < count; i++) {
    const nameOffset = toc.readUInt32LE(4 + i * 8);
    const nameEnd = toc.indexOf(0, nameOffset);
    const start = toc.readUInt32LE(8 + i * 8);
    const end = i + 1 < count ? toc.readUInt32LE(16 + i * 8) : toc.length;
    items.push({
      name: toc.toString('latin1', nameOffset, nameEnd),
      data: toc.subarray(start, end),
    });
  }
  return { header: bytes.subarray(0, headerSize), items };
}

const align16 = (n) => (n + 15) & ~15;

function writeArchive(header, items) {
  const names = items.map((item) => Buffer.from(`${item.name}\0`, 'latin1'));
  const namesStart = 4 + items.length * 8;
  let offset = align16(namesStart + names.reduce((sum, name) => sum + name.length, 0));
  const toc = Buffer.alloc(offset);
  toc.writeUInt32LE(items.length, 0);
  const parts = [header, toc];
  let nameOffset = namesStart;
  items.forEach((item, i) => {
    toc.writeUInt32LE(nameOffset, 4 + i * 8);
    names[i].copy(toc, nameOffset);
    nameOffset += names[i].length;
    toc.writeUInt32LE(offset, 8 + i * 8);
    const padded = align16(item.data.length);
    parts.push(item.data, Buffer.alloc(padded - item.data.length));
    offset += padded;
  });
  return Buffer.concat(parts);
}

// Patterns relative to the package ("brkitr/*.brk"), * within one path segment
const patterns = readFileSync(coreList, 'utf8')
  .split('\n')
  .map((line) => line.replace(/#.*/, '').trim())
  .filter(Boolean)
  .map(
    (line) => new RegExp(`^${line.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`),
  );

const { header, items } = readArchive(readFileSync(input));
const pkg = items[0].name.split('/')[0];

/**
 * The data of a break rules item (data header, then the rules of ICU's format, ICU common/rbbidata.h)
 * with other rules of the same format version.
 */
function replaceRules(data, rules) {
  const headerSize = data.readUInt16LE(0);
  const format = (bytes) => bytes.subarray(0, 8).toString('hex');
  if (rules.readUInt32LE(0) !== 0xb1a0 || format(rules) !== format(data.subarray(headerSize)))
    throw new Error('the replacement rules do not have the format of the item');
  return Buffer.concat([data.subarray(0, headerSize), rules]);
}
for (const replacement of replacements) {
  const [name, file] = replacement.split('=');
  const item = items.find((item) => item.name === `${pkg}/${name}`);
  if (!item || !file) throw new Error(`cannot replace ${replacement}`);
  item.data = replaceRules(item.data, readFileSync(file));
}
const core = [];
const lazy = [];
for (const item of items) {
  const relative = item.name.slice(pkg.length + 1);
  (patterns.some((pattern) => pattern.test(relative)) ? core : lazy).push(item);
}

mkdirSync(outDir, { recursive: true });
const coreArchive = writeArchive(header, core);
writeFileSync(path.join(outDir, `${pkg}.dat`), coreArchive);
rmSync(filesDir, { recursive: true, force: true });
for (const item of lazy) {
  const file = path.join(filesDir, item.name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, item.data);
}
const entry = `${pkg.replace(/l$/, '')}_dat`;
// The data of a locale (<locale>.res and the same name under curr, lang, region, unit, zone) is a
// group: the first read fetches the rest at once, and the engine fetches the groups of the
// user's languages at the start (LazyFiles.cpp)
const groupOf = (name) =>
  /^[^/]+\/(?:(?:curr|lang|region|unit|zone)\/)?([a-z]{2,3}(?:_[A-Za-z0-9]+)*)\.res$/.exec(
    name,
  )?.[1];
const index = lazy
  .map((item) => {
    const locale = groupOf(item.name);
    return `${item.name} ${item.data.length}${locale ? ` icu:${locale}` : ''}\\n`;
  })
  .join('');
writeFileSync(
  path.join(outDir, 'icudata.c'),
  `// Generated by tools/icu-data.mjs from ${path.basename(input)} and ${path.basename(coreList)}
// The ICU data linked into the engine (ICU looks up the symbol ${entry}). ${pkg}.dat has the
// SHA-256 ${createHash('sha256').update(coreArchive).digest('hex')}: compiler caches do not
// look into #embed, so this line changes the source when only the data changed.
__attribute__((aligned(16))) const unsigned char ${entry}[] = {
#embed "${pkg}.dat"
};
// The other items, files of the engine folder under icu/ with their sizes
const char bl_icu_files[] = "${index}";
`,
);
const mb = (list) => (list.reduce((sum, item) => sum + item.data.length, 0) / 1048576).toFixed(1);
console.log(
  `ICU data: ${core.length} items linked (${mb(core)} MB), ${lazy.length} files (${mb(lazy)} MB)`,
);
