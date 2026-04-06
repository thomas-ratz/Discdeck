# Discdeck Part 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows Electron tray app that receives an RTSP video push and a JSON event stream from a (future) Steam Deck Decky plugin, and renders the video in a titled window that vanilla Discord can capture as an "Application Window" screen-share source.

**Architecture:** Electron app with strict main/preload/renderer separation. The main process owns all LAN-facing I/O via four modules under `src/main/network/` (the Part 2 plug-in seam). Video flows: RTSP → bundled FFmpeg subprocess (`-rtsp_flags listen` + `-c:v copy` to fragmented MP4 on stdout) → main process forwards chunks over a localhost-only WebSocket → renderer plays via Media Source Extensions in a `<video>` element. Events flow: a separate LAN WebSocket server in main accepts a single Deck connection and exchanges versioned JSON messages that drive a pure state machine, which in turn drives window title, tray icon, and renderer state via typed IPC.

**Tech Stack:**
- **Runtime:** Node.js 20 LTS, Electron 31+
- **Build:** electron-vite (handles main, preload, renderer with HMR)
- **Language:** TypeScript with `strict: true`
- **UI:** React 18 + vanilla CSS in renderer
- **Tests:** Vitest (unit + integration; no Electron-in-test, no Playwright in v1)
- **Logging:** `electron-log`
- **Networking:** `ws` (WebSocket server + client), `bonjour-service` (mDNS)
- **Media:** `ffmpeg-static` (bundled FFmpeg binary)
- **Utility:** `uuid` (v4 generation)
- **Test harness execution:** `tsx` for running TypeScript dummy producer scripts

**Spec reference:** `docs/superpowers/specs/2026-04-06-discdeck-part1-design.md`. Every task below cites the spec section it implements.

---

## Resolved open questions (spec §9)

| Question | Resolution | Why |
|---|---|---|
| Logging library | `electron-log` | Designed for Electron, writes to standard OS log paths, simple API |
| Test runner | Vitest | Modern, Vite-native, fast, TypeScript-first |
| React vs vanilla DOM | React | Component model is worth the small dependency cost |
| Tailwind vs vanilla CSS | Vanilla CSS | Renderer surface is two screens; Tailwind is overkill |
| TypeScript strict | `strict: true` from day one | Catches the bugs the test suite would otherwise have to |

---

## File structure (target end-state)

```
discdeck-pc/
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── electron.vite.config.ts
├── electron-builder.yml          # stub; populated in Part 1.5
├── vitest.config.ts
├── .gitignore
├── README.md
├── LICENSE                       # already exists
│
├── src/
│   ├── main/
│   │   ├── index.ts              # entry: app.whenReady() → wires everything (Task 12)
│   │   ├── window.ts             # BrowserWindow + dynamic title (Task 10)
│   │   ├── tray.ts               # Tray icon, menu, notifications (Task 11)
│   │   ├── ipc.ts                # contextBridge channel definitions (Task 9)
│   │   ├── log.ts                # electron-log singleton (Task 1)
│   │   ├── state/
│   │   │   └── stream-state.ts   # pure state machine (Task 2)
│   │   └── network/              # ◄── Part 2 plug-in seam
│   │       ├── event-protocol.ts # message envelope types + validators (Task 4)
│   │       ├── event-server.ts   # LAN WS server (Task 5)
│   │       ├── ffmpeg-listener.ts # supervised ffmpeg subprocess (Task 6)
│   │       ├── video-relay.ts    # localhost-only WS (Task 7)
│   │       └── mdns.ts           # _discdeck._tcp.local advertiser (Task 8)
│   │
│   ├── preload/
│   │   └── index.ts              # contextBridge.exposeInMainWorld (Task 9)
│   │
│   ├── shared/
│   │   └── ipc-types.ts          # IPC channel + payload types shared by main + preload + renderer (Task 9)
│   │
│   └── renderer/
│       ├── index.html            # Task 13
│       ├── index.tsx             # Task 13
│       ├── App.tsx               # Task 16
│       ├── components/
│       │   ├── IdleSplash.tsx    # Task 14
│       │   └── VideoPlayer.tsx   # Task 15
│       └── styles.css            # Task 13
│
├── resources/
│   ├── icons/                    # Tray icon variants (Task 11)
│   │   ├── tray-idle.png
│   │   ├── tray-ready.png
│   │   ├── tray-live.png
│   │   └── tray-error.png
│   └── splash/                   # (empty in v1; idle splash is text-only)
│
├── test/
│   ├── unit/
│   │   ├── stream-state.test.ts        # Task 2
│   │   ├── window-title.test.ts        # Task 3
│   │   └── event-protocol.test.ts      # Task 4
│   ├── integration/
│   │   ├── event-server.test.ts        # Task 5
│   │   └── ffmpeg-listener.test.ts     # Task 6
│   └── dummy-producer/
│       ├── README.md                   # Task 17
│       ├── produce.ts                  # the test harness (Task 17)
│       └── push-testpattern.sh         # standalone ffmpeg one-liner (Task 17)
│
└── docs/
    ├── MANUAL_TEST.md                  # Task 18
    ├── PROTOCOL.md                     # Task 18 (extracted from spec §4)
    └── superpowers/
        ├── specs/
        │   └── 2026-04-06-discdeck-part1-design.md   # exists
        └── plans/
            └── 2026-04-06-discdeck-part1.md           # this document
```

### Boundary rules (enforced by Task 18 acceptance check)

1. **`src/renderer/`** must not import `electron`, `node:*`, `ws`, `fs`, or any Node API.
2. **`src/main/`** outside `src/main/network/` must not import `ws`, `bonjour-service`, or `child_process`.
3. **`src/main/network/`** must not import anything from `src/renderer/`.
4. **`src/preload/index.ts`** is the only file that calls `contextBridge.exposeInMainWorld`.

These rules are checked manually in Task 18 step 6.

---

## Task ordering rationale

1. **Tasks 1–4** build the pure-logic core (bootstrap → state machine → title formatter → protocol parser). Pure functions, fast unit tests, no Electron, no network. These are the load-bearing pieces and the first place a bug would be expensive.
2. **Tasks 5–8** build the network sidecars (event WS server → ffmpeg listener → video relay → mDNS). Each has integration tests against real localhost sockets. Ordered so each task can be tested independently before the next builds on it.
3. **Tasks 9–12** wire the Electron shell (IPC types → window → tray → main entry that composes everything). Tasks 9–11 each produce something testable in isolation; Task 12 is the integration point.
4. **Tasks 13–16** build the renderer (HTML scaffold → idle splash → video player → App that switches between them based on IPC state).
5. **Task 17** builds the dummy producer that drives the entire app end-to-end without a Deck.
6. **Task 18** writes manual test docs and runs the full acceptance checklist.

---

## Task 1: Project bootstrap

**Spec reference:** §6 (project structure), §9 (resolved open questions).

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `electron.vite.config.ts`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/main/log.ts` (used by every later task)
- Create: `src/main/index.ts` (placeholder; full implementation in Task 12)
- Create: `src/preload/index.ts` (placeholder; full implementation in Task 9)
- Create: `src/renderer/index.html` (placeholder; replaced in Task 13)
- Create: `src/renderer/index.tsx` (placeholder; replaced in Task 13)

- [ ] **Step 1.1: Initialize package.json**

Create `package.json`:

```json
{
  "name": "discdeck-pc",
  "version": "0.1.0",
  "description": "Steam Deck → Discord stream bridge: PC companion app",
  "main": "out/main/index.js",
  "type": "module",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "test": "vitest run test/unit",
    "test:watch": "vitest test/unit",
    "test:integration": "vitest run test/integration",
    "test:all": "vitest run",
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.node.json",
    "dummy:full": "tsx test/dummy-producer/produce.ts full",
    "dummy:events": "tsx test/dummy-producer/produce.ts events",
    "dummy:video": "tsx test/dummy-producer/produce.ts video",
    "dummy:flap": "tsx test/dummy-producer/produce.ts flap",
    "dummy:crash": "tsx test/dummy-producer/produce.ts crash",
    "dummy:bad-handshake": "tsx test/dummy-producer/produce.ts bad-handshake"
  },
  "dependencies": {
    "bonjour-service": "^1.2.1",
    "electron-log": "^5.1.7",
    "ffmpeg-static": "^5.2.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "uuid": "^10.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@types/uuid": "^10.0.0",
    "@types/ws": "^8.5.10",
    "@vitejs/plugin-react": "^4.3.1",
    "electron": "^31.0.0",
    "electron-vite": "^2.3.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vite": "^5.3.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 1.2: Run install**

Run: `npm install`
Expected: completes without errors. `node_modules/` and `package-lock.json` are created.

- [ ] **Step 1.3: Create root tsconfig.json**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": false,
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"]
    }
  },
  "include": ["src/renderer/**/*", "src/shared/**/*"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 1.4: Create node-side tsconfig.node.json**

Create `tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "composite": true,
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"]
    }
  },
  "include": [
    "src/main/**/*",
    "src/preload/**/*",
    "src/shared/**/*",
    "test/**/*",
    "electron.vite.config.ts",
    "vitest.config.ts"
  ]
}
```

- [ ] **Step 1.5: Create electron.vite.config.ts**

Create `electron.vite.config.ts`:

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
});
```

- [ ] **Step 1.6: Create vitest.config.ts**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
  },
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
});
```

- [ ] **Step 1.7: Create .gitignore**

Create `.gitignore`:

```
node_modules/
out/
dist/
*.log
.vite/
.electron-vite/
.DS_Store
.env
.env.*
.claude/
```

- [ ] **Step 1.8: Create src/main/log.ts**

Create `src/main/log.ts`:

```ts
import log from 'electron-log/main';

log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.transports.file.fileName = 'discdeck.log';

export const logger = log.scope('discdeck');
export default logger;
```

- [ ] **Step 1.9: Create src/main/index.ts placeholder**

Create `src/main/index.ts`:

```ts
import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import logger from './log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

app.whenReady().then(() => {
  logger.info('Discdeck PC starting (bootstrap placeholder)');
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 1.10: Create src/preload/index.ts placeholder**

Create `src/preload/index.ts`:

```ts
// Bootstrap placeholder. Real contextBridge wiring lands in Task 9.
console.log('[preload] loaded');
```

- [ ] **Step 1.11: Create src/renderer/index.html placeholder**

Create `src/renderer/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>🎮 Steam Deck (waiting)</title>
  </head>
  <body>
    <div id="root">Discdeck bootstrap OK</div>
    <script type="module" src="./index.tsx"></script>
  </body>
</html>
```

- [ ] **Step 1.12: Create src/renderer/index.tsx placeholder**

Create `src/renderer/index.tsx`:

```tsx
console.log('[renderer] bootstrap loaded');
```

- [ ] **Step 1.13: Verify dev server boots**

Run: `npm run dev`
Expected: Electron window opens showing "Discdeck bootstrap OK", title bar reads "🎮 Steam Deck (waiting)". Console logs `[preload] loaded` and `[renderer] bootstrap loaded`. No errors in stderr.
Close the window with Ctrl+C in the terminal to stop the dev server.

- [ ] **Step 1.14: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0, no output (or only the standard TypeScript "Found 0 errors" message depending on version).

- [ ] **Step 1.15: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.node.json electron.vite.config.ts vitest.config.ts .gitignore src/main/log.ts src/main/index.ts src/preload/index.ts src/renderer/index.html src/renderer/index.tsx
git commit -m "chore: bootstrap electron-vite + react + vitest scaffold"
```

---

## Task 2: Stream state machine (TDD)

**Spec reference:** §3.2 (sidecar supervision and crash-loop guard), §5.3 (renderer states), §7.2 (load-bearing test target).

**Files:**
- Create: `test/unit/stream-state.test.ts`
- Create: `src/main/state/stream-state.ts`

This module is pure logic with no I/O. It is the heart of the app: every other module either feeds it events or reads its state.

### State definition

The state machine has four states (`StreamState`):
- `idle` — no Deck connected, or Deck connected but no stream active
- `connecting` — Deck has sent `stream_starting` but no video frames have arrived yet
- `live` — video frames are flowing
- `error` — crash-loop guard tripped or unrecoverable error; stays here until explicit reset

It accepts six input events (`StreamEvent`):
- `deck_connected` — event WS handshake completed
- `deck_disconnected` — event WS dropped
- `stream_starting` — Deck sent `stream_starting` message
- `video_chunk_received` — first fMP4 chunk reached the relay
- `stream_stopped` — Deck sent `stream_stopped` OR ffmpeg listener exited normally
- `ffmpeg_crashed` — ffmpeg listener exited abnormally (used for crash-loop counting)
- `reconnect` — explicit user request from tray menu

