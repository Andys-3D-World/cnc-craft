#!/bin/sh
# Takes all screenshots in German and English. The vite preview must run on port 1433.
# Result: <out>/de/<scene>.png and <out>/en/<scene>.png at 3600 x 2250. A nearly invisible window shows up while it runs.
# Usage: tools/website/screens.sh <out-dir> [scene ...]
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$1"; shift
SCENES="${*:-design simulation laser plasma wiring max external engrave material tools beds}"
swiftc -O "$HERE/screens.swift" -o "$OUT/screens" 2>/dev/null
for L in de en; do
  mkdir -p "$OUT/$L"
  for S in $SCENES; do
    rm -f "$OUT/$L/$S.png"
    "$OUT/screens" "$HERE/screens.js" "$OUT/$L" "$L" http://localhost:1433/ "$S" & P=$!
    I=0; while [ ! -s "$OUT/$L/$S.png" ] && [ $I -lt 40 ]; do sleep 1; I=$((I+1)); done
    sleep 1; kill $P 2>/dev/null || true; wait $P 2>/dev/null || true
    [ -s "$OUT/$L/$S.png" ] && echo "$L $S ok" || echo "$L $S FAILED"
  done
done
