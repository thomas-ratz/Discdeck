import shutil
import pytest

from backend import capability


@pytest.mark.skipif(shutil.which('getcap') is None, reason='getcap not installed (non-Linux)')
def test_has_cap_sys_admin_on_bare_binary(tmp_path):
    exe = tmp_path / 'fakebin'
    exe.write_bytes(b'\x7fELF...')
    assert capability.has_cap_sys_admin(str(exe)) is False


def test_parse_getcap_output():
    assert capability._parse_getcap_output('/path/to/ffmpeg cap_sys_admin=ep\n') is True
    assert capability._parse_getcap_output('/path/to/ffmpeg cap_chown,cap_sys_admin+ep\n') is True
    assert capability._parse_getcap_output('/path/to/ffmpeg\n') is False
    assert capability._parse_getcap_output('') is False
