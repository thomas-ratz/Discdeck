# Discdeck — PC Companion App (Part 1)

The PC half of the Discdeck two-part Steam Deck → Discord stream bridge. A Windows Electron tray app that receives an RTSP video push and a JSON event stream from a Decky Loader plugin (Part 2, separate repo) and renders the video in a window that vanilla Discord can capture as a screen-share source.

**Status:** Part 1 in development. Part 2 (the Deck-side plugin) does not yet exist; testing is done via the dummy producer harness.

## Why

Discord exposes no public API for pushing remote video into a voice channel. The only way to get Steam Deck pixels into vanilla Discord is to materialize them as a normal OS window on the PC and let Discord's "Application Window" screen-share pick it up locally. This app is the materializer.

## Install

```bash
npm install
```

Requires Node.js 20+. The bundled FFmpeg comes from `ffmpeg-static` — no system FFmpeg required.

## Run

```bash
npm run dev
```

The app starts in the system tray. Right-click the tray icon → "Show window" to reveal the streaming window.

## Test it without a Steam Deck

The `dummy-producer` harness simulates a complete Decky session:

```bash
# In one terminal:
npm run dev

# In another:
npm run dummy:full       # full lifecycle with video
npm run dummy:events     # events only, no video
npm run dummy:video      # video only, no events
npm run dummy:flap       # connect/disconnect stress for 60s
```

See `test/dummy-producer/README.md` for the full subcommand list.

## Use it with Discord

1. Start Discdeck (`npm run dev`).
2. Open Discord and join a voice channel.
3. Click "Share Your Screen" → "Application Window".
4. Pick the window titled `🎮 Steam Deck — …` from the list.
5. Start streaming from your Deck (Part 2) — or run `npm run dummy:full` for testing.

## Protocol

The Decky-side contract is documented at `docs/PROTOCOL.md`. When Part 2 is built, it implements that protocol verbatim — see the `dummy-producer` script for a reference implementation.

## Tests

```bash
npm test                 # unit tests (state machine, protocol, title formatter)
npm run test:integration # integration tests (event server, ffmpeg listener)
npm run typecheck        # typescript strict typecheck
```

Manual verification checklist: `docs/MANUAL_TEST.md`.

## Architecture

See `docs/superpowers/specs/2026-04-06-discdeck-part1-design.md` for the full design.

```
Steam Deck (RTSP push) → FFmpeg listener → video relay WS → <video> + MSE
                       └→ Event WS         → state machine → tray + window title
                       └→ mDNS discovery   ←┘
```

The `src/main/network/` directory is the **Part 2 plug-in seam**: when Part 2 is ready, deleting `test/dummy-producer/produce.ts` should be the only change needed in this codebase.

## License

See `LICENSE`.
