from __future__ import annotations

import io
import json
import subprocess
import sys
from importlib.metadata import version

import pytest

from fixlib_py import server


def call(line: str) -> dict:
    response = server.dispatch(line)
    assert response is not None
    return json.loads(response)


def test_ping_returns_the_package_version() -> None:
    request = '{"jsonrpc":"2.0","id":1,"method":"ping"}'

    response = call(request)

    assert response == {"jsonrpc": "2.0", "id": 1, "result": {"version": version("fixlib-py")}}


def test_echo_returns_the_value_unchanged() -> None:
    value = {"title": "Árvíztűrő tükörfúrógép", "bpm": 124.5, "tags": [1, None, True]}
    request = json.dumps(
        {"jsonrpc": "2.0", "id": "a-1", "method": "echo", "params": {"value": value}}
    )

    response = call(request)

    assert response == {"jsonrpc": "2.0", "id": "a-1", "result": {"value": value}}


def test_malformed_json_gets_a_parse_error() -> None:
    request = '{"jsonrpc":"2.0","id":1,"method":'

    response = call(request)

    assert response["id"] is None
    assert response["error"]["code"] == server.PARSE_ERROR


def test_unknown_method_gets_method_not_found() -> None:
    request = '{"jsonrpc":"2.0","id":7,"method":"analysis.missing"}'

    response = call(request)

    assert response["id"] == 7
    assert response["error"]["code"] == server.METHOD_NOT_FOUND


@pytest.mark.parametrize(
    "request_line",
    [
        "[]",
        '"ping"',
        '{"id":1,"method":"ping"}',
        '{"jsonrpc":"2.0","id":1,"method":5}',
        '{"jsonrpc":"2.0","id":true,"method":"ping"}',
    ],
)
def test_a_request_that_is_not_json_rpc_gets_invalid_request(request_line: str) -> None:
    response = call(request_line)

    assert response["error"]["code"] == server.INVALID_REQUEST


@pytest.mark.parametrize(
    "params",
    ['{"value":1,"extra":2}', "{}", "[1]"],
)
def test_wrong_params_get_invalid_params(params: str) -> None:
    request = '{"jsonrpc":"2.0","id":1,"method":"echo","params":' + params + "}"

    response = call(request)

    assert response["error"]["code"] == server.INVALID_PARAMS


def test_camel_case_params_reach_the_method_as_snake_case(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(server._methods, "test.job", lambda job_id: {"jobId": job_id})
    request = '{"jsonrpc":"2.0","id":1,"method":"test.job","params":{"jobId":"j-9"}}'

    response = call(request)

    assert response["result"] == {"jobId": "j-9"}


def test_a_failing_method_gets_an_internal_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail() -> None:
        raise RuntimeError("boom")

    monkeypatch.setitem(server._methods, "test.fail", fail)
    request = '{"jsonrpc":"2.0","id":3,"method":"test.fail"}'

    response = call(request)

    assert response["id"] == 3
    assert response["error"] == {"code": server.INTERNAL_ERROR, "message": "RuntimeError: boom"}


def test_a_result_that_is_not_json_gets_an_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(server._methods, "test.bytes", lambda: b"raw")
    request = '{"jsonrpc":"2.0","id":4,"method":"test.bytes"}'

    response = call(request)

    assert response["error"]["code"] == server.INTERNAL_ERROR


def test_a_notification_gets_no_response() -> None:
    request = '{"jsonrpc":"2.0","method":"ping"}'

    response = server.dispatch(request)

    assert response is None


def test_registering_a_method_name_twice_is_rejected() -> None:
    with pytest.raises(ValueError, match="already registered"):
        server.rpc("ping")(lambda: None)


def test_serve_stops_reading_after_shutdown() -> None:
    lines = [
        '{"jsonrpc":"2.0","id":1,"method":"shutdown"}\n',
        '{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
    ]
    output = io.StringIO()

    server.serve(lines, server.ProtocolWriter(output))

    assert [json.loads(line) for line in output.getvalue().splitlines()] == [
        {"jsonrpc": "2.0", "id": 1, "result": None}
    ]


def test_serve_answers_a_bad_line_and_keeps_going() -> None:
    lines = ["not json\n", "\n", '{"jsonrpc":"2.0","id":1,"method":"shutdown"}\n']
    output = io.StringIO()

    server.serve(lines, server.ProtocolWriter(output))

    responses = [json.loads(line) for line in output.getvalue().splitlines()]
    assert [response["id"] for response in responses] == [None, 1]
    assert responses[0]["error"]["code"] == server.PARSE_ERROR


def test_progress_is_sent_as_a_notification(monkeypatch: pytest.MonkeyPatch) -> None:
    output = io.StringIO()
    monkeypatch.setattr(server, "_writer", server.ProtocolWriter(output))

    server.report_progress("job-1", 42.5)

    assert json.loads(output.getvalue()) == {
        "jsonrpc": "2.0",
        "method": "progress",
        "params": {"jobId": "job-1", "percent": 42.5},
    }


def test_the_cpu_pool_leaves_one_core_free(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server.os, "cpu_count", lambda: 8)

    pool = server.cpu_pool()

    try:
        assert pool._max_workers == 7
    finally:
        server.close_executors()


PRINTING_SERVER = """
import os
from fixlib_py import server

@server.rpc("test.print")
def noisy():
    print("stray print from a method")
    os.write(1, b"stray write to fd 1\\n")
    return "ok"

server.main()
"""


def test_a_print_inside_a_method_does_not_reach_the_protocol_stream() -> None:
    sidecar = subprocess.Popen(
        [sys.executable, "-c", PRINTING_SERVER],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert sidecar.stdin is not None and sidecar.stdout is not None

    try:
        sidecar.stdin.write('{"jsonrpc":"2.0","id":1,"method":"test.print"}\n')
        sidecar.stdin.flush()
        first_line = sidecar.stdout.readline()
        remaining_output, error_output = sidecar.communicate(
            '{"jsonrpc":"2.0","id":2,"method":"shutdown"}\n', timeout=20
        )
    finally:
        sidecar.kill()

    assert json.loads(first_line) == {"jsonrpc": "2.0", "id": 1, "result": "ok"}
    assert json.loads(remaining_output) == {"jsonrpc": "2.0", "id": 2, "result": None}
    assert "stray print from a method" in error_output
    assert "stray write to fd 1" in error_output


def test_the_server_exits_when_stdin_closes() -> None:
    completed = subprocess.run(
        [sys.executable, "-m", "fixlib_py.server"],
        input='{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
        capture_output=True,
        text=True,
        timeout=20,
    )

    assert completed.returncode == 0
