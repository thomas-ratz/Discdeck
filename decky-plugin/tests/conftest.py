"""Shared pytest fixtures and test-only stubs for Decky-provided globals.

Decky injects a `decky` module into the plugin runtime. Backend modules import
from it. At pytest time no Decky runtime exists, so we install a stub before
any backend module is imported.
"""
from __future__ import annotations

import logging
import sys
import types
from pathlib import Path


def _install_decky_stub(tmp_path: Path) -> None:
    if 'decky' in sys.modules:
        return
    stub = types.ModuleType('decky')
    stub.__version__ = '1.0.0-test'
    stub.HOME = str(tmp_path / 'home')
    stub.USER = 'test'
    stub.DECKY_VERSION = 'v3.2.3-test'
    stub.DECKY_USER = 'test'
    stub.DECKY_USER_HOME = str(tmp_path / 'home')
    stub.DECKY_HOME = str(tmp_path / 'homebrew')
    stub.DECKY_PLUGIN_SETTINGS_DIR = str(tmp_path / 'settings')
    stub.DECKY_PLUGIN_RUNTIME_DIR = str(tmp_path / 'runtime')
    stub.DECKY_PLUGIN_LOG_DIR = str(tmp_path / 'logs')
    stub.DECKY_PLUGIN_DIR = str(tmp_path / 'plugin')
    stub.DECKY_PLUGIN_NAME = 'Discdeck'
    stub.DECKY_PLUGIN_VERSION = '0.1.0'
    stub.DECKY_PLUGIN_AUTHOR = 'Jaste'
    stub.DECKY_PLUGIN_LOG = str(tmp_path / 'logs' / 'discdeck.log')
    stub.logger = logging.getLogger('decky')

    async def emit(event: str, *args) -> None:  # noqa: ANN001
        stub.logger.debug('emit %s %r', event, args)

    stub.emit = emit
    sys.modules['decky'] = stub
    for d in (stub.DECKY_PLUGIN_SETTINGS_DIR,
              stub.DECKY_PLUGIN_RUNTIME_DIR,
              stub.DECKY_PLUGIN_LOG_DIR):
        Path(d).mkdir(parents=True, exist_ok=True)


import pytest


@pytest.fixture(autouse=True)
def _decky_stub(tmp_path, monkeypatch):
    """Auto-fixture so every test gets a clean Decky stub."""
    # Remove cached decky + backend modules so each test is isolated.
    for mod in list(sys.modules):
        if mod == 'decky' or mod.startswith('backend.'):
            sys.modules.pop(mod, None)
    _install_decky_stub(tmp_path)
    yield
