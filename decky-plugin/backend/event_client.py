"""Event WebSocket client to the PC companion.

Owns the WS lifetime. Sends hello, waits for welcome, heartbeats every 5s,
enforces 15s idle timeout. Exposes send() for forwarding game/stream messages
from the state machine.

Spec ref: Part 2 design §5.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable

import websockets
from websockets.asyncio.client import ClientConnection
from websockets.exceptions import ConnectionClosed

from backend.event_protocol import make_message, parse_message, ProtocolError

_log = logging.getLogger(__name__)

Handler = Callable[[dict[str, Any]], Awaitable[None]]
DisconnectHandler = Callable[[str], Awaitable[None]]


class EventClient:
    def __init__(
        self,
        *,
        url: str,
        hello: dict[str, Any],
        on_welcome: Handler | None = None,
        on_disconnect: DisconnectHandler | None = None,
        heartbeat_interval: float = 5.0,
        idle_timeout: float = 15.0,
    ) -> None:
        self._url = url
        self._hello = hello
        self._on_welcome = on_welcome
        self._on_disconnect = on_disconnect
        self._hb_interval = heartbeat_interval
        self._idle_timeout = idle_timeout
        self._ws: ClientConnection | None = None
        self._last_recv: float = 0.0
        self._stopping = asyncio.Event()

    async def run(self) -> None:
        """Connect, hello/welcome, then run receive + heartbeat loops until closed."""
        reason = 'unknown'
        try:
            async with websockets.connect(self._url, open_timeout=10.0) as ws:
                self._ws = ws
                self._last_recv = time.monotonic()
                await self._send_raw(make_message('hello', self._hello))
                tasks = [
                    asyncio.create_task(self._receive_loop()),
                    asyncio.create_task(self._heartbeat_loop()),
                    asyncio.create_task(self._idle_watchdog()),
                    asyncio.create_task(self._stop_waiter()),
                ]
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
                for t in done:
                    if t.exception() is not None:
                        reason = f'{type(t.exception()).__name__}: {t.exception()}'
                        _log.warning('event client exited: %s', reason)
                        break
                else:
                    reason = 'stopped'
        except (OSError, ConnectionClosed, asyncio.TimeoutError) as e:
            reason = f'{type(e).__name__}: {e}'
            _log.info('event client could not connect or dropped: %s', reason)
        finally:
            self._ws = None
            if self._on_disconnect:
                await self._on_disconnect(reason)

    async def stop(self) -> None:
        self._stopping.set()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001
                pass

    async def send(self, type_: str, data: dict[str, Any] | None = None) -> None:
        if self._ws is None:
            raise ConnectionError('not connected')
        await self._send_raw(make_message(type_, data or {}))

    async def _send_raw(self, envelope: dict[str, Any]) -> None:
        assert self._ws is not None
        await self._ws.send(json.dumps(envelope))

    async def _receive_loop(self) -> None:
        assert self._ws is not None
        async for raw in self._ws:
            self._last_recv = time.monotonic()
            try:
                msg = parse_message(raw if isinstance(raw, str) else raw.decode('utf-8'))
            except ProtocolError as e:
                _log.warning('dropping invalid message: %s', e)
                continue
            if msg['type'] == 'welcome' and self._on_welcome is not None:
                await self._on_welcome(msg['data'])

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(self._hb_interval)
            try:
                await self.send('heartbeat')
            except (ConnectionError, ConnectionClosed):
                return

    async def _idle_watchdog(self) -> None:
        while True:
            await asyncio.sleep(self._hb_interval / 2)
            if time.monotonic() - self._last_recv > self._idle_timeout:
                _log.warning('idle timeout — closing')
                if self._ws is not None:
                    await self._ws.close()
                return

    async def _stop_waiter(self) -> None:
        await self._stopping.wait()
