"""The sidecar: a long-running JSON-RPC 2.0 server, one JSON document per line.

Requests arrive on stdin and responses leave on stdout. stdout belongs to the protocol
writer alone; everything else (print, library output, logs) is routed to stderr.
Method signatures are mirrored by hand in src/shared/rpc.ts.
"""

from __future__ import annotations

import inspect
import json
import logging
import math
import multiprocessing
import multiprocessing.connection
import os
import re
import signal
import sys
import threading
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, wait
from concurrent.futures.process import BrokenProcessPool
from contextlib import contextmanager
from dataclasses import dataclass
from importlib.metadata import version
from typing import Any, TextIO

from fixlib_py.logging_setup import configure_logging

logger = logging.getLogger(__name__)

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# Requests are answered on these threads so a long job never blocks ping. Heavy work
# is handed on to cpu_pool() or demucs_executor() by the method itself.
DISPATCH_THREADS = 32

_methods: dict[str, Callable[..., Any]] = {}
_executor_lock = threading.Lock()
_cpu_pool: ProcessPoolExecutor | None = None
_demucs_executor: ThreadPoolExecutor | None = None
_writer: ProtocolWriter | None = None

# The jobs that can be told to stop, by the id the app gave them.
_jobs_lock = threading.Lock()
_jobs: dict[str, threading.Event] = {}
# Ids that were cancelled while no such job was running. A cancel can overtake the
# job it is meant for: both arrive as requests and are answered on different threads.
# Insertion ordered, and cut to the newest when it grows.
_cancelled_early: dict[str, None] = {}
MAX_CANCELLED_EARLY = 256
# The same limit as in src/shared/rpc.ts.
MAX_JOB_ID_LENGTH = 64
# How often a job waiting for a pool worker looks whether it was told to stop.
_POLL_S = 0.2


class JobCancelled(Exception):
    """Raised inside a job that was told to stop."""


