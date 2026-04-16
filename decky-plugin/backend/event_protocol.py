"""v1 event protocol envelope and validators.

Faithful port of src/main/network/event-protocol.ts from the Part 1 codebase.
If Part 1's TS file changes, this file changes with it — the contract must
stay byte-identical in both directions.

Spec ref: docs/PROTOCOL.md, Part 2 design §5.
"""
from __future__ import annotations

import datetime as _dt
import json
import uuid
from typing import Any, TypedDict

PROTOCOL_VERSION = 1

KNOWN_TYPES: frozenset[str] = frozenset({
    'hello', 'welcome',
    'game_start', 'game_change', 'game_stop',
    'stream_starting', 'stream_stopped',
    'heartbeat', 'error',
})


class Envelope(TypedDict):
    v: int
    type: str
    id: str
    ts: str
    data: dict[str, Any]


class ProtocolError(ValueError):
    """Raised when an envelope fails validation."""


def make_message(type_: str, data: dict[str, Any] | None = None) -> Envelope:
    if type_ not in KNOWN_TYPES:
        raise ProtocolError(f'unknown type: {type_}')
    return Envelope(
        v=PROTOCOL_VERSION,
        type=type_,
        id=str(uuid.uuid4()),
        ts=_dt.datetime.now(_dt.timezone.utc).isoformat(),
        data=data or {},
    )


def parse_message(wire: str) -> Envelope:
    try:
        obj = json.loads(wire)
    except json.JSONDecodeError as e:
        raise ProtocolError(f'invalid json: {e}') from e
    if not isinstance(obj, dict):
        raise ProtocolError('envelope must be a JSON object')
    for field in ('v', 'type', 'id', 'ts', 'data'):
        if field not in obj:
            raise ProtocolError(f'missing field: {field}')
    if obj['v'] != PROTOCOL_VERSION:
        raise ProtocolError(f'protocol version mismatch: got {obj["v"]}, want {PROTOCOL_VERSION}')
    if obj['type'] not in KNOWN_TYPES:
        raise ProtocolError(f'unknown type: {obj["type"]}')
    if not isinstance(obj['data'], dict):
        raise ProtocolError('data must be a JSON object')
    return obj  # type: ignore[return-value]
