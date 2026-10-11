"""Logging for the sidecar: stderr always, plus a rotating file when the app names a folder.

The app sets FIXLIB_LOG_DIR to its log folder and copies the stderr lines into its own
main.log. Nothing here may write to stdout, which carries the JSON-RPC protocol.

Only the sidecar process itself logs here. A worker of the process pool is a fresh
interpreter without these handlers, and the rotating file must not be shared between
processes: a worker hands its messages back to the sidecar with its result.
"""

from __future__ import annotations

import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_DIR_ENV = "FIXLIB_LOG_DIR"
LOG_FILE_NAME = "python.log"
# docs/SECURITY.md §01: 5 files of 10 MB, rotated.
MAX_LOG_BYTES = 10 * 1024 * 1024
LOG_FILE_COUNT = 5

_configured: list[logging.Handler] | None = None


def configure_logging(
    max_bytes: int = MAX_LOG_BYTES, file_count: int = LOG_FILE_COUNT
) -> list[logging.Handler]:
    """Send every log record to stderr and, if FIXLIB_LOG_DIR is set, to python.log.

    Returns the handlers it added to the root logger. A log folder that cannot be
    written is reported on stderr and otherwise ignored: the sidecar must still start.
    A second call changes nothing and returns the handlers of the first.
    """
    global _configured
    if _configured is not None:
        return _configured

    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]
    file_problem: OSError | None = None

    log_dir = os.environ.get(LOG_DIR_ENV)
    if log_dir:
        try:
            folder = Path(log_dir)
            folder.mkdir(mode=0o700, parents=True, exist_ok=True)
            handlers.append(
                RotatingFileHandler(
                    folder / LOG_FILE_NAME,
                    maxBytes=max_bytes,
                    # The current file plus the older ones make file_count in total.
                    backupCount=file_count - 1,
                    encoding="utf-8",
                )
            )
            # A log can name files of the library: for the user only, like the database.
            (folder / LOG_FILE_NAME).chmod(0o600)
        except OSError as error:
            file_problem = error

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for handler in handlers:
        handler.setFormatter(formatter)
        root.addHandler(handler)
    if file_problem is not None:
        root.warning("no log file, logging to stderr only: %s", file_problem)
    _configured = handlers
    return handlers
