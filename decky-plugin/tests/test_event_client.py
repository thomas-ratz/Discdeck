import asyncio
import json

import pytest
import websockets


@pytest.mark.asyncio
async def test_hello_welcome_roundtrip():
    """Client sends hello on connect; waits for welcome before emitting anything else."""
    from backend.event_client import EventClient

    received = []
    welcome_sent = asyncio.Event()

    async def server_handler(ws):
        async for raw in ws:
            msg = json.loads(raw)
            received.append(msg)
            if msg['type'] == 'hello':
                welcome = {
                    'v': 1, 'type': 'welcome', 'id': 'w', 'ts': 'x',
                    'data': {'server': 'test-pc', 'server_version': '0.1.0',
                             'accepted_capabilities': ['video', 'events']},
                }
                await ws.send(json.dumps(welcome))
                welcome_sent.set()

    async with websockets.serve(server_handler, '127.0.0.1', 0) as server:
        port = server.sockets[0].getsockname()[1]
        got_welcome = asyncio.Event()

        async def on_welcome(data):
            got_welcome.set()

        client = EventClient(
            url=f'ws://127.0.0.1:{port}/events',
            hello={'client': 'decky-discdeck', 'client_version': '0.1.0-test',
                   'deck_name': 'Test', 'capabilities': ['video', 'events']},
            on_welcome=on_welcome,
        )
        task = asyncio.create_task(client.run())
        try:
            await asyncio.wait_for(got_welcome.wait(), 2.0)
        finally:
            await client.stop()
            task.cancel()
            try: await task
            except asyncio.CancelledError: pass
    assert received and received[0]['type'] == 'hello'


@pytest.mark.asyncio
async def test_heartbeat_timeout_closes_connection():
    """Silent server (no heartbeats) → client closes after 15s.

    We shorten the timeout for this test via the client's `idle_timeout` arg.
    """
    from backend.event_client import EventClient
    closed = asyncio.Event()

    async def server_handler(ws):
        # Accept hello, send welcome, then go silent.
        async for raw in ws:
            msg = json.loads(raw)
            if msg['type'] == 'hello':
                await ws.send(json.dumps({'v': 1, 'type': 'welcome', 'id': 'w',
                                           'ts': 'x', 'data': {'server': 'x', 'server_version': 'x'}}))
            # Ignore heartbeats — do NOT reply.

    async with websockets.serve(server_handler, '127.0.0.1', 0) as server:
        port = server.sockets[0].getsockname()[1]

        async def on_disconnect(reason):
            closed.set()

        client = EventClient(
            url=f'ws://127.0.0.1:{port}/events',
            hello={'client': 'decky-discdeck', 'client_version': '0.1.0-test',
                   'deck_name': 'Test', 'capabilities': ['video', 'events']},
            on_disconnect=on_disconnect,
            heartbeat_interval=0.2,
            idle_timeout=0.6,
        )
        task = asyncio.create_task(client.run())
        try:
            await asyncio.wait_for(closed.wait(), 3.0)
        finally:
            await client.stop()
            task.cancel()
            try: await task
            except asyncio.CancelledError: pass
