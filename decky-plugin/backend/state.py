"""Pure state machine. No I/O, no async — unit-testable in isolation.

Each public method takes the inputs that cause a transition, mutates state,
and returns a list of (message_type, data) tuples the caller must send on the
event WS (order matters). Side effects (spawning ffmpeg, sending bytes) are
the caller's responsibility.

Spec ref: Part 2 design §3, §5.2.
"""
from __future__ import annotations

import enum
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, TypedDict

_CRASH_LOOP_WINDOW_SEC = 30.0
_CRASH_LOOP_THRESHOLD = 3


class State(str, enum.Enum):
    DISCONNECTED = 'disconnected'
    CONNECTING = 'connecting'
    CONNECTED_IDLE = 'connected_idle'
    CONNECTED_GAME = 'connected_game'
    STREAMING = 'streaming'
    ERROR = 'error'


class GameRef(TypedDict):
    app_id: str
    game_name: str


Message = tuple[str, dict[str, Any]]


@dataclass
class StateMachine:
    state: State = State.DISCONNECTED
    current_game: GameRef | None = None
    streaming: bool = False
    error_message: str | None = None
    connected_pc: dict[str, Any] | None = None
    _abnormal_exits: deque = field(default_factory=lambda: deque(maxlen=_CRASH_LOOP_THRESHOLD))

    # ---- WS lifecycle ----
    def on_dial_started(self) -> list[Message]:
        if self.state in (State.CONNECTING, State.STREAMING, State.CONNECTED_GAME, State.CONNECTED_IDLE):
            return []
        self.state = State.CONNECTING
        return []

    def on_welcome(self, server_info: dict[str, Any]) -> list[Message]:
        self.connected_pc = server_info
        self.state = State.CONNECTED_GAME if self.current_game else State.CONNECTED_IDLE
        # Send hello? No — the caller sends hello before calling us.
        # We're now live; return nothing — game/stream messages follow naturally.
        return []

    def on_ws_dropped(self) -> list[Message]:
        self.streaming = False
        self.state = State.DISCONNECTED
        self.connected_pc = None
        return []

    # ---- Game lifecycle (from SteamClient frontend hooks) ----
    def on_game_event(self, *, kind: str, app_id: str,
                      game_name: str | None = None, at: str) -> list[Message]:
        if kind == 'start':
            was_in_game = self.current_game is not None
            self.current_game = {'app_id': app_id, 'game_name': game_name or 'Unknown'}
            if self.state in (State.CONNECTED_IDLE, State.CONNECTED_GAME):
                self.state = State.CONNECTED_GAME
            msg_type = 'game_change' if was_in_game else 'game_start'
            data = {'game_name': game_name, 'app_id': app_id, 'launched_at': at}
            return [(msg_type, data)]
        if kind == 'stop':
            # Only emit game_stop if the stopping app matches current.
            if self.current_game and self.current_game['app_id'] == app_id:
                self.current_game = None
                if self.state == State.CONNECTED_GAME:
                    self.state = State.CONNECTED_IDLE
                return [('game_stop', {'game_name': game_name, 'closed_at': at})]
            # Stale — ignore.
            return []
        raise ValueError(f'unknown game event kind: {kind}')

    # ---- Streaming lifecycle ----
    def on_toggle_streaming(self, enabled: bool) -> list[Message]:
        if enabled:
            if self.state not in (State.CONNECTED_IDLE, State.CONNECTED_GAME):
                raise RuntimeError(f'cannot start streaming from state {self.state}')
            self.streaming = True
            self.state = State.STREAMING
            # Caller fills in rtsp_url etc. in the data dict it builds from config.
            return [('stream_starting', {
                'video_codec': 'h264',
                'width': 1280, 'height': 800, 'fps': 60,
            })]
        # disabled
        if self.state == State.STREAMING:
            self.streaming = False
            self.state = State.CONNECTED_GAME if self.current_game else State.CONNECTED_IDLE
            return [('stream_stopped', {'reason': 'user_toggled_off'})]
        return []

    def on_ffmpeg_exit(self, *, abnormal: bool, now: float | None = None) -> list[Message]:
        now = time.monotonic() if now is None else now
        if not abnormal:
            # Normal exit (we killed it or it ended cleanly). State already updated
            # by on_toggle_streaming(False), so nothing to do.
            return []
        # Abnormal — record, check crash loop.
        self._abnormal_exits.append(now)
        self.streaming = False
        if (len(self._abnormal_exits) >= _CRASH_LOOP_THRESHOLD
                and now - self._abnormal_exits[0] <= _CRASH_LOOP_WINDOW_SEC):
            self.state = State.ERROR
            self.error_message = 'ffmpeg crash-looped'
            return [('stream_stopped', {'reason': 'error'})]
        # Not yet in crash loop — drop back to idle/game so user can respawn.
        # But don't override a DISCONNECTED state if the WS already dropped.
        if self.state == State.STREAMING:
            self.state = State.CONNECTED_GAME if self.current_game else State.CONNECTED_IDLE
        return [('stream_stopped', {'reason': 'error'})]

    # ---- User actions ----
    def on_user_reconnect(self) -> list[Message]:
        self.state = State.DISCONNECTED
        self.error_message = None
        self.connected_pc = None
        self._abnormal_exits.clear()
        return []

    # ---- Direct error injection (setcap failure, etc.) ----
    def force_error(self, message: str) -> list[Message]:
        self.state = State.ERROR
        self.error_message = message
        self.streaming = False
        return []

    # ---- Snapshot for frontend ----
    def snapshot(self) -> dict[str, Any]:
        return {
            'state': self.state.value,
            'connected_pc': self.connected_pc,
            'current_game': self.current_game,
            'streaming': self.streaming,
            'error_message': self.error_message,
        }
