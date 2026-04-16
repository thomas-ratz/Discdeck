import asyncio

import pytest
from zeroconf import ServiceInfo, Zeroconf


@pytest.mark.asyncio
async def test_browser_finds_published_service():
    from backend.mdns_browser import MdnsBrowser

    zc = Zeroconf()
    info = ServiceInfo(
        '_discdeck._tcp.local.',
        'test-pc._discdeck._tcp.local.',
        addresses=[b'\x7f\x00\x00\x01'],
        port=8765,
        properties={b'event_port': b'8765', b'rtsp_port': b'8554', b'protocol_version': b'1'},
        server='test-pc.local.',
    )
    zc.register_service(info)

    found = asyncio.Event()
    captured = {}

    async def on_found(discovery):
        captured.update(discovery)
        found.set()

    browser = MdnsBrowser(on_service_found=on_found)
    await browser.start()
    try:
        await asyncio.wait_for(found.wait(), 5.0)
        assert captured['server'] == 'test-pc.local.'
        assert captured['event_port'] == 8765
        assert captured['rtsp_port'] == 8554
    finally:
        await browser.stop()
        zc.unregister_service(info)
        zc.close()


@pytest.mark.asyncio
async def test_wrong_protocol_version_is_rejected():
    from backend.mdns_browser import MdnsBrowser
    zc = Zeroconf()
    info = ServiceInfo(
        '_discdeck._tcp.local.',
        'bad-pc._discdeck._tcp.local.',
        addresses=[b'\x7f\x00\x00\x01'],
        port=8765,
        properties={b'event_port': b'8765', b'rtsp_port': b'8554', b'protocol_version': b'99'},
        server='bad-pc.local.',
    )
    zc.register_service(info)

    found_events = []

    async def on_found(d):
        found_events.append(d)

    browser = MdnsBrowser(on_service_found=on_found)
    await browser.start()
    try:
        await asyncio.sleep(1.5)
        assert not found_events, 'should have ignored protocol v99'
    finally:
        await browser.stop()
        zc.unregister_service(info)
        zc.close()
