"""Grant cap_sys_admin+ep to bundled ffmpeg.

Uses `getcap` to check and `setcap` to grant. Both tools are standard on
SteamOS. The setcap call requires root, which Decky provides via the
`flags: ["root"]` declaration in plugin.json.

Spec ref: Part 2 design §4.4.
"""
from __future__ import annotations

import asyncio
import logging
import re
import shutil

_log = logging.getLogger(__name__)

_CAP_PATTERN = re.compile(r'cap_sys_admin(?:[=,+][ep]+)')


def _parse_getcap_output(output: str) -> bool:
    return bool(_CAP_PATTERN.search(output))


async def _run(*argv: str) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return proc.returncode, out.decode('utf-8', 'replace'), err.decode('utf-8', 'replace')


def has_cap_sys_admin(binary_path: str) -> bool:
    """Synchronous wrapper — used at module init before the asyncio loop starts."""
    if shutil.which('getcap') is None:
        return False
    import subprocess
    try:
        result = subprocess.run(
            ['getcap', binary_path],
            capture_output=True, text=True, timeout=5,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        _log.warning('getcap failed: %s', e)
        return False
    return _parse_getcap_output(result.stdout)


async def grant_cap_sys_admin(binary_path: str) -> None:
    """Grants cap_sys_admin+ep. Raises RuntimeError on failure."""
    if shutil.which('setcap') is None:
        raise RuntimeError('setcap not available on this system')
    code, out, err = await _run('setcap', 'cap_sys_admin+ep', binary_path)
    if code != 0:
        raise RuntimeError(f'setcap failed (code {code}): {err or out}')
    _log.info('granted cap_sys_admin+ep to %s', binary_path)