def rpc(name: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Register a function as the JSON-RPC method `name`.

    Parameters arrive camelCase on the wire and are passed as snake_case keyword arguments.
    """

    def register(function: Callable[..., Any]) -> Callable[..., Any]:
        if name in _methods:
            raise ValueError(f"RPC method already registered: {name}")
        # Every parameter must be nameable from the wire and nothing else may be.
        for parameter in inspect.signature(function).parameters.values():
            if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
                raise ValueError(f"RPC method {name} must not take *args or **kwargs")
            if parameter.name.startswith("_"):
                raise ValueError(f"RPC method {name} has a private parameter: {parameter.name}")
        _methods[name] = function
        return function

    return register


@dataclass(frozen=True)
class Request:
    """A validated request. `request_id` is None for a notification."""

    request_id: int | str | None
    method: str
    params: dict[str, Any]
    is_notification: bool


class ProtocolWriter:
    """The only writer of the protocol stream. Safe to call from any thread."""

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def send(self, message: dict[str, Any]) -> None:
        line = _encode(message)
        with self._lock:
            self._stream.write(line + "\n")
            self._stream.flush()


def _exit_with_parent() -> None:
    """Runs in a pool worker as it starts: the worker ends when the sidecar does.

    A worker is not told when its parent is gone, however that ended, and would go on
    analysing a file after the app has quit.
    """
    parent = multiprocessing.parent_process()
    if parent is None:
        return

    def watch() -> None:
        multiprocessing.connection.wait([parent.sentinel])
        os._exit(0)

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()


def new_worker_pool(max_workers: int) -> ProcessPoolExecutor:
    """A process pool whose workers do not outlive the sidecar."""
    return ProcessPoolExecutor(max_workers=max_workers, initializer=_exit_with_parent)


def cpu_pool() -> ProcessPoolExecutor:
    """The process pool for CPU analysis. Created on first use so startup stays fast."""
    global _cpu_pool
    with _executor_lock:
        if _cpu_pool is None:
            _cpu_pool = new_worker_pool(max(1, (os.cpu_count() or 2) - 1))
        return _cpu_pool


def discard_cpu_pool(pool: ProcessPoolExecutor) -> None:
    """Drop a pool whose worker died, so the next job gets a new one.

    A process pool that lost a worker fails every job it holds and takes no more.
    Names the pool it means: several jobs notice the same broken pool, and only the
    first of them may replace it.
    """
    global _cpu_pool
    with _executor_lock:
        if _cpu_pool is pool:
            _cpu_pool = None
    pool.shutdown(wait=False, cancel_futures=True)


def demucs_executor() -> ThreadPoolExecutor:
    """The single worker for Demucs, so the model loads once and jobs never overlap."""
    global _demucs_executor
    with _executor_lock:
        if _demucs_executor is None:
            _demucs_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="demucs")
        return _demucs_executor


def close_executors() -> None:
    """Stop both executors without waiting for queued work."""
    global _cpu_pool, _demucs_executor
    with _executor_lock:
        for executor in (_cpu_pool, _demucs_executor):
            if executor is not None:
                executor.shutdown(wait=False, cancel_futures=True)
        _cpu_pool = None
        _demucs_executor = None


def report_progress(job_id: str, percent: float) -> None:
    """Send a progress notification for a running job. Call it from the server process."""
    if _writer is None:
        raise RuntimeError("report_progress() needs a running server")
    if not math.isfinite(percent) or not 0 <= percent <= 100:
        raise ValueError(f"percent must be between 0 and 100, got {percent}")
    _writer.send(
        {"jsonrpc": "2.0", "method": "progress", "params": {"jobId": job_id, "percent": percent}}
    )


def _check_job_id(job_id: object) -> str:
    if not isinstance(job_id, str) or not 1 <= len(job_id) <= MAX_JOB_ID_LENGTH:
        raise ValueError(f"jobId must be a string of 1 to {MAX_JOB_ID_LENGTH} characters")
    return job_id


@contextmanager
def cancellable(job_id: str) -> Iterator[threading.Event]:
    """Makes the work inside the block a job that `job.cancel` can stop.

    The block gets an event that is set once the app asks the job to stop. A long
    method enters the block first of all, checks the event between its steps, at
    least every few seconds, and then calls `raise_if_cancelled` or returns: a job
    has to be gone within 5 seconds.

    The app gives every attempt of a job its own id. An id cannot be used again
    while the job that has it is still running.
    """
    _check_job_id(job_id)
    event = threading.Event()
    with _jobs_lock:
        if job_id in _jobs:
            raise ValueError("a job with this id is already running")
        # The cancel was faster than the job: it starts out as told to stop.
        if _cancelled_early.pop(job_id, "absent") is None:
            event.set()
        _jobs[job_id] = event
    try:
        yield event
    finally:
        with _jobs_lock:
            _jobs.pop(job_id, None)


def raise_if_cancelled(event: threading.Event) -> None:
    """Ends the job with JobCancelled if the app has asked it to stop."""
    if event.is_set():
        raise JobCancelled()


def _run_in(
    pool: ProcessPoolExecutor, stop: threading.Event, function: Callable[..., Any], *arguments: Any
) -> Any:
    """Runs one call in a worker of `pool`, and stops waiting when told to stop.

    Essentia cannot be interrupted. A job that is told to stop answers at once and
    leaves its worker to finish the track; it only reads.
    """
    future = pool.submit(function, *arguments)
    while not wait([future], timeout=_POLL_S).done:
        if stop.is_set():
            future.cancel()
        raise_if_cancelled(stop)
    return future.result()


def run_in_cpu_pool(stop: threading.Event, function: Callable[..., Any], *arguments: Any) -> Any:
    """Runs a CPU analysis of one file in the shared pool, for a job made `cancellable`."""
    raise_if_cancelled(stop)
    pool = cpu_pool()
    try:
        return _run_in(pool, stop, function, *arguments)
    except BrokenProcessPool:
        discard_cpu_pool(pool)
    # A worker that dies takes every job of its pool with it, and nothing says which
    # file did it. So each of them is tried once more in a pool of its own: the file
    # that kills its worker fails alone, and the others get their result.
    raise_if_cancelled(stop)
    alone = new_worker_pool(1)
    try:
        return _run_in(alone, stop, function, *arguments)
    finally:
        alone.shutdown(wait=False, cancel_futures=True)


@rpc("job.cancel")
def cancel_job(job_id: str) -> dict[str, bool]:
    """Ask a job to stop. `cancelled` is false when no such job is running yet.

    The id is remembered then, so that a job which registers a moment later is
    stopped as it starts.
    """
    _check_job_id(job_id)
    with _jobs_lock:
        event = _jobs.get(job_id)
        if event is None:
            _cancelled_early[job_id] = None
            while len(_cancelled_early) > MAX_CANCELLED_EARLY:
                del _cancelled_early[next(iter(_cancelled_early))]
            return {"cancelled": False}
    event.set()
    return {"cancelled": True}


@rpc("ping")
def ping() -> dict[str, str]:
    return {"version": version("fixlib-py")}


@rpc("echo")
def echo(value: Any) -> dict[str, Any]:
    return {"value": value}


@rpc("shutdown")
def shutdown() -> None:
    # serve() stops reading after it has answered this request.
    return None


def _encode(message: dict[str, Any]) -> str:
    # ASCII only and no NaN or Infinity, so every line is JSON that the bridge can parse.
    return json.dumps(message, allow_nan=False, separators=(",", ":"))


def _error_response(request_id: int | str | None, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _snake_case(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def parse_request(line: str) -> Request | dict[str, Any]:
    """Turn one input line into a Request, or into the error response to send back."""
    try:
        payload = json.loads(line)
    except (ValueError, RecursionError):
        return _error_response(None, PARSE_ERROR, "Parse error")

    if not isinstance(payload, dict):
        return _error_response(None, INVALID_REQUEST, "Invalid Request")

    request_id = payload.get("id")
    id_is_valid = isinstance(request_id, (int, str)) and not isinstance(request_id, bool)
    is_notification = "id" not in payload
    if not is_notification and not id_is_valid:
        return _error_response(None, INVALID_REQUEST, "Invalid Request")

    method = payload.get("method")
    params = payload.get("params", {})
    if payload.get("jsonrpc") != "2.0" or not isinstance(method, str):
        return _error_response(request_id, INVALID_REQUEST, "Invalid Request")
    if not isinstance(params, dict):
        return _error_response(request_id, INVALID_PARAMS, "Params must be an object")

    return Request(request_id, method, params, is_notification)


def execute(request: Request) -> dict[str, Any] | None:
    """Run the requested method. Return the response, or None for a notification."""
    response = _run_method(request)
    return None if request.is_notification else response


def _run_method(request: Request) -> dict[str, Any]:
    function = _methods.get(request.method)
    if function is None:
        return _error_response(
            request.request_id, METHOD_NOT_FOUND, f"Method not found: {request.method}"
        )

    arguments = {_snake_case(key): value for key, value in request.params.items()}
    if len(arguments) != len(request.params):
        return _error_response(
            request.request_id, INVALID_PARAMS, "Invalid params: two keys name one parameter"
        )
    try:
        inspect.signature(function).bind(**arguments)
    except TypeError as error:
        return _error_response(request.request_id, INVALID_PARAMS, f"Invalid params: {error}")

    try:
        result = function(**arguments)
        # Serialise here so a result that is not JSON becomes this request's error.
        json.dumps(result, allow_nan=False)
    except JobCancelled:
        # Asked for by the app, which no longer waits for this answer.
        logger.info("RPC method %s stopped on request", request.method)
        return _error_response(request.request_id, INTERNAL_ERROR, "JobCancelled")
    except Exception as error:
        logger.exception("RPC method %s failed", request.method)
        return _error_response(
            request.request_id, INTERNAL_ERROR, f"{type(error).__name__}: {error}"
        )
    return {"jsonrpc": "2.0", "id": request.request_id, "result": result}


def dispatch(line: str) -> str | None:
    """Handle one input line. Return the response line, or None when nothing is sent."""
    parsed = parse_request(line)
    response = execute(parsed) if isinstance(parsed, Request) else parsed
    return None if response is None else _encode(response)


def serve(lines: Iterable[str], writer: ProtocolWriter) -> None:
    """Answer requests until `shutdown` arrives or the input ends.

    Requests still running when the server stops get no response; the bridge
    rejects them on its side.
    """
    global _writer
    _writer = writer

    def answer(request: Request) -> None:
        try:
            response = execute(request)
            if response is not None:
                writer.send(response)
        except Exception:
            logger.exception("Could not answer RPC request %s", request.method)

    dispatch_pool = ThreadPoolExecutor(max_workers=DISPATCH_THREADS, thread_name_prefix="rpc")
    try:
        for raw_line in lines:
            line = raw_line.strip()
            if not line:
                continue
            parsed = parse_request(line)
            if not isinstance(parsed, Request):
                try:
                    writer.send(parsed)
                except OSError:
                    # The app closed its end of the pipe: nobody is left to answer.
                    logger.warning("protocol stream closed, stopping")
                    break
                continue
            if parsed.method == "shutdown":
                answer(parsed)
                break
            dispatch_pool.submit(answer, parsed)
    finally:
        dispatch_pool.shutdown(wait=False, cancel_futures=True)
        close_executors()
        _writer = None


def claim_stdout() -> TextIO:
    """Reserve the real stdout for the protocol and point everything else at stderr.

    The redirect is done on the file descriptor as well, so output from native
    libraries and from pool workers cannot reach the protocol stream either.
    """
    sys.stdout.flush()
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(protocol_fd, "w", encoding="utf-8", newline="\n")


def claim_stdin() -> TextIO:
    """Reserve the real stdin for the protocol and give everything else an empty one.

    Child processes inherit fd 0. A tool such as ffmpeg reads its stdin, and would
    otherwise swallow requests meant for the server.
    """
    protocol_fd = os.dup(0)
    null_fd = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null_fd, 0)
    os.close(null_fd)
    return os.fdopen(protocol_fd, "r", encoding="utf-8", newline="\n")


def main() -> None:
    # The modules whose `@rpc` methods the sidecar serves; importing registers them.
    from fixlib_py import (  # noqa: F401
        convert,
        cover,
        fingerprint,
        normalize,
        placeholder,
        tag_write,
        tags,
    )
    from fixlib_py.analysis import (  # noqa: F401
        bpm_key,
        energy,
        energy_model,
        loudness,
        peaks,
        stems,
        structure,
    )

    protocol_output = claim_stdout()
    protocol_input = claim_stdin()
    configure_logging()
    # Ctrl-C in a development terminal reaches the whole process group. The app
    # stops the sidecar itself, by `shutdown` or by closing stdin.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    logger.info("sidecar started, pid %d", os.getpid())
    exit_code = 0
    try:
        serve(protocol_input, ProtocolWriter(protocol_output))
    except Exception:
        logger.exception("sidecar stopped on an error")
        exit_code = 1
    finally:
        logger.info("sidecar stopped")
        logging.shutdown()
        # Do not wait for dispatch threads that are still inside a long method.
        os._exit(exit_code)


if __name__ == "__main__":
    # `python -m fixlib_py.server` runs this file as `__main__`, a second copy of the
    # module. Start the importable one, so `@rpc` in other modules fills its registry.
    from fixlib_py.server import main as run_server

    run_server()
