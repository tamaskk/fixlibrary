"""Logging for the sidecar: stderr always, plus a rotating file when the app names a folder.

Nothing here may write to stdout, which carries the JSON-RPC protocol.
"""

from __future__ import annotations

import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_DIR_ENV = "FIXLIB_LOG_DIR"
LOG_FILE_NAME = "sidecar.log"
# docs/SECURITY.md §01: 5 files of 10 MB, rotated.
MAX_LOG_BYTES = 10 * 1024 * 1024
LOG_FILE_COUNT = 5


def configure_logging() -> None:
    """Send every log record to stderr and, if FIXLIB_LOG_DIR is set, to the log file."""
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]

    log_dir = os.environ.get(LOG_DIR_ENV)
    if log_dir:
        folder = Path(log_dir)
        folder.mkdir(parents=True, exist_ok=True)
        handlers.append(
            RotatingFileHandler(
                folder / LOG_FILE_NAME,
                maxBytes=MAX_LOG_BYTES,
                backupCount=LOG_FILE_COUNT - 1,
                encoding="utf-8",
            )
        )

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for handler in handlers:
        handler.setFormatter(formatter)
        root.addHandler(handler)
