from __future__ import annotations

import io
import json
import re
import subprocess
import sys
import threading
from importlib.metadata import version
from pathlib import Path

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


def test_a_nan_result_gets_an_internal_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(server._methods, "test.nan", lambda: {"strength": float("nan")})
    request = '{"jsonrpc":"2.0","id":5,"method":"test.nan"}'

    response = call(request)

    assert response["id"] == 5
    assert response["error"]["code"] == server.INTERNAL_ERROR


def test_responses_are_ascii_so_any_reader_can_split_them() -> None:
    request = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "echo", "params": {"value": "tűz \ud800"}}
    )

    response_line = server.dispatch(request)

    assert response_line is not None
    assert response_line.isascii()
    assert json.loads(response_line)["result"] == {"value": "tűz \ud800"}


def test_two_keys_that_name_one_parameter_get_invalid_params(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(server._methods, "test.job", lambda job_id: job_id)
    request = '{"jsonrpc":"2.0","id":1,"method":"test.job","params":{"jobId":"a","job_id":"b"}}'

    response = call(request)

    assert response["error"]["code"] == server.INVALID_PARAMS


def test_a_deeply_nested_request_gets_a_parse_error() -> None:
    request = "[" * 100_000

    response = call(request)

    assert response["error"]["code"] == server.PARSE_ERROR


@pytest.mark.parametrize(
    "function",
    [lambda **options: None, lambda *values: None, lambda _internal=None: None],
)
def test_a_method_that_takes_more_than_named_public_params_is_rejected(function) -> None:
    with pytest.raises(ValueError, match="test.loose"):
        server.rpc("test.loose")(function)

    assert "test.loose" not in server._methods


@pytest.mark.parametrize("percent", [-1, 100.5, float("nan")])
def test_progress_outside_0_to_100_is_rejected(
    monkeypatch: pytest.MonkeyPatch, percent: float
) -> None:
    output = io.StringIO()
    monkeypatch.setattr(server, "_writer", server.ProtocolWriter(output))

    with pytest.raises(ValueError, match="percent"):
        server.report_progress("job-1", percent)

    assert output.getvalue() == ""


def test_the_python_methods_match_the_typescript_contract() -> None:
    contract = Path(__file__).parents[2] / "src/shared/rpc.ts"
    schemas = contract.read_text(encoding="utf-8").split("export const RPC_SCHEMAS = {")[1]
    schemas = schemas.split("} as const")[0]

    typescript_methods = set(re.findall(r"^  ['\"]?([\w.]+)['\"]?: \{$", schemas, re.MULTILINE))

    assert typescript_methods == set(server._methods)


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
import subprocess
import sys
from fixlib_py import server

@server.rpc("test.print")
def noisy():
    print("stray print from a method")
    os.write(1, b"stray write to fd 1\\n")
    return "ok"

@server.rpc("test.child")
def child_reads_stdin():
    child = subprocess.run(
        [sys.executable, "-c", "import sys; print(len(sys.stdin.read()))"],
        capture_output=True, text=True, timeout=10,
    )
    return child.stdout.strip()

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


def test_a_child_process_cannot_read_the_protocol_input() -> None:
    requests = (
        '{"jsonrpc":"2.0","id":1,"method":"test.child"}\n'
        '{"jsonrpc":"2.0","id":2,"method":"echo","params":{"value":"still here"}}\n'
    )
    sidecar = subprocess.Popen(
        [sys.executable, "-c", PRINTING_SERVER],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert sidecar.stdin is not None and sidecar.stdout is not None

    try:
        sidecar.stdin.write(requests)
        sidecar.stdin.flush()
        responses = [json.loads(sidecar.stdout.readline()) for _ in range(2)]
    finally:
        sidecar.kill()
        sidecar.communicate()

    assert sorted(responses, key=lambda response: response["id"]) == [
        {"jsonrpc": "2.0", "id": 1, "result": "0"},
        {"jsonrpc": "2.0", "id": 2, "result": {"value": "still here"}},
    ]


def test_running_the_module_starts_the_importable_server() -> None:
    completed = subprocess.run(
        [sys.executable, "-m", "fixlib_py.server"],
        input='{"jsonrpc":"2.0","id":1,"method":"shutdown"}\n',
        capture_output=True,
        text=True,
        timeout=20,
    )

    assert completed.returncode == 0
    assert json.loads(completed.stdout) == {"jsonrpc": "2.0", "id": 1, "result": None}
    assert "fixlib_py.server: sidecar started" in completed.stderr
    assert "__main__" not in completed.stderr


def test_the_server_exits_when_stdin_closes() -> None:
    completed = subprocess.run(
        [sys.executable, "-m", "fixlib_py.server"],
        input='{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
        capture_output=True,
        text=True,
        timeout=20,
    )

    assert completed.returncode == 0


def test_job_cancel_stops_a_running_job_within_five_seconds() -> None:
    started = threading.Event()
    outcome: list[str] = []

    def long_job() -> None:
        try:
            with server.cancellable("job-1") as stop:
                started.set()
                # Stands in for a method that checks between its steps.
                while not stop.wait(0.05):
                    pass
                server.raise_if_cancelled(stop)
        except server.JobCancelled:
            outcome.append("cancelled")

    worker = threading.Thread(target=long_job)
    worker.start()
    assert started.wait(2)

    response = call('{"jsonrpc":"2.0","id":1,"method":"job.cancel","params":{"jobId":"job-1"}}')
    worker.join(5)

    assert response["result"] == {"cancelled": True}
    assert outcome == ["cancelled"]
    assert not worker.is_alive()


def test_job_cancel_says_when_no_such_job_is_running() -> None:
    with server.cancellable("job-2"):
        pass

    finished = call('{"jsonrpc":"2.0","id":1,"method":"job.cancel","params":{"jobId":"job-2"}}')
    unknown = call('{"jsonrpc":"2.0","id":2,"method":"job.cancel","params":{"jobId":"nope"}}')

    assert finished["result"] == {"cancelled": False}
    assert unknown["result"] == {"cancelled": False}


def test_two_jobs_cannot_share_an_id() -> None:
    with server.cancellable("job-3"):
        with pytest.raises(ValueError):
            with server.cancellable("job-3"):
                pass


def test_job_cancel_refuses_an_id_that_is_not_a_string() -> None:
    response = call('{"jsonrpc":"2.0","id":1,"method":"job.cancel","params":{"jobId":7}}')

    assert response["error"]["code"] == server.INTERNAL_ERROR
