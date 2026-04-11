# Discdeck — Part 1 Design Spec (PC Companion App)

**Date:** 2026-04-06
**Status:** Approved for implementation planning
**Scope:** Part 1 only (Windows Electron tray app). Part 2 (Decky Loader plugin) is out of scope and will get its own spec.

---

## 1. Project context

Discdeck is a two-part LAN-only system that lets a Steam Deck stream gameplay to a vanilla Discord client running on the user's PC, by appearing as a selectable "Application Window" in Discord's screen-share picker.

- **Part 1 (this spec):** Windows Electron tray app that receives an RTSP video push and a JSON event stream from the Deck, renders the video in a titled BrowserWindow, and surfaces status via tray icon and OS notifications.
- **Part 2 (future spec):** Decky Loader plugin that captures the Deck screen via FFmpeg+pipewire, pushes RTSP to the PC, and reports game lifecycle events over a WebSocket.

### 1.1 The hard constraint that justifies the architecture

Discord exposes no public API for pushing remote video into a voice channel. The only way to get Deck pixels into Discord without modifying Discord itself is to materialize them as a normal OS window on the PC and let Discord's standard "Application Window" screen-share feature capture it locally. Part 1 is the materializer; Part 2 is the source.

### 1.2 Project values

- **Open source.** Codebase, protocol, and dependencies must all be open. Bundling closed binaries is rejected.
- **LAN-only.** No cloud relays, no third-party servers, no telemetry.
- **No Discord modifications.** Must work with vanilla Discord. Modded clients (Vencord, etc.) are a Part 3 enhancement, not a requirement.
- **Minimal dependencies, but bundle what's needed.** "Minimal" means few moving parts, not "small download." Bundling `ffmpeg-static` for install-time UX is preferred over requiring users to install FFmpeg themselves.
- **Survive across Decky/SteamOS updates** (Part 2 concern, noted here for completeness).

---

## 2. Architecture overview

```
                    ┌─────────────────── PC (Windows) ───────────────────┐
                    │                                                    │
   ┌──────────┐     │   ┌──────────────┐    ┌────────────────────────┐   │     ┌─────────┐
   │  Steam   │     │   │   FFmpeg     │    │      Electron App      │   │     │ Discord │
   │   Deck   │ ──► │   │  RTSP        │ ─► │  ┌──────────────────┐  │   │ ──► │ (Window │
   │ (Part 2) │ LAN │   │  listener    │    │  │ Main process     │  │   │     │ Capture)│
   └──────────┘     │   │  + transcode │    │  │  - tray icon     │  │   │     └─────────┘
                    │   │  → fMP4      │    │  │  - sidecars      │  │   │
   ┌──────────┐     │   │  over WS     │    │  │  - event router  │  │   │
   │  Test    │ ──► │   └──────────────┘    │  └──────────────────┘  │   │
   │  FFmpeg  │ LAN │                       │  ┌──────────────────┐  │   │
   │ (dummy)  │     │   ┌──────────────┐    │  │ Renderer         │  │   │
   └──────────┘     │   │ Event server │    │  │  - <video> + MSE │  │   │
                    │   │   (WS, JSON) │ ─► │  │  - idle splash   │  │   │
                    │   │ port 8765    │    │  │  - title="🎮…"   │  │   │
                    │   └──────────────┘    │  └──────────────────┘  │   │
                    │                       └────────────────────────┘   │
                    └────────────────────────────────────────────────────┘
```

### 2.1 Two LAN channels

The Deck-facing surface is two independent channels with different lifetimes and failure modes:

1. **Video channel** — RTSP push from Deck → bundled FFmpeg in listener mode (`-rtsp_flags listen`) on PC port 8554 → same FFmpeg transcodes to fragmented MP4 (no re-encode; `-c:v copy`) → streamed over a localhost-only WebSocket to the Electron renderer → played in `<video>` via Media Source Extensions.
2. **Event channel** — A WebSocket server in the Electron main process accepts a single LAN connection from the Deck on port 8765 and exchanges JSON events (one message per WebSocket text frame; see §4.1): handshake, game lifecycle, stream lifecycle, heartbeat. These drive window title, tray state, and renderer state.

The channels are decoupled because game state and stream state are orthogonal in real use (you can launch a game without streaming; you can keep streaming after a game closes; etc.).

### 2.2 Connection direction

**PC = server, Deck = client**, on every channel.

- The PC is always-on with a stable address; the Deck is mobile.
- Decky plugins are constrained — running listening sockets on SteamOS requires firewall fiddling that breaks across system updates. The Deck dialing out is the safe direction.
- This matches the original requirement: *"PC companion app listens on the local network for an RTSP or WebRTC stream coming from a Steam Deck."*

### 2.3 Discovery (mDNS)

