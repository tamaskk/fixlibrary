---
paths:
  - 'src/main/ipc/**'
  - 'src/main/pipeline/**'
  - 'src/main/services/**'
  - 'src/preload/**'
  - 'src/shared/**'
  - 'python/fixlib_py/server.py'
---

# IPC, RPC, pipeline and services

- Every renderer-to-main call has three parts that change together: the channel and types in `src/shared/ipc.ts`, the exposed function in `src/preload/index.ts`, the handler in `src/main/ipc/<domain>.ts`. Channel names are `domain:action`.
- IPC handlers are thin: validate the payload with a Zod schema, call one pipeline function, return a typed result. No business logic, no direct file or process work.
- The renderer is untrusted. Never accept a file path to write, a command, or a channel name from it. Resolve tracks by id on the main side.
- Results: return data or throw an error whose message is safe to show. Expected failures use the codes in `src/shared/errors.ts`. Never send stack traces, raw tool output or secrets to the renderer.
- Long work does not block the handler: enqueue it and report through `pipeline:progress` events, at most 4 per second.
- Pipeline code holds the business rules and stays as pure as possible. Side effects live in `src/main/services/` (one adapter per external thing) and `src/main/db/`.
- Python is reached only through `services/python-bridge.ts`. A new method needs the `@rpc` function, its types in `src/shared/rpc.ts`, and a timeout from `src/shared/timeouts.ts`.
- External binaries and `claude` are started with `spawn(path, argsArray)`. Never `shell: true`, never a concatenated command string.
- Online lookups live in `src/main/services/lookup/<source>.ts`, cached in `lookup_cache`, rate limited per source, called from pipeline stages only.
- Anything that modifies a library file goes through `services/file-ops.ts` in the apply phase. See the file-safety rule.
- The preload stays logic-free and imports only `electron` and `@shared/*`.
