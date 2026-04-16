"""Supervise a single ffmpeg subprocess at a time.

Spawns with its own process group so we can reap cleanly (VAAPI encoder
threads otherwise linger on SteamOS). Distinguishes normal exits (caller
asked for stop) from abnormal exits (exit code != 0) and reports both via a
single on_exit callback.

Spec ref: Part 2 design §4.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import time
from dataclasses import dataclass
from typing import Awaitable, Callable

_log = logging.getLogger(__name__)

BuildArgs = Callable[[], list[str]]
ExitHandler = Callable[[bool], Awaitable[None]]


@dataclass
class _AbnormalCounter:
    count: int = 0


class FfmpegSupervisor:
    def __init__(
        self,
        *,
        ffmpeg_path: str,
        build_args: BuildArgs,
        on_exit: ExitHandler,
        sigkill_grace_sec: float = 2.0,
    ) -> None:
        self._path = ffmpeg_path
        self._build_args = build_args
        self._on_exit = on_exit
        self._grace = sigkill_grace_sec
        self._proc: asyncio.subprocess.Process | None = None
        self._wait_task: asyncio.Task | None = None
        self._requested_stop = False
        self._start_mono: float = 0.0
        self.abnormal_count: int = 0

    async def start(self) -> None:
        if self._proc is not None:
            raise RuntimeError('supervisor already running')
        argv = [self._path, *self._build_args()]
        _log.info('spawning ffmpeg: %s', ' '.join(argv))
        kwargs: dict = {
            'stdin': asyncio.subprocess.DEVNULL,
            'stdout': asyncio.subprocess.PIPE,
            'stderr': asyncio.subprocess.PIPE,
        }
        if os.name == 'posix':
            kwargs['preexec_fn'] = os.setsid
        self._proc = await asyncio.create_subprocess_exec(*argv, **kwargs)
        self._start_mono = time.monotonic()
        self._requested_stop = False
        self._wait_task = asyncio.create_task(self._waiter())

    async def _waiter(self) -> None:
        assert self._proc is not None
        code = await self._proc.wait()
        abnormal = (code != 0) and not self._requested_stop
        stderr = await self._proc.stderr.read() if self._proc.stderr else b''
        _log.info('ffmpeg exited code=%s abnormal=%s stderr=%.200s',
                  code, abnormal, stderr.decode('utf-8', 'replace'))
        if abnormal:
            self.abnormal_count += 1
        self._proc = None
        await self._on_exit(abnormal)

    async def stop(self) -> None:
        if self._proc is None:
            return
        self._requested_stop = True
        if os.name == 'posix':
            try:
                os.killpg(os.getpgid(self._proc.pid), signal.SIGINT)
            except ProcessLookupError:
                return
        else:
            try:
                self._proc.send_signal(signal.SIGTERM)
            except (ProcessLookupError, OSError):
                return
        try:
            await asyncio.wait_for(self.wait(), self._grace)
            return
        except asyncio.TimeoutError:
            _log.warning('ffmpeg did not exit on SIGTERM/SIGINT; sending SIGKILL')
            if self._proc is None:
                return
            if os.name == 'posix':
                try:
                    os.killpg(os.getpgid(self._proc.pid), signal.SIGKILL)
                except ProcessLookupError:
                    return
            else:
                try:
                    self._proc.kill()
                except (ProcessLookupError, OSError):
                    return
            await self.wait()

    async def wait(self) -> None:
        if self._wait_task is not None:
            await self._wait_task
