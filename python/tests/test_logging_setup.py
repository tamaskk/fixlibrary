from __future__ import annotations

import logging
from collections.abc import Iterator
from pathlib import Path

import pytest

from fixlib_py import logging_setup


@pytest.fixture
def clean_root_logger(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Give each test the root logger as it found it, with the test's handlers closed."""
    root = logging.getLogger()
    handlers_before = list(root.handlers)
    level_before = root.level
    # Each test configures logging as a fresh sidecar would.
    monkeypatch.setattr(logging_setup, "_configured", None)
    yield
    for handler in root.handlers:
        if handler not in handlers_before:
            handler.close()
    root.handlers = handlers_before
    root.setLevel(level_before)


@pytest.mark.usefixtures("clean_root_logger")
def test_python_log_is_created_in_the_folder_the_app_names(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log_dir = tmp_path / "Logs" / "FixLibrary"
    monkeypatch.setenv(logging_setup.LOG_DIR_ENV, str(log_dir))

    logging_setup.configure_logging()
    logging.getLogger("fixlib_py.test").info("sidecar started, árvíztűrő")

    content = (log_dir / "python.log").read_text(encoding="utf-8")
    assert "INFO fixlib_py.test: sidecar started, árvíztűrő" in content


@pytest.mark.usefixtures("clean_root_logger")
def test_the_log_rotates_and_keeps_five_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(logging_setup.LOG_DIR_ENV, str(tmp_path))
    logging_setup.configure_logging(max_bytes=1000)
    log = logging.getLogger("fixlib_py.test")

    for count in range(200):
        log.info("%d %s", count, "x" * 200)

    files = sorted(path.name for path in tmp_path.iterdir())
    assert files == ["python.log", "python.log.1", "python.log.2", "python.log.3", "python.log.4"]
    assert "199 " in (tmp_path / "python.log").read_text(encoding="utf-8")


@pytest.mark.usefixtures("clean_root_logger")
def test_without_a_log_folder_only_stderr_is_used(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv(logging_setup.LOG_DIR_ENV, raising=False)

    handlers = logging_setup.configure_logging()
    logging.getLogger("fixlib_py.test").warning("to stderr")

    captured = capsys.readouterr()
    assert len(handlers) == 1
    assert "to stderr" in captured.err
    assert captured.out == ""


@pytest.mark.usefixtures("clean_root_logger")
def test_a_log_folder_that_cannot_be_written_does_not_stop_the_sidecar(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    blocked = tmp_path / "a-file-not-a-folder"
    blocked.write_text("in the way")
    monkeypatch.setenv(logging_setup.LOG_DIR_ENV, str(blocked))

    handlers = logging_setup.configure_logging()

    assert len(handlers) == 1
    assert "no log file, logging to stderr only" in capsys.readouterr().err


@pytest.mark.usefixtures("clean_root_logger")
def test_configuring_twice_does_not_write_every_line_twice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(logging_setup.LOG_DIR_ENV, str(tmp_path))

    first = logging_setup.configure_logging()
    second = logging_setup.configure_logging()
    logging.getLogger("fixlib_py.test").info("only once")

    content = (tmp_path / "python.log").read_text(encoding="utf-8")
    assert second is first
    assert content.count("only once") == 1


@pytest.mark.usefixtures("clean_root_logger")
def test_the_log_file_is_readable_by_the_user_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(logging_setup.LOG_DIR_ENV, str(tmp_path))

    logging_setup.configure_logging()

    assert (tmp_path / "python.log").stat().st_mode & 0o777 == 0o600