The PC publishes a service record `_discdeck._tcp.local` advertising both ports. The Deck (Part 2) browses for the service. Both machines have multicast UDP sockets open for the discovery exchange, but the actual data-plane connections (RTSP, WS) are normal client-dials-server TCP.

Discovery is the *only* layer where "both listen for each other" applies; everything else is one-way client→server.

| Channel | Protocol | PC role | Deck role |
|---|---|---|---|
| Discovery | mDNS / multicast UDP | Advertises | Browses |
| Events | WebSocket | Server (port 8765) | Client (dials, sends JSON) |
| Video | RTSP | Server (port 8554, FFmpeg listener) | Client (FFmpeg pushes) |

---

## 3. Process model

```
┌─────────────────────── Electron App ───────────────────────┐
│                                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  MAIN PROCESS (Node.js)                             │   │
│  │  • App lifecycle (ready / quit / single-instance)   │   │
│  │  • Tray icon + menu + notifications                 │   │
│  │  • BrowserWindow + dynamic title                    │   │
│  │  • Stream state machine                             │   │
│  │  • Spawns + supervises ffmpeg sidecar               │   │
│  │  • Hosts: Event WS server  (LAN, :8765)             │   │
│  │  • Hosts: Video relay WS   (localhost only, random) │   │
│  │  • mDNS responder                                   │   │
│  └─────────────────────────────────────────────────────┘   │
│            │                              │                │
│            │ spawn + stdio                │ IPC            │
│            ▼                              ▼                │
│  ┌──────────────────────┐    ┌────────────────────────┐    │
│  │ FFmpeg sidecar       │    │ RENDERER (Chromium)    │    │
│  │ (ffmpeg-static)      │    │ • <video> + MSE        │    │
│  │ -rtsp_flags listen   │    │ • Idle splash UI       │    │
│  │   rtsp://0.0.0.0:8554│    │ • Connects to localhost│    │
│  │ -c:v copy            │    │   video relay WS       │    │
│  │ -movflags            │    │ • Receives state via   │    │
│  │   +frag_keyframe     │    │   IPC (idle/live/title)│    │
│  │ -f mp4 pipe:1        │    │                        │    │
│  │ stdout: fMP4 chunks  │    │ NO direct network I/O  │    │
│  │ stderr: log lines    │    │ NO direct file system  │    │
│  └──────────────────────┘    └────────────────────────┘    │
└────────────────────────────────────────────────────────────┘
```

### 3.1 Lifecycle ownership rule

Only the main process touches sidecars and LAN sockets. The renderer is a pure UI consumer driven by IPC state updates and a single localhost WebSocket for video chunks. This isolation:

- Keeps the renderer crash-safe from network/decoder hiccups.
- Keeps the Part 2 swap-in clean (Part 2 only changes what arrives at the LAN-facing endpoints, never the UI).
- Honors Electron's standard security posture (`contextIsolation: true`, `nodeIntegration: false`).

### 3.2 Sidecar supervision

FFmpeg in `-rtsp_flags listen` mode exits when the RTSP pusher disconnects. The main process treats that as a *normal* event:

1. Stream state transitions `live → idle`.
2. Renderer hides video element, shows idle splash.
3. FFmpeg is respawned to accept the next push.

**Crash-loop guard:** if FFmpeg exits abnormally 3+ times within 30 seconds, state moves to `error` and stays there until the user clicks "Reconnect" in the tray menu. Prevents fork-bombing on misconfiguration.

### 3.3 Data flow on stream arrival

1. Deck (or test producer) opens RTSP push to `rtsp://<pc>:8554/deck`.
2. Bundled FFmpeg accepts push, copies video stream (no re-encode), wraps in fragmented MP4, writes chunks to stdout.
3. Main process reads stdout chunks, forwards to localhost video-relay WebSocket.
4. Renderer's `<video>` element, attached to a `MediaSource`, appends the chunks via `SourceBuffer.appendBuffer()`.
5. In parallel: main process flips state `connecting → live`, hides idle splash, updates tray icon to "live", fires "Now streaming: \<game\>" notification.

---

## 4. Event protocol (Part 2 contract)

This protocol is the contract that Part 2 implements against. It is versioned and stable.

### 4.1 Transport

- **URL:** `ws://<pc-ip>:8765/events` (port configurable; defaults to 8765)
- **Encoding:** UTF-8 JSON, one message per WebSocket text frame.
- **Connection model:** single active Deck connection. Second connection causes the first to be closed with code `replaced`. Handles "Deck rebooted, PC didn't notice old socket is dead."
- **Auth (v1):** none. LAN-only personal use. Envelope leaves room for a shared secret in `hello` for v2.
- **Heartbeat:** both sides send `heartbeat` every 5s. Either side closes the connection after 15s of silence. Belt-and-suspenders against half-open TCP sockets.

