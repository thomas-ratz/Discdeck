#!/usr/bin/env bash
# Download a static ffmpeg build with VAAPI support from BtbN/FFmpeg-Builds,
# verify it runs, and place it at bin/ffmpeg.
#
# This script is idempotent: if bin/ffmpeg already exists and reports a version,
# it does nothing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HERE}/../bin/ffmpeg"

if [[ -x "${DEST}" ]] && "${DEST}" -version >/dev/null 2>&1; then
  echo "bin/ffmpeg already present and runnable."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# Use the "master-latest" linux64-gpl build — includes libx264 and VAAPI.
URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
echo "Downloading ${URL} ..."
curl -fsSL "${URL}" -o "${TMP}/ffmpeg.tar.xz"

echo "Extracting..."
tar -xJf "${TMP}/ffmpeg.tar.xz" -C "${TMP}"

FOUND="$(find "${TMP}" -name ffmpeg -type f -perm -u+x | head -n1)"
if [[ -z "${FOUND}" ]]; then
  echo "Could not locate ffmpeg in extracted archive" >&2
  exit 1
fi

mkdir -p "$(dirname "${DEST}")"
cp "${FOUND}" "${DEST}"
chmod +x "${DEST}"

echo "Verifying VAAPI support..."
if ! "${DEST}" -hide_banner -encoders 2>/dev/null | grep -q h264_vaapi; then
  echo "ffmpeg binary does not include h264_vaapi encoder" >&2
  exit 1
fi

"${DEST}" -version | head -n1
echo "bin/ffmpeg ready."