It also tracks two pieces of context:
- `currentGame: string | null` — set/cleared by external `setGame` calls (driven by event_server message handlers, not by the state machine itself)
- `crashLoopCount: number` and `crashLoopWindowStart: number` — for the §3.2 crash-loop guard (3 abnormal exits in 30 seconds → `error`)

### Transition rules

| From | Event | To | Notes |
|---|---|---|---|
| any | `reconnect` | `idle` | Resets crash-loop counters |
| `idle` | `deck_connected` | `idle` | No state change; tracked separately as `deckConnected` flag |
| `idle` | `stream_starting` | `connecting` | Only if Deck is connected; otherwise ignored |
| `connecting` | `video_chunk_received` | `live` | First chunk wins |
| `connecting` | `stream_stopped` | `idle` | User cancelled before video arrived |
| `connecting` | `ffmpeg_crashed` | `idle` or `error` | Increments crash-loop count; → `error` if 3+ in 30s window |
| `live` | `stream_stopped` | `idle` | Normal end |
| `live` | `ffmpeg_crashed` | `idle` or `error` | Same crash-loop logic |
| `live` | `deck_disconnected` | `idle` | Deck went away |
| any | `deck_disconnected` | unchanged | Tracked in `deckConnected` flag only |
| `error` | any except `reconnect` | `error` | Sticky |

The state machine is pure: `reduce(currentState, event) → nextState`. No timers (the heartbeat-timeout is enforced by `event-server.ts` in Task 5; the state machine just receives `deck_disconnected`).

- [ ] **Step 2.1: Write the first failing test (initial state)**

Create `test/unit/stream-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createStreamState } from '../../src/main/state/stream-state.js';

describe('stream-state', () => {
  it('starts in idle with no deck and no game', () => {
    const sm = createStreamState();
    expect(sm.state).toBe('idle');
    expect(sm.deckConnected).toBe(false);
    expect(sm.currentGame).toBeNull();
  });
});
```

- [ ] **Step 2.2: Run test and confirm it fails**

Run: `npx vitest run test/unit/stream-state.test.ts`
Expected: FAIL — module `src/main/state/stream-state.ts` not found.

- [ ] **Step 2.3: Create minimal implementation that makes the first test pass**

Create `src/main/state/stream-state.ts`:

```ts
export type StreamState = 'idle' | 'connecting' | 'live' | 'error';

export type StreamEvent =
  | { type: 'deck_connected' }
  | { type: 'deck_disconnected' }
  | { type: 'stream_starting' }
  | { type: 'video_chunk_received' }
  | { type: 'stream_stopped' }
  | { type: 'ffmpeg_crashed'; at: number }
  | { type: 'reconnect' };

export interface StreamStateSnapshot {
  state: StreamState;
  deckConnected: boolean;
  currentGame: string | null;
  errorReason: string | null;
}

export interface StreamStateMachine extends StreamStateSnapshot {
  send(event: StreamEvent): StreamStateSnapshot;
  setGame(game: string | null): void;
  setError(reason: string | null): void;
  snapshot(): StreamStateSnapshot;
}

const CRASH_LOOP_THRESHOLD = 3;
const CRASH_LOOP_WINDOW_MS = 30_000;

export function createStreamState(): StreamStateMachine {
  let state: StreamState = 'idle';
  let deckConnected = false;
  let currentGame: string | null = null;
  let errorReason: string | null = null;
  let crashTimestamps: number[] = [];

  function snapshot(): StreamStateSnapshot {
    return { state, deckConnected, currentGame, errorReason };
  }

  function recordCrash(at: number): boolean {
    crashTimestamps = crashTimestamps.filter((t) => at - t < CRASH_LOOP_WINDOW_MS);
    crashTimestamps.push(at);
    return crashTimestamps.length >= CRASH_LOOP_THRESHOLD;
  }

  function send(event: StreamEvent): StreamStateSnapshot {
    if (event.type === 'reconnect') {
      state = 'idle';
      errorReason = null;
      crashTimestamps = [];
      return snapshot();
    }

    if (state === 'error') {
      // sticky; only `reconnect` can leave error state
      return snapshot();
    }

    switch (event.type) {
      case 'deck_connected':
        deckConnected = true;
        break;
      case 'deck_disconnected':
        deckConnected = false;
        if (state === 'live' || state === 'connecting') state = 'idle';
        break;
      case 'stream_starting':
        if (deckConnected && state === 'idle') state = 'connecting';
        break;
      case 'video_chunk_received':
        if (state === 'connecting') state = 'live';
        break;
      case 'stream_stopped':
        if (state === 'connecting' || state === 'live') state = 'idle';
        break;
      case 'ffmpeg_crashed': {
        const tripped = recordCrash(event.at);
        if (tripped) {
          state = 'error';
          errorReason = 'FFmpeg crashed 3+ times in 30s. Click Reconnect.';
        } else {
          if (state === 'connecting' || state === 'live') state = 'idle';
        }
        break;
      }
    }

    return snapshot();
  }

  return {
    get state() {
      return state;
    },
    get deckConnected() {
      return deckConnected;
    },
    get currentGame() {
      return currentGame;
    },
    get errorReason() {
      return errorReason;
    },
    send,
    snapshot,
    setGame(game) {
      currentGame = game;
    },
    setError(reason) {
      errorReason = reason;
      if (reason !== null) state = 'error';
    },
  };
}
```

- [ ] **Step 2.4: Run test and confirm it passes**

Run: `npx vitest run test/unit/stream-state.test.ts`
Expected: PASS (1 test).

- [ ] **Step 2.5: Add transition tests**

Append to `test/unit/stream-state.test.ts`:

```ts
describe('stream-state transitions', () => {
  it('deck_connected sets the connected flag without changing state', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    expect(sm.state).toBe('idle');
    expect(sm.deckConnected).toBe(true);
  });

  it('stream_starting goes idle → connecting only when deck is connected', () => {
    const sm = createStreamState();
    sm.send({ type: 'stream_starting' }); // ignored — no deck
    expect(sm.state).toBe('idle');
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    expect(sm.state).toBe('connecting');
  });

  it('first video_chunk_received goes connecting → live', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    expect(sm.state).toBe('live');
  });

  it('stream_stopped from live goes back to idle', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    sm.send({ type: 'stream_stopped' });
    expect(sm.state).toBe('idle');
  });

  it('deck_disconnected from live goes back to idle and clears flag', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    sm.send({ type: 'deck_disconnected' });
    expect(sm.state).toBe('idle');
    expect(sm.deckConnected).toBe(false);
  });

  it('stream_stopped from connecting (cancelled before video) goes idle', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'stream_stopped' });
    expect(sm.state).toBe('idle');
  });
});
```

- [ ] **Step 2.6: Run all stream-state tests**

Run: `npx vitest run test/unit/stream-state.test.ts`
Expected: 6 PASS.

- [ ] **Step 2.7: Add crash-loop tests**

Append:

```ts
describe('stream-state crash-loop guard', () => {
  it('two crashes within window stay in idle and do not trip', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    sm.send({ type: 'ffmpeg_crashed', at: 1000 });
    expect(sm.state).toBe('idle');
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    sm.send({ type: 'ffmpeg_crashed', at: 2000 });
    expect(sm.state).toBe('idle');
  });

  it('three crashes within 30s window trip the guard to error', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    for (let i = 0; i < 3; i++) {
      sm.send({ type: 'stream_starting' });
      sm.send({ type: 'video_chunk_received' });
      sm.send({ type: 'ffmpeg_crashed', at: 1000 + i * 1000 });
    }
    expect(sm.state).toBe('error');
    expect(sm.errorReason).toMatch(/3\+ times/);
  });

  it('three crashes spread over more than 30s do not trip', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    sm.send({ type: 'ffmpeg_crashed', at: 0 });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    sm.send({ type: 'ffmpeg_crashed', at: 20_000 });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    sm.send({ type: 'ffmpeg_crashed', at: 50_000 }); // first crash now outside window
    expect(sm.state).toBe('idle');
  });

  it('reconnect from error returns to idle and resets crash counter', () => {
    const sm = createStreamState();
    sm.send({ type: 'deck_connected' });
    for (let i = 0; i < 3; i++) {
      sm.send({ type: 'stream_starting' });
      sm.send({ type: 'video_chunk_received' });
      sm.send({ type: 'ffmpeg_crashed', at: 1000 + i * 1000 });
    }
    expect(sm.state).toBe('error');
    sm.send({ type: 'reconnect' });
    expect(sm.state).toBe('idle');
    expect(sm.errorReason).toBeNull();
  });

  it('error state is sticky to non-reconnect events', () => {
    const sm = createStreamState();
    sm.setError('test');
    sm.send({ type: 'deck_connected' });
    sm.send({ type: 'stream_starting' });
    sm.send({ type: 'video_chunk_received' });
    expect(sm.state).toBe('error');
  });
});
```

- [ ] **Step 2.8: Run all stream-state tests**

Run: `npx vitest run test/unit/stream-state.test.ts`
Expected: 11 PASS.

- [ ] **Step 2.9: Add setGame test**

Append:

```ts
describe('stream-state setGame', () => {
  it('setGame updates currentGame independently of state', () => {
    const sm = createStreamState();
    sm.setGame('Hollow Knight');
    expect(sm.currentGame).toBe('Hollow Knight');
    sm.setGame(null);
    expect(sm.currentGame).toBeNull();
  });
});
```

- [ ] **Step 2.10: Run all tests**

Run: `npx vitest run test/unit/stream-state.test.ts`
Expected: 12 PASS.

- [ ] **Step 2.11: Commit**

```bash
git add test/unit/stream-state.test.ts src/main/state/stream-state.ts
git commit -m "feat(state): pure stream state machine with crash-loop guard"
```

---

## Task 3: Window title formatter (TDD)

**Spec reference:** §5.1 (title format table).

**Files:**
- Create: `test/unit/window-title.test.ts`
- Create: `src/main/window.ts` (the formatter only — BrowserWindow setup added in Task 10)

The title formatter is a pure function `formatTitle(snapshot) → string` that maps a `StreamStateSnapshot` to the exact title string from spec §5.1. The leading "🎮 Steam Deck" must be invariant.

- [ ] **Step 3.1: Write the failing test**

Create `test/unit/window-title.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatTitle } from '../../src/main/window.js';

describe('formatTitle', () => {
  it('returns waiting title when no deck is connected', () => {
    expect(
      formatTitle({
        state: 'idle',
        deckConnected: false,
        currentGame: null,
        errorReason: null,
      }),
    ).toBe('🎮 Steam Deck (waiting)');
  });
});
```

- [ ] **Step 3.2: Run test and confirm it fails**

Run: `npx vitest run test/unit/window-title.test.ts`
Expected: FAIL — `formatTitle` is not exported by `src/main/window.ts` (or file does not exist).

- [ ] **Step 3.3: Create minimal implementation**

Create `src/main/window.ts`:

```ts
import type { StreamStateSnapshot } from './state/stream-state.js';

export function formatTitle(s: StreamStateSnapshot): string {
  const PREFIX = '🎮 Steam Deck';

  if (!s.deckConnected) return `${PREFIX} (waiting)`;
  if (s.currentGame === null) return PREFIX;

  const base = `${PREFIX} — ${s.currentGame}`;

  switch (s.state) {
    case 'connecting':
      return `${base} (connecting…)`;
    case 'error':
      return `${base} (error)`;
    case 'idle':
    case 'live':
    default:
      return base;
  }
}
```

- [ ] **Step 3.4: Run test and confirm it passes**

Run: `npx vitest run test/unit/window-title.test.ts`
Expected: PASS (1 test).

- [ ] **Step 3.5: Add tests for every row in the spec table**

Append to `test/unit/window-title.test.ts`:

```ts
describe('formatTitle — all spec rows', () => {
  const base = {
    deckConnected: true as const,
    errorReason: null,
  };

  it('deck connected, no game → "🎮 Steam Deck"', () => {
    expect(
      formatTitle({ ...base, state: 'idle', currentGame: null }),
    ).toBe('🎮 Steam Deck');
  });

  it('deck connected, game known, idle → "🎮 Steam Deck — Hollow Knight"', () => {
    expect(
      formatTitle({ ...base, state: 'idle', currentGame: 'Hollow Knight' }),
    ).toBe('🎮 Steam Deck — Hollow Knight');
  });

  it('connecting → adds "(connecting…)" suffix', () => {
    expect(
      formatTitle({ ...base, state: 'connecting', currentGame: 'Hollow Knight' }),
    ).toBe('🎮 Steam Deck — Hollow Knight (connecting…)');
  });

  it('live → no suffix (same as idle with game)', () => {
    expect(
      formatTitle({ ...base, state: 'live', currentGame: 'Hollow Knight' }),
    ).toBe('🎮 Steam Deck — Hollow Knight');
  });

  it('error with game → adds "(error)" suffix', () => {
    expect(
      formatTitle({ ...base, state: 'error', currentGame: 'Hollow Knight' }),
    ).toBe('🎮 Steam Deck — Hollow Knight (error)');
  });

  it('all titles begin with the invariant prefix', () => {
    const cases = [
      { state: 'idle', deckConnected: false, currentGame: null, errorReason: null },
      { state: 'idle', deckConnected: true, currentGame: null, errorReason: null },
      { state: 'live', deckConnected: true, currentGame: 'Hades', errorReason: null },
      { state: 'error', deckConnected: true, currentGame: 'Hades', errorReason: 'x' },
    ] as const;
    for (const c of cases) {
      expect(formatTitle(c).startsWith('🎮 Steam Deck')).toBe(true);
    }
  });
});
```

- [ ] **Step 3.6: Run all title tests**

Run: `npx vitest run test/unit/window-title.test.ts`
Expected: 7 PASS.

- [ ] **Step 3.7: Commit**

```bash
git add test/unit/window-title.test.ts src/main/window.ts
git commit -m "feat(window): pure title formatter covering all spec states"
```

---

## Task 4: Event protocol types and validators (TDD)

**Spec reference:** §4 (entire section — envelope, message types, version handling).

**Files:**
- Create: `test/unit/event-protocol.test.ts`
- Create: `src/main/network/event-protocol.ts`

This module defines the typed envelope and a validator that rejects malformed messages, unknown types, and version mismatches. It is pure JSON parsing — no I/O.

### Validator contract

`parseMessage(raw: string): ParseResult` returns a discriminated union:
- `{ ok: true, message: EventMessage }` on success
- `{ ok: false, code: 'bad_json' | 'bad_envelope' | 'unknown_type' | 'version_mismatch'; reason: string }` on failure

The validator does NOT enforce data shape per type beyond the envelope — the consumer (event-server) handles per-type validation. This keeps the validator dumb and the consumer authoritative.

- [ ] **Step 4.1: Write the first failing test**

Create `test/unit/event-protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseMessage, PROTOCOL_VERSION } from '../../src/main/network/event-protocol.js';

describe('parseMessage', () => {
  it('exports the protocol version constant', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('parses a valid hello envelope', () => {
    const raw = JSON.stringify({
      v: 1,
      type: 'hello',
      id: 'abc',
      ts: '2026-04-06T00:00:00.000Z',
      data: { client: 'decky-discdeck', client_version: '0.1.0', deck_name: 'X', capabilities: [] },
    });
    const result = parseMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.type).toBe('hello');
      expect(result.message.v).toBe(1);
    }
  });
});
```

- [ ] **Step 4.2: Run test and confirm it fails**

Run: `npx vitest run test/unit/event-protocol.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4.3: Create minimal implementation**

Create `src/main/network/event-protocol.ts`:

```ts
export const PROTOCOL_VERSION = 1 as const;

export type EventMessageType =
  | 'hello'
  | 'welcome'
  | 'game_start'
  | 'game_change'
  | 'game_stop'
  | 'stream_starting'
  | 'stream_stopped'
  | 'heartbeat'
  | 'error';

export const KNOWN_TYPES: ReadonlySet<EventMessageType> = new Set([
  'hello',
  'welcome',
  'game_start',
  'game_change',
  'game_stop',
  'stream_starting',
  'stream_stopped',
  'heartbeat',
  'error',
]);

export interface EventMessage<T extends EventMessageType = EventMessageType> {
  v: number;
  type: T;
  id: string;
  ts: string;
  data: Record<string, unknown>;
}

export type ParseResult =
  | { ok: true; message: EventMessage }
  | {
      ok: false;
      code: 'bad_json' | 'bad_envelope' | 'unknown_type' | 'version_mismatch';
      reason: string;
    };

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function parseMessage(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, code: 'bad_json', reason: (e as Error).message };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, code: 'bad_envelope', reason: 'message is not a JSON object' };
  }
  const { v, type, id, ts, data } = parsed as Record<string, unknown>;
  if (typeof v !== 'number') {
    return { ok: false, code: 'bad_envelope', reason: 'v must be a number' };
  }
  if (v !== PROTOCOL_VERSION) {
    return { ok: false, code: 'version_mismatch', reason: `expected v=${PROTOCOL_VERSION}, got v=${v}` };
  }
  if (typeof type !== 'string') {
    return { ok: false, code: 'bad_envelope', reason: 'type must be a string' };
  }
  if (!KNOWN_TYPES.has(type as EventMessageType)) {
    return { ok: false, code: 'unknown_type', reason: `unknown message type: ${type}` };
  }
  if (typeof id !== 'string') {
    return { ok: false, code: 'bad_envelope', reason: 'id must be a string' };
  }
  if (typeof ts !== 'string') {
    return { ok: false, code: 'bad_envelope', reason: 'ts must be a string' };
  }
  if (!isPlainObject(data)) {
    return { ok: false, code: 'bad_envelope', reason: 'data must be an object' };
  }
  return {
    ok: true,
    message: { v, type: type as EventMessageType, id, ts, data },
  };
}

import { v4 as uuidv4 } from 'uuid';

export function makeMessage<T extends EventMessageType>(
  type: T,
  data: Record<string, unknown> = {},
): EventMessage<T> {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: uuidv4(),
    ts: new Date().toISOString(),
    data,
  };
}
```

- [ ] **Step 4.4: Run tests and confirm they pass**

Run: `npx vitest run test/unit/event-protocol.test.ts`
Expected: 2 PASS.

- [ ] **Step 4.5: Add the makeMessage import to the top of the test file**

Update the existing import line at the top of `test/unit/event-protocol.test.ts` to include `makeMessage`:

```ts
import { parseMessage, makeMessage, PROTOCOL_VERSION } from '../../src/main/network/event-protocol.js';
```

- [ ] **Step 4.6: Add negative-path tests and the makeMessage round-trip test**

Append to `test/unit/event-protocol.test.ts`:

```ts
describe('parseMessage — error paths', () => {
  it('rejects non-JSON input', () => {
    const r = parseMessage('not json {');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_json');
  });

  it('rejects a JSON array', () => {
    const r = parseMessage('[]');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_envelope');
  });

  it('rejects missing v', () => {
    const r = parseMessage(JSON.stringify({ type: 'hello', id: 'a', ts: 'b', data: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_envelope');
  });

  it('rejects version mismatch', () => {
    const r = parseMessage(JSON.stringify({ v: 99, type: 'hello', id: 'a', ts: 'b', data: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('version_mismatch');
  });

  it('rejects unknown type', () => {
    const r = parseMessage(JSON.stringify({ v: 1, type: 'mystery', id: 'a', ts: 'b', data: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unknown_type');
  });

  it('rejects non-object data', () => {
    const r = parseMessage(JSON.stringify({ v: 1, type: 'hello', id: 'a', ts: 'b', data: 'oops' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_envelope');
  });

  it('accepts every known type with empty data', () => {
    const types = [
      'hello',
      'welcome',
      'game_start',
      'game_change',
      'game_stop',
      'stream_starting',
      'stream_stopped',
      'heartbeat',
      'error',
    ] as const;
    for (const type of types) {
      const r = parseMessage(JSON.stringify({ v: 1, type, id: 'x', ts: 'y', data: {} }));
      expect(r.ok).toBe(true);
    }
  });
});

describe('makeMessage', () => {
  it('produces a valid envelope that round-trips through parseMessage', () => {
    const msg = makeMessage('heartbeat');
    const r = parseMessage(JSON.stringify(msg));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message.type).toBe('heartbeat');
      expect(r.message.v).toBe(1);
      expect(typeof r.message.id).toBe('string');
      expect(r.message.id.length).toBeGreaterThan(0);
    }
  });

  it('preserves custom data through round-trip', () => {
    const msg = makeMessage('game_start', { game_name: 'Hollow Knight', app_id: '367520' });
    const r = parseMessage(JSON.stringify(msg));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message.data.game_name).toBe('Hollow Knight');
  });
});
```

- [ ] **Step 4.7: Run all event-protocol tests**

Run: `npx vitest run test/unit/event-protocol.test.ts`
Expected: 11 PASS.

- [ ] **Step 4.8: Run the full unit test suite**

Run: `npm test`
Expected: All unit tests across stream-state, window-title, and event-protocol pass.

- [ ] **Step 4.9: Commit**

```bash
git add test/unit/event-protocol.test.ts src/main/network/event-protocol.ts
git commit -m "feat(network): event protocol envelope, validator, and message factory"
```

---

## Task 5: Event WebSocket server (integration TDD)

**Spec reference:** §4.1 (transport, single-connection, heartbeat), §3.1 (lifecycle ownership), §4.5 (typical session).

**Files:**
- Create: `test/integration/event-server.test.ts`
- Create: `src/main/network/event-server.ts`

The event server is a thin wrapper around `ws.WebSocketServer` that:
1. Accepts at most one active Deck connection on `ws://0.0.0.0:8765/events`. A second connection causes the first to be closed with code `4000` (`replaced`).
2. Performs the `hello`/`welcome` handshake before treating the connection as "live."
3. Emits parsed `EventMessage` objects via a typed callback for the consumer (state machine wiring in Task 12).
4. Sends `heartbeat` every 5 seconds and closes the connection if 15 seconds pass without receiving any message from the Deck.

The integration tests use a real `ws` client to drive the real server on a random port. No mocking.

- [ ] **Step 5.1: Write the first failing test**

Create `test/integration/event-server.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startEventServer, type EventServer } from '../../src/main/network/event-server.js';
import { makeMessage } from '../../src/main/network/event-protocol.js';

let server: EventServer | null = null;

beforeEach(async () => {
  server = await startEventServer({ port: 0, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 600 });
});

afterEach(async () => {
  if (server) await server.stop();
  server = null;
});

function url(): string {
  return `ws://127.0.0.1:${server!.port}/events`;
}

function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url());
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function recv(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(data.toString()));
    ws.once('error', reject);
  });
}

describe('event-server: handshake', () => {
  it('accepts hello and replies with welcome', async () => {
    const ws = await open();
    ws.send(JSON.stringify(makeMessage('hello', { client: 'test', client_version: '0.0.0', deck_name: 'TestDeck', capabilities: ['video', 'events'] })));
    const reply = JSON.parse(await recv(ws));
    expect(reply.type).toBe('welcome');
    expect(reply.v).toBe(1);
    ws.close();
  });
});
```

- [ ] **Step 5.2: Run test and confirm it fails**

Run: `npx vitest run test/integration/event-server.test.ts`
Expected: FAIL — `startEventServer` not exported.

- [ ] **Step 5.3: Create the implementation**

Create `src/main/network/event-server.ts`:

```ts
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { AddressInfo } from 'net';
import { parseMessage, makeMessage, type EventMessage } from './event-protocol.js';
import logger from '../log.js';

export interface EventServerOptions {
  port: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  serverVersion?: string;
}

export interface EventServerCallbacks {
  onConnected?: (info: { deckName: string }) => void;
  onDisconnected?: () => void;
  onMessage?: (msg: EventMessage) => void;
  onError?: (err: { code: string; reason: string }) => void;
}

export interface EventServer {
  port: number;
  setCallbacks(cb: EventServerCallbacks): void;
  send(msg: EventMessage): void;
  stop(): Promise<void>;
}

const REPLACED_CODE = 4000;

export function startEventServer(options: EventServerOptions): Promise<EventServer> {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 15_000;
  const serverVersion = options.serverVersion ?? '0.1.0';

  let callbacks: EventServerCallbacks = {};
  let activeSocket: WebSocket | null = null;
  let activeHeartbeatInterval: NodeJS.Timeout | null = null;
  let activeTimeoutTimer: NodeJS.Timeout | null = null;
  let activeDeckName: string | null = null;

  const wss = new WebSocketServer({ port: options.port, path: '/events' });

  function clearActiveTimers() {
    if (activeHeartbeatInterval) clearInterval(activeHeartbeatInterval);
    if (activeTimeoutTimer) clearTimeout(activeTimeoutTimer);
    activeHeartbeatInterval = null;
    activeTimeoutTimer = null;
  }

  function tearDownActive(reason: string) {
    clearActiveTimers();
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      try {
        activeSocket.close(1000, reason);
      } catch {
        /* ignore */
      }
    }
    activeSocket = null;
    if (activeDeckName !== null) {
      activeDeckName = null;
      callbacks.onDisconnected?.();
    }
  }

  function resetTimeout() {
    if (activeTimeoutTimer) clearTimeout(activeTimeoutTimer);
    activeTimeoutTimer = setTimeout(() => {
      logger.warn('event-server: heartbeat timeout, closing connection');
      tearDownActive('heartbeat timeout');
    }, heartbeatTimeoutMs);
  }

  wss.on('connection', (socket) => {
    if (activeSocket) {
      logger.info('event-server: replacing previous connection');
      try {
        activeSocket.close(REPLACED_CODE, 'replaced');
      } catch {
        /* ignore */
      }
      clearActiveTimers();
      activeSocket = null;
    }

    let handshakeComplete = false;

    const handshakeTimeout = setTimeout(() => {
      if (!handshakeComplete) {
        logger.warn('event-server: handshake timeout, closing');
        try {
          socket.close(1002, 'handshake timeout');
        } catch {
          /* ignore */
        }
      }
    }, 5_000);

    socket.on('message', (data: RawData) => {
      const raw = data.toString();
      const result = parseMessage(raw);
      if (!result.ok) {
        logger.warn('event-server: parse error', result);
        callbacks.onError?.({ code: result.code, reason: result.reason });
        try {
          socket.close(1002, result.code);
        } catch {
          /* ignore */
        }
        return;
      }

      if (!handshakeComplete) {
        if (result.message.type !== 'hello') {
          logger.warn('event-server: first message was not hello');
          try {
            socket.close(1002, 'expected hello');
          } catch {
            /* ignore */
          }
          return;
        }
        clearTimeout(handshakeTimeout);
        handshakeComplete = true;
        activeSocket = socket;
        const deckName =
          typeof result.message.data.deck_name === 'string' ? result.message.data.deck_name : 'Unknown Deck';
        activeDeckName = deckName;
        const welcome = makeMessage('welcome', {
          server: 'discdeck-pc',
          server_version: serverVersion,
          accepted_capabilities: ['video', 'events'],
        });
        try {
          socket.send(JSON.stringify(welcome));
        } catch (e) {
          logger.error('event-server: failed to send welcome', e);
        }

        // Start heartbeat & timeout cycle
        activeHeartbeatInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            try {
              socket.send(JSON.stringify(makeMessage('heartbeat')));
            } catch (e) {
              logger.warn('event-server: heartbeat send failed', e);
            }
          }
        }, heartbeatIntervalMs);
        resetTimeout();

        callbacks.onConnected?.({ deckName });
        return;
      }

      // Past handshake: any received message resets the timeout
      resetTimeout();
      // Heartbeats are not forwarded to the consumer
      if (result.message.type !== 'heartbeat') {
        callbacks.onMessage?.(result.message);
      }
    });

    socket.on('close', () => {
      clearTimeout(handshakeTimeout);
      if (activeSocket === socket) {
        tearDownActive('peer closed');
      }
    });

    socket.on('error', (err) => {
      logger.warn('event-server: socket error', err);
    });
  });

  return new Promise((resolve, reject) => {
    wss.once('listening', () => {
      const addr = wss.address() as AddressInfo;
      logger.info(`event-server: listening on :${addr.port}/events`);
      resolve({
        get port() {
          return addr.port;
        },
        setCallbacks(cb) {
          callbacks = cb;
        },
        send(msg) {
          if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
            try {
              activeSocket.send(JSON.stringify(msg));
            } catch (e) {
              logger.warn('event-server: send failed', e);
            }
          }
        },
        async stop() {
          tearDownActive('server stop');
          await new Promise<void>((res) => wss.close(() => res()));
          logger.info('event-server: stopped');
        },
      });
    });
    wss.once('error', reject);
  });
}
```

- [ ] **Step 5.4: Run handshake test and confirm pass**

Run: `npx vitest run test/integration/event-server.test.ts`
Expected: 1 PASS.

- [ ] **Step 5.5: Add tests for single-connection enforcement, message forwarding, and heartbeat timeout**

Append:

```ts
async function helloAndWelcome(ws: WebSocket): Promise<void> {
  ws.send(JSON.stringify(makeMessage('hello', { client: 'test', client_version: '0.0.0', deck_name: 'TestDeck', capabilities: ['video', 'events'] })));
  const reply = JSON.parse(await recv(ws));
  if (reply.type !== 'welcome') throw new Error('expected welcome, got ' + reply.type);
}