### 4.2 Message envelope

Every message in either direction uses the same envelope:

```json
{
  "v": 1,
  "type": "game_start",
  "id": "f3b1c2…",
  "ts": "2026-04-06T14:23:11.482Z",
  "data": { ... }
}
```

| Field | Type | Notes |
|---|---|---|
| `v` | int | Protocol version. Currently `1`. Receivers reject mismatched versions during handshake. |
| `type` | string | Message type (table below). |
| `id` | string | UUIDv4 generated by sender. Reserved for future ack/correlation; v1 receivers must accept but may ignore. |
| `ts` | ISO-8601 string | Sender's clock. Receivers must NOT trust it for ordering; for logs only. |
| `data` | object | Type-specific payload. May be `{}`. |

### 4.3 Message types (v1)

| Type | Direction | `data` shape | Purpose |
|---|---|---|---|
| `hello` | Deck → PC | `{ "client": "decky-discdeck", "client_version": "0.1.0", "deck_name": "Jaste's Deck", "capabilities": ["video", "events"] }` | First message after connect. PC must accept or close. |
| `welcome` | PC → Deck | `{ "server": "discdeck-pc", "server_version": "0.1.0", "accepted_capabilities": ["video", "events"] }` | Handshake ack. Connection is "live" after this. |
| `game_start` | Deck → PC | `{ "game_name": "Hollow Knight", "app_id": "367520", "launched_at": "2026-04-06T..." }` | Foreground game became active. `app_id` may be `null` for non-Steam games. |
| `game_change` | Deck → PC | Same as `game_start` | Foreground game changed without an intervening `game_stop`. |
| `game_stop` | Deck → PC | `{ "game_name": "Hollow Knight", "closed_at": "2026-04-06T..." }` | Game closed; PC drops to "no game" title. |
| `stream_starting` | Deck → PC | `{ "rtsp_url": "rtsp://<pc>:8554/deck", "video_codec": "h264", "width": 1280, "height": 800, "fps": 60 }` | Heads-up that RTSP push is about to begin. PC flips renderer to `connecting` *before* first video frame arrives. |
| `stream_stopped` | Deck → PC | `{ "reason": "user_toggled_off" \| "game_closed" \| "error" }` | RTSP push ended. PC returns to `idle`. |
| `heartbeat` | both | `{}` | Keep-alive. |
| `error` | either | `{ "code": "...", "message": "..." }` | Sender may close socket immediately after. |

### 4.4 Why `game_*` and `stream_*` are separate

Game lifecycle and streaming lifecycle are orthogonal:

- Launching a game doesn't auto-start streaming (user opts in via Quick Access Menu).
- Closing a game doesn't auto-stop streaming (user might want to keep broadcasting the Steam UI).
- Toggling streaming off doesn't end a game session.

Collapsing them into one event would force the UI to make assumptions about user intent. Keeping them separate makes the UI a faithful projection of two orthogonal states.

### 4.5 Typical session

```
Deck                                                     PC
 │ Open WS → ws://192.168.1.42:8765/events                │
 │───────────────────────────────────────────────────────▶│
 │ {type:"hello", data:{client_version, deck_name, …}}    │
 │───────────────────────────────────────────────────────▶│
 │              {type:"welcome", data:{server_version}}   │
 │◀───────────────────────────────────────────────────────│
 │                                                        │ state: idle, "Steam Deck"
 │ user launches Hollow Knight                            │
 │ {type:"game_start", data:{game_name:"Hollow Knight"}}  │
 │───────────────────────────────────────────────────────▶│ title: "🎮 Steam Deck — Hollow Knight"
 │                                                        │
 │ user taps "Stream to PC" in QAM                        │
 │ {type:"stream_starting", data:{rtsp_url, codec, …}}    │
 │───────────────────────────────────────────────────────▶│ state: connecting
 │                                                        │
 │ Decky spawns ffmpeg push                               │
 │     RTSP push to rtsp://pc:8554/deck ─────────────────▶│ ffmpeg sidecar receives
 │                                                        │ state: live, video plays
 │                                                        │
 │ heartbeats every 5s                                    │
 │ {type:"heartbeat"} ◀──────────────────────────────────▶│ {type:"heartbeat"}
 │                                                        │
 │ user quits to Steam UI                                 │
 │ {type:"game_stop", data:{game_name:"Hollow Knight"}}   │
 │───────────────────────────────────────────────────────▶│ title: "🎮 Steam Deck"
 │                                                        │ (video still playing — Steam UI)
 │                                                        │
 │ user toggles streaming off                             │
 │ {type:"stream_stopped", data:{reason:"user_…"}}        │
 │───────────────────────────────────────────────────────▶│ state: idle
 │                                                        │
 │ RTSP push ends ───────────────────────────────────────▶│ ffmpeg listener exits, respawned
 │                                                        │
 │ Deck sleeps; WS connection drops                       │
 │───────────────────────────────────────────────────────▶│ tray: ⚪ no Deck connected
```

