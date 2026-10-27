#!/usr/bin/env sh
# Rebuilds src/fonts/*.woff2 from the @fontsource packages: only the glyphs
# and OpenType features this site uses. Needs fonttools + brotli:
#   pip install fonttools brotli
set -eu
cd "$(dirname "$0")/.."

# Basic Latin + Latin-1 + the punctuation and arrows the interface uses.
CORE='U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+2013-2014,U+2018-201A,U+201C-201E,U+2022,U+2026,U+2032-2033,U+2190-2193,U+2212'
# Accented Latin for place names (Nepāl, Ōsumi…); only fetched when a page uses it.
EXT='U+0100-024F,U+1E00-1EFF'

subset() { # source, unicodes, features, output
  pyftsubset "node_modules/@fontsource/$1" --unicodes="$2" --layout-features="$3" \
    --no-hinting --desubroutinize --flavor=woff2 --output-file="src/fonts/$4"
}

S=instrument-serif/files/instrument-serif
M=jetbrains-mono/files/jetbrains-mono
subset "$S-latin-400-italic.woff2"     "$CORE" kern serif-italic.woff2
subset "$S-latin-ext-400-italic.woff2" "$EXT"  kern serif-italic-ext.woff2
subset "$M-latin-400-normal.woff2"     "$CORE" ''   mono.woff2
subset "$M-latin-ext-400-normal.woff2" "$EXT"  ''   mono-ext.woff2
ls -l src/fonts
