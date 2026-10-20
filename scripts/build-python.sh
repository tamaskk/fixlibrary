#!/usr/bin/env bash
# Builds the Python runtime the packaged app runs (T-041): the pinned CPython of
# fetch-python-runtime.sh with every dependency and fixlib_py installed into it, the
# Demucs weights next to it, the code compiled ahead, every Mach-O file signed ad hoc,
# packed as build/python-runtime-<version>.tar.gz with a manifest of its SHA-256.
# python-build-standalone is relocatable; a virtual environment would not be.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_DIR="${REPO_ROOT}/python"
VERSION="$(tr -d '[:space:]' <"${PYTHON_DIR}/runtime-version.txt")"
OUT_DIR="${REPO_ROOT}/build"
STAGE="${OUT_DIR}/python-runtime"
ARCHIVE="${OUT_DIR}/python-runtime-${VERSION}.tar.gz"
MANIFEST="${OUT_DIR}/python-runtime.json"
MODELS="${REPO_ROOT}/resources/models/htdemucs"

[[ "${VERSION}" =~ ^[0-9]+$ ]] || { echo "error: python/runtime-version.txt must hold a whole number" >&2; exit 1; }
[[ -f "${MODELS}/state.pt" ]] || { echo "error: no Demucs weights: run scripts/fetch-demucs-weights.sh" >&2; exit 1; }

"${REPO_ROOT}/scripts/fetch-python-runtime.sh"

echo "Copying the interpreter to ${STAGE}"
# Only the archive of this version is packaged: older ones go.
rm -rf "${STAGE}" "${MANIFEST}" "${OUT_DIR}"/python-runtime-*.tar.gz
cp -R "${PYTHON_DIR}/runtime" "${STAGE}"
rm -f "${STAGE}/.archive-sha256"
PYTHON="${STAGE}/bin/python3"

echo "Installing the locked dependencies and fixlib_py"
REQUIREMENTS="$(mktemp)"
trap 'rm -f "${REQUIREMENTS}"' EXIT
# The lock as it is, with its hashes, without the dev group and the project itself:
# a wheel that is not the one locked is refused.
(cd "${PYTHON_DIR}" && uv export --frozen --no-dev --no-emit-project --format requirements.txt) >"${REQUIREMENTS}"
uv pip install --python "${PYTHON}" --break-system-packages --no-deps --require-hashes -r "${REQUIREMENTS}"
uv pip install --python "${PYTHON}" --break-system-packages --no-deps "${PYTHON_DIR}"

echo "Adding the Demucs weights"
mkdir -p "${STAGE}/models" "${STAGE}/torch-home"
cp -R "${MODELS}" "${STAGE}/models/htdemucs"

echo "Compiling the Python files"
# A few test files of the packages are not valid Python 3.11; they stay uncompiled.
"${PYTHON}" -m compileall -q -j 0 "${STAGE}/lib" >/dev/null || true

echo "Signing every Mach-O file ad hoc"
signed=0
while IFS= read -r -d '' file; do
  if file -b "${file}" | grep -q 'Mach-O'; then
    codesign --force --sign - "${file}" 2>/dev/null
    signed=$((signed + 1))
  fi
done < <(find "${STAGE}" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0)
echo "Signed ${signed} files"

echo "Packing ${ARCHIVE}"
# The folder itself is the root of the archive: it unpacks as python-runtime/.
COPYFILE_DISABLE=1 tar -czf "${ARCHIVE}" -C "${OUT_DIR}" python-runtime
SHA256="$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')"
SIZE="$(stat -f %z "${ARCHIVE}")"
printf '{\n  "version": %s,\n  "archive": "python-runtime-%s.tar.gz",\n  "sha256": "%s",\n  "size": %s\n}\n' \
  "${VERSION}" "${VERSION}" "${SHA256}" "${SIZE}" >"${MANIFEST}"
echo "Done: ${ARCHIVE} ($((SIZE / 1024 / 1024)) MiB)"
