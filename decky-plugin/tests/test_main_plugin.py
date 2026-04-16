import asyncio

import pytest


@pytest.mark.asyncio
async def test_plugin_lifecycle_smoke():
    """Plugin class can be instantiated, _main runs, _unload cleans up."""
    # Import after decky stub is installed
    from main import Plugin

    p = Plugin()
    main_task = asyncio.create_task(p._main())
    await asyncio.sleep(0.1)  # let _main kick off
    state = await p.get_state()
    assert state['state'] in ('disconnected', 'connecting', 'error')
    await p._unload()
    main_task.cancel()
    try: await main_task
    except asyncio.CancelledError: pass


@pytest.mark.asyncio
async def test_set_pc_address_mode_persists(tmp_path):
    from main import Plugin
    p = Plugin()
    asyncio.create_task(p._main())
    await asyncio.sleep(0.1)
    await p.set_pc_address_mode({'mode': 'manual', 'address': '10.0.0.5'})
    state = await p.get_state()
    assert state['pc_address_mode'] == 'manual'
    assert state['manual_pc_address'] == '10.0.0.5'
    await p._unload()


@pytest.mark.asyncio
async def test_on_game_event_updates_state():
    from main import Plugin
    p = Plugin()
    asyncio.create_task(p._main())
    await asyncio.sleep(0.1)
    await p.on_game_event({'kind': 'start', 'app_id': '1', 'game_name': 'A', 'at': 't1'})
    state = await p.get_state()
    assert state['current_game'] == {'app_id': '1', 'game_name': 'A'}
    await p._unload()
