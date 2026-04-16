"""Configure backend logging to use decky.logger.

Respects an undocumented DEBUG escape hatch: if a file named `discdeck.debug`
exists in DECKY_PLUGIN_SETTINGS_DIR, log level is DEBUG; otherwise INFO.

Spec ref: Part 2 design §7.4.
"""
from __future__ import annotations

import logging
from pathlib import Path

import decky


def configure() -> logging.Logger:
    """Configure root logging. Return the backend logger."""
    debug_flag = Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / 'discdeck.debug'
    level = logging.DEBUG if debug_flag.exists() else logging.INFO

    root = logging.getLogger()
    root.setLevel(level)

    # decky.logger already writes to DECKY_PLUGIN_LOG. We only need to ensure
    # our own logger hierarchy propagates to it.
    backend_logger = logging.getLogger('discdeck')
    backend_logger.setLevel(level)

    return backend_logger
