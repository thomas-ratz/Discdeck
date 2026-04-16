# Discdeck — Part 2 Design Spec (Decky Loader Plugin)

**Date:** 2026-04-16
**Status:** Approved for implementation planning
**Scope:** Part 2 only (Steam Deck-side Decky Loader plugin). Part 1 (PC companion app) is already shipped and merged to `main`; its contract is locked by `docs/PROTOCOL.md` and the Part 1 design spec at `docs/superpowers/specs/2026-04-06-discdeck-part1-design.md`.

---

## 1. Project context

Discdeck lets a Steam Deck stream gameplay to vanilla Discord running on the user's PC by appearing as a selectable "Application Window" in Discord's screen-share picker.

- **Part 1 (done, merged to `main` 2026-04-16):** Windows Electron tray app that receives RTSP video and a JSON event stream from the Deck, renders the video in a titled window Discord can capture, surfaces status via tray icon and OS notifications.
- **Part 2 (this spec):** Decky Loader plugin on the Steam Deck that detects game lifecycle events, captures the Deck screen via bundled FFmpeg (`kmsgrab` + VAAPI), and pushes RTSP + JSON events to the PC over LAN. Discovers the PC via mDNS.

### 1.1 What Part 2 does not change

The Part 1 contract is frozen. Part 2 is a faithful producer against it. Specifically:

- The v1 event protocol in `docs/PROTOCOL.md` is authoritative. Every Part 2 message conforms byte-for-byte.
- The RTSP push URL, port, codec, and required ffmpeg flags (`-x264opts repeat-headers=1`, `-rtsp_transport tcp`) match the Part 1 listener's expectations.
- The mDNS service `_discdeck._tcp.local` is what Part 2 browses for; Part 1 advertises it.

The Part 1 spec's §6.2 "swap-in test" says: *"on the day Part 2 lands, deleting `test/dummy-producer/produce.ts` should be the only change required to the Part 1 codebase."* This spec is written so that property holds.

### 1.2 Project values (inherited)

- Open source, LAN-only, no cloud relays, no telemetry.
- Minimal dependencies, but bundle what's needed (the plugin ships its own ffmpeg binary — see §4).
- Survive across Decky Loader and SteamOS updates where feasible; when a SteamOS update genuinely breaks us (e.g. kmsgrab changes), fail cleanly with an actionable error.

---

## 2. Architecture overview

