#!/usr/bin/env bash
# Standalone ffmpeg push for manual debugging without Node.
# Usage: ./push-testpattern.sh [host]
HOST="${1:-127.0.0.1}"
exec ffmpeg \
  -re \
  -f lavfi -i testsrc2=size=1280x800:rate=30 \
  -c:v libx264 -tune zerolatency -preset ultrafast \
  -g 30 -pix_fmt yuv420p \
  -x264opts repeat-headers=1 \
  -rtsp_transport tcp \
  -f rtsp "rtsp://${HOST}:8554/deck"
