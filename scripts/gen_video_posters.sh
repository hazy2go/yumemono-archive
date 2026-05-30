#!/usr/bin/env bash
# Pre-render first-frame JPEG posters for every Drive-hosted video into /vp/.
# Drive's own thumbnail endpoint (thumbnail?id=…) 404s for all video files, so
# the site serves these static images instead (CDN-cached → instant tiles).
#
# Run from the deploy repo root after a data refresh. Only missing posters are
# generated, so it's cheap to re-run. Pulls frames through the live /v/ proxy.
#
#   bash scripts/gen_video_posters.sh
#
# Requires: ffmpeg, python3, and data/drive-map.json populated.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p vp
BASE="${POSTER_PROXY:-https://yumemono.xyz}"

python3 -c "import json;dm=json.load(open('data/drive-map.json'));[print(v) for k,v in dm.items() if k.lower().endswith('.mp4')]" \
| xargs -P 12 -I{} bash -c '
  id="$1"; out="vp/${id}.jpg"
  if [ -s "$out" ]; then exit 0; fi
  for ts in 0.1 1.0 0.0; do
    ffmpeg -nostdin -loglevel error -ss $ts -i "'"$BASE"'/v/${id}?v=5" -frames:v 1 \
      -vf "scale=min(640\,iw):-2" -q:v 4 "$out" -y 2>/dev/null
    [ -s "$out" ] && [ "$(stat -f%z "$out" 2>/dev/null || stat -c%s "$out")" -gt 1500 ] && break
  done
  if [ -s "$out" ]; then echo "ok $id"; else rm -f "$out"; echo "FAIL $id"; fi
' _ {}

echo "posters in vp/: $(ls vp/*.jpg 2>/dev/null | wc -l)"
