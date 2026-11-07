#!/bin/zsh
# Regenerates build/icon.icns from build/icon.svg: Electron rasterizes, sips resizes, iconutil packs.
set -euo pipefail
cd "$(dirname "$0")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
base="$work/icon.png"
env -u ELECTRON_RUN_AS_NODE ../node_modules/.bin/electron render-icon.cjs "$base" >/dev/null 2>&1
set="$work/icon.iconset"
mkdir "$set"
for size in 16 32 128 256 512; do
  sips -z $size $size "$base" --out "$set/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$base" --out "$set/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set" -o icon.icns
