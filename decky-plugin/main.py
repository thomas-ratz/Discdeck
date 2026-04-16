"""Discdeck Decky plugin entry point.

Glue only — all logic lives in backend/ modules. This file wires them together
and exposes the call()-able methods the frontend uses.

Spec ref: Part 2 design §2, §5, §6.3.
"""
from __future__ import annotations

import asyncio
import os
import socket
from pathlib import Path
from typing import Any

import decky

from backend import capability
from backend.event_client import EventClient
from backend.ffmpeg_supervisor import FfmpegSupervisor
from backend.logging_setup import configure as configure_logging
from backend.mdns_browser import MdnsBrowser
from backend.settings_store import SettingsStore
from backend.state import StateMachine, State

FFMPEG_PATH = str(Path(decky.DECKY_PLUGIN_DIR) / 'bin' / 'ffmpeg')
PLUGIN_VERSION = decky.DECKY_PLUGIN_VERSION


def _deck_name() -> str:
    try:
        return socket.gethostname()
    except Exception:
        return 'Steam Deck'


class Plugin:
    async def _main(self) -> None:
        self.log = configure_logging()
        self.log.info('discdeck plugin starting (v%s)', PLUGIN_VERSION)
        self.sm = StateMachine()
        self.settings = SettingsStore(Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / 'config.json')
        self.event_client: EventClient | None = None
        self.ffmpeg: FfmpegSupervisor | None = None
        self.mdns: MdnsBrowser | None = None
        self.current_pc: dict[str, Any] | None = None
        self._connect_task: asyncio.Task | None = None
        self._client_task: asyncio.Task | None = None
        self._shutdown = asyncio.Event()

        # Bootstrap capability on bundled ffmpeg (idempotent).
        try:
            await self._bootstrap_capability()
        except RuntimeError as e:
            self.log.error('setcap bootstrap failed: %s', e)
            self.sm.force_error(f'Permission setup failed: {e}')
            await self._emit_state()

        # Start discovery based on settings.
        mode = self.settings.get()['pc_address_mode']
        if mode == 'auto':
            await self._start_mdns()
        else:
            addr = self.settings.get()['manual_pc_address']
            if addr:
                self._connect_task = asyncio.create_task(self._connect_to(addr, 8765, 8554, server=addr))

        await self._shutdown.wait()

    async def _unload(self) -> None:
        self._shutdown.set()
        if self.ffmpeg is not None:
            await self.ffmpeg.stop()
        if self.event_client is not None:
            await self.event_client.stop()
        if self.mdns is not None:
            await self.mdns.stop()
        if self._client_task is not None:
            self._client_task.cancel()

    async def _uninstall(self) -> None:
        # Nothing persistent outside the plugin dir; no-op.
        pass

    async def _migration(self) -> None:
        # No prior plugin versions to migrate from in v0.1.0.
        pass

    # ---- Capability bootstrap ----
    async def _bootstrap_capability(self) -> None:
        if not Path(FFMPEG_PATH).exists():
            raise RuntimeError(f'{FFMPEG_PATH} not found; run scripts/fetch_ffmpeg.sh before packaging')
        if capability.has_cap_sys_admin(FFMPEG_PATH):
            self.log.debug('cap_sys_admin already set on ffmpeg')
            return
        await capability.grant_cap_sys_admin(FFMPEG_PATH)

    # ---- mDNS ----
    async def _start_mdns(self) -> None:
        if self.mdns is not None:
            return
        self.mdns = MdnsBrowser(on_service_found=self._on_mdns_found)
        await self.mdns.start()

    async def _on_mdns_found(self, d: dict[str, Any]) -> None:
        if self.current_pc is not None:
            return  # already connected or connecting
        addr = d['addresses'][0] if d['addresses'] else d['server']
        self._connect_task = asyncio.create_task(
            self._connect_to(addr, d['event_port'], d['rtsp_port'], server=d['server'])
        )

    # ---- WS connection ----
    async def _connect_to(self, addr: str, event_port: int, rtsp_port: int, *, server: str) -> None:
        self.sm.on_dial_started()
        await self._emit_state()
        self.current_pc = {'server': server, 'address': addr,
                           'event_port': event_port, 'rtsp_port': rtsp_port}
        hello = {
            'client': 'decky-discdeck',
            'client_version': PLUGIN_VERSION,
            'deck_name': _deck_name(),
            'capabilities': ['video', 'events'],
        }
        self.event_client = EventClient(
            url=f'ws://{addr}:{event_port}/events',
            hello=hello,
            on_welcome=self._on_welcome,
            on_disconnect=self._on_disconnect,
        )
        self._client_task = asyncio.create_task(self.event_client.run())

    async def _on_welcome(self, server_info: dict[str, Any]) -> None:
        self.sm.on_welcome(server_info)
        await self._emit_state()

    async def _on_disconnect(self, reason: str) -> None:
        self.log.info('WS disconnected: %s', reason)
        if self.ffmpeg is not None:
            await self.ffmpeg.stop()
            self.ffmpeg = None
        self.sm.on_ws_dropped()
        self.current_pc = None
        await self._emit_state()

    # ---- Frontend call() methods ----
    async def get_state(self) -> dict[str, Any]:
        s = self.settings.get()
        return {
            **self.sm.snapshot(),
            'pc_address_mode': s['pc_address_mode'],
            'manual_pc_address': s['manual_pc_address'],
            'connected_pc': self.current_pc,
        }

    async def set_streaming_enabled(self, enabled: bool) -> dict[str, Any]:
        msgs = self.sm.on_toggle_streaming(enabled)
        for mtype, data in msgs:
            if mtype == 'stream_starting':
                data = dict(data)
                data['rtsp_url'] = f"rtsp://{self.current_pc['address']}:{self.current_pc['rtsp_port']}/deck"
                await self._send(mtype, data)
                await self._spawn_ffmpeg()
            elif mtype == 'stream_stopped':
                await self._send(mtype, data)
                if self.ffmpeg is not None:
                    await self.ffmpeg.stop()
                    self.ffmpeg = None
        await self._emit_state()
        return await self.get_state()

    async def on_game_event(self, args: dict[str, Any]) -> None:
        msgs = self.sm.on_game_event(
            kind=args['kind'], app_id=args['app_id'],
            game_name=args.get('game_name'), at=args['at'],
        )
        for mtype, data in msgs:
            await self._send(mtype, data)
        await self._emit_state()

    async def set_pc_address_mode(self, args: dict[str, Any]) -> None:
        mode = args['mode']
        addr = args.get('address')
        self.settings.update(pc_address_mode=mode, manual_pc_address=addr)
        # Tear down current connection and restart.
        if self.event_client is not None:
            await self.event_client.stop()
            self.event_client = None
        if self.mdns is not None:
            await self.mdns.stop()
            self.mdns = None
        self.sm.on_user_reconnect()
        if mode == 'auto':
            await self._start_mdns()
        elif addr:
            asyncio.create_task(self._connect_to(addr, 8765, 8554, server=addr))
        await self._emit_state()

    async def reconnect(self) -> None:
        await self.set_pc_address_mode({
            'mode': self.settings.get()['pc_address_mode'],
            'address': self.settings.get()['manual_pc_address'],
        })

    async def get_logs(self, args: dict[str, Any]) -> list[str]:
        n = args.get('lines', 200)
        logfile = Path(decky.DECKY_PLUGIN_LOG)
        if not logfile.exists():
            return []
        lines = logfile.read_text(errors='replace').splitlines()
        return lines[-n:]

    # ---- Internal helpers ----
    async def _send(self, mtype: str, data: dict[str, Any]) -> None:
        if self.event_client is None:
            return
        try:
            await self.event_client.send(mtype, data)
        except ConnectionError as e:
            self.log.warning('failed to send %s: %s', mtype, e)

    async def _spawn_ffmpeg(self) -> None:
        assert self.current_pc is not None
        rtsp = f"rtsp://{self.current_pc['address']}:{self.current_pc['rtsp_port']}/deck"
        self.ffmpeg = FfmpegSupervisor(
            ffmpeg_path=FFMPEG_PATH,
            build_args=lambda: _build_ffmpeg_args(rtsp),
            on_exit=self._on_ffmpeg_exit,
        )
        try:
            await self.ffmpeg.start()
        except (OSError, RuntimeError) as e:
            self.log.error('ffmpeg spawn failed: %s', e)
            self.sm.force_error(f'ffmpeg spawn failed: {e}')

    async def _on_ffmpeg_exit(self, abnormal: bool) -> None:
        msgs = self.sm.on_ffmpeg_exit(abnormal=abnormal)
        for mtype, data in msgs:
            await self._send(mtype, data)
        self.ffmpeg = None
        await self._emit_state()

    async def _emit_state(self) -> None:
        try:
            await decky.emit('state_changed', await self.get_state())
        except Exception as e:  # noqa: BLE001
            self.log.warning('state_changed emit failed: %s', e)


def _build_ffmpeg_args(rtsp_url: str) -> list[str]:
    """See spec §4.1 for the rationale of each flag."""
    return [
        '-thread_queue_size', '512',
        '-framerate', '60',
        '-device', '/dev/dri/card1',
        '-f', 'kmsgrab', '-i', '-',
        '-vaapi_device', '/dev/dri/renderD128',
        '-vf', 'hwmap=derive_device=vaapi,scale_vaapi=w=1280:h=800:format=nv12',
        '-c:v', 'h264_vaapi',
        '-profile:v', 'constrained_baseline',
        '-level', '3.0',
        '-bf', '0',
        '-g', '60',
        '-b:v', '6M',
        '-maxrate', '8M',
        '-bufsize', '2M',
        '-x264opts', 'repeat-headers=1',
        '-rtsp_transport', 'tcp',
        '-f', 'rtsp',
        rtsp_url,
    ]
