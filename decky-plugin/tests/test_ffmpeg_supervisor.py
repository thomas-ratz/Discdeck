import asyncio
import sys

import pytest


@pytest.mark.asyncio
async def test_normal_exit_is_not_abnormal():
    """A subprocess that exits quickly with code 0 is not counted as abnormal."""
    from backend.ffmpeg_supervisor import FfmpegSupervisor, _AbnormalCounter

    exits = []

    async def on_exit(abnormal):
        exits.append(abnormal)

    sup = FfmpegSupervisor(
        ffmpeg_path=sys.executable,    # Use `python` as a stand-in subprocess
        build_args=lambda: ['-c', 'pass'],
        on_exit=on_exit,
    )
    await sup.start()
    await asyncio.wait_for(sup.wait(), 2.0)
    assert exits == [False]  # exit code 0 → not abnormal
    assert sup.abnormal_count == 0


@pytest.mark.asyncio
async def test_abnormal_exit_counted():
    from backend.ffmpeg_supervisor import FfmpegSupervisor
    exits = []

    async def on_exit(abnormal):
        exits.append(abnormal)

    sup = FfmpegSupervisor(
        ffmpeg_path=sys.executable,
        build_args=lambda: ['-c', 'import sys; sys.exit(7)'],
        on_exit=on_exit,
    )
    await sup.start()
    await asyncio.wait_for(sup.wait(), 2.0)
    assert exits == [True]
    assert sup.abnormal_count == 1


@pytest.mark.asyncio
async def test_kill_escalates_to_sigkill_after_grace():
    """A subprocess that ignores SIGINT is killed with SIGKILL after grace."""
    from backend.ffmpeg_supervisor import FfmpegSupervisor
    sup = FfmpegSupervisor(
        ffmpeg_path=sys.executable,
        build_args=lambda: [
            '-c',
            'import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\n'
            'time.sleep(5)',
        ],
        on_exit=lambda abnormal: asyncio.sleep(0),
        sigkill_grace_sec=0.5,
    )
    await sup.start()
    await asyncio.sleep(0.2)  # let it ignore SIGINT
    start = asyncio.get_event_loop().time()
    await sup.stop()
    elapsed = asyncio.get_event_loop().time() - start
    assert elapsed < 2.0, 'SIGKILL escalation should happen within ~0.5s'