describe('event-server: single connection enforcement', () => {
  it('closes the previous connection when a second client connects', async () => {
    const a = await open();
    await helloAndWelcome(a);
    const closedReason = new Promise<number>((resolve) => a.once('close', (code) => resolve(code)));
    const b = await open();
    await helloAndWelcome(b);
    const code = await closedReason;
    expect(code).toBe(4000);
    b.close();
  });
});

describe('event-server: callback fan-out', () => {
  it('forwards non-heartbeat messages to onMessage', async () => {
    const received: string[] = [];
    server!.setCallbacks({
      onMessage: (msg) => received.push(msg.type),
    });
    const ws = await open();
    await helloAndWelcome(ws);
    ws.send(JSON.stringify(makeMessage('game_start', { game_name: 'Hollow Knight' })));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toContain('game_start');
    expect(received).not.toContain('heartbeat');
    ws.close();
  });

  it('does not forward heartbeats but does reset the timeout', async () => {
    let dropped = false;
    server!.setCallbacks({
      onDisconnected: () => {
        dropped = true;
      },
    });
    const ws = await open();
    await helloAndWelcome(ws);
    // Send heartbeats faster than the configured timeout
    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(makeMessage('heartbeat')));
      }
    }, 100);
    await new Promise((r) => setTimeout(r, 1200)); // longer than heartbeatTimeoutMs=600
    clearInterval(interval);
    expect(dropped).toBe(false);
    ws.close();
  });
});

describe('event-server: heartbeat timeout', () => {
  it('drops the connection if no message arrives within the timeout window', async () => {
    let dropped = false;
    server!.setCallbacks({
      onDisconnected: () => {
        dropped = true;
      },
    });
    const ws = await open();
    await helloAndWelcome(ws);
    // Stop responding entirely; server will time us out (heartbeatTimeoutMs=600)
    await new Promise((r) => setTimeout(r, 1200));
    expect(dropped).toBe(true);
    ws.terminate();
  });
});

describe('event-server: bad input', () => {
  it('closes connection on garbage hello', async () => {
    const ws = await open();
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.send('not even json');
    await closed;
  });

  it('closes connection if first message is not hello', async () => {
    const ws = await open();
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.send(JSON.stringify(makeMessage('game_start', { game_name: 'X' })));
    await closed;
  });
});
```

- [ ] **Step 5.6: Run all event-server integration tests**

Run: `npx vitest run test/integration/event-server.test.ts`
Expected: 7 PASS. Test runtime around 4-6 seconds total (the heartbeat tests deliberately wait).

- [ ] **Step 5.7: Commit**

```bash
git add test/integration/event-server.test.ts src/main/network/event-server.ts
git commit -m "feat(network): event WebSocket server with handshake and heartbeat"
```

---

## Task 6: FFmpeg listener subprocess (integration TDD)

**Spec reference:** §3.2 (sidecar supervision), §3.3 (data flow), §2.1 (RTSP listener config).

**Files:**
- Create: `test/integration/ffmpeg-listener.test.ts`
- Create: `src/main/network/ffmpeg-listener.ts`

The `ffmpeg-listener` module spawns and supervises a single bundled `ffmpeg` process running in RTSP listen mode. It exposes:
- `start()` — spawns ffmpeg, starts forwarding stdout chunks via callback
- `stop()` — kills ffmpeg with SIGTERM, escalates to SIGKILL after 2s
- `onChunk(cb)` — receives `Buffer` chunks of fragmented MP4
- `onExit(cb)` — receives `{ code, signal, normal }` where `normal` is `true` for clean exits

**Note:** The `ffmpeg-static` package returns the binary path as its default export. On Windows it includes the `.exe` extension automatically.

The integration test:
1. Starts the listener on a free port.
2. Spawns a *second* ffmpeg as a test producer pushing a 2-second test pattern to that port.
3. Asserts at least one chunk arrives via the callback within 5 seconds.
4. Cleans up both processes.

- [ ] **Step 6.1: Write the failing test**

Create `test/integration/ffmpeg-listener.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { createFfmpegListener, type FfmpegListener } from '../../src/main/network/ffmpeg-listener.js';

let listener: FfmpegListener | null = null;
let producer: ChildProcess | null = null;

afterEach(async () => {
  if (producer) {
    producer.kill('SIGKILL');
    producer = null;
  }
  if (listener) {
    await listener.stop();
    listener = null;
  }
});

function pushTestPattern(port: number): ChildProcess {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary path');
  return spawn(
    ffmpegPath,
    [
      '-re',
      '-f', 'lavfi',
      '-i', 'testsrc2=size=320x240:rate=15:duration=2',
      '-c:v', 'libx264',
      '-tune', 'zerolatency',
      '-preset', 'ultrafast',
      '-g', '15',
      '-pix_fmt', 'yuv420p',
      '-f', 'rtsp',
      `rtsp://127.0.0.1:${port}/deck`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
}

describe('ffmpeg-listener', () => {
  it('receives fMP4 chunks from a real RTSP push', async () => {
    listener = await createFfmpegListener({ port: 18554 });
    let chunkCount = 0;
    let totalBytes = 0;
    listener.onChunk((buf) => {
      chunkCount += 1;
      totalBytes += buf.length;
    });
    listener.start();

    // Give the listener a moment to be ready before pushing
    await new Promise((r) => setTimeout(r, 500));
    producer = pushTestPattern(18554);

    // Wait up to 8 seconds for first chunks
    const start = Date.now();
    while (chunkCount === 0 && Date.now() - start < 8_000) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(chunkCount).toBeGreaterThan(0);
    expect(totalBytes).toBeGreaterThan(100);
  }, 15_000);
});
```

- [ ] **Step 6.2: Run test and confirm it fails**

Run: `npx vitest run test/integration/ffmpeg-listener.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6.3: Create the implementation**

Create `src/main/network/ffmpeg-listener.ts`:

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import logger from '../log.js';

export interface FfmpegListenerOptions {
  port: number;
  bindHost?: string;
  path?: string;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  normal: boolean;
}

export interface FfmpegListener {
  start(): void;
  stop(): Promise<void>;
  onChunk(cb: (chunk: Buffer) => void): void;
  onExit(cb: (info: ExitInfo) => void): void;
}

export function createFfmpegListener(options: FfmpegListenerOptions): Promise<FfmpegListener> {
  const port = options.port;
  const host = options.bindHost ?? '0.0.0.0';
  const path = options.path ?? '/deck';
  const url = `rtsp://${host}:${port}${path}`;

  let proc: ChildProcessWithoutNullStreams | null = null;
  let chunkCb: ((chunk: Buffer) => void) | null = null;
  let exitCb: ((info: ExitInfo) => void) | null = null;
  let stopping = false;

  function spawnProc() {
    if (!ffmpegPath) {
      throw new Error('ffmpeg-static did not provide a binary path');
    }
    const args = [
      '-rtsp_flags', 'listen',
      '-i', url,
      '-c:v', 'copy',
      '-an',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1',
    ];
    logger.info(`ffmpeg-listener: spawning ${ffmpegPath} ${args.join(' ')}`);
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    p.stdout.on('data', (chunk: Buffer) => {
      if (chunkCb) chunkCb(chunk);
    });
    p.stderr.on('data', (chunk: Buffer) => {
      logger.debug(`ffmpeg-listener[stderr]: ${chunk.toString().trimEnd()}`);
    });
    p.on('exit', (code, signal) => {
      const normal = stopping || code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL';
      logger.info(`ffmpeg-listener: exit code=${code} signal=${signal} normal=${normal}`);
      proc = null;
      if (exitCb) exitCb({ code, signal, normal });
    });

    return p;
  }

  return Promise.resolve({
    start() {
      if (proc) return;
      stopping = false;
      proc = spawnProc();
    },
    async stop() {
      if (!proc) return;
      stopping = true;
      const p = proc;
      p.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (!p.killed) p.kill('SIGKILL');
          resolve();
        }, 2_000);
        p.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
      proc = null;
    },
    onChunk(cb) {
      chunkCb = cb;
    },
    onExit(cb) {
      exitCb = cb;
    },
  });
}
```

- [ ] **Step 6.4: Run the integration test**

Run: `npx vitest run test/integration/ffmpeg-listener.test.ts`
Expected: PASS within ~10 seconds. If it fails with "Connection refused" or similar, increase the 500 ms warmup in the test to 1000 ms; on slower machines ffmpeg-listen takes longer to bind.

- [ ] **Step 6.5: Run all integration tests together**

Run: `npm run test:integration`
Expected: All passing (event-server + ffmpeg-listener).

- [ ] **Step 6.6: Commit**

```bash
git add test/integration/ffmpeg-listener.test.ts src/main/network/ffmpeg-listener.ts
git commit -m "feat(network): supervised ffmpeg RTSP listener with fMP4 stdout pipe"
```

---

## Task 7: Video relay WebSocket server

**Spec reference:** §3 (process model — localhost video relay), §3.3 (data flow step 3).

**Files:**
- Create: `src/main/network/video-relay.ts`

A trivial localhost-only WebSocket server that broadcasts incoming `Buffer` chunks to all connected clients (in practice, the renderer is the only client). No tests for this module beyond a tiny smoke test — it is a 30-line wrapper around `ws.WebSocketServer` and the value is in the integration with Task 6 (covered by Task 12 wiring).

- [ ] **Step 7.1: Create the implementation**

Create `src/main/network/video-relay.ts`:

```ts
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import logger from '../log.js';

export interface VideoRelay {
  port: number;
  push(chunk: Buffer): void;
  stop(): Promise<void>;
}

export function startVideoRelay(): Promise<VideoRelay> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });

  return new Promise((resolve, reject) => {
    wss.once('listening', () => {
      const addr = wss.address() as AddressInfo;
      logger.info(`video-relay: listening on 127.0.0.1:${addr.port}`);
      resolve({
        get port() {
          return addr.port;
        },
        push(chunk) {
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
              try {
                client.send(chunk, { binary: true });
              } catch (e) {
                logger.warn('video-relay: client send failed', e);
              }
            }
          }
        },
        async stop() {
          for (const client of wss.clients) {
            try {
              client.close(1001, 'shutdown');
            } catch {
              /* ignore */
            }
          }
          await new Promise<void>((res) => wss.close(() => res()));
          logger.info('video-relay: stopped');
        },
      });
    });
    wss.once('error', reject);
  });
}
```

- [ ] **Step 7.2: Verify it typechecks**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 7.3: Commit**

```bash
git add src/main/network/video-relay.ts
git commit -m "feat(network): localhost video relay WebSocket"
```

---

## Task 8: mDNS responder

**Spec reference:** §2.3 (mDNS discovery).

**Files:**
- Create: `src/main/network/mdns.ts`

Publishes a single `_discdeck._tcp.local` service record advertising both the event WS port (8765) and the RTSP listener port (8554). The video relay port is *not* advertised — it is localhost-only and not discoverable.

- [ ] **Step 8.1: Create the implementation**

Create `src/main/network/mdns.ts`:

```ts
import { Bonjour } from 'bonjour-service';
import os from 'os';
import logger from '../log.js';

export interface MdnsService {
  stop(): Promise<void>;
}

export interface MdnsOptions {
  eventPort: number;
  rtspPort: number;
  serviceName?: string;
}

export function publishMdnsService(options: MdnsOptions): MdnsService {
  const bonjour = new Bonjour();
  const name = options.serviceName ?? `Discdeck on ${os.hostname()}`;
  const service = bonjour.publish({
    name,
    type: 'discdeck',
    protocol: 'tcp',
    port: options.eventPort,
    txt: {
      event_port: String(options.eventPort),
      rtsp_port: String(options.rtspPort),
      protocol_version: '1',
    },
  });
  service.on('up', () => logger.info(`mdns: published ${name} (event=${options.eventPort}, rtsp=${options.rtspPort})`));
  service.on('error', (err: Error) => logger.warn('mdns: error', err));

  return {
    async stop() {
      await new Promise<void>((resolve) => {
        service.stop(() => resolve());
      });
      bonjour.destroy();
      logger.info('mdns: stopped');
    },
  };
}
```

- [ ] **Step 8.2: Verify it typechecks**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 8.3: Commit**

```bash
git add src/main/network/mdns.ts
git commit -m "feat(network): mDNS service advertiser"
```

---

## Task 9: IPC bridge (typed)

**Spec reference:** §3.1 (lifecycle ownership rule), §6.1 (boundaries 1 and 3).

**Files:**
- Create: `src/shared/ipc-types.ts`
- Modify: `src/preload/index.ts` (replace placeholder)
- Create: `src/main/ipc.ts`

The IPC bridge defines exactly the channels that cross the main↔renderer boundary. Per §6.1 boundary rule 1, **video frames never cross IPC** — they go through the localhost video-relay WebSocket. Only state updates and small commands cross.

### Channel inventory

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `state:update` | main → renderer | `RendererState` | Push current snapshot whenever it changes |
| `state:get` | renderer → main (invoke) | `void → RendererState` | Pull on initial mount |
| `video:port` | renderer → main (invoke) | `void → number` | Renderer asks where to connect for video chunks |
| `command:reconnect` | renderer → main (send) | `void` | Wired in Task 11 (tray menu also dispatches this) |

`RendererState` is a flat snapshot the renderer can render directly:

```ts
{
  state: 'idle' | 'connecting' | 'live' | 'error';
  deckConnected: boolean;
  currentGame: string | null;
  errorReason: string | null;
}
```

(Identical to `StreamStateSnapshot` from Task 2.)

- [ ] **Step 9.1: Create src/shared/ipc-types.ts**

Create `src/shared/ipc-types.ts`:

```ts
export type RendererStreamState = 'idle' | 'connecting' | 'live' | 'error';

export interface RendererState {
  state: RendererStreamState;
  deckConnected: boolean;
  currentGame: string | null;
  errorReason: string | null;
}

export const IPC_CHANNELS = {
  STATE_UPDATE: 'state:update',
  STATE_GET: 'state:get',
  VIDEO_PORT: 'video:port',
  COMMAND_RECONNECT: 'command:reconnect',
} as const;

export interface DiscdeckBridge {
  getState(): Promise<RendererState>;
  onStateUpdate(cb: (state: RendererState) => void): () => void;
  getVideoPort(): Promise<number>;
  reconnect(): void;
}

declare global {
  interface Window {
    discdeck: DiscdeckBridge;
  }
}
```

- [ ] **Step 9.2: Replace src/preload/index.ts with the real bridge**

Replace `src/preload/index.ts` entirely:

```ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type RendererState, type DiscdeckBridge } from '@shared/ipc-types';

const bridge: DiscdeckBridge = {
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.STATE_GET) as Promise<RendererState>,
  onStateUpdate: (cb) => {
    const listener = (_event: unknown, state: RendererState) => cb(state);
    ipcRenderer.on(IPC_CHANNELS.STATE_UPDATE, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.STATE_UPDATE, listener);
    };
  },
  getVideoPort: () => ipcRenderer.invoke(IPC_CHANNELS.VIDEO_PORT) as Promise<number>,
  reconnect: () => ipcRenderer.send(IPC_CHANNELS.COMMAND_RECONNECT),
};

contextBridge.exposeInMainWorld('discdeck', bridge);
```

- [ ] **Step 9.3: Create src/main/ipc.ts**

Create `src/main/ipc.ts`:

```ts
import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, type RendererState } from '@shared/ipc-types';
import logger from './log.js';

export interface IpcRouter {
  publish(state: RendererState): void;
  dispose(): void;
}

export interface IpcRouterDeps {
  getState: () => RendererState;
  getVideoPort: () => number;
  onReconnect: () => void;
  getWindow: () => BrowserWindow | null;
}

export function createIpcRouter(deps: IpcRouterDeps): IpcRouter {
  const stateGetHandler = () => deps.getState();
  const videoPortHandler = () => deps.getVideoPort();
  const reconnectHandler = () => {
    logger.info('ipc: reconnect command received');
    deps.onReconnect();
  };

  ipcMain.handle(IPC_CHANNELS.STATE_GET, stateGetHandler);
  ipcMain.handle(IPC_CHANNELS.VIDEO_PORT, videoPortHandler);
  ipcMain.on(IPC_CHANNELS.COMMAND_RECONNECT, reconnectHandler);

  return {
    publish(state) {
      const win = deps.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.STATE_UPDATE, state);
      }
    },
    dispose() {
      ipcMain.removeHandler(IPC_CHANNELS.STATE_GET);
      ipcMain.removeHandler(IPC_CHANNELS.VIDEO_PORT);
      ipcMain.removeListener(IPC_CHANNELS.COMMAND_RECONNECT, reconnectHandler);
    },
  };
}
```

- [ ] **Step 9.4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 9.5: Commit**

```bash
git add src/shared/ipc-types.ts src/preload/index.ts src/main/ipc.ts
git commit -m "feat(ipc): typed contextBridge with state push and command channels"
```

---

## Task 10: BrowserWindow + dynamic title

**Spec reference:** §5.1 (title format), §5.2 (window properties), §5.6 (close-to-tray semantics).

**Files:**
- Modify: `src/main/window.ts` (extend with createWindow function)

The pure `formatTitle` function from Task 3 stays. We add a `createDiscdeckWindow` factory that constructs a `BrowserWindow` with the spec §5.2 properties and exposes a `setTitleFromState` method.

- [ ] **Step 10.1: Append the window factory to src/main/window.ts**

Append to `src/main/window.ts`:

```ts
import { BrowserWindow, app } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DiscdeckWindow {
  window: BrowserWindow;
  setTitleFromState(snapshot: StreamStateSnapshot): void;
  show(): void;
  hide(): void;
  destroy(): void;
}

export interface CreateWindowOptions {
  preloadPath?: string;
  rendererUrl?: string;
}