This protocol is also documented standalone at `docs/PROTOCOL.md` once Part 1 implementation begins, so Part 2's author has a single-file reference.

---

## 5. Window and tray UX

### 5.1 Window title

Computed by main process from `(deck_connected, current_game, stream_state)`, pushed to BrowserWindow on every change:

| State | Title |
|---|---|
| No Deck connected | `🎮 Steam Deck (waiting)` |
| Deck connected, no game | `🎮 Steam Deck` |
| Deck connected, game known | `🎮 Steam Deck — Hollow Knight` |
| Stream starting | `🎮 Steam Deck — Hollow Knight (connecting…)` |
| Live | `🎮 Steam Deck — Hollow Knight` |
| Stream errored | `🎮 Steam Deck — Hollow Knight (error)` |

The leading `🎮 Steam Deck` is invariant — it is the prefix Discord's window picker uses to identify the stream window across game changes. Do not reorder.

### 5.2 Window properties

- **Default size:** 1280×800 (Steam Deck native resolution).
- **Aspect ratio:** locked to 16:10. Resize handles enforce.
- **Frame:** standard OS frame (titlebar + border). Required for Discord window picker to read the title reliably.
- **Always-on-top:** off by default; toggleable from tray menu.
- **Close button:** hides to tray; does **not** quit. True quit only via tray menu.
- **Single instance:** enforced via `app.requestSingleInstanceLock()`. Second launch focuses existing window.

### 5.3 Renderer states

| State | UI |
|---|---|
| `idle` | Idle splash: dark background, centered "🎮 Discdeck" wordmark, subtitle "Waiting for Steam Deck…" with slow pulsing dot. |
| `connecting` | Splash with subtitle "Connecting to \<game\>…" and a spinner. |
| `live` | `<video>` element fullscreen-within-window, MSE-fed, no chrome. |
| `error` | Splash with red accent and error reason. |

### 5.4 Tray icon and menu

Four icon variants in `resources/icons/`:

| Icon | State | Tooltip |
|---|---|---|
| `tray-idle.png` (grey) | No Deck connected | "Discdeck — waiting for Steam Deck" |
| `tray-ready.png` (white) | Deck connected, no stream | "Discdeck — Deck connected" |
| `tray-live.png` (green dot) | Stream live | "Discdeck — streaming \<game\>" |
| `tray-error.png` (red dot) | Error state | "Discdeck — error (click for details)" |

**Tray context menu:**

```
● Streaming: Hollow Knight        (info row, disabled, dynamic)
● Deck: Jaste's Deck connected    (info row, disabled, dynamic)
─────────────────────────────────
Show window
Hide window
Always on top                     (checkbox)
─────────────────────────────────
Reconnect                         (force-respawn ffmpeg + reset state)
Open log folder                   (reveals log file in OS file manager)
─────────────────────────────────
About Discdeck
Quit Discdeck
```

### 5.5 OS notifications

Fired via `electron.Notification`. Throttled to max 1 per event type per 10s to prevent spam from a flapping connection.

| Trigger | Notification |
|---|---|
| Deck connects (event WS handshake) | "Steam Deck connected — \<deck_name\>" |
| Deck disconnects | "Steam Deck disconnected" |
| Stream goes live | "Now streaming: \<game\>" |
| Stream stops | (none — too noisy; tray icon update is sufficient) |
| Error state entered | "Discdeck error — \<reason\>" (click action: open log folder) |

All notifications toggleable via settings file (no UI in v1; documented in README).

### 5.6 Quit semantics

`window.on('close')` is intercepted: hides window, returns false. Quit only via tray menu. On real quit, sequential cleanup with timeouts:

1. Stop accepting new event WS connections.
2. Send WebSocket close frame to current Deck connection (if any).
3. Kill ffmpeg sidecar with SIGTERM, escalate to SIGKILL after 2s grace.
4. Close video relay WS server.
5. Unregister mDNS service.
6. `app.quit()`.

If shutdown takes longer than 5s total, force-exit and log a warning.

---

## 6. Project structure

