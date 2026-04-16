# Discdeck Part 2 — Manual Verification Checklist

Run after every meaningful change on a real Steam Deck against a real PC running
Part 1. The integration test covers the event-level paths; this checklist covers
hardware-only interactions.

## Prerequisites

- [ ] Part 1 running on a PC on the same LAN.
- [ ] Plugin installed per `README.md`.

## Checklist

- [ ] **First launch:** plugin icon appears in QAM within 15s of Decky start.
- [ ] **Capability bootstrap:** first-install setcap completes without user
       intervention beyond granting the Decky root prompt.
- [ ] **mDNS discovery:** status line shows `● Connected to <PC>` within 15s on
       a normal LAN.
- [ ] **Game detection:** launch Hollow Knight → QAM shows `Game: Hollow Knight`
       within 2s. Status line unchanged.
- [ ] **Stream start:** toggle ON → PC window title becomes `🎮 Steam Deck —
       Hollow Knight`. Video plays on PC within 5s.
- [ ] **Game switch:** close Hollow Knight, launch Hades without toggling OFF.
       PC title updates to `🎮 Steam Deck — Hades`. Video continues.
- [ ] **Stream stop:** toggle OFF → PC returns to idle splash. No zombie ffmpeg
       (`pgrep ffmpeg` returns nothing).
- [ ] **QAM close/reopen during stream:** reopen QAM, panel shows correct live
       state (streaming ON, current game, status). No re-dial.
- [ ] **PC unplug:** pull PC's Ethernet / turn off its Wi-Fi. Within 15s status
       flips to `⚪ Searching…`. ffmpeg reaped (`pgrep ffmpeg` empty).
- [ ] **PC reconnect:** plug back in. Plugin reconnects within 15s without
       manual reconnect.
- [ ] **Manual IP fallback:** in QAM, set PC address to manual with correct IP;
       connection works. Set wrong IP; status shows error within 10s.
- [ ] **The real smoke test:** have a friend join a Discord voice channel, share
       the `🎮 Steam Deck — <game>` window. They see Deck gameplay with minimal
       lag.
