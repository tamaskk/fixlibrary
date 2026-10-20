#!/usr/bin/env bash
# Checks a packed Python runtime (T-041) the way the app will use it: unpacked to a
# path other than the one it was built at, every Mach-O file's signature valid, the
# heavy modules importable, and the sidecar answering `ping` and `analysis.bpm_key`
# on a synthetic file. Usage: scripts/smoke-runtime.sh [archive]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(tr -d '[:space:]' <"${REPO_ROOT}/python/runtime-version.txt")"
ARCHIVE="${1:-${REPO_ROOT}/build/python-runtime-${VERSION}.tar.gz}"
FFMPEG="${REPO_ROOT}/resources/bin/ffmpeg"

[[ -f "${ARCHIVE}" ]] || { echo "error: no archive at ${ARCHIVE}: run scripts/build-python.sh" >&2; exit 1; }
[[ -x "${FFMPEG}" ]] || { echo "error: no ffmpeg: run scripts/fetch-binaries.sh" >&2; exit 1; }

# A path with a space and nothing in common with the build folder.
# Resolved: the sidecar opens no file through a link, and /var is one.
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/fixlib smoke.XXXXXX")" && pwd -P)"
trap 'rm -rf "${WORK}"' EXIT
tar -xzf "${ARCHIVE}" -C "${WORK}"
RUNTIME="${WORK}/python-runtime"
PYTHON="${RUNTIME}/bin/python3"

echo "Checking the signatures"
bad=0
checked=0
while IFS= read -r -d '' file; do
  if [[ "$(file -b "${file}")" == *Mach-O* ]]; then
    checked=$((checked + 1))
    if ! codesign -v "${file}" 2>/dev/null; then
      echo "  not valid: ${file#"${RUNTIME}/"}" >&2
      bad=$((bad + 1))
    fi
  fi
done < <(find "${RUNTIME}" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0)
echo "  ${checked} Mach-O files, ${bad} not valid"
[[ "${bad}" -eq 0 ]] || exit 1

echo "Importing the heavy modules"
"${PYTHON}" -I -c 'import essentia.standard, torch, torchaudio, demucs, scipy, yt_dlp, fixlib_py; print("  torch", torch.__version__)'

echo "Calling the sidecar"
FIXLIB_FFMPEG="${FFMPEG}" \
  FIXLIB_MODELS_DIR="${RUNTIME}/models" \
  TORCH_HOME="${RUNTIME}/torch-home" \
  "${PYTHON}" -I - "${PYTHON}" "${WORK}/loop.wav" <<'PY'
import json
import os
import select
import subprocess
import sys
import time

import numpy as np
import soundfile

python, sample = sys.argv[1], sys.argv[2]
# 30 s of a decaying 55 Hz kick every half second (120 BPM) over a quiet A minor chord.
rate = 44100
t = np.arange(30 * rate) / rate
kick = np.sin(2 * np.pi * 55 * t) * np.exp(-12 * (t % 0.5))
chord = sum(np.sin(2 * np.pi * f * t) for f in (220.0, 261.63, 329.63)) * 0.05
soundfile.write(sample, (0.6 * kick + chord).astype(np.float32), rate)
# As the app starts it (python-bridge.ts): no user site-packages, no working folder.
errors = open(os.path.join(os.path.dirname(sample), "sidecar.log"), "w")
server = subprocess.Popen(
    [python, "-s", "-P", "-m", "fixlib_py.server"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=errors,
    text=True,
    cwd=os.path.dirname(sample),
)

def call(request_id, method, params, timeout_s=120):
    server.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n")
    server.stdin.flush()
    deadline = time.monotonic() + timeout_s
    while True:
        # A sidecar that hangs fails the smoke instead of holding it.
        ready, _, _ = select.select([server.stdout], [], [], max(0, deadline - time.monotonic()))
        if not ready:
            raise TimeoutError(f"{method} gave no answer in {timeout_s} s")
        answer = json.loads(server.stdout.readline())
        if answer.get("id") == request_id:
            return answer

try:
    ping = call(1, "ping", {})
    assert "result" in ping, ping
    print("  ping:", ping["result"])
    measured = call(2, "analysis.bpm_key", {"path": sample, "jobId": "smoke", "bpmMin": 70, "bpmMax": 180})
    assert "result" in measured, measured
    print("  analysis.bpm_key:", measured["result"])
except Exception:
    errors.flush()
    sys.stderr.write(open(errors.name).read()[-4000:])
    raise
finally:
    server.stdin.close()
    server.wait(timeout=30)
PY
echo "The runtime works from ${RUNTIME}"
