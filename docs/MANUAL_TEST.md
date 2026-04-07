# Manual Verification Checklist

Run after every meaningful change to Discdeck Part 1. The Discord smoke test cannot be automated and is the most important check on this list.

## Setup

- [ ] `npm install` completes without errors
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` (unit tests) passes
- [ ] `npm run test:integration` passes

## Lifecycle

- [ ] `npm run dev` boots the app. Tray icon appears (grey). Window is hidden.
- [ ] Right-click tray → "Show window" → window appears with title `🎮 Steam Deck (waiting)` and "Waiting for Steam Deck…" splash.
- [ ] Click tray icon → window toggles visibility.
- [ ] Click X on the window → window hides instead of quitting. Tray icon remains.

## Events only

- [ ] In a second terminal: `npm run dummy:events`
- [ ] Notification "Steam Deck connected — Test Deck" fires.
- [ ] Window title flips to `🎮 Steam Deck — Hollow Knight`.
- [ ] Tray icon flips to white.
- [ ] Title flips to `🎮 Steam Deck — Celeste` after ~3s.
- [ ] Title flips back to `🎮 Steam Deck` (deck connected, no game), then to `🎮 Steam Deck (waiting)` when dummy disconnects.
- [ ] Notification "Steam Deck disconnected" fires.

## Full pipeline

- [ ] In a second terminal: `npm run dummy:full`
- [ ] Splash briefly shows "Connecting to Hollow Knight…" with spinner.
- [ ] Splash is replaced by live video showing a test pattern (color bars + counter).
- [ ] Title flips to `🎮 Steam Deck — Hades` mid-stream while video keeps playing.
- [ ] Stream ends, splash returns, tray icon goes back to grey.
- [ ] Run `npm run dummy:full` a SECOND time without restarting the app — video still plays. (Regression check for the relay buffer fix: the per-session buffer must be cleared between ffmpeg respawns or the second run inherits the first run's stale init segment and Chromium MSE rejects the new fragments.)

## Discord smoke test (the whole point)

- [ ] Open Discord, join a voice channel.
- [ ] Click "Share Your Screen" → "Application Window".
- [ ] Confirm a window titled `🎮 Steam Deck — …` appears in the picker list.
- [ ] Run `npm run dummy:full` again.
- [ ] In Discord, select the Discdeck window. The preview should show the test pattern.
- [ ] Other voice channel members should see the test pattern.

## Reconnect / flap stress

- [ ] In a second terminal: `npm run dummy:flap`
- [ ] App handles 60s of connect/disconnect cycles without crashing.
- [ ] After flap finishes, run `tasklist | findstr ffmpeg` (Windows) — should show 0 or 1 ffmpeg processes, never growing.

## Quit cleanup

- [ ] Right-click tray → "Quit Discdeck".
- [ ] Within 2s, all sidecars exit.
- [ ] In another terminal: `netstat -ano | findstr 8765` returns nothing (port freed).
- [ ] In another terminal: `netstat -ano | findstr 8554` returns nothing (port freed).
