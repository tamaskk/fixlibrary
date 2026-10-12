"""Opening library files for reading. File names and content are untrusted."""

from __future__ import annotations

import os
import stat
from typing import BinaryIO

# Opens nothing that is reached through a link, in any part of the path. The app
# only sends paths under a library root that has its links resolved already.
# The two flags cannot be combined; the wider one is used where the system has it.
NO_LINKS = getattr(os, "O_NOFOLLOW_ANY", os.O_NOFOLLOW)


def open_regular_file(path: str) -> BinaryIO | None:
    """Open a file for reading, or return None when it is not a regular file.

    A link is never followed, and something that is not a regular file is never
    read: a pipe would block forever.
    """
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | NO_LINKS)
    try:
        # Asked of the descriptor before it becomes a file object: a folder cannot
        # become one, and its descriptor must not stay open.
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            os.close(descriptor)
            return None
        return os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise
