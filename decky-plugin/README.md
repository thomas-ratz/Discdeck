# Discdeck — Decky Plugin (Part 2)

Decky Loader plugin that streams your Steam Deck's gameplay to the Discdeck PC
companion (Part 1), which in turn shows it to Discord as a capturable window.

**Requires:** Steam Deck running SteamOS 3.6+, Decky Loader v3.2+, and a PC
running the Discdeck companion app (Part 1) on the same LAN.

## Installing (dev mode)

1. Build:
   ```bash
   cd decky-plugin
   pnpm install
   pnpm run build
   ./scripts/fetch_ffmpeg.sh
   ```
2. Zip `decky-plugin/` (excluding `node_modules/`, `.venv/`) as `discdeck-0.1.0.zip`.
3. On the Deck, enable Developer Mode in Decky, then "Install plugin from URL" pointing to the zip (or copy the directory directly to `$HOME/homebrew/plugins/discdeck/`).
4. Restart Decky. The first launch will `setcap cap_sys_admin+ep bin/ffmpeg` (you may see a root prompt).

## Using

1. Open QAM, select the Discdeck panel.
2. Wait for `● Connected to <PC>` (auto-detect via mDNS; if it hangs, switch to manual IP).
3. Launch a game. `Game: <name>` should update within 2 seconds.
4. Flip "Stream to PC" ON. The PC companion's window title flips to `🎮 Steam Deck — <game>`.
5. In Discord on the PC, "Share Your Screen" → "Application Window" → select the Steam Deck window. Done.

## Troubleshooting

- **"Searching for PC…" forever:** Your router is probably dropping multicast. Switch to a manual IP under `PC address`.
- **"Permission setup failed":** `setcap` couldn't run. Check logs — usually means Decky wasn't granted the root flag.
- **"No KMS device found":** SteamOS update moved the DRI device paths. File an issue with the contents of `ls /dev/dri/`.
- **Streaming toggles on then immediately errors:** ffmpeg crashed. Open logs (Settings → Open logs) and look for the ffmpeg exit line.

Protocol reference: [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md) in the Discdeck repo.
