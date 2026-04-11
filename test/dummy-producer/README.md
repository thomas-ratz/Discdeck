# Dummy Producer

A test harness that simulates a complete Decky session against the Discdeck PC app.
Also serves as the reference implementation for Part 2 (the Decky plugin).

## Subcommands

| Command | What it does |
|---|---|
| `npm run dummy:full` | Full lifecycle: hello → game_start → stream_starting → ffmpeg test pattern push → game_change → stream_stopped → game_stop → disconnect |
| `npm run dummy:events` | Event WS only, no video — fast loop for testing title and tray updates |
| `npm run dummy:video` | RTSP push only, no events — test the video pipeline in isolation |
| `npm run dummy:flap` | Connect/disconnect every 3s for 60s — validates reconnect handling |
| `npm run dummy:crash` | Connects, sends hello, then terminates the socket — tests cleanup |
| `npm run dummy:bad-handshake` | Sends garbage as hello — tests the error path |

## Environment

`DISCDECK_HOST` (default: `127.0.0.1`) — host running the Discdeck PC app. Use this if testing against the app on another machine on the LAN.

## ffmpeg producer flags

When pushing RTSP to Discdeck's listener, the producer MUST include:
- `-x264opts repeat-headers=1` — puts SPS/PPS into the SDP sprop-parameter-sets so the listener can determine codec params at probe time
- `-rtsp_transport tcp` — forces TCP RTP delivery, eliminating UDP packet loss on loopback and LAN

Without these flags, the listener exits immediately with `Could not find codec parameters for stream 0 (Video: h264, none): unspecified size`. Part 2's Decky plugin needs the same flags.

## Manual ffmpeg push

For debugging without Node, the equivalent video-only push is in `push-testpattern.sh`. Run a system ffmpeg pointed at `rtsp://<host>:8554/deck`.