export function createDiscdeckWindow(opts: CreateWindowOptions = {}): DiscdeckWindow {
  const preloadPath = opts.preloadPath ?? join(__dirname, '../preload/index.js');
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    show: false,
    title: '🎮 Steam Deck (waiting)',
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Lock 16:10 aspect ratio (Steam Deck native).
  window.setAspectRatio(16 / 10);

  // Close-to-tray: intercept the close event unless the app is actually quitting.
  let allowClose = false;
  window.on('close', (e) => {
    if (!allowClose) {
      e.preventDefault();
      window.hide();
    }
  });

  app.on('before-quit', () => {
    allowClose = true;
  });

  if (opts.rendererUrl) {
    window.loadURL(opts.rendererUrl);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return {
    window,
    setTitleFromState(snapshot) {
      window.setTitle(formatTitle(snapshot));
    },
    show() {
      window.show();
      window.focus();
    },
    hide() {
      window.hide();
    },
    destroy() {
      allowClose = true;
      if (!window.isDestroyed()) window.destroy();
    },
  };
}
```

- [ ] **Step 10.2: Verify the existing window-title tests still pass**

Run: `npx vitest run test/unit/window-title.test.ts`
Expected: 7 PASS. (The new code is additive — `formatTitle` is unchanged.)

- [ ] **Step 10.3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 10.4: Commit**

```bash
git add src/main/window.ts
git commit -m "feat(window): BrowserWindow factory with close-to-tray and aspect lock"
```

---

## Task 11: Tray icon, menu, and notifications

**Spec reference:** §5.4 (tray icon and menu), §5.5 (OS notifications).

**Files:**
- Create: `src/main/tray.ts`
- Create: `resources/icons/tray-idle.png`
- Create: `resources/icons/tray-ready.png`
- Create: `resources/icons/tray-live.png`
- Create: `resources/icons/tray-error.png`

Tray icons in v1 are simple solid-color 16×16 PNGs (grey/white/green/red). Real artwork is a polish pass. The Node script in step 11.1 generates them so the engineer does not need design tools.

- [ ] **Step 11.1: Generate placeholder tray icons**

Create a temporary script `scripts/make-tray-icons.mjs`:

```js
// One-time script to generate placeholder 16x16 PNG tray icons.
// Uses a hand-rolled minimal PNG encoder so we don't add a dep.
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import zlib from 'zlib';

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng16(rgb) {
  const W = 16, H = 16;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0; // filter type none
    for (let x = 0; x < W; x++) {
      raw[p++] = rgb[0];
      raw[p++] = rgb[1];
      raw[p++] = rgb[2];
      raw[p++] = 255;
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const targets = {
  'resources/icons/tray-idle.png':  [128, 128, 128],
  'resources/icons/tray-ready.png': [240, 240, 240],
  'resources/icons/tray-live.png':  [80, 200, 80],
  'resources/icons/tray-error.png': [220, 60, 60],
};

for (const [path, rgb] of Object.entries(targets)) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, makePng16(rgb));
  console.log('wrote', path);
}
```

Then run:
```bash
node scripts/make-tray-icons.mjs
```
Expected: prints four "wrote …/tray-*.png" lines.

- [ ] **Step 11.2: Create src/main/tray.ts**

Create `src/main/tray.ts`:

```ts
import { Tray, Menu, Notification, nativeImage, BrowserWindow, shell, app } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import logger from './log.js';
import type { RendererState } from '@shared/ipc-types';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type TrayIconState = 'idle' | 'ready' | 'live' | 'error';

export interface TrayController {
  setState(state: RendererState): void;
  setAlwaysOnTop(on: boolean): void;
  destroy(): void;
}

export interface TrayDeps {
  getWindow: () => BrowserWindow | null;
  onReconnect: () => void;
  onQuit: () => void;
  onToggleAlwaysOnTop: (on: boolean) => void;
}

const NOTIFY_THROTTLE_MS = 10_000;

function iconPath(name: TrayIconState): string {
  // electron-vite outputs main bundle to out/main, so resources/ is two levels up
  return join(__dirname, '..', '..', 'resources', 'icons', `tray-${name}.png`);
}

function pickIcon(state: RendererState): TrayIconState {
  if (state.state === 'error') return 'error';
  if (state.state === 'live' || state.state === 'connecting') return 'live';
  if (state.deckConnected) return 'ready';
  return 'idle';
}

export function createTray(deps: TrayDeps): TrayController {
  const tray = new Tray(nativeImage.createFromPath(iconPath('idle')));
  tray.setToolTip('Discdeck — waiting for Steam Deck');

  let lastState: RendererState = {
    state: 'idle',
    deckConnected: false,
    currentGame: null,
    errorReason: null,
  };
  let alwaysOnTop = false;
  const lastNotificationAt: Record<string, number> = {};

  function notify(key: string, title: string, body: string) {
    const now = Date.now();
    if (lastNotificationAt[key] && now - lastNotificationAt[key] < NOTIFY_THROTTLE_MS) return;
    lastNotificationAt[key] = now;
    try {
      new Notification({ title, body }).show();
    } catch (e) {
      logger.warn('tray: notification failed', e);
    }
  }

  function buildMenu(): Menu {
    const streamingLabel =
      lastState.state === 'live'
        ? `● Streaming: ${lastState.currentGame ?? 'Steam Deck'}`
        : lastState.state === 'connecting'
          ? `○ Connecting: ${lastState.currentGame ?? 'Steam Deck'}`
          : lastState.state === 'error'
            ? `✕ Error: ${lastState.errorReason ?? 'unknown'}`
            : '○ Idle';
    const deckLabel = lastState.deckConnected ? '● Deck connected' : '○ No Deck connected';

    return Menu.buildFromTemplate([
      { label: streamingLabel, enabled: false },
      { label: deckLabel, enabled: false },
      { type: 'separator' },
      {
        label: 'Show window',
        click: () => {
          const win = deps.getWindow();
          if (win) {
            win.show();
            win.focus();
          }
        },
      },
      {
        label: 'Hide window',
        click: () => deps.getWindow()?.hide(),
      },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: alwaysOnTop,
        click: (item) => {
          alwaysOnTop = item.checked;
          deps.onToggleAlwaysOnTop(alwaysOnTop);
        },
      },
      { type: 'separator' },
      { label: 'Reconnect', click: () => deps.onReconnect() },
      {
        label: 'Open log folder',
        click: () => {
          const logDir = app.getPath('logs');
          shell.openPath(logDir);
        },
      },
      { type: 'separator' },
      { label: 'About Discdeck', enabled: false },
      { label: 'Quit Discdeck', click: () => deps.onQuit() },
    ]);
  }

  function refresh() {
    const icon = pickIcon(lastState);
    tray.setImage(nativeImage.createFromPath(iconPath(icon)));
    let tip = 'Discdeck — waiting for Steam Deck';
    if (lastState.state === 'error') tip = 'Discdeck — error (click for details)';
    else if (lastState.state === 'live') tip = `Discdeck — streaming ${lastState.currentGame ?? 'Steam Deck'}`;
    else if (lastState.deckConnected) tip = 'Discdeck — Deck connected';
    tray.setToolTip(tip);
    tray.setContextMenu(buildMenu());
  }

  refresh();

  tray.on('click', () => {
    const win = deps.getWindow();
    if (!win) return;
    if (win.isVisible()) win.hide();
    else {
      win.show();
      win.focus();
    }
  });

  return {
    setState(next) {
      const wasConnected = lastState.deckConnected;
      const wasLive = lastState.state === 'live';
      const wasError = lastState.state === 'error';
      lastState = next;
      refresh();

      if (!wasConnected && next.deckConnected) {
        notify('deck_connected', 'Steam Deck connected', 'Discdeck is ready.');
      }
      if (wasConnected && !next.deckConnected) {
        notify('deck_disconnected', 'Steam Deck disconnected', 'Waiting for reconnect.');
      }
      if (!wasLive && next.state === 'live') {
        notify('stream_live', 'Now streaming', next.currentGame ?? 'Steam Deck');
      }
      if (!wasError && next.state === 'error') {
        notify('stream_error', 'Discdeck error', next.errorReason ?? 'unknown error');
      }
    },
    setAlwaysOnTop(on) {
      alwaysOnTop = on;
      refresh();
    },
    destroy() {
      tray.destroy();
    },
  };
}
```

- [ ] **Step 11.3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 11.4: Commit**

```bash
git add src/main/tray.ts resources/icons/tray-idle.png resources/icons/tray-ready.png resources/icons/tray-live.png resources/icons/tray-error.png scripts/make-tray-icons.mjs
git commit -m "feat(tray): tray icon with state-driven menu, notifications, and placeholder icons"
```

---

## Task 12: Main entry — wire everything together

**Spec reference:** §3.1 (lifecycle), §3.2 (sidecar supervision), §3.3 (data flow), §5.6 (quit semantics).

**Files:**
- Modify: `src/main/index.ts` (replace placeholder with the full composition)

This is the integration point. It instantiates every module from Tasks 1–11 and wires them together by translating low-level events into state-machine inputs and propagating snapshots out through IPC and tray.

### Wiring overview

```
event-server.onConnected     → state.send('deck_connected')
event-server.onDisconnected  → state.send('deck_disconnected')
event-server.onMessage(game_start|game_change) → state.setGame(); refresh
event-server.onMessage(game_stop)              → state.setGame(null); refresh
event-server.onMessage(stream_starting)        → state.send('stream_starting'); ffmpeg.start()
event-server.onMessage(stream_stopped)         → state.send('stream_stopped'); ffmpeg.stop()

ffmpeg.onChunk(buf) → videoRelay.push(buf); state.send('video_chunk_received') (only on first chunk)
ffmpeg.onExit(info) → state.send(info.normal ? 'stream_stopped' : 'ffmpeg_crashed'); ffmpeg respawn if not error

state changes → ipc.publish(snapshot); tray.setState(snapshot); window.setTitleFromState(snapshot)
```

- [ ] **Step 12.1: Replace src/main/index.ts entirely**

Replace `src/main/index.ts` with:

```ts
import { app } from 'electron';
import logger from './log.js';
import { createStreamState, type StreamStateSnapshot } from './state/stream-state.js';
import { startEventServer, type EventServer } from './network/event-server.js';
import { createFfmpegListener, type FfmpegListener } from './network/ffmpeg-listener.js';
import { startVideoRelay, type VideoRelay } from './network/video-relay.js';
import { publishMdnsService, type MdnsService } from './network/mdns.js';
import { createDiscdeckWindow, type DiscdeckWindow } from './window.js';
import { createTray, type TrayController } from './tray.js';
import { createIpcRouter, type IpcRouter } from './ipc.js';
import type { RendererState } from '@shared/ipc-types';

const EVENT_PORT = 8765;
const RTSP_PORT = 8554;

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
  process.exit(0);
}

let state = createStreamState();
let eventServer: EventServer | null = null;
let ffmpeg: FfmpegListener | null = null;
let videoRelay: VideoRelay | null = null;
let mdns: MdnsService | null = null;
let discdeckWindow: DiscdeckWindow | null = null;
let tray: TrayController | null = null;
let ipc: IpcRouter | null = null;
let firstChunkSeenForCurrentSession = false;
let quitting = false;

function snapshot(): RendererState {
  const s = state.snapshot();
  return {
    state: s.state,
    deckConnected: s.deckConnected,
    currentGame: s.currentGame,
    errorReason: s.errorReason,
  };
}

function refreshAllUI() {
  const snap = snapshot();
  ipc?.publish(snap);
  tray?.setState(snap);
  if (discdeckWindow) {
    const fullSnap: StreamStateSnapshot = state.snapshot();
    discdeckWindow.setTitleFromState(fullSnap);
  }
}

function applyEvent(send: () => void) {
  send();
  refreshAllUI();
}

app.on('second-instance', () => {
  discdeckWindow?.show();
});

app.whenReady().then(async () => {
  logger.info('Discdeck PC starting');

  videoRelay = await startVideoRelay();
  ffmpeg = await createFfmpegListener({ port: RTSP_PORT });

  ffmpeg.onChunk((chunk) => {
    videoRelay?.push(chunk);
    if (!firstChunkSeenForCurrentSession) {
      firstChunkSeenForCurrentSession = true;
      applyEvent(() => state.send({ type: 'video_chunk_received' }));
    }
  });

  ffmpeg.onExit((info) => {
    firstChunkSeenForCurrentSession = false;
    if (quitting) return;
    if (info.normal) {
      applyEvent(() => state.send({ type: 'stream_stopped' }));
    } else {
      applyEvent(() => state.send({ type: 'ffmpeg_crashed', at: Date.now() }));
    }
    if (state.snapshot().state !== 'error') {
      // Respawn the listener so it's ready for the next push.
      ffmpeg!.start();
    }
  });

  ffmpeg.start();

  eventServer = await startEventServer({ port: EVENT_PORT });
  eventServer.setCallbacks({
    onConnected: ({ deckName }) => {
      logger.info(`Deck connected: ${deckName}`);
      applyEvent(() => state.send({ type: 'deck_connected' }));
    },
    onDisconnected: () => {
      logger.info('Deck disconnected');
      applyEvent(() => state.send({ type: 'deck_disconnected' }));
    },
    onMessage: (msg) => {
      switch (msg.type) {
        case 'game_start':
        case 'game_change': {
          const name = typeof msg.data.game_name === 'string' ? msg.data.game_name : null;
          state.setGame(name);
          refreshAllUI();
          break;
        }
        case 'game_stop':
          state.setGame(null);
          refreshAllUI();
          break;
        case 'stream_starting':
          applyEvent(() => state.send({ type: 'stream_starting' }));
          break;
        case 'stream_stopped':
          applyEvent(() => state.send({ type: 'stream_stopped' }));
          break;
        case 'error':
          logger.warn('Deck reported error:', msg.data);
          break;
      }
    },
    onError: (err) => logger.warn('event-server parse error', err),
  });

  mdns = publishMdnsService({ eventPort: EVENT_PORT, rtspPort: RTSP_PORT });

  discdeckWindow = createDiscdeckWindow({
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
  });
  // Hidden by default; tray controls visibility.
  discdeckWindow.window.once('ready-to-show', () => {
    // Do not auto-show — start hidden in tray.
  });

  ipc = createIpcRouter({
    getState: snapshot,
    getVideoPort: () => videoRelay!.port,
    onReconnect: () => {
      logger.info('reconnect requested');
      applyEvent(() => state.send({ type: 'reconnect' }));
      ffmpeg?.stop().then(() => ffmpeg?.start());
    },
    getWindow: () => discdeckWindow?.window ?? null,
  });

  tray = createTray({
    getWindow: () => discdeckWindow?.window ?? null,
    onReconnect: () => {
      logger.info('reconnect requested via tray');
      applyEvent(() => state.send({ type: 'reconnect' }));
      ffmpeg?.stop().then(() => ffmpeg?.start());
    },
    onToggleAlwaysOnTop: (on) => {
      discdeckWindow?.window.setAlwaysOnTop(on);
    },
    onQuit: () => {
      app.quit();
    },
  });

  refreshAllUI();
  logger.info('Discdeck PC ready');
});

app.on('window-all-closed', (e) => {
  // Tray app: do not quit when window closes.
  e.preventDefault();
});

