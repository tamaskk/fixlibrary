---
paths:
  - 'python/**'
---

# Python sidecar

- Python 3.11, managed with uv. Add dependencies with `uv add` only after approval; commit `uv.lock`.
- `sys.stdout` belongs to the JSON-RPC writer. Never `print()`; use the logger, which writes to stderr and the log file. A stray print breaks the protocol.
- A new capability is an `@rpc("domain.method")` function with type hints, mirrored in `src/shared/rpc.ts` in the same commit. Parameters and results are JSON-serializable, camelCase on the wire.
- CPU analysis runs in the process pool. Demucs runs in its own single-worker executor so the model loads once. Do not load torch in pool workers.
- Long jobs report progress notifications and honour `job.cancel` within 5 seconds.
- Functions that write audio or tags take an explicit target path from the TypeScript side and never pick one. See the file-safety rule.
- Tags are written as ID3v2.3 with mutagen.
- `keys.py` mirrors `src/shared/keys.ts`; change both together.
- External tools are run with `subprocess.run([...])` and an argument list. Never `shell=True`.
- Tests: pytest in `python/tests/`, synthetic signals with known properties; tests needing real tracks skip when `tests/fixtures/real/` is absent.
- Commands, from `python/`: `uv run pytest`, `uv run ruff check .`, `uv run ruff format .`.
