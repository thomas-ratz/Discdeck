"""Atomic-write JSON settings persistence.

Spec ref: Part 2 design §7.3.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, TypedDict

_log = logging.getLogger(__name__)


class LastConnectedPC(TypedDict):
    server: str
    event_port: int
    rtsp_port: int
    last_seen: str


class Settings(TypedDict):
    version: int
    pc_address_mode: str  # "auto" | "manual"
    manual_pc_address: str | None
    last_connected_pc: LastConnectedPC | None


_DEFAULTS: Settings = {
    'version': 1,
    'pc_address_mode': 'auto',
    'manual_pc_address': None,
    'last_connected_pc': None,
}


class SettingsStore:
    """Atomic JSON persistence for plugin settings.

    Reads once at construction. All writes are atomic: write to `.tmp`,
    fsync, rename. A corrupt file on disk falls back to defaults without
    crashing the plugin.
    """

    def __init__(self, path: Path | str) -> None:
        self._path = Path(path)
        self._settings: Settings = dict(_DEFAULTS)  # type: ignore[assignment]
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            loaded = json.loads(self._path.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as e:
            _log.warning('settings file unreadable (%s); using defaults', e)
            return
        if not isinstance(loaded, dict):
            _log.warning('settings file not a JSON object; using defaults')
            return
        # Merge known keys, ignore unknowns
        for k in _DEFAULTS:
            if k in loaded:
                self._settings[k] = loaded[k]  # type: ignore[literal-required]

    def get(self) -> Settings:
        # Return a shallow copy so callers can't mutate our state
        return dict(self._settings)  # type: ignore[return-value]

    def update(self, **changes: Any) -> Settings:
        for k, v in changes.items():
            if k not in _DEFAULTS:
                raise KeyError(f'unknown setting: {k}')
            self._settings[k] = v  # type: ignore[literal-required]
        self._write()
        return self.get()

    def _write(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + '.tmp')
        with tmp.open('w', encoding='utf-8') as f:
            json.dump(self._settings, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self._path)