app.on('before-quit', async (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  logger.info('Discdeck PC shutting down');

  const cleanup = (async () => {
    try {
      ipc?.dispose();
    } catch (e) {
      logger.warn('ipc dispose failed', e);
    }
    try {
      await eventServer?.stop();
    } catch (e) {
      logger.warn('event-server stop failed', e);
    }
    try {
      await ffmpeg?.stop();
    } catch (e) {
      logger.warn('ffmpeg stop failed', e);
    }
    try {
      await videoRelay?.stop();
    } catch (e) {
      logger.warn('video-relay stop failed', e);
    }
    try {
      await mdns?.stop();
    } catch (e) {
      logger.warn('mdns stop failed', e);
    }
    try {
      tray?.destroy();
    } catch (e) {
      logger.warn('tray destroy failed', e);
    }
    try {
      discdeckWindow?.destroy();
    } catch (e) {
      logger.warn('window destroy failed', e);
    }
  })();

  await Promise.race([
    cleanup,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);

  logger.info('Discdeck PC stopped');
  app.exit(0);
});
```

- [ ] **Step 12.2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 12.3: Verify dev server boots and the app window stays hidden**

Run: `npm run dev`
Expected:
- Logs include "Discdeck PC starting", "video-relay: listening", "event-server: listening on :8765/events", "mdns: published Discdeck on …", "Discdeck PC ready".
- No window appears (tray-only on startup).
- Tray icon is visible.
- Right-click tray → "Show window" → window appears with title `🎮 Steam Deck (waiting)` and shows the placeholder renderer content.

Stop with Ctrl+C.

- [ ] **Step 12.4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): wire state machine, network sidecars, IPC, tray, and window"
```

---

## Task 13: Renderer scaffold (HTML, React mount, base styles)

**Spec reference:** §5.3 (renderer states), §6.1 (renderer purity boundary).

**Files:**
- Modify: `src/renderer/index.html` (replace placeholder)
- Modify: `src/renderer/index.tsx` (replace placeholder)
- Create: `src/renderer/App.tsx` (full version in Task 16; minimal version here)
- Create: `src/renderer/styles.css`

- [ ] **Step 13.1: Replace src/renderer/index.html**

Replace `src/renderer/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>🎮 Steam Deck (waiting)</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./index.tsx"></script>
  </body>
</html>
```

- [ ] **Step 13.2: Replace src/renderer/index.tsx**

Replace `src/renderer/index.tsx`:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 13.3: Create a minimal src/renderer/App.tsx (placeholder; full version in Task 16)**

Create `src/renderer/App.tsx`:

```tsx
import React from 'react';

export default function App(): React.ReactElement {
  return (
    <div className="discdeck-root">
      <div className="splash">
        <div className="brand">🎮 Discdeck</div>
        <div className="subtitle">Renderer scaffold ready</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 13.4: Create src/renderer/styles.css**

Create `src/renderer/styles.css`:

```css
* {
  box-sizing: border-box;
}

html, body, #root, .discdeck-root {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100vh;
  background: #0b0f14;
  color: #e6edf3;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  overflow: hidden;
}

.discdeck-root {
  display: flex;
  align-items: center;
  justify-content: center;
}

.splash {
  text-align: center;
  user-select: none;
}

.splash .brand {
  font-size: 56px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 16px;
}

.splash .subtitle {
  font-size: 18px;
  color: #8b949e;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.splash.error .subtitle {
  color: #ff7b72;
}

.pulse-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #8b949e;
  animation: pulse 1.6s ease-in-out infinite;
}

.spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid #30363d;
  border-top-color: #58a6ff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.1); }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.video-stage {
  width: 100%;
  height: 100%;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.video-stage video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
```

- [ ] **Step 13.5: Verify dev boot still works**

Run: `npm run dev`
Expected: window opens (when revealed via tray) showing "🎮 Discdeck / Renderer scaffold ready" centered on a dark background. Stop with Ctrl+C.

- [ ] **Step 13.6: Commit**

```bash
git add src/renderer/index.html src/renderer/index.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(renderer): React scaffold with base splash styles"
```

---

## Task 14: IdleSplash component

**Spec reference:** §5.3 (renderer states table).

**Files:**
- Create: `src/renderer/components/IdleSplash.tsx`

A pure presentational component that renders three sub-states based on props: `idle`, `connecting`, `error`.

- [ ] **Step 14.1: Create src/renderer/components/IdleSplash.tsx**

Create `src/renderer/components/IdleSplash.tsx`:

```tsx
import React from 'react';
import type { RendererState } from '@shared/ipc-types';

export interface IdleSplashProps {
  state: RendererState;
}

export default function IdleSplash({ state }: IdleSplashProps): React.ReactElement {
  if (state.state === 'error') {
    return (
      <div className="splash error">
        <div className="brand">🎮 Discdeck</div>
        <div className="subtitle">{state.errorReason ?? 'Unknown error'}</div>
      </div>
    );
  }

  if (state.state === 'connecting') {
    const game = state.currentGame ?? 'Steam Deck';
    return (
      <div className="splash">
        <div className="brand">🎮 Discdeck</div>
        <div className="subtitle">
          Connecting to {game}…<span className="spinner" />
        </div>
      </div>
    );
  }

  // idle (covers both deck-not-connected and deck-connected-no-stream)
  const subtitle = state.deckConnected
    ? state.currentGame
      ? `Ready to stream ${state.currentGame}`
      : 'Deck connected — waiting for stream'
    : 'Waiting for Steam Deck…';

  return (
    <div className="splash">
      <div className="brand">🎮 Discdeck</div>
      <div className="subtitle">
        {subtitle}
        <span className="pulse-dot" />
      </div>
    </div>
  );
}
```

- [ ] **Step 14.2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 14.3: Commit**

```bash
git add src/renderer/components/IdleSplash.tsx
git commit -m "feat(renderer): IdleSplash component for idle/connecting/error states"
```

---

## Task 15: VideoPlayer component (MSE consumer)

**Spec reference:** §3.3 (data flow step 4), §5.3 (live state).

**Files:**
- Create: `src/renderer/components/VideoPlayer.tsx`

A React component that:
1. On mount, calls `window.discdeck.getVideoPort()` to learn the localhost video relay port.
2. Opens a `WebSocket('ws://127.0.0.1:<port>')` with `binaryType = 'arraybuffer'`.
3. Creates a `MediaSource`, attaches it to a `<video>` element via `URL.createObjectURL(mediaSource)`.
4. On `sourceopen`, creates a `SourceBuffer` for `'video/mp4; codecs="avc1.42E01E"'` (H.264 baseline — broad compatibility; matches what Deck pipewire+ffmpeg emits by default).
5. Queues incoming WebSocket chunks and appends them to the SourceBuffer when it's not updating.
6. Cleans up on unmount.

- [ ] **Step 15.1: Create src/renderer/components/VideoPlayer.tsx**

Create `src/renderer/components/VideoPlayer.tsx`:

```tsx
import React, { useEffect, useRef } from 'react';

const MIME = 'video/mp4; codecs="avc1.42E01E"';

export default function VideoPlayer(): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let mediaSource: MediaSource | null = null;
    let sourceBuffer: SourceBuffer | null = null;
    const queue: ArrayBuffer[] = [];

    function pump() {
      if (!sourceBuffer || sourceBuffer.updating) return;
      const next = queue.shift();
      if (!next) return;
      try {
        sourceBuffer.appendBuffer(next);
      } catch (e) {
        console.error('VideoPlayer appendBuffer failed', e);
      }
    }

    async function init() {
      try {
        const port = await window.discdeck.getVideoPort();
        if (cancelled) return;

        if (!('MediaSource' in window) || !MediaSource.isTypeSupported(MIME)) {
          console.error('VideoPlayer: MIME not supported:', MIME);
          return;
        }

        mediaSource = new MediaSource();
        const video = videoRef.current;
        if (!video) return;
        video.src = URL.createObjectURL(mediaSource);

        mediaSource.addEventListener('sourceopen', () => {
          if (!mediaSource) return;
          sourceBuffer = mediaSource.addSourceBuffer(MIME);
          sourceBuffer.mode = 'sequence';
          sourceBuffer.addEventListener('updateend', pump);
          pump();
        });

        ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.binaryType = 'arraybuffer';
        ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            queue.push(event.data);
            pump();
          }
        };
        ws.onerror = (err) => {
          console.warn('VideoPlayer ws error', err);
        };
        ws.onclose = () => {
          console.info('VideoPlayer ws closed');
        };
      } catch (e) {
        console.error('VideoPlayer init failed', e);
      }
    }

    init();

    return () => {
      cancelled = true;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      if (sourceBuffer && mediaSource && mediaSource.readyState === 'open') {
        try {
          mediaSource.endOfStream();
        } catch {
          /* ignore */
        }
      }
      sourceBuffer = null;
      mediaSource = null;
    };
  }, []);

  return (
    <div className="video-stage">
      <video ref={videoRef} autoPlay muted playsInline />
    </div>
  );
}
```

- [ ] **Step 15.2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 15.3: Commit**

```bash
git add src/renderer/components/VideoPlayer.tsx
git commit -m "feat(renderer): VideoPlayer MSE consumer with localhost relay connection"
```

---

## Task 16: Wire renderer App to main state

**Spec reference:** §5.3 (renderer state switching).

**Files:**
- Modify: `src/renderer/App.tsx` (replace placeholder)

`App.tsx` subscribes to `state:update` IPC pushes and renders either `IdleSplash` or `VideoPlayer` based on the current state.

- [ ] **Step 16.1: Replace src/renderer/App.tsx**

Replace `src/renderer/App.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import IdleSplash from './components/IdleSplash.js';
import VideoPlayer from './components/VideoPlayer.js';
import type { RendererState } from '@shared/ipc-types';

const INITIAL_STATE: RendererState = {
  state: 'idle',
  deckConnected: false,
  currentGame: null,
  errorReason: null,
};

export default function App(): React.ReactElement {
  const [state, setState] = useState<RendererState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    window.discdeck
      .getState()
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch((e) => console.error('initial getState failed', e));

    const unsubscribe = window.discdeck.onStateUpdate((s) => {
      if (!cancelled) setState(s);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <div className="discdeck-root">
      {state.state === 'live' ? <VideoPlayer /> : <IdleSplash state={state} />}
    </div>
  );
}
```

- [ ] **Step 16.2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 16.3: Verify dev boot end-to-end (no streaming yet)**

Run: `npm run dev`
Expected:
- App starts hidden in tray.
- Right-click tray → Show window → splash shows "🎮 Discdeck / Waiting for Steam Deck…" with pulsing dot.
- Tray icon is grey (`tray-idle`).
- Title bar reads "🎮 Steam Deck (waiting)".

Stop with Ctrl+C.

- [ ] **Step 16.4: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(renderer): subscribe to main state and switch between splash and player"
```

---

## Task 17: Dummy producer test harness

**Spec reference:** §7.1 (dummy producer subcommand list), §4.5 (typical session).

**Files:**
- Create: `test/dummy-producer/produce.ts`
- Create: `test/dummy-producer/push-testpattern.sh`
- Create: `test/dummy-producer/README.md`

The dummy producer is the canonical end-to-end driver for Part 1. It also serves as the reference implementation for Part 2.

- [ ] **Step 17.1: Create test/dummy-producer/produce.ts**

Create `test/dummy-producer/produce.ts`:

```ts
#!/usr/bin/env tsx
import WebSocket from 'ws';
import { spawn, type ChildProcess } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { makeMessage } from '../../src/main/network/event-protocol.js';

const HOST = process.env.DISCDECK_HOST ?? '127.0.0.1';
const EVENT_URL = `ws://${HOST}:8765/events`;
const RTSP_URL = `rtsp://${HOST}:8554/deck`;

function log(...args: unknown[]) {
  console.log('[dummy]', ...args);
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function connect(): Promise<WebSocket> {
  log('connecting to', EVENT_URL);
  const ws = new WebSocket(EVENT_URL);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

function send(ws: WebSocket, type: Parameters<typeof makeMessage>[0], data: Record<string, unknown> = {}) {
  const msg = makeMessage(type, data);
  log('→', type, JSON.stringify(data));
  ws.send(JSON.stringify(msg));
}

async function helloAndWelcome(ws: WebSocket): Promise<void> {
  send(ws, 'hello', {
    client: 'dummy-producer',
    client_version: '0.0.0-test',
    deck_name: 'Test Deck',
    capabilities: ['video', 'events'],
  });
  await new Promise<void>((resolve, reject) => {
    const onMsg = (data: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'welcome') {
          log('← welcome from', parsed.data?.server, parsed.data?.server_version);
          ws.removeListener('message', onMsg);
          resolve();
        }
      } catch (e) {
        reject(e);
      }
    };
    ws.on('message', onMsg);
    setTimeout(() => reject(new Error('welcome timeout')), 5000);
  });
}

function startHeartbeats(ws: WebSocket): NodeJS.Timeout {
  return setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) send(ws, 'heartbeat');
  }, 5000);
}