```
discdeck-pc/
├── package.json
├── tsconfig.json
├── electron-builder.yml          # packaging config (used in Part 1.5)
├── README.md
├── LICENSE                       # already exists
│
├── src/
│   ├── main/                     ─────────── BOUNDARY 1: Node.js / OS / network
│   │   ├── index.ts              # entry: app.whenReady() → wires everything
│   │   ├── window.ts             # BrowserWindow + dynamic title formatter
│   │   ├── tray.ts               # Tray icon, menu, notifications
│   │   ├── state/
│   │   │   └── stream-state.ts   # ◄── pure state machine, the heart of the app
│   │   ├── network/              ─────────── BOUNDARY 2: Part 2 plug-in seam
│   │   │   ├── ffmpeg-listener.ts  # supervised ffmpeg subprocess (RTSP listen + transcode)
│   │   │   ├── video-relay.ts      # localhost-only WS server, fMP4 → renderer
│   │   │   ├── event-server.ts     # LAN WS server for JSON event protocol
│   │   │   ├── event-protocol.ts   # message envelope types + validators
│   │   │   └── mdns.ts             # advertises _discdeck._tcp.local
│   │   └── ipc.ts                # contextBridge channel definitions (typed)
│   │
│   ├── preload/                  ─────────── BOUNDARY 3: privileged → sandboxed
│   │   └── index.ts              # only safe API surface exposed to renderer
│   │
│   └── renderer/                 ─────────── BOUNDARY 4: pure UI, no I/O, no Node
│       ├── index.html
│       ├── index.tsx
│       ├── App.tsx
│       ├── components/
│       │   ├── VideoPlayer.tsx   # MSE consumer; only talks to localhost video-relay WS
│       │   └── IdleSplash.tsx    # idle/connecting/error states
│       └── styles.css
│
├── resources/
│   ├── icons/                    # tray icon variants (idle/ready/live/error)
│   └── splash/                   # splash assets
│
├── test/
│   ├── unit/
│   │   ├── stream-state.test.ts
│   │   ├── event-protocol.test.ts
│   │   └── window-title.test.ts
│   ├── integration/
│   │   ├── event-server.test.ts
│   │   └── ffmpeg-listener.test.ts
│   └── dummy-producer/
│       ├── README.md
│       ├── produce.ts            # the test harness (also Part 2 reference impl)
│       └── push-testpattern.sh   # standalone ffmpeg one-liner
│
└── docs/
    ├── MANUAL_TEST.md            # manual checklist
    ├── PROTOCOL.md               # event protocol extracted as standalone doc
    └── superpowers/
        └── specs/
            └── 2026-04-06-discdeck-part1-design.md   # this document
```

### 6.1 The four boundaries (rules)

1. **Main → Renderer (typed IPC):** only state updates and small commands cross. Never video frames (those use the localhost relay WS). Never raw network data.
2. **`network/` → rest of main:** the rest of main only sees parsed/validated event objects and normalized stream state. Does not import `ws`, does not know what RTSP is, does not know what mDNS is. **This is the seam that makes Part 2 a drop-in replacement for the dummy producer.**
3. **Preload boundary:** standard Electron security. `contextIsolation: true`, `nodeIntegration: false`. Renderer cannot `require('fs')` or any Node API.
4. **Renderer purity:** the renderer is a React app that could run in a regular browser modulo the IPC bridge. No Node imports, no Electron imports.

### 6.2 The Part 2 swap-in test

The proof that the seam is correctly placed: **on the day Part 2 lands, deleting `test/dummy-producer/produce.ts` should be the only change required to the Part 1 codebase.** Part 2 connects to the same `ws://pc:8765/events` and pushes to the same `rtsp://pc:8554/deck` that the dummy producer was using, sends the same messages, and the PC app cannot tell the difference.

If during Part 1 implementation the team is tempted to add a "test mode" branch in the main process, that is a smell — it means the dummy producer is no longer a faithful Decky stand-in and the seam is leaking.

---

## 7. Testing strategy

The defining constraint: Part 2 does not exist yet, so Part 1 must be fully testable in isolation from a real Steam Deck.

### 7.1 The dummy producer (most important test artifact)

`test/dummy-producer/produce.ts` is a Node script that simulates a complete Decky session against a running Discdeck PC app. It performs every state transition the real Decky plugin will need, in roughly the order they happen in real use.

Subcommands:

| Command | Behavior |
|---|---|
| `npm run dummy:full` | Full lifecycle: handshake → game_start → stream_starting → ffmpeg test pattern push → game_change → stream_stopped → game_stop → disconnect |
| `npm run dummy:events` | Event WS only, no video — fast loop for testing title/tray updates |
| `npm run dummy:video` | RTSP push only, no events — test video pipeline in isolation |
| `npm run dummy:flap` | Connect/disconnect every 3s — validates reconnect handling |
| `npm run dummy:crash` | Connects, sends `hello`, then kills WS hard mid-frame |
| `npm run dummy:bad-handshake` | Sends garbage as `hello` — tests error path |

The script also serves as the **reference implementation for Part 2.** When the Decky Python plugin is written, it is a direct translation of `produce.ts` to Python with the same message order, field names, and timing.

