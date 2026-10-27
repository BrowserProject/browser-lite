"""Cuts a large font into smaller fonts by characters, for the fonts the engine loads on demand
(deps/recipes/lazyfonts.sh). Each slice keeps the names of the font (family, copyright, license)
and every layout feature reachable from its characters; fontconfig finds a slice by the
characters it covers, so a page loads only the slices of the characters it shows.

  slice-fonts.py cjk <font> <slices.txt> <out-dir>      slices of Google Fonts (nam-files),
                                                         most frequent characters first
  slice-fonts.py emoji <font> <emoji-test.txt> <out-dir> one slice per Unicode emoji group
  slice-fonts.py blocks <font> <out-dir>                 blocks of 256 code points, neighbours
                                                         merged up to 200 characters (symbols)

Output: <out-dir>/<font name>.<NNN>.<ext>, slices without any character of the font are left out.
Needs fonttools (PYTHONPATH).
"""

import os
import re
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

# Emoji components: every emoji slice has them, so sequences (ZWJ, skin tones, hair, keycaps,
# tag flags) stay within the slice of their first character
EMOJI_COMPONENTS = set(
    [0x200D, 0xFE0F, 0x20E3]
    + list(range(0x1F3FB, 0x1F400))
    + list(range(0x1F9B0, 0x1F9B4))
    + list(range(0xE0020, 0xE0080))
)


def cjk_slices(path):
    """Text proto of nam-files: 'subsets { codepoints: N ... }', listed lowest priority first."""
    # Comments name the characters, also braces ("codepoints: 125 # } RIGHT CURLY BRACKET")
    text = re.sub(r"#[^\n]*", "", open(path, encoding="utf-8").read())
    blocks = re.findall(r"subsets\s*\{(.*?)\}", text, re.S)
    slices = [set(int(cp) for cp in re.findall(r"codepoints:\s*(\d+)", block)) for block in blocks]
    slices.reverse()
    return slices


def emoji_slices(path):
    """emoji-test.txt of Unicode: the code points of every group except the components."""
    groups = []
    for line in open(path, encoding="utf-8"):
        match = re.match(r"# group: (.*)", line)
        if match:
            groups.append((match.group(1), set()))
            continue
        match = re.match(r"([0-9A-F ]+?)\s*;\s*(fully-qualified|minimally-qualified|unqualified)", line)
        if match and groups:
            groups[-1][1].update(int(cp, 16) for cp in match.group(1).split())
    return [codepoints | EMOJI_COMPONENTS for name, codepoints in groups if name != "Component"]


def block_slices(cmap):
    slices = []
    for block in sorted(set(cp >> 8 for cp in cmap)):
        codepoints = set(cp for cp in cmap if cp >> 8 == block)
        if slices and len(slices[-1]) + len(codepoints) <= 200:
            slices[-1] |= codepoints
        else:
            slices.append(codepoints)
    return slices


def main():
    kind, font_path = sys.argv[1:3]
    out = sys.argv[-1]
    cmap = set(TTFont(font_path).getBestCmap())
    if kind == "cjk":
        slices = cjk_slices(sys.argv[3])
    elif kind == "emoji":
        slices = emoji_slices(sys.argv[3])
    else:
        slices = block_slices(cmap)
    os.makedirs(out, exist_ok=True)
    stem, ext = os.path.splitext(os.path.basename(font_path))
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.hinting = False
    # Plain charstrings compress better (the server sends Brotli)
    options.desubroutinize = True
    written = 0
    for index, codepoints in enumerate(slices):
        unicodes = sorted(codepoints & cmap)
        # A slice of only components or of characters another slice has is useless
        if not set(unicodes) - EMOJI_COMPONENTS:
            continue
        font = TTFont(font_path)
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=unicodes)
        subsetter.subset(font)
        font.save(os.path.join(out, f"{stem}.{index:03d}{ext}"))
        written += 1
    print(f"{os.path.basename(font_path)}: {written} slices")


if __name__ == "__main__":
    main()
