#!/usr/bin/env bash
# Downloads the weights of the htdemucs model (Demucs 4, Meta, MIT) once, checks them,
# and turns them into resources/models/htdemucs/state.pt for the sidecar (T-028), which
# loads it with weights_only=True; the model's arguments are fixed in
# python/fixlib_py/analysis/stems.py. The sidecar never downloads anything: without this
# file, stem analysis is off. The packaged app gets it from T-041.
#
#   ./scripts/fetch-demucs-weights.sh            install, unless already current
#   ./scripts/fetch-demucs-weights.sh --verify   only check what is installed
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

# The file Demucs 4.1.0 names for htdemucs (demucs/remote/files.txt). Upstream publishes
# only the first eight digits of its hash, in the file's name; the full hash below is
# the one of the file downloaded on 2026-10-15, whose first eight digits match.
WEIGHTS_URL="https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th"
WEIGHTS_SHA256="8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4"
# The file is 84 MB; a download that grows past this is not it.
MAX_BYTES=200000000

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="${REPO_ROOT}/resources/models"
MODEL_DIR="${MODELS_DIR}/htdemucs"
PYTHON="${REPO_ROOT}/python/.venv/bin/python"
# The hash of the package the installed file was made from, and of the file.
MANIFEST_FILE="${MODEL_DIR}/.installed-sha256"

model_is_current() {
  [[ -f "${MANIFEST_FILE}" ]] || return 1
  [[ "$(head -n 1 "${MANIFEST_FILE}")" == "source ${WEIGHTS_SHA256}" ]] || return 1
  (cd "${MODEL_DIR}" && tail -n +2 "${MANIFEST_FILE}" | shasum -a 256 -c --quiet -) >/dev/null 2>&1
}

if [[ "${1:-}" == "--verify" ]]; then
  if model_is_current; then
    echo "resources/models/htdemucs is complete and unchanged"
    exit 0
  fi
  echo "resources/models/htdemucs is missing or changed: run scripts/fetch-demucs-weights.sh" >&2
  exit 1
fi

if model_is_current; then
  echo "resources/models/htdemucs is current"
  exit 0
fi
[[ -x "${PYTHON}" ]] || { echo "python/.venv is missing: run 'uv sync' in python/" >&2; exit 1; }

# Beside the model, on the same drive: the new folder is put in place by a rename.
mkdir -p "${MODELS_DIR}"
WORK="$(mktemp -d "${MODELS_DIR}/.htdemucs.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --tlsv1.2 --max-redirs 3 --max-filesize "${MAX_BYTES}" --max-time 900 \
  --output "${WORK}/htdemucs.th" "${WEIGHTS_URL}"
echo "${WEIGHTS_SHA256}  ${WORK}/htdemucs.th" | shasum -a 256 -c --quiet -

"${PYTHON}" -I "${REPO_ROOT}/scripts/convert-demucs-weights.py" \
  "${WORK}/htdemucs.th" "${WEIGHTS_SHA256}" "${WORK}/htdemucs"
(cd "${WORK}/htdemucs" && { echo "source ${WEIGHTS_SHA256}"; shasum -a 256 state.pt; } > .installed-sha256)

# The old folder is moved aside first, so the model is never half there.
if [[ -e "${MODEL_DIR}" ]]; then mv "${MODEL_DIR}" "${WORK}/old"; fi
mv "${WORK}/htdemucs" "${MODEL_DIR}"
echo "installed resources/models/htdemucs"