### 7.2 Unit tests (Vitest)

Pure logic only. No Electron, no network. Fast, runs in CI, drives TDD.

| Module | Coverage |
|---|---|
| `state/stream-state.ts` | State machine: every input event from every state, expected output state. Crash-loop counting. Heartbeat timeout. |
| `network/event-protocol.ts` | Message envelope validation. Unknown `type` rejection. Version mismatch handling. Bad JSON handling. |
| `main/window.ts` (title formatter) | Title-string generation from `(deck_connected, game_name, stream_state)` tuples. All combinations from §5.1. |

The state machine is the load-bearing piece — it gets the most coverage and is written test-first.

### 7.3 Integration tests (Vitest + real localhost sockets)

Spin up real `event-server` and `video-relay` modules in-process, connect with a real `ws` client, assert handshake works end-to-end. Spin up a real `ffmpeg-listener` against an ffmpeg test-pattern push, assert that fMP4 chunks reach the relay WS within N seconds. **No mocking of network or processes.**

### 7.4 Manual verification checklist

`docs/MANUAL_TEST.md`. Run after every meaningful change:

- [ ] App starts, tray icon appears, window hidden by default.
- [ ] Tray → "Show window" → window appears with title `🎮 Steam Deck (waiting)` and idle splash.
- [ ] `npm run dummy:events` → window title flips to `🎮 Steam Deck — Hollow Knight`, tray icon flips to `ready`, OS notification fires.
- [ ] `npm run dummy:full` → window goes idle → connecting → live (test pattern) → idle. Tray icon and notifications match every transition.
- [ ] **Discord smoke test (the whole point):** Open Discord, join voice channel, "Share Your Screen" → "Application Window" → confirm `🎮 Steam Deck — …` appears in the list and selecting it shows the test pattern in the preview.
- [ ] `npm run dummy:flap` for 60s → no crashes, no leaked ffmpeg processes (`tasklist | findstr ffmpeg` should show 0 or 1, never growing).
- [ ] Quit via tray menu → all sidecars exit within 2s, ports 8765 and 8554 freed (`netstat -ano | findstr 8765`).

The Discord smoke test cannot be automated.

### 7.5 Deliberately not tested

- **Renderer visual regression.** Manual verification suffices at this scale.
- **Cross-platform packaging.** Part 1 is Windows-only.
- **Performance benchmarks.** Frame drops are visible during manual testing; instrumentation only added when there is a measured problem.

---

## 8. Out of scope

### 8.1 Deferred to Part 1.5 (same codebase, after Part 1 ships)

| Item | Reason for deferral |
|---|---|
| **Audio** | Wanted, but adding A/V from day 1 doubles complexity (jitter buffer, sync, output device selection, echo prevention). Transport (RTSP + fMP4) and protocol (`stream_starting` codec fields) are chosen specifically so audio is purely additive later, not a rewrite. |
| **MediaMTX swap** | If `ffmpeg -rtsp_flags listen` proves flaky in real Deck use, swap in a bundled MediaMTX binary as the always-on RTSP server. Single-file change in `src/main/network/`. |
| **macOS / Linux packaging** | Code is cross-platform-ready (no Windows-only APIs in main), but `electron-builder` config and tray-icon assets ship Windows in v1 only. |
| **Settings UI** | v1 reads settings from a JSON file with documented schema. Real settings window is polish that does not unblock anything. |
| **Last-frame freeze on disconnect** | Idle splash is acceptable for v1; freeze-frame is a polish pass. |
| **Visual regression tests** | Manual checklist sufficient at this scale. |

### 8.2 Deferred to Part 2 (Decky Loader plugin, separate spec)

The entire Deck side. Part 2 will get its own brainstorm + spec + plan cycle. The contract it implements against is locked by §4 of this spec.

Part 2 must include: mDNS browser, WebSocket client implementing v1 protocol, ffmpeg subprocess management for RTSP push, Steam game lifecycle hooks, Quick Access Menu toggle, TypeScript/React frontend per Decky template.

### 8.3 Deferred to Part 3 (separate project, possibly never)

| Item | Why explicitly out |
|---|---|
| **Modded Discord client integration** (Vencord, BetterDiscord) | Future enhancement if Parts 1+2 see real use. Window-capture approach does not preclude it; modded clients can use it *plus* gain richer overlays via Discord API access we do not have today. |
| **Discord Rich Presence updates from PC companion** | Requires user-supplied bot token and Discord API quota management. Independent feature. |
| **Multi-Deck support** (one PC receiving from N Decks) | YAGNI. Architecture does not preclude it (event WS keys could become deck IDs, ffmpeg listener could fan out) but adds complexity not justified by current requirements. |
| **Web-based remote viewer** | Different product. Electron window is required for Discord capture; browser viewing is a different problem. |

