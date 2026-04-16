from pathlib import Path


def test_defaults_when_no_file(tmp_path):
    from backend.settings_store import SettingsStore
    s = SettingsStore(tmp_path / 'config.json')
    assert s.get()['version'] == 1
    assert s.get()['pc_address_mode'] == 'auto'
    assert s.get()['manual_pc_address'] is None
    assert s.get()['last_connected_pc'] is None


def test_load_existing(tmp_path):
    from backend.settings_store import SettingsStore
    p = tmp_path / 'config.json'
    p.write_text('{"version":1,"pc_address_mode":"manual","manual_pc_address":"10.0.0.5","last_connected_pc":null}')
    s = SettingsStore(p)
    assert s.get()['pc_address_mode'] == 'manual'
    assert s.get()['manual_pc_address'] == '10.0.0.5'


def test_update_is_atomic(tmp_path):
    from backend.settings_store import SettingsStore
    p = tmp_path / 'config.json'
    s = SettingsStore(p)
    s.update(pc_address_mode='manual', manual_pc_address='192.168.1.42')
    # no stray .tmp file after update completes
    assert not (tmp_path / 'config.json.tmp').exists()
    assert p.exists()
    # reload picks up change
    s2 = SettingsStore(p)
    assert s2.get()['manual_pc_address'] == '192.168.1.42'


def test_corrupt_file_falls_back_to_defaults(tmp_path):
    from backend.settings_store import SettingsStore
    p = tmp_path / 'config.json'
    p.write_text('not valid json at all')
    s = SettingsStore(p)
    assert s.get()['version'] == 1
    assert s.get()['pc_address_mode'] == 'auto'
