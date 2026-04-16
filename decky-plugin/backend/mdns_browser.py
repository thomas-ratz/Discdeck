"""Browse LAN for _discdeck._tcp.local. advertised by the PC companion.

Spec ref: Part 2 design §7.1.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from zeroconf import ServiceStateChange, Zeroconf
from zeroconf.asyncio import AsyncServiceBrowser, AsyncZeroconf

_log = logging.getLogger(__name__)

Discovery = dict[str, Any]
FoundHandler = Callable[[Discovery], Awaitable[None]]
RemovedHandler = Callable[[str], Awaitable[None]]

SERVICE_TYPE = '_discdeck._tcp.local.'
EXPECTED_PROTOCOL_VERSION = 1


class MdnsBrowser:
    def __init__(
        self,
        *,
        on_service_found: FoundHandler,
        on_service_removed: RemovedHandler | None = None,
    ) -> None:
        self._on_found = on_service_found
        self._on_removed = on_service_removed
        self._azc: AsyncZeroconf | None = None
        self._browser: AsyncServiceBrowser | None = None

    async def start(self) -> None:
        self._azc = AsyncZeroconf()
        self._browser = AsyncServiceBrowser(
            self._azc.zeroconf,
            [SERVICE_TYPE],
            handlers=[self._handler],
        )

    async def stop(self) -> None:
        if self._browser is not None:
            await self._browser.async_cancel()
            self._browser = None
        if self._azc is not None:
            await self._azc.async_close()
            self._azc = None

    def _handler(self, zeroconf: Zeroconf, service_type: str, name: str,
                 state_change: ServiceStateChange) -> None:
        if state_change == ServiceStateChange.Added:
            asyncio.ensure_future(self._added(zeroconf, service_type, name))
        elif state_change == ServiceStateChange.Removed and self._on_removed is not None:
            asyncio.ensure_future(self._on_removed(name))

    async def _added(self, zc: Zeroconf, stype: str, name: str) -> None:
        assert self._azc is not None
        info = await self._azc.async_get_service_info(stype, name)
        if info is None:
            return
        props = {k.decode(): v.decode() for k, v in info.properties.items() if v is not None}
        try:
            if int(props.get('protocol_version', '0')) != EXPECTED_PROTOCOL_VERSION:
                _log.info('ignoring %s: protocol_version=%s', name, props.get('protocol_version'))
                return
            event_port = int(props['event_port'])
            rtsp_port = int(props['rtsp_port'])
        except (ValueError, KeyError) as e:
            _log.warning('malformed TXT record on %s: %s', name, e)
            return
        discovery: Discovery = {
            'server': info.server or name,
            'addresses': [a for a in info.parsed_addresses()],
            'event_port': event_port,
            'rtsp_port': rtsp_port,
        }
        await self._on_found(discovery)