### 8.4 Explicitly rejected

| Item | Reason |
|---|---|
| **Modifying Discord** | Hard project constraint. The whole architecture exists to avoid this. |
| **Cloud relay servers** | Hard project constraint. LAN-only. |
| **Embedding mpv/VLC for playback** | Heavy native dependency, complicates packaging, no quality win over MSE. |
| **Custom video codec** | Use whatever Deck pipewire+ffmpeg pipeline emits (h264 default). PC re-muxes with `-c:v copy` — zero re-encoding, zero extra latency. |
| **Authentication / encryption on LAN protocols (v1)** | LAN-only personal use. Envelope leaves room for shared secret in `hello` so v2 can add it without a breaking change. |

---

## 9. Open questions for the implementation plan

These are decisions the implementation plan should make explicit but that the design can defer:

- Which logging library? (Likely `pino` or `electron-log`; either is fine.)
- Which test runner exactly? (Likely Vitest, but Jest is acceptable.)
- React vs vanilla DOM in renderer? (Recommend React for component structure, but the renderer is small enough that vanilla would also work.)
- Tailwind vs vanilla CSS for splash? (Either; vanilla is simpler given the tiny surface area.)
- TypeScript strict settings? (Recommend `strict: true` from day one.)

These choices do not affect any boundary defined in this spec.

---

## 10. Acceptance criteria for Part 1 "done"

Part 1 is complete and ready to merge to `main` when:

1. All unit and integration tests pass in CI.
2. The full manual checklist in §7.4 passes on a clean Windows install.
3. The Discord smoke test (§7.4) passes — `🎮 Steam Deck — \<game\>` appears in Discord's window picker and selecting it shows the streamed video to other voice channel members.
4. `npm run dummy:flap` runs for 5+ minutes without crashing, leaking ffmpeg processes, or leaking memory.
5. `docs/PROTOCOL.md` exists as a standalone, readable reference for the Part 2 author.
6. README documents installation, the dummy producer commands, and the manual test procedure.
7. The four boundaries in §6.1 are honored: a grep of `src/renderer/` finds zero `electron`/`node:` imports, and a grep of `src/main/` outside `network/` finds zero `ws`/`rtsp`/`mdns` references.

---

## 11. Implementation post-mortem (added during integration)

Part 1 was merged after the manual checklist + Discord smoke test passed. A handful of design decisions in §1–§10 turned out to be wrong or incomplete in subtle ways during the bring-up. Capturing them here so Part 2's author and any future Part 1.5 work doesn't re-walk the same bugs.

### 11.1 The init-segment timing race (the load-bearing bug)

§3.3 describes the data flow as "ffmpeg listener stdout chunks → main forwards to localhost video-relay WebSocket → renderer plays via MSE." What it does NOT call out is that **the renderer's WebSocket connects to the relay AFTER ffmpeg has already started writing stdout**. The state machine flips to `live` only on the FIRST chunk arrival, and only THEN does the renderer mount `VideoPlayer` and open its WebSocket — by which point the fMP4 init segment (ftyp + moov, ~800 bytes) and possibly the first moof+mdat have already been broadcast to zero clients and lost. Without an init segment, Chromium MSE rejects every subsequent moof+mdat with `CHUNK_DEMUXER_ERROR_APPEND_FAILED` and the renderer shows a black window despite a perfectly valid stream flowing.

**Fix landed:** `video-relay.ts` accumulates a per-session buffer (capped at 4 MB) of every chunk pushed since the last `resetSession()` call, and replays it to any new client at connection time. `main/index.ts` calls `resetSession()` whenever ffmpeg respawns. See `fix(network): buffer init segment in video relay for late-joining clients`.

**Implication for Part 2:** the Decky producer doesn't need to know about this — the relay handles it transparently — but anyone building a similar PC-side companion for a different protocol must remember that **MSE consumers MUST be guaranteed to see the init segment**, and naive "broadcast as it arrives" relays will lose data to clients that join after the first chunk.

### 11.2 `-c:v copy` vs re-encode in the listener

§2.1 specifies `-c:v copy` as the listener's transcode mode (no re-encode, preserve Deck encoder choice). In practice this produced fMP4 with `Timestamps are unset` / `Non-monotonic DTS` warnings from the mp4 muxer because the RTSP demuxer doesn't always deliver packets with explicit timestamps. The resulting file would *probably* play once the relay-buffer fix landed (the diagnostic `out/listener-capture.mp4` did parse correctly in Edge), but Part 1 ships with a re-encode (`-c:v libx264 -profile:v baseline -level 3.0 -preset ultrafast -tune zerolatency`) for safety. CPU cost on 1280x800@30fps test pattern: a few percent.

