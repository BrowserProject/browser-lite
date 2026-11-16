/**
 * How a browser shows an address: an internationalized host (`xn--` labels, as URLs and the
 * engine carry it) in Unicode when it passes spoofing checks like Chrome's, else as it is.
 * Unicode lets people read Japanese or German hosts; the checks keep `xn--` for hosts that could
 * pass for another one (apple.com with a Cyrillic a, or written only with Cyrillic letters that
 * look like Latin ones).
 * Rules, per label (docs/security.md#internationalized-addresses):
 * - letters, marks and digits of the recommended scripts of UAX #31, plus `-`, without
 *   characters that look like others or like punctuation (IPA, small capitals, modifier letters,
 *   historic Cyrillic and Latin, sharp s and final sigma, default ignorables);
 * - one script, Latin with the scripts of Chinese, Japanese or Korean counting as one (UTS #39
 *   "highly restrictive"), digits of one numbering system, no repeated combining mark and the
 *   combining diacriticals only after a Latin, Greek or Cyrillic letter;
 * - Japanese characters that look like a slash or a dash only next to Japanese;
 * - a Cyrillic, Greek or Armenian label made only of letters that look like Latin ones only under
 *   a top level domain of that script or of a country that writes it.
 * One unsafe label keeps the whole host in `xn--`.
 * The rest of an address shows its escaped UTF-8 characters decoded, see `displayURL`.
 */

/** UAX #31 Table 5, the recommended scripts; Common and Inherited are counted apart. */
const SCRIPTS = [
  'Arabic',
  'Armenian',
  'Bengali',
  'Bopomofo',
  'Cyrillic',
  'Devanagari',
  'Ethiopic',
  'Georgian',
  'Greek',
  'Gujarati',
  'Gurmukhi',
  'Han',
  'Hangul',
  'Hebrew',
  'Hiragana',
  'Kannada',
  'Katakana',
  'Khmer',
  'Lao',
  'Latin',
  'Malayalam',
  'Myanmar',
  'Oriya',
  'Sinhala',
  'Tamil',
  'Telugu',
  'Thaana',
  'Thai',
  'Tibetan',
].map((name) => ({ name, test: new RegExp(`\\p{Script_Extensions=${name}}`, 'u') }));

const COMMON = /[\p{Script_Extensions=Common}\p{Script_Extensions=Inherited}]/u;
const ALLOWED_KIND = /[-\p{L}\p{M}\p{Nd}]/u;
const DIGIT = /\p{Nd}/u;
const NONSPACING_MARK = /\p{Mn}/u;
const LATIN_GREEK_CYRILLIC =
  /[\p{Script_Extensions=Latin}\p{Script_Extensions=Greek}\p{Script_Extensions=Cyrillic}]/u;
const JAPANESE =
  /[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Han}]/u;
const KANA = /[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u;

/** Characters that look like other ones or like punctuation, also inside allowed blocks. */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const LOOKALIKE: [number, number][] = [
  [0x00df, 0x00df], // sharp s, a deviation character like final sigma
  [0x03c2, 0x03c2],
  [0x0138, 0x0138],
  [0x01c0, 0x01c3], // clicks
  [0x0237, 0x0237],
  [0x0250, 0x02ff], // IPA extensions, spacing modifier letters
  [0x0335, 0x0338], // overlays
  [0x0460, 0x0481], // historic Cyrillic
  [0x05b4, 0x05b4],
  [0x05b9, 0x05ba],
  [0x05bc, 0x05bc],
  [0x05c1, 0x05c4],
  [0x0650, 0x0650],
  [0x1c80, 0x1c8f], // Cyrillic extended C
  [0x1d00, 0x1dbf], // phonetic extensions, small capitals
  [0x1e9c, 0x1e9d],
  [0x1efe, 0x1eff],
  [0x2c60, 0x2c7f], // Latin extended C
  [0x2de0, 0x2dff], // Cyrillic extended A
  [0xa640, 0xa69f], // Cyrillic extended B
  [0xa720, 0xa7ff], // Latin extended D
  [0xab30, 0xab6f], // Latin extended E
];

/** Japanese characters that look like a slash: only next to Japanese (Chrome). */
const SLASH_LIKE = new Set([0x30ce, 0x30bd, 0x30be, 0x30f3, 0x4e36, 0x4e3f, 0x4e40, 0x4e41]);
const PROLONGED_SOUND_MARK = 0x30fc;

/**
 * Letters of a script that look like Latin letters, and the top level domains under which a
 * label made only of them is still shown (those of the script count too).
 */
const LATIN_ALIKE = [
  {
    script: /\p{Script=Cyrillic}/u,
    letters: new Set('асԁеһіјӏорԛѕԝхуьъҽпг'),
    tlds: new Set([
      'ba',
      'bg',
      'by',
      'kg',
      'kz',
      'me',
      'mk',
      'mn',
      'rs',
      'ru',
      'su',
      'tj',
      'ua',
      'uz',
    ]),
  },
  {
    script: /\p{Script=Greek}/u,
    letters: new Set('αεηικνορτυχω'),
    tlds: new Set(['cy', 'gr']),
  },
  {
    script: /\p{Script=Armenian}/u,
    letters: new Set('ագզհյնոսցօք'),
    tlds: new Set(['am']),
  },
];

const cache = new Map<string, string>();

/**
 * The host to show for host (a `URL.host` or `hostname`, with or without port): its `xn--`
 * labels in Unicode when every label passes the spoofing checks, else host unchanged.
 */
export function displayHost(host: string): string {
  if (!host.includes('xn--')) return host;
  const port = /^(.*?)(:\d+)?$/.exec(host);
  const name = port?.[1] ?? host;
  let shown = cache.get(name);
  if (shown === undefined) {
    shown = unicodeHost(name) ?? name;
    if (cache.size > 500) cache.clear();
    cache.set(name, shown);
  }
  return shown + (port?.[2] ?? '');
}

/** An escape of a byte outside ASCII, a run of escapes. */
const NON_ASCII_ESCAPE = /%[89a-f][0-9a-f]/i;
const ESCAPE_RUN = /(?:%[0-9a-f]{2})+/gi;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Characters an address shows escaped: invisible, unassigned, or spoofing the lock icon. */
const KEPT_ESCAPED =
  /[\p{White_Space}\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}\u2800\u{1f50f}\u{1f510}\u{1f512}\u{1f513}]/u;