function spawnTestPatternPush(): ChildProcess {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary path');
  log('spawning ffmpeg test pattern push to', RTSP_URL);
  const child = spawn(
    ffmpegPath,
    [
      '-re',
      '-f', 'lavfi',
      '-i', 'testsrc2=size=1280x800:rate=30',
      '-c:v', 'libx264',
      '-tune', 'zerolatency',
      '-preset', 'ultrafast',
      '-g', '30',
      '-pix_fmt', 'yuv420p',
      '-f', 'rtsp',
      RTSP_URL,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  child.on('exit', (code, signal) => log('ffmpeg push exited code=', code, 'signal=', signal));
  return child;
}

async function full() {
  const ws = await connect();
  await helloAndWelcome(ws);
  const hb = startHeartbeats(ws);
  await sleep(500);
  send(ws, 'game_start', { game_name: 'Hollow Knight', app_id: '367520', launched_at: new Date().toISOString() });
  await sleep(2000);
  send(ws, 'stream_starting', {
    rtsp_url: RTSP_URL,
    video_codec: 'h264',
    width: 1280,
    height: 800,
    fps: 30,
  });
  const ff = spawnTestPatternPush();
  log('streaming for 15 seconds…');
  await sleep(8000);
  send(ws, 'game_change', { game_name: 'Hades', app_id: '1145360', launched_at: new Date().toISOString() });
  await sleep(7000);
  send(ws, 'stream_stopped', { reason: 'user_toggled_off' });
  ff.kill('SIGINT');
  await sleep(1000);
  send(ws, 'game_stop', { game_name: 'Hades', closed_at: new Date().toISOString() });
  clearInterval(hb);
  ws.close();
  log('done');
}

async function eventsOnly() {
  const ws = await connect();
  await helloAndWelcome(ws);
  const hb = startHeartbeats(ws);
  await sleep(500);
  send(ws, 'game_start', { game_name: 'Hollow Knight', app_id: '367520', launched_at: new Date().toISOString() });
  await sleep(3000);
  send(ws, 'game_change', { game_name: 'Celeste', app_id: '504230', launched_at: new Date().toISOString() });
  await sleep(3000);
  send(ws, 'game_stop', { game_name: 'Celeste', closed_at: new Date().toISOString() });
  await sleep(1000);
  clearInterval(hb);
  ws.close();
  log('events done');
}

async function videoOnly() {
  log('pushing test pattern for 20s without an event channel');
  const ff = spawnTestPatternPush();
  await sleep(20_000);
  ff.kill('SIGINT');
  log('video done');
}

async function flap() {
  log('flap mode: connect/disconnect every 3s for 60s');
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    try {
      const ws = await connect();
      await helloAndWelcome(ws);
      send(ws, 'game_start', { game_name: 'FlapTest', app_id: null, launched_at: new Date().toISOString() });
      await sleep(3000);
      send(ws, 'game_stop', { game_name: 'FlapTest', closed_at: new Date().toISOString() });
      ws.close();
    } catch (e) {
      log('flap iteration error', e);
    }
    await sleep(500);
  }
  log('flap done');
}

async function crash() {
  const ws = await connect();
  send(ws, 'hello', {
    client: 'dummy-producer',
    client_version: '0.0.0-test',
    deck_name: 'CrashTest',
    capabilities: [],
  });
  await sleep(100);
  log('terminating socket abruptly');
  ws.terminate();
}

async function badHandshake() {
  const ws = await connect();
  log('sending garbage as hello');
  ws.send('this is not even json');
  await sleep(500);
  ws.close();
}

const cmd = process.argv[2];
const dispatch: Record<string, () => Promise<void>> = {
  full,
  events: eventsOnly,
  video: videoOnly,
  flap,
  crash,
  'bad-handshake': badHandshake,
};

const fn = dispatch[cmd ?? ''];
if (!fn) {
  console.error('Usage: tsx test/dummy-producer/produce.ts <full|events|video|flap|crash|bad-handshake>');
  process.exit(2);
}

fn().catch((e) => {
  console.error('[dummy] fatal', e);
  process.exit(1);
});
```

- [ ] **Step 17.2: Create test/dummy-producer/push-testpattern.sh**

Create `test/dummy-producer/push-testpattern.sh`:

```bash
#!/usr/bin/env bash
# Standalone ffmpeg push for manual debugging without Node.
# Usage: ./push-testpattern.sh [host]
HOST="${1:-127.0.0.1}"
exec ffmpeg \
  -re \
  -f lavfi -i testsrc2=size=1280x800:rate=30 \
  -c:v libx264 -tune zerolatency -preset ultrafast \
  -g 30 -pix_fmt yuv420p \
  -f rtsp "rtsp://${HOST}:8554/deck"
```

- [ ] **Step 17.3: Create test/dummy-producer/README.md**

Create `test/dummy-producer/README.md`:

```markdown
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

## Manual ffmpeg push

For debugging without Node, the equivalent video-only push is in `push-testpattern.sh`. Run a system ffmpeg pointed at `rtsp://<host>:8554/deck`.
```

- [ ] **Step 17.4: Test the dummy producer end-to-end**

In one terminal: `npm run dev`
In another: `npm run dummy:events`

Expected sequence in the Discdeck window/tray:
1. Tray notification "Steam Deck connected — Test Deck"
2. Window title flips to `🎮 Steam Deck — Hollow Knight`
3. Tray icon flips to white (`tray-ready`)
4. ~3s later, title flips to `🎮 Steam Deck — Celeste`
5. ~3s later, title flips to `🎮 Steam Deck` (game stopped, deck still connected)
6. ~1s later, tray icon flips back to grey, title back to `🎮 Steam Deck (waiting)`, notification "Steam Deck disconnected"

Stop dev server with Ctrl+C.

- [ ] **Step 17.5: Test the full pipeline**

In one terminal: `npm run dev`
In another: `npm run dummy:full`

Expected: same as 17.4 but with:
- Splash shows "Connecting to Hollow Knight…" briefly
- Window switches to live video showing the test pattern (color bars + counter)
- After ~8s, title flips to `🎮 Steam Deck — Hades` while video keeps playing
- After ~7s more, video stops and splash returns

Stop dev server with Ctrl+C.

- [ ] **Step 17.6: Commit**

```bash
git add test/dummy-producer/produce.ts test/dummy-producer/push-testpattern.sh test/dummy-producer/README.md
git commit -m "feat(test): dummy producer harness covering all spec subcommands"
```

---

## Task 18: Manual test docs, PROTOCOL.md, README, and acceptance run

**Spec reference:** §7.4 (manual checklist), §10 (acceptance criteria), §4 (protocol — extracted to its own doc).

**Files:**
- Create: `docs/MANUAL_TEST.md`
- Create: `docs/PROTOCOL.md`
- Create: `README.md`

- [ ] **Step 18.1: Create docs/MANUAL_TEST.md**

Create `docs/MANUAL_TEST.md`:

```markdown
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
```

- [ ] **Step 18.2: Create docs/PROTOCOL.md**

Create `docs/PROTOCOL.md`:

```markdown
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

The client should send `stream_starting` *before* opening the RTSP push, and `stream_stopped` *after* closing it.
```

- [ ] **Step 18.3: Create README.md**

Create `README.md`:

```markdown
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
Steam Deck (RTSP push) ─→ FFmpeg listener ─→ video relay WS ─→ <video> + MSE
                       └→ Event WS         ─→ state machine ─→ tray + window title
                       └→ mDNS discovery   ←┘
```

The `src/main/network/` directory is the **Part 2 plug-in seam**: when Part 2 is ready, deleting `test/dummy-producer/produce.ts` should be the only change needed in this codebase.

## License

See `LICENSE`.
```

- [ ] **Step 18.4: Run the boundary-rule grep checks (spec §10 acceptance criterion 7)**

Run the four boundary checks. Each must return zero matches (or only the documented exceptions).

```bash
# 1. renderer must not import electron, node:, ws, fs, child_process, etc.
grep -RE "from ['\"]electron['\"]|from ['\"]node:|from ['\"]ws['\"]|from ['\"]fs['\"]|from ['\"]child_process['\"]" src/renderer/ || echo "PASS: renderer is pure"

# 2. main outside network/ must not import ws, bonjour-service, child_process
grep -RE "from ['\"]ws['\"]|from ['\"]bonjour-service['\"]|from ['\"]child_process['\"]" src/main --exclude-dir=network || echo "PASS: main outside network/ is clean"

# 3. network/ must not import from renderer/
grep -R "from ['\"].*renderer" src/main/network/ || echo "PASS: network does not depend on renderer"

# 4. preload is the only file that calls contextBridge.exposeInMainWorld
grep -R "exposeInMainWorld" src/ --include="*.ts" --include="*.tsx"
# Expected: only one match, in src/preload/index.ts
```

If any check fails, fix the offending import and re-run before continuing.

- [ ] **Step 18.5: Run the full automated test suite**

```bash
npm test
npm run test:integration
npm run typecheck
```

Expected: all green.

- [ ] **Step 18.6: Run the full manual checklist from docs/MANUAL_TEST.md**

Walk through every checkbox. The Discord smoke test is the load-bearing one — if `🎮 Steam Deck — …` does not appear in Discord's window picker, Part 1 has failed its primary goal.

If any checkbox fails, file the failure as a bug and fix before declaring Part 1 done.

- [ ] **Step 18.7: Commit docs and final state**

```bash
git add docs/MANUAL_TEST.md docs/PROTOCOL.md README.md
git commit -m "docs: manual test checklist, protocol reference, and README"
```

---

## Spec coverage check

Each numbered acceptance criterion from spec §10 maps to specific tasks:

| Spec §10 criterion | Implementing task(s) |
|---|---|
| 1. All unit and integration tests pass | Tasks 2, 3, 4 (unit) + Tasks 5, 6 (integration) — verified Step 18.5 |
| 2. Full manual checklist passes | Task 18 step 18.6 |
| 3. Discord smoke test passes | Task 18 step 18.6 |
| 4. `npm run dummy:flap` for 5+ min without leak | Task 17 step 17.4-17.5 baseline; Task 18 step 18.6 stress |
| 5. `docs/PROTOCOL.md` exists as standalone reference | Task 18 step 18.2 |
| 6. README documents install + dummy producer + manual test | Task 18 step 18.3 |
| 7. Boundary rules enforced via grep | Task 18 step 18.4 |

Each spec section also has an implementing task:

| Spec section | Implementing task(s) |
|---|---|
| §1 (project context) | n/a — informational |
| §2 (architecture) | Tasks 5–8 (network), Task 12 (wiring) |
| §3 (process model) | Task 1 (scaffold), Task 12 (composition) |
| §3.2 (sidecar supervision, crash-loop) | Task 2 (state machine), Task 6 (ffmpeg-listener), Task 12 (wiring) |
| §3.3 (data flow) | Task 12 (wiring) |
| §4 (event protocol) | Task 4 (validator), Task 5 (server), Task 18.2 (PROTOCOL.md) |
| §5.1 (window title) | Task 3 (formatter), Task 10 (apply to BrowserWindow) |
| §5.2 (window properties) | Task 10 |
| §5.3 (renderer states) | Tasks 13, 14, 15, 16 |
| §5.4 (tray) | Task 11 |
| §5.5 (notifications) | Task 11 |
| §5.6 (quit semantics) | Task 10 (close interception), Task 12 (cleanup sequence) |
| §6 (project structure) | All tasks (each creates files in their target locations) |
| §6.1 (boundary rules) | Task 18 step 18.4 (enforcement check) |
| §6.2 (Part 2 swap-in test) | Task 17 (dummy producer) — the swap-in mechanism itself |
| §7.1 (dummy producer) | Task 17 |
| §7.2 (unit tests) | Tasks 2, 3, 4 |
| §7.3 (integration tests) | Tasks 5, 6 |
| §7.4 (manual checklist) | Task 18.1 |
| §7.5 (deliberately not tested) | n/a — informational |
| §8 (out of scope) | n/a — informational |
| §9 (open questions) | Resolved in plan header |
| §10 (acceptance) | Task 18.5–18.6 |

No gaps.
