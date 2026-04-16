import json
import pytest


def test_make_message_round_trips_through_json():
    from backend.event_protocol import make_message, parse_message
    msg = make_message('hello', {'client': 'decky-discdeck'})
    wire = json.dumps(msg)
    parsed = parse_message(wire)
    assert parsed['type'] == 'hello'
    assert parsed['v'] == 1
    assert parsed['data']['client'] == 'decky-discdeck'
    assert len(parsed['id']) == 36  # uuid4


def test_parse_rejects_non_json():
    from backend.event_protocol import parse_message, ProtocolError
    with pytest.raises(ProtocolError):
        parse_message('not json at all')


def test_parse_rejects_wrong_version():
    from backend.event_protocol import parse_message, ProtocolError
    bad = '{"v":2,"type":"hello","id":"x","ts":"x","data":{}}'
    with pytest.raises(ProtocolError, match='version'):
        parse_message(bad)


def test_parse_rejects_unknown_type():
    from backend.event_protocol import parse_message, ProtocolError
    bad = '{"v":1,"type":"bogus","id":"x","ts":"x","data":{}}'
    with pytest.raises(ProtocolError, match='unknown type'):
        parse_message(bad)


def test_parse_rejects_missing_fields():
    from backend.event_protocol import parse_message, ProtocolError
    with pytest.raises(ProtocolError):
        parse_message('{"v":1,"type":"hello"}')


@pytest.mark.parametrize('t', [
    'hello', 'welcome', 'game_start', 'game_change', 'game_stop',
    'stream_starting', 'stream_stopped', 'heartbeat', 'error',
])
def test_all_known_types_accepted(t):
    from backend.event_protocol import make_message, parse_message
    wire = json.dumps(make_message(t, {}))
    assert parse_message(wire)['type'] == t