/**
 * The address to show for url, like Chrome: its host like `displayHost`, and in the rest (path,
 * query, fragment) the percent escapes of UTF-8 characters as those characters
 * (`Z%C3%BCrich` with the u umlaut it encodes). Escapes of ASCII, of bytes that are not UTF-8 and of
 * characters that cannot be seen or could fool the reader (spaces, controls, bidi and other
 * invisible characters, lock symbols) stay, so the text loads the same address again.
 * `view-source:` and `blob:` show their inner address that way too.
 */
export function displayURL(url: string): string {
  if (!url.includes('xn--') && !NON_ASCII_ESCAPE.test(url)) return url;
  const inner = /^(view-source:|blob:)(.*)$/is.exec(url);
  if (inner) return (inner[1] ?? '') + displayURL(inner[2] ?? '');
  const authority = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/i.exec(url);
  if (!authority) return url;
  const [whole, scheme = '', hostPart = ''] = authority;
  const at = hostPart.lastIndexOf('@') + 1;
  const rest = url.slice(whole.length).replace(ESCAPE_RUN, unescapeRun);
  return `${scheme}${hostPart.slice(0, at)}${displayHost(hostPart.slice(at))}${rest}`;
}

/** A run of escapes with its well-formed UTF-8 characters decoded, unless they stay escaped. */
function unescapeRun(run: string): string {
  const bytes = Uint8Array.from({ length: run.length / 3 }, (_, index) =>
    Number.parseInt(run.slice(index * 3 + 1, index * 3 + 3), 16),
  );
  let shown = '';
  for (let index = 0; index < bytes.length; ) {
    const lead = bytes[index] ?? 0;
    const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    const char = length > 1 ? decodeUTF8(bytes.subarray(index, index + length), length) : '';
    if (char && !KEPT_ESCAPED.test(char)) {
      shown += char;
      index += length;
    } else {
      shown += run.slice(index * 3, index * 3 + 3);
      index++;
    }
  }
  return shown;
}

/** The one character that bytes encode in UTF-8, '' when they are not that. */
function decodeUTF8(bytes: Uint8Array, length: number): string {
  if (bytes.length !== length) return '';
  try {
    return UTF8.decode(bytes);
  } catch {
    return '';
  }
}

/** The Unicode form of an ASCII hostname, null when it is not valid or not safe to show. */
function unicodeHost(host: string): string | null {
  const labels: string[] = [];
  for (const label of host.split('.')) {
    if (!label.startsWith('xn--')) {
      labels.push(label);
      continue;
    }
    const decoded = decodePunycode(label.slice(4));
    if (decoded === null) return null;
    labels.push(decoded);
  }
  const unicode = labels.join('.');
  // Only a host that encodes back to itself: valid IDNA, already mapped and normalized
  try {
    if (new URL(`http://${unicode}/`).hostname !== host) return null;
  } catch {
    return null;
  }
  const tld = labels.findLast((label) => label !== '') ?? '';
  return labels.every((label) => isSafeLabel(label, tld)) ? unicode : null;
}

function looksLikeAnother(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return IGNORABLE.test(char) || LOOKALIKE.some(([from, to]) => code >= from && code <= to);
}

function isSafeLabel(label: string, tld: string): boolean {
  const points = [...label];
  if (points.every((char) => char.charCodeAt(0) < 0x80)) return true;
  for (const char of points) if (!ALLOWED_KIND.test(char) || looksLikeAnother(char)) return false;
  return (
    isOneScript(points) &&
    hasOneNumberingSystem(points) &&
    hasSafeMarks(points) &&
    hasSafeJapanese(points) &&
    !looksLatin(points, tld)
  );
}

