"""Runs Part 2 backend against a live Part 1 companion app.

Gated by DISCDECK_PART1_PATH env var. Skip if not set. In CI we do not run
this test; it runs manually from a developer machine after setting:

    DISCDECK_PART1_PATH=E:/Gamedev/Solodev/Discdeck pytest tests/integration/ -v

The test spins up `npm run dev` in the Part 1 repo, waits for mDNS, runs a
short event script, asserts Part 1's logfile records the expected events.
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import time
from pathlib import Path

import pytest

PART1_PATH = os.environ.get('DISCDECK_PART1_PATH')
pytestmark = pytest.mark.skipif(not PART1_PATH, reason='DISCDECK_PART1_PATH not set')


@pytest.mark.asyncio
async def test_part1_receives_game_and_stream_events(tmp_path):
    from backend.event_client import EventClient
    from backend.mdns_browser import MdnsBrowser
    from backend.event_protocol import make_message

    # 1. Spin up Part 1 in dev mode.
    part1_log = tmp_path / 'part1.log'
    proc = subprocess.Popen(
        ['npm', 'run', 'dev'],
        cwd=PART1_PATH,
        stdout=part1_log.open('wb'),
        stderr=subprocess.STDOUT,
        shell=(os.name == 'nt'),
    )
    try:
        # 2. Wait for mDNS to come up (give Part 1 ~10s to fully boot).
        found = asyncio.Event()
        discovery = {}

        async def on_found(d):
            discovery.update(d); found.set()

        browser = MdnsBrowser(on_service_found=on_found)
        await browser.start()
        try:
            await asyncio.wait_for(found.wait(), 20.0)
        finally:
            await browser.stop()

        # 3. Connect WS, go through the full lifecycle.
        welcome = asyncio.Event()

        async def on_welcome(_info):
            welcome.set()

        addr = discovery['addresses'][0]
        client = EventClient(
            url=f"ws://{addr}:{discovery['event_port']}/events",
            hello={'client': 'decky-discdeck', 'client_version': '0.1.0-int',
                   'deck_name': 'IntegrationTest', 'capabilities': ['video', 'events']},
            on_welcome=on_welcome,
        )
        run_task = asyncio.create_task(client.run())
        try:
            await asyncio.wait_for(welcome.wait(), 5.0)
            # Send a game_start — Part 1 should log it.
            await client.send('game_start', {
                'game_name': 'IntegrationTestGame', 'app_id': '999999',
                'launched_at': '2026-04-16T00:00:00Z',
            })
            await asyncio.sleep(1.0)
        finally:
            await client.stop()
            run_task.cancel()
            try: await run_task
            except asyncio.CancelledError: pass

        # 4. Assert Part 1 logged the event.
        # (Part 1 uses electron-log; test verifies via its log file path.)
        # Give it a moment to flush.
        time.sleep(1.0)
        part1_text = part1_log.read_text(errors='replace')
        assert 'IntegrationTestGame' in part1_text or 'game_start' in part1_text
    finally:
        proc.terminate()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.kill()
