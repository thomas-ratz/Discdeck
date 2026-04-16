import pytest


def test_initial_state_is_disconnected():
    from backend.state import StateMachine, State
    sm = StateMachine()
    assert sm.state == State.DISCONNECTED
    assert sm.current_game is None
    assert sm.streaming is False


def test_welcome_transitions_to_connected_idle():
    from backend.state import StateMachine, State
    sm = StateMachine()
    sm.on_dial_started()
    assert sm.state == State.CONNECTING
    sm.on_welcome({'server': 'test-pc', 'server_version': '0.1.0'})
    assert sm.state == State.CONNECTED_IDLE


def test_game_start_transitions_to_connected_game():
    from backend.state import StateMachine, State
    sm = StateMachine()
    sm.on_dial_started()
    sm.on_welcome({'server': 'pc', 'server_version': '0.1.0'})
    out = sm.on_game_event(kind='start', app_id='367520', game_name='Hollow Knight',
                           at='2026-04-16T12:00:00Z')
    assert sm.state == State.CONNECTED_GAME
    assert sm.current_game == {'app_id': '367520', 'game_name': 'Hollow Knight'}
    assert out[0][0] == 'game_start'


def test_game_change_when_start_with_existing_game():
    from backend.state import StateMachine, State
    sm = StateMachine()
    sm.on_dial_started(); sm.on_welcome({'server': 'pc', 'server_version': '0.1.0'})
    sm.on_game_event(kind='start', app_id='367520', game_name='Hollow Knight',
                     at='2026-04-16T12:00:00Z')
    out = sm.on_game_event(kind='start', app_id='1145360', game_name='Hades',
                           at='2026-04-16T12:05:00Z')
    assert out[0][0] == 'game_change'
    assert sm.current_game == {'app_id': '1145360', 'game_name': 'Hades'}


def test_stale_game_stop_is_ignored():
    from backend.state import StateMachine
    sm = StateMachine()
    sm.on_dial_started(); sm.on_welcome({'server': 'pc', 'server_version': '0.1.0'})
    sm.on_game_event(kind='start', app_id='1', game_name='A', at='t1')
    sm.on_game_event(kind='start', app_id='2', game_name='B', at='t2')  # game_change
    out = sm.on_game_event(kind='stop', app_id='1', game_name='A', at='t3')  # stale
    assert out == []  # no message emitted
    assert sm.current_game == {'app_id': '2', 'game_name': 'B'}


def test_stream_toggle_requires_connected():
    from backend.state import StateMachine
    sm = StateMachine()
    with pytest.raises(RuntimeError):
        sm.on_toggle_streaming(True)


def test_stream_toggle_emits_stream_starting():
    from backend.state import StateMachine, State
    sm = StateMachine()
    sm.on_dial_started(); sm.on_welcome({'server': 'pc', 'server_version': '0.1.0'})
    out = sm.on_toggle_streaming(True)
    assert any(msg_type == 'stream_starting' for msg_type, _ in out)
    assert sm.state == State.STREAMING


def test_stream_toggle_off_emits_stream_stopped():
    from backend.state import StateMachine, State
    sm = StateMachine()
    sm.on_dial_started(); sm.on_welcome({'server': 'pc', 'server_version': '0.1.0'})
    sm.on_toggle_streaming(True)
    out = sm.on_toggle_streaming(False)
    assert any(msg_type == 'stream_stopped' and data['reason'] == 'user_toggled_off'
               for msg_type, data in out)
    assert sm.state == State.CONNECTED_IDLE


def test_crash_loop_after_three_abnormal_exits_moves_to_error():
    from backend.state import StateMachine, State
    sm = StateMachine()
    sm.on_dial_started(); sm.on_welcome({'server': 'pc', 'server_version': '0.1.0'})
    # Exits 1 and 2 don't trigger error — user can respawn
    sm.on_toggle_streaming(True)
    sm.on_ffmpeg_exit(abnormal=True, now=0.0)
    assert sm.state in (State.CONNECTED_IDLE, State.CONNECTED_GAME)
    sm.on_toggle_streaming(True)
    sm.on_ffmpeg_exit(abnormal=True, now=1.0)
    assert sm.state in (State.CONNECTED_IDLE, State.CONNECTED_GAME)
    # 3rd abnormal within 30s → error
    sm.on_toggle_streaming(True)
    sm.on_ffmpeg_exit(abnormal=True, now=2.0)
    assert sm.state == State.ERROR


def test_ws_drop_while_streaming_kills_stream_state():
    from backend.state import StateMachine, State
    sm = StateMachine()
    sm.on_dial_started(); sm.on_welcome({'server': 'pc', 'server_version': '0.1.0'})
    sm.on_toggle_streaming(True)
    sm.on_ws_dropped()
    assert sm.state == State.DISCONNECTED
    assert sm.streaming is False


def test_reconnect_from_error_resets():
    from backend.state import StateMachine, State
    sm = StateMachine()
    sm.force_error('test')
    assert sm.state == State.ERROR
    sm.on_user_reconnect()
    assert sm.state == State.DISCONNECTED