/** UTS #39 highly restrictive: one script, Latin may join the scripts of CJK. */
function isOneScript(points: string[]): boolean {
  const sets: Set<string>[] = [];
  for (const char of points) {
    const scripts = new Set(SCRIPTS.filter(({ test }) => test.test(char)).map(({ name }) => name));
    if (scripts.size === 0) {
      if (COMMON.test(char)) continue;
      return false;
    }
    if (scripts.has('Han')) for (const added of ['Jpan', 'Kore', 'Hanb']) scripts.add(added);
    if (scripts.has('Hiragana') || scripts.has('Katakana')) scripts.add('Jpan');
    if (scripts.has('Hangul')) scripts.add('Kore');
    if (scripts.has('Bopomofo')) scripts.add('Hanb');
    sets.push(scripts);
  }
  if (common(sets).size > 0) return true;
  const withoutLatin = sets.filter((set) => !set.has('Latin'));
  const rest = common(withoutLatin);
  return ['Jpan', 'Kore', 'Hanb'].some((script) => rest.has(script));
}

function common(sets: Set<string>[]): Set<string> {
  const [first, ...others] = sets;
  return new Set([...(first ?? [])].filter((name) => others.every((set) => set.has(name))));
}

/** The digits come from one numbering system: one zero digit for all of them. */
function hasOneNumberingSystem(points: string[]): boolean {
  let zero: number | null = null;
  for (const char of points) {
    if (!DIGIT.test(char)) continue;
    const code = char.codePointAt(0) ?? 0;
    let start = code;
    while (start > 0 && DIGIT.test(String.fromCodePoint(start - 1))) start--;
    const digitZero = start + Math.floor((code - start) / 10) * 10;
    if (zero !== null && zero !== digitZero) return false;
    zero = digitZero;
  }
  return true;
}

/** No combining mark twice in a row, the diacriticals of U+0300 only after Latin, Greek, Cyrillic. */
function hasSafeMarks(points: string[]): boolean {
  return points.every((char, index) => {
    const before = points[index - 1] ?? '';
    if (NONSPACING_MARK.test(char) && char === before) return false;
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x0300 || code > 0x036f) return true;
    return LATIN_GREEK_CYRILLIC.test(before) && !NONSPACING_MARK.test(before);
  });
}

/** Katakana that looks like a slash next to Japanese only, the prolonged sound mark after kana. */
function hasSafeJapanese(points: string[]): boolean {
  return points.every((char, index) => {
    const code = char.codePointAt(0);
    const before = points[index - 1] ?? '';
    const after = points[index + 1] ?? '';
    if (code === PROLONGED_SOUND_MARK) return KANA.test(before);
    if (code !== undefined && SLASH_LIKE.has(code))
      return JAPANESE.test(before) || JAPANESE.test(after);
    return true;
  });
}

/** A Cyrillic, Greek or Armenian label of Latin lookalikes outside its own top level domains. */
function looksLatin(points: string[], tld: string): boolean {
  const letters = points.filter((char) => /\p{L}/u.test(char));
  return LATIN_ALIKE.some(
    ({ script, letters: alike, tlds }) =>
      letters.length > 0 &&
      letters.every((char) => script.test(char) && alike.has(char)) &&
      !tlds.has(tld) &&
      ![...tld].some((char) => script.test(char)),
  );
}

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;

/** RFC 3492 decoding of a label without its `xn--`; null when it is not valid Punycode. */
function decodePunycode(input: string): string | null {
  const output: number[] = [];
  const delimiter = input.lastIndexOf('-');
  for (let index = 0; index < delimiter; index++) {
    const code = input.charCodeAt(index);
    if (code >= 0x80) return null;
    output.push(code);
  }
  let n = 0x80;
  let bias = 72;
  let i = 0;
  for (let index = delimiter > 0 ? delimiter + 1 : 0; index < input.length; ) {
    const before = i;
    for (let weight = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const digit = punycodeDigit(input.charCodeAt(index++));
      if (digit >= BASE) return null;
      i += digit * weight;
      const threshold = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < threshold) break;
      weight *= BASE - threshold;
      if (i > 0x7fffffff || weight > 0x7fffffff) return null;
    }
    const length = output.length + 1;
    bias = adapt(i - before, length, before === 0);
    n += Math.floor(i / length);
    i %= length;
    if (n > 0x10ffff) return null;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

function punycodeDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 22;
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61;
  return BASE;
}

function adapt(delta: number, points: number, first: boolean): number {
  let scaled = first ? Math.floor(delta / 700) : delta >> 1;
  scaled += Math.floor(scaled / points);
  let k = 0;
  while (scaled > ((BASE - T_MIN) * T_MAX) >> 1) {
    scaled = Math.floor(scaled / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * scaled) / (scaled + 38));
}
