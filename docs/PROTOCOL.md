# Discdeck Event Protocol v1

The contract between the Discdeck PC companion app and any Decky-side client (the future Decky Loader plugin, or the dummy producer).

## Transport

- **URL:** `ws://<pc-ip>:8765/events` (port configurable; default 8765)
- **Encoding:** UTF-8 JSON, one message per WebSocket text frame.
- **Connection model:** single active client. A second client closes the first with code `4000` (replaced).
- **Auth (v1):** none. LAN-only. The envelope leaves room for a shared secret in `hello` for v2.
- **Heartbeat:** both sides send `heartbeat` every 5 seconds. Either side closes the connection after 15 seconds of silence.

## Envelope

```json
{
  "v": 1,
  "type": "game_start",
  "id": "f3b1c2…",
  "ts": "2026-04-06T14:23:11.482Z",
  "data": { }
}
```

| Field | Type | Notes |
|---|---|---|
| `v` | int | Protocol version. Currently `1`. |
| `type` | string | One of the message types below. |
| `id` | string | UUIDv4. Reserved for future ack/correlation. |
| `ts` | ISO-8601 string | Sender's clock. Receivers must not trust for ordering. |
| `data` | object | Type-specific payload. May be `{}`. |

## Message types

| Type | Direction | `data` shape |
|---|---|---|
| `hello` | Client → Server | `{ "client": "...", "client_version": "0.1.0", "deck_name": "...", "capabilities": ["video", "events"] }` |
| `welcome` | Server → Client | `{ "server": "discdeck-pc", "server_version": "0.1.0", "accepted_capabilities": ["video", "events"] }` |
| `game_start` | Client → Server | `{ "game_name": "...", "app_id": "..." \| null, "launched_at": "..." }` |
| `game_change` | Client → Server | Same as `game_start` |
| `game_stop` | Client → Server | `{ "game_name": "...", "closed_at": "..." }` |
| `stream_starting` | Client → Server | `{ "rtsp_url": "rtsp://<pc>:8554/deck", "video_codec": "h264", "width": 1280, "height": 800, "fps": 60 }` |
| `stream_stopped` | Client → Server | `{ "reason": "user_toggled_off" \| "game_closed" \| "error" }` |
| `heartbeat` | both | `{}` |
| `error` | either | `{ "code": "...", "message": "..." }` |

## Discovery

The PC publishes an mDNS service `_discdeck._tcp.local` advertising the event WS port and the RTSP listener port. The TXT record contains:

```
event_port=8765
rtsp_port=8554
protocol_version=1
```

Clients should discover the PC via this service rather than hard-coding an IP.

## Video transport (separate channel)

Video does NOT flow over this WebSocket. It is a separate RTSP push:

- **URL (Client pushes to):** `rtsp://<pc>:<rtsp_port>/deck`
- **Codec:** H.264 in an RTP/RTSP envelope. Default: `avc1.42E01E` (Constrained Baseline). The PC re-muxes with `-c:v copy` — no transcode, no extra latency.
- **Resolution / fps:** Whatever the Deck source emits. The `stream_starting` message carries this metadata for the PC's UI.
- **Required producer flags:** `-x264opts repeat-headers=1` (puts SPS/PPS into SDP sprop-parameter-sets so the listener can probe codec params) and `-rtsp_transport tcp` (forces TCP RTP delivery to avoid UDP packet loss on probe).

The client should send `stream_starting` *before* opening the RTSP push, and `stream_stopped` *after* closing it.