**Implication for Part 2:** when the Decky-side producer becomes the only thing pushing to the listener, we control both ends and can guarantee well-formed input. At that point Part 1.5 should revisit `-c:v copy` to drop the wasted re-encode CPU. The plan's "out of scope" §8.1 should be updated to add this as an explicit Part 1.5 item.

### 11.3 Electron preload + ESM + sandbox

§5.2 calls for `contextIsolation: true`, `nodeIntegration: false`, and §6.1 boundary 3 implies `sandbox: true` is the secure default. Reality: **Electron's `sandbox: true` mode does not support ES-module preload scripts**, and electron-vite outputs the preload as `.mjs` because the project has `"type": "module"`. With `sandbox: true`, the preload silently fails to load — no error, just a dead `window.discdeck` reference in the renderer. Part 1 ships with `sandbox: false`. `contextIsolation: true` + `nodeIntegration: false` is sufficient for our threat model (renderer only ever loads first-party content), but the spec's implicit "sandbox: true is the default" assumption was wrong.

**Implication for Part 2:** none directly (Part 2 doesn't touch the preload), but if Part 1.5 ever revisits packaging or upgrades Electron, watch for changes to ESM preload support. The cleanest long-term fix is to switch the preload build target to CommonJS (`.cjs` or `.js` without `"type": "module"` scope), at which point `sandbox: true` becomes available again.

### 11.4 The MIME-must-match-avcC false trail

During the streaming bug investigation we spent significant effort chasing a hypothesis that `video/mp4; codecs="avc1.42E01E"` (the MIME the renderer was declaring) didn't match the avcC bytes the listener produces (`0x42 0xC0 0x1E`). It turns out **Chromium MSE accepts both `42E01E` and `42C01E` (and other variants) as constrained baseline @ level 3.0** — the difference is just `constraint_set2_flag`. The MIME mismatch was a complete dead end. The codebase still uses `avc1.42C01E` because it matches the actual avcC bytes byte-for-byte, but `42E01E` would also work.

**Implication for Part 2:** when picking a MIME, match the actual stream's avcC if you can read it; if not, use any of the compatible variants. Don't trust online "avc1 codec string calculator" pages over `MediaSource.isTypeSupported(...)`.

### 11.5 React StrictMode + MediaSource lifecycle

§9 left the React choice open. Part 1 ships with React 18 but **StrictMode is disabled in `src/renderer/index.tsx`** because its dev-mode effect double-invoke tangles badly with the `MediaSource` lifecycle: re-attaching a `MediaSource` to the same `<video>` element silently detaches the first one, leaving the original `SourceBuffer` orphaned and producing a confusing cascade of `appendBuffer` errors. `VideoPlayer.tsx` retains defensive lifecycle code (capture-in-local-const, `mediaSource !== ms` checks, `cancelled` flag in `pump`) so re-enabling StrictMode later should be safe, but for Part 1 we just turn it off.

**Implication for Part 2:** none — Decky's renderer is React but doesn't use MediaSource. If Part 1.5 ever revisits this, the cleanest fix is probably to wrap MediaSource creation in a `useRef` so it's stable across re-mounts.

### 11.6 Stale TypeScript emit artifacts in `src/`

Task 9's tsconfig had `composite: true` which caused `tsc --build` runs to emit `.js` and `.d.ts` files next to every `.ts` source. These are gitignored but they shadow the real `.ts` files when Vite resolves imports, leading to "I changed the source but the bundle still has the old version" symptoms. Part 1's `tsconfig` no longer uses `composite`, but if anyone reintroduces it, **add a clean step that deletes `find src test -type f \( -name "*.js" -o -name "*.d.ts" \)`** before each build. (The current spec doesn't mention this gotcha because it was discovered during bring-up.)

---

## 12. Part 1.5 polish backlog (added post-merge)

In addition to the §8.1 items, the streaming bring-up surfaced these follow-ups:

- **Revisit `-c:v copy`** in the ffmpeg listener once Part 2's producer is the only input (see §11.2)
- **Bounded session buffer**: the relay's 4 MB cap is a placeholder; smarter would be "init segment + last keyframe fragment" so late-joining clients get a clean start without unbounded memory (see §11.1)
- **Re-enable React StrictMode** by stabilizing `MediaSource` across re-mounts (see §11.5)
- **CommonJS preload + sandbox: true** for tighter renderer isolation (see §11.3)
- **Dynamic MIME from avcC**: parse the init segment and construct the codec string at runtime, so encoder changes don't need a renderer code change (see §11.4)
- **Manual test for second-run regression**: the relay-buffer fix is now in `MANUAL_TEST.md` §"Full pipeline" — a vitest integration test would be more durable
