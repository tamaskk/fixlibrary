#!/usr/bin/env bash
# Downloads the pinned python-build-standalone CPython into python/runtime/.
# The archive is executed later, so it is unpacked only after its SHA-256 matches.
set -euo pipefail

PYTHON_VERSION="3.11.17"
RELEASE_TAG="20261009"
ARCHIVE="cpython-${PYTHON_VERSION}+${RELEASE_TAG}-aarch64-apple-darwin-install_only.tar.gz"
# From the SHA256SUMS asset of the same release.
SHA256="7b6068989d9b6a0e2a883352b7d0d141ce8670a61360bf4ddabac0e046a08e10"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}/${ARCHIVE}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${REPO_ROOT}/python/runtime"
# Records which archive the runtime came from, so a re-pinned release replaces it.
STAMP_FILE="${RUNTIME_DIR}/.archive-sha256"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "error: this runtime is built for macOS arm64 only" >&2
  exit 1
fi

if [[ -f "${STAMP_FILE}" ]] && [[ "$(<"${STAMP_FILE}")" == "${SHA256}" ]]; then
  echo "python/runtime already holds CPython ${PYTHON_VERSION} (${RELEASE_TAG})"
  exit 0
fi

# Next to the target, so the final move is a rename on the same volume.
WORK_DIR="$(mktemp -d "${REPO_ROOT}/python/.runtime.XXXXXX")"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "Downloading ${ARCHIVE}"
curl --fail --location --silent --show-error \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --connect-timeout 20 --max-time 600 --retry 3 \
  --output "${WORK_DIR}/${ARCHIVE}" -- "${URL}"

ACTUAL_SHA256="$(shasum -a 256 "${WORK_DIR}/${ARCHIVE}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${SHA256}" ]]; then
  echo "error: SHA-256 mismatch for ${ARCHIVE}" >&2
  echo "  expected ${SHA256}" >&2
  echo "  actual   ${ACTUAL_SHA256}" >&2
  exit 1
fi

# The archive has a single top-level python/ directory.
tar -xzf "${WORK_DIR}/${ARCHIVE}" -C "${WORK_DIR}"

if [[ "$(lipo -archs "${WORK_DIR}/python/bin/python${PYTHON_VERSION%.*}")" != "arm64" ]]; then
  echo "error: the unpacked interpreter is not an arm64 binary" >&2
  exit 1
fi
printf '%s\n' "${SHA256}" >"${WORK_DIR}/python/.archive-sha256"

if [[ -e "${RUNTIME_DIR}" ]]; then
  mv "${RUNTIME_DIR}" "${WORK_DIR}/previous"
fi
if ! mv "${WORK_DIR}/python" "${RUNTIME_DIR}"; then
  # Put the old runtime back before the exit trap removes the work directory.
  if [[ -e "${WORK_DIR}/previous" ]]; then
    mv "${WORK_DIR}/previous" "${RUNTIME_DIR}"
  fi
  exit 1
fi

"${RUNTIME_DIR}/bin/python3" --version