```
┌───────────── Steam Deck (SteamOS, Gaming Mode) ──────────────┐       ┌────────── PC ─────────────┐
│                                                              │       │                           │
│  ┌─────────────── Decky Loader runtime ────────────────┐     │       │                           │
│  │                                                     │     │       │                           │
│  │  ┌────────────────┐           ┌──────────────────┐  │     │       │                           │
│  │  │  QAM frontend  │◄── emit ──│  Python backend  │  │     │       │                           │
│  │  │  (React, TSX)  │           │   (main.py)      │  │     │       │                           │
│  │  │                │── call ──►│                  │  │     │       │                           │
│  │  │ • Status line  │           │ • State machine  │  │     │       │                           │
│  │  │ • Toggle       │           │ • mDNS browser   │──┼─────┼─mDNS──┤ _discdeck._tcp advert     │
│  │  │ • IP fallback  │           │ • Event WS client│──┼─────┼──WS──►│ Event server :8765        │
│  │  │ • SteamClient  │           │ • FFmpeg super-  │  │     │       │                           │
│  │  │   hooks        │           │   visor          │──┼──spawn─┐    │                           │
│  │  └────────────────┘           └──────────────────┘  │     │  │    │                           │
│  │                                                     │     │  │    │                           │
│  └─────────────────────────────────────────────────────┘     │  │    │                           │
│                                                              │  ▼    │                           │
│                                               ┌──────────────────┐   │                           │
│                                               │  bundled ffmpeg  │───┼──RTSP─►│ Listener :8554   │
│                                               │  (kmsgrab+VAAPI) │   │        └──────────────────┘
│                                               └──────────────────┘   │                           │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 Component responsibilities

| Component | Owns |
|---|---|
| Python backend (`main.py` + `backend/*`) | State machine, settings, mDNS browse, event WS client, ffmpeg lifecycle, logging. Long-lived; outlives QAM open/close. |
| QAM frontend (`src/*.tsx`) | Renders backend state, forwards user intents, calls SteamClient lifecycle hooks. Ephemeral — mounts with QAM, unmounts when QAM closes. |
| Bundled ffmpeg binary (`bin/ffmpeg`) | One subprocess at a time. Captures Deck display via `kmsgrab`, hw-encodes H.264 via VAAPI, pushes RTSP to PC. |

### 2.2 Why the backend owns the state machine

Decky plugins have two execution contexts: the Python backend, which runs as long as Decky Loader is up, and the React frontend, which is mounted and unmounted as the user opens and closes the QAM. Anything that must survive QAM close — the PC connection, the stream, the state of what game is running — must live in the backend.

The frontend is a pure view: on mount it calls `get_state()` once and then subscribes to `state_changed` events emitted by the backend. No frontend-local state except transient form input.

This mirrors Part 1's "main process owns network and sidecars; renderer is a projection of state" boundary (Part 1 spec §3.1).

### 2.3 Connection direction (unchanged from Part 1)

Every channel between the two machines is Deck-dials-PC:

| Channel | Protocol | PC role | Deck role |
|---|---|---|---|
| Discovery | mDNS / multicast UDP | Advertises `_discdeck._tcp.local` | Browses |
| Events | WebSocket | Server (port 8765) | Client (dials, sends JSON) |
| Video | RTSP | Server (port 8554, ffmpeg listener) | Client (ffmpeg pushes) |

---

## 3. State machine

The backend owns a single state machine. States mirror Part 1's from the producer's perspective.

### 3.1 States

| State | Meaning |
|---|---|
| `disconnected` | No WS to PC. Either mDNS is browsing or we are retrying a configured manual IP. |
| `connecting` | WS dialing or handshake in flight. |
| `connected_idle` | WS live, `hello`/`welcome` exchanged, no foreground game, streaming OFF. |
| `connected_game` | WS live, foreground game known, streaming OFF. |
| `streaming` | WS live, ffmpeg subprocess running, `stream_starting` sent. |
| `error` | Unrecoverable without user action (setcap failed, ffmpeg crash-loop, etc.). |

### 3.2 Transitions

- `disconnected → connecting`: mDNS service found, or manual IP configured and user tapped Reconnect, or optimistic retry of `last_connected_pc` on startup.
- `connecting → connected_idle`: `welcome` received from PC.
- `connecting → disconnected`: dial timeout (10s), `welcome` timeout (5s), or socket error. Exponential backoff retry: 1s, 2s, 4s, 8s, capped at 30s.
- `connected_idle ↔ connected_game`: SteamClient `app_launched` / `app_exited` events arrive from the frontend.
- `(connected_idle | connected_game) → streaming`: user flipped the toggle ON. Backend sends `stream_starting`, then spawns ffmpeg.
- `streaming → (connected_idle | connected_game)`: user flipped toggle OFF, or ffmpeg died normally, or WS dropped. Backend sends `stream_stopped` (only if WS still alive), then kills ffmpeg.
- **Any → `error`:** ffmpeg exits abnormally 3+ times within 30s. Mirrors Part 1 spec §3.2 crash-loop guard.
- `error → disconnected`: user taps Reconnect in QAM.

### 3.3 Disconnection rules

- WS heartbeat every 5s both directions, 15s silence = kill connection (matches Part 1 spec §4.1).
- If WS dies while `streaming`, ffmpeg is killed **immediately**, not after the next push timeout. Avoids the "RTSP TCP blocks for 30s trying to flush to a dead peer" problem.
- `stream_stopped.reason` values extend Part 1's set: `user_toggled_off`, `game_closed`, `error`, `disconnected` (new). Part 1 already accepts unknown reasons, so this is additive.

### 3.4 Why a state machine, not ad-hoc booleans

Same rationale as Part 1 spec §7.2. Every input — WS event, SteamClient event, user tap, ffmpeg exit — goes through one transition table. Pure, unit-testable, no `asyncio.Lock` gymnastics.

---

## 4. Capture pipeline

### 4.1 FFmpeg command (baseline)

```bash
bin/ffmpeg \
  -thread_queue_size 512 \
  -framerate 60 \
  -device /dev/dri/card1 \
  -f kmsgrab -i - \
  -vaapi_device /dev/dri/renderD128 \
  -vf 'hwmap=derive_device=vaapi,scale_vaapi=w=1280:h=800:format=nv12' \
  -c:v h264_vaapi \
  -profile:v constrained_baseline \
  -level 3.0 \
  -bf 0 \
  -g 60 \
  -b:v 6M \
  -maxrate 8M \
  -bufsize 2M \
  -x264opts repeat-headers=1 \
  -rtsp_transport tcp \
  -f rtsp \
  rtsp://<pc>:8554/deck
```

### 4.2 Flags and their reasons

| Flag | Why |
|---|---|
| `-f kmsgrab -device /dev/dri/cardN` | The only proven screen-capture path in SteamOS Gaming Mode. PipeWire via ffmpeg isn't implemented; GStreamer-pipewire crashes Gamescope. |
| `-vaapi_device /dev/dri/renderD128` | Hardware H.264 encoder — near-zero CPU cost. |
| `-vf 'hwmap=…,scale_vaapi=…format=nv12'` | kmsgrab emits BGR0; VAAPI H.264 encoder needs NV12. `scale_vaapi` does the format conversion on the GPU. The `scale` to 1280×800 is a no-op at native resolution but forces the format filter. |
| `-profile:v constrained_baseline`, `-bf 0`, `-level 3.0` | Matches the profile Part 1's listener and MSE consumer are proven against. No B-frames avoids reordering latency. |
| `-g 60` | One keyframe per second at 60 fps. Tight enough for fast channel recovery without bloating bitrate. |
| `-b:v 6M -maxrate 8M -bufsize 2M` | Conservative default for clean 5 GHz LAN. User-adjustable bitrate is Part 2.5. |
| `-x264opts repeat-headers=1` | **Mandatory per `feedback_ffmpeg_rtsp_producer_flags` memory note and Part 1 spec §4.3.** Puts SPS/PPS into SDP `sprop-parameter-sets` so Part 1's listener can probe codec params. Without this, the listener silently loses headers. |
| `-rtsp_transport tcp` | Forces TCP delivery; avoids UDP packet loss during the RTSP probe on Wi-Fi. Also mandated by memory note. |

### 4.3 Device-path probing

`/dev/dri/card1` is not guaranteed — on some Decks the KMS device is `card0`. At backend startup, `backend/ffmpeg_supervisor.py` iterates `/dev/dri/by-path/` and picks the PCI device tagged `platform-` or `pci-*-card` with connected outputs. The selected path is logged on every spawn; if probing fails, state goes to `error` with message `No KMS device found`.

### 4.4 `setcap` bootstrap

The bundled ffmpeg needs `cap_sys_admin+ep` to read the KMS framebuffer.

1. `plugin.json` declares `"flags": ["root"]` so Decky permits privileged subprocess helpers.
2. On `_main()` startup, `backend/capability.py` runs `getcap bin/ffmpeg`. If the required capability is absent, it runs `setcap cap_sys_admin+ep bin/ffmpeg` via Decky's root helper. Exactly once per install.
3. If setcap fails: state → `error`, QAM surfaces `Permission setup failed — tap for logs`. Recoverable by user re-triggering via Reconnect.

### 4.5 Crash-loop supervisor (mirrors Part 1 §3.2)

- ffmpeg exit with non-zero code within 10s of start → counts as abnormal.
- 3 abnormal exits within a 30s rolling window → state → `error`.
- Normal stop path: backend sends SIGINT → 2s grace → SIGKILL. ffmpeg is spawned in its own process group (`os.setsid`) and reaped via `os.killpg`, because bare `kill(pid)` occasionally leaks VAAPI encoder threads on SteamOS.

### 4.6 Audio

Out of scope for Part 2. Matches Part 1 spec §8.1 deferral. Adding audio in Part 2.5 is additive: append `-f pulse -i default` (or pipewire equivalent) to the command and extend `stream_starting.data` with `audio_codec` / `sample_rate`. Part 1's `stream_starting` message already accepts extra fields.

---

## 5. Event flow & game detection

### 5.1 Frontend-side SteamClient hooks

The frontend subscribes to two SteamClient APIs at plugin module load time (not QAM mount — these need to outlive QAM):

- `SteamClient.GameSessions.RegisterForAppLifetimeNotifications(cb)` — fires on every app start / exit, provides `{unAppID, bRunning, ...}`.
- `appStore.GetAppOverviewByAppID(id)` — resolves an app ID to a display name.

For each fired notification, the frontend calls `backend.on_game_event({kind, app_id, game_name?, at})`. Non-Steam games come through with shortcut IDs (large integers); forwarded as strings; Part 1 accepts any string or `null`.

### 5.2 Backend normalization

The backend owns a single `current_app_id` field and normalizes raw `start`/`stop` events into Part 1's `game_start` / `game_change` / `game_stop`:

```
raw event                      current_app_id (before)    PC receives
─────────────────────────      ───────────────────        ───────────
start(HollowKnight)            null                  ──►  game_start       (current_app_id := HollowKnight)
start(Hades)                   HollowKnight          ──►  game_change      (current_app_id := Hades)
stop(HollowKnight)             Hades (mismatch)      ──►  ignore           (stale stop, SteamClient race)
stop(Hades)                    Hades                 ──►  game_stop        (current_app_id := null)
```

The "stop doesn't match current" case handles SteamClient's occasional out-of-order delivery when one game exits as another launches.

### 5.3 Event matrix

```
source event                         backend action
────────────────────────────────     ──────────────────────────────────────────
user toggle ON (canStream == true)   spawn ffmpeg, send stream_starting
user toggle OFF                      SIGINT ffmpeg, send stream_stopped(user_toggled_off)
ffmpeg exits while toggle ON         crash-loop++, send stream_stopped(error), maybe respawn
ffmpeg exits while toggle OFF        normal — no message (stream_stopped was already sent)
WS drops                             kill ffmpeg, set state → disconnected, start backoff retry
heartbeat timeout (15s silence)      treat as WS drop
welcome timeout (5s)                 close WS, → disconnected
```

### 5.4 Hello handshake

On every new WS connection:

```json
{"v":1,"type":"hello","id":"<uuid4>","ts":"<iso>","data":{
  "client":"decky-discdeck",
  "client_version":"<from package.json>",
  "deck_name":"<from /etc/hostname>",
  "capabilities":["video","events"]
}}
```

If `welcome` doesn't arrive within 5s, close with no error — the Part 1 server replies fast enough that anything else means the peer isn't a Discdeck PC.

---

## 6. QAM UI

The frontend is a pure view over backend state. No local state except transient form input.

### 6.1 Component tree

```
<QAMPanel>                                 src/index.tsx
├── <StatusLine status={state} />          "● Connected to Jaste-PC" / "⚪ Searching…" / "⚠ Error …"
├── <CurrentGame game={game} />            "Hollow Knight" / "None"
├── <StreamToggle
│    enabled={streaming}
│    disabled={!canStream}
│    onChange={toggle} />                   primary action
├── <Divider />
├── <PCAddressRow mode={mode} address={addr} />   tap → <PCAddressSubmenu>
└── <SettingsRow />                                tap → <SettingsSubmenu>

<PCAddressSubmenu>
├── Auto-detect (mDNS)   [✓]
└── Manual: [ 192.168.x.x       ]          validated on blur

<SettingsSubmenu>
├── Reconnect now                          forces disconnect + rediscover
├── Open logs                              paginated log viewer
└── About                                  plugin name, version
```

All components use `@decky/ui` primitives (`PanelSection`, `PanelSectionRow`, `ToggleField`, `ButtonItem`, `TextField`). No custom CSS, no third-party component libraries.

### 6.2 Backend → frontend events

| Event | Payload | Fires on |
|---|---|---|
| `state_changed` | `{state, connected_pc, current_game, streaming, error_message}` | Every state-machine transition |
| `log_appended` | `{line}` | Every log line — only while log viewer is mounted (subscribe on mount, unsubscribe on unmount) |

### 6.3 Frontend → backend calls

| Method | Args | Returns | Purpose |
|---|---|---|---|
| `get_state` | — | full snapshot | Called on QAM mount (frontend is ephemeral) |
| `set_streaming_enabled` | `bool` | new state | Toggle action |
| `on_game_event` | `{kind, app_id, game_name?, at}` | void | SteamClient lifecycle forwards |
| `set_pc_address_mode` | `{mode: "auto"\|"manual", address?}` | void | PC address config |
| `reconnect` | — | void | Force reconnect |
| `get_logs` | `{lines: number}` | `string[]` | Log viewer initial load |

### 6.4 `canStream` derivation

`canStream === true` iff `state ∈ {connected_idle, connected_game}` and `streaming === false`. When disabled, the toggle is greyed; the reason is visible in the status line (`⚪ Searching for PC…`, `⚠ Permission setup failed`, etc.).

---

## 7. Discovery, settings, persistence

### 7.1 mDNS browsing

- Library: `zeroconf` (pure-Python, no native deps, ships fine in Decky's runtime).
- Browses for `_discdeck._tcp.local`.
- On `ServiceStateChange.Added`: extract `server`, `port`, TXT fields (`event_port`, `rtsp_port`, `protocol_version`). Validate `protocol_version == 1`. If valid: `disconnected → connecting`.
- On `ServiceStateChange.Removed`: if the removed service is the currently connected one, treat as WS drop.
- Browser starts in `_main()` and runs for the plugin's lifetime.

### 7.2 Manual-IP fallback

1. User enters `192.168.1.42` or `host.local` in QAM.
2. Frontend calls `set_pc_address_mode({mode: "manual", address})`.
3. Backend stops mDNS browser (avoids racing), persists to settings, dials `ws://<address>:8765/events`.
4. Reverting to `auto` stops manual dialing and restarts the mDNS browser.

### 7.3 Settings file

Location: `${DECKY_PLUGIN_SETTINGS_DIR}/config.json` — Decky-provided, auto-created, survives plugin reinstall when `_migration` is declared.

```json
{
  "version": 1,
  "pc_address_mode": "auto",
  "manual_pc_address": null,
  "last_connected_pc": {
    "server": "jaste-pc",
    "event_port": 8765,
    "rtsp_port": 8554,
    "last_seen": "2026-04-16T12:34:56Z"
  }
}
```

- `version` field enables future migrations without guessing.
- `last_connected_pc` is a cache: on startup with `pc_address_mode == "auto"`, backend tries the last-seen PC's address in parallel with starting mDNS browse. First to succeed wins; the other is canceled. Shaves 2–5s off warm reconnect on a stable LAN.
- Writes are atomic: write `.tmp`, rename. Implemented in `backend/settings_store.py`.

### 7.4 Logging

- Uses `decky.logger`, which writes to `DECKY_PLUGIN_LOG`. Decky rotates.
- Default level: `INFO`. If a file named `discdeck.debug` exists in `DECKY_PLUGIN_SETTINGS_DIR`, level is `DEBUG`. Undocumented support escape hatch.
- Every state transition logs: `state: connected_game → streaming (trigger: user_toggle)`.
- Every ffmpeg spawn logs the full argv. Every ffmpeg exit logs exit code + signal.
- WS message types are logged at INFO; full payloads only at DEBUG (avoids leaking game names to plain logs by default).

### 7.5 No telemetry, no crash reporter

Matches Part 1 spec §1.2. All failure data lives on the device.

---

## 8. Project structure

```
discdeck-decky/
├── plugin.json                        # name, author, flags:["root"], publish tags
├── package.json                       # frontend deps (@decky/api, @decky/ui)
├── pnpm-lock.yaml
├── rollup.config.js                   # frontend bundler per decky-plugin-template
├── tsconfig.json
├── README.md
├── LICENSE
│
├── main.py                            ─────── BACKEND ENTRY ───────
│                                      # Plugin class + Decky lifecycle hooks.
│                                      # Thin — dispatches to backend/ modules.
│
├── backend/                           # Python package, imported by main.py
│   ├── __init__.py
│   ├── state.py                       # StreamState dataclass + state machine (pure)
│   ├── event_client.py                # WS client (asyncio + websockets)
│   ├── event_protocol.py              # Envelope + validators; direct port of Part 1's event-protocol.ts
│   ├── mdns_browser.py                # zeroconf browser for _discdeck._tcp.local
│   ├── ffmpeg_supervisor.py           # spawn / reap / crash-loop counter
│   ├── capability.py                  # getcap/setcap helpers for bin/ffmpeg
│   ├── settings_store.py              # atomic-write JSON persistence
│   └── logging_setup.py               # decky.logger config
│
├── bin/
│   └── ffmpeg                         # bundled static build with VAAPI (~25 MB);
│                                      # setcap applied on first run
│
├── src/                               ─────── FRONTEND ───────
│   ├── index.tsx                      # Plugin entry, SteamClient hooks, QAM <PanelSection>
│   ├── components/
│   │   ├── StatusLine.tsx
│   │   ├── CurrentGame.tsx
│   │   ├── StreamToggle.tsx
│   │   ├── PCAddressSubmenu.tsx
│   │   ├── SettingsSubmenu.tsx
│   │   └── LogViewer.tsx
│   ├── hooks/
│   │   └── useBackendState.ts         # subscribes to state_changed, calls get_state on mount
│   └── backend.ts                     # typed wrappers around call<…>()
│
├── tests/                             # pytest — backend only
│   ├── test_state_machine.py
│   ├── test_event_protocol.py
│   ├── test_ffmpeg_supervisor.py
│   ├── test_event_client_roundtrip.py
│   ├── test_mdns_discovery.py
│   └── integration/
│       └── test_against_part1_listener.py
│
└── docs/
    ├── MANUAL_TEST.md
    └── superpowers/
        └── specs/
            └── 2026-04-16-discdeck-part2-design.md   # this document
```

### 8.1 Module boundary rules

1. **`main.py` is glue.** It wires `backend/*` modules together and exposes `call()`-able methods. No logic of its own.
2. **`backend/event_protocol.py` is a direct port of `src/main/network/event-protocol.ts`** from Part 1. Every type and validator has a Python twin. They must not drift; an integration test cross-checks message shapes against a vendored copy of the TS types.
3. **Frontend purity:** `src/` never imports backend internals. It only knows `call()` method names and `emit()` event names. Rewriting the backend should not require touching the frontend.
4. **State machine is pure:** `backend/state.py` has no imports from `asyncio`, `subprocess`, or `websockets`. Same testability property as Part 1's `stream-state.ts`.

### 8.2 Plugin-repo-versus-main-repo layout

Open question for the implementation plan: does Part 2 live in the existing Discdeck repo under `decky-plugin/` or in a sibling repo `discdeck-decky`? Decky's plugin store expects one plugin per repo, which argues for sibling. A monorepo makes the Part 1 ↔ Part 2 integration test easier. The implementation plan should decide.

---

## 9. Testing strategy

The defining constraint (mirrors Part 1): **a physical PC running Part 1 must not be required to run most tests.**

### 9.1 Unit tests (pytest, pure, no network, no subprocess)

| Module | Coverage |
|---|---|
| `backend/state.py` | Every transition from every state. Crash-loop counter. `game_change` derivation from SteamClient event stream. |
| `backend/event_protocol.py` | Envelope validation. Unknown-`type` rejection. Version mismatch. Bad JSON. |
| `backend/ffmpeg_supervisor.py` | Mock-subprocess tests: spawn, normal exit, abnormal exit counting, SIGINT / SIGKILL escalation timing, process-group reaping. |

### 9.2 Integration tests (pytest + real local services)

- `test_event_client_roundtrip.py`: spin up a mock event server in-process that speaks v1, assert `hello → welcome → game_start → stream_starting → stream_stopped` in correct order and with correct envelope shapes.
- `test_mdns_discovery.py`: publish a fake `_discdeck._tcp.local` record; assert the browser finds it and transitions state within 5s.

### 9.3 The Part 1 integration test

`tests/integration/test_against_part1_listener.py`: spins up the real Part 1 companion app via `npm run dev` (Part 1 repo path configured via env var) and runs the Part 2 backend against it. Asserts:

1. mDNS discovery finds the PC within 10s.
2. WS handshake completes.
3. `game_start` + `stream_starting` → ffmpeg spawned → fMP4 chunks reach Part 1's video relay (verified by tailing Part 1's logfile or via a test-only state-introspection endpoint — decided during implementation).
4. Clean disconnect from Part 2 side closes Part 1's state cleanly (no leaked ffmpeg or socket).

This is the Part 2 equivalent of Part 1's "Discord smoke test" — it can't replace a real Deck run, but it catches 90% of protocol regressions.

### 9.4 Manual verification on real hardware (`docs/MANUAL_TEST.md`)

- [ ] Install plugin via Decky dev mode from a GitHub release zip.
- [ ] On first launch: `setcap` prompt resolves; plugin reaches `connected_idle` within 15s on a normal LAN.
- [ ] Launch Hollow Knight → QAM shows `Game: Hollow Knight` within 2s. Status line unchanged.
- [ ] Toggle "Stream to PC" ON → PC window title flips to `🎮 Steam Deck — Hollow Knight`, video plays on PC.
- [ ] Close Hollow Knight → stream remains live (per design §3.2 orthogonality); PC title updates to `🎮 Steam Deck`.
- [ ] Toggle OFF → PC returns to idle splash.
- [ ] **The real smoke test:** PC-side Discord screen-share picks up the window; remote viewer in the voice channel sees Deck gameplay.
- [ ] QAM close/reopen during streaming: stream survives, QAM on reopen shows correct live state.
- [ ] Pull PC's network cable during streaming: Part 2 reaches `disconnected` within 15s, ffmpeg is reaped (`pgrep ffmpeg` returns nothing), backoff retry starts.

The Discord smoke test cannot be automated.

### 9.5 Deliberately not tested

- Visual regression on the QAM (manual).
- Cross-Decky-version compatibility (minimum version pinned in `plugin.json`, documented in README).
- Performance under adverse Wi-Fi (qualitative manual test).

---

## 10. Out of scope

### 10.1 Deferred to Part 2.5 (same plugin, after Part 2 ships)

| Item | Reason |
|---|---|
| **Audio capture** | User-requested. Add `-f pulse -i default` (or pipewire equivalent) to the ffmpeg command; extend `stream_starting` with `audio_codec` / `sample_rate`. Part 1.5 picks it up on the receiving end. |
| **User-adjustable fps (30 / 60)** | User-requested. New QAM settings row; backend re-reads on stream start. No protocol change — fps field already in `stream_starting`. |
| **User-adjustable bitrate** | If 6 Mbps default proves wrong in practice. |
| **Per-game auto-stream preference** | Remember toggle state per app_id. YAGNI until the plugin sees day-to-day use. |
| **Richer non-Steam game names** | v1 uses whatever `appStore.GetAppOverviewByAppID` returns for shortcut IDs (often just the shortcut name). Could be enriched from desktop files. |
| **Inline QAM diagnostics** | Bitrate / fps / frame drops / ping visible in the panel. |
| **Shared-secret auth on the `hello`** | Part 1's envelope reserves room for it. Add when either end ever leaves LAN. |
| **Plugin store submission** | v1 installable in dev mode from a GitHub release zip. Formal store listing is paperwork after the plugin is proven. |

### 10.2 Explicitly out of scope forever

| Item | Reason |
|---|---|
| **Running without Decky Loader** | Decky provides SteamClient hooks, lifecycle, and the privileged subprocess helper. A standalone systemd service would have to re-implement all of it. |
| **Cloud relay / WAN** | Matches Part 1 §1.2. |
| **Multi-PC targeting (one Deck → N PCs)** | YAGNI. Event WS is single-connection by protocol. |
| **Streaming Desktop Mode (KDE)** | Desktop mode has different capture primitives and no Gamescope. Possible Part 3 if ever. |
| **Installing footprint outside `$HOME/homebrew/plugins/discdeck/`** | Plugins shouldn't spread. Everything stays under the Decky plugin directory. |

### 10.3 Risks accepted

| Risk | Mitigation |
|---|---|
| SteamOS update breaks `kmsgrab` or moves DRI device paths | Backend probes device paths at startup, logs clearly, surfaces `error` state in QAM. Documented in README as a known class of failure. |
| SteamClient API renames across Steam client updates | Frontend is thin; a patch release fixes in a few lines. Whole Decky ecosystem handles it the same way. |
| User Wi-Fi drops frames / jitters | Out of our control. Visible as lag in Discord preview; no in-plugin UI for it. |
| PC firewall blocks ports 8554/8765 | Part 1 README documents firewall rules. Part 2 surfaces connection timeout as `error` in QAM with an actionable message. |

---

## 11. Acceptance criteria for Part 2 "done"

1. All pytest unit and integration tests pass in CI.
2. `tests/integration/test_against_part1_listener.py` passes against Part 1's current `main`.
3. Manual checklist in `docs/MANUAL_TEST.md` passes on a real Deck against a real PC running Part 1.
4. The real smoke test: a remote Discord viewer in a voice channel sees Deck gameplay with ≤ 500 ms glass-to-glass latency on a clean 5 GHz LAN.
5. `setcap` bootstrap on first install succeeds without manual intervention beyond the Decky root prompt.
6. Plugin survives QAM close / reopen without dropping the PC connection or the stream.
7. README covers: install from release zip in Decky dev mode, the five most likely failure modes (no PC found, setcap failed, firewall, no DRI device, crash-loop), and a pointer to `docs/PROTOCOL.md` in the Part 1 repo.
8. Deleting `test/dummy-producer/produce.ts` from the Part 1 repo does not affect Part 1 behavior when Part 2 is the producer. (Validates the §6.2 swap-in property.)

---

## 12. Open questions for the implementation plan

These are decisions the implementation plan should make explicit but that the design can defer:

- **Repo layout:** sibling `discdeck-decky` repo, or `decky-plugin/` subdirectory of the existing repo? (§8.2) Both have merit; the plan picks one.
- **Frontend bundler:** `rollup` (what the official template uses) or `esbuild`. Template default unless there's a strong reason to deviate.
- **Python WS library:** `websockets` (Python 3 standard choice) vs `aiohttp`. Template and Decky's runtime both support either.
- **Bundled ffmpeg source:** prebuilt static from BtbN/FFmpeg-Builds (same source ffmpeg-static uses) vs in-repo Docker build. BtbN is simpler for v1.
- **Part 1 integration test invocation:** does the test actually spin up Part 1 via `npm run dev` in a child process, or is there a test-only HTTP state introspection endpoint added to Part 1? The latter requires a tiny Part 1 change; the former requires a Part 1 checkout.

These choices do not affect any boundary defined in this spec.
