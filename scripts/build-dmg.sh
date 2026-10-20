#!/usr/bin/env bash
# Builds the two DMGs of a release (T-042) into release/:
#   FixLibrary-<version>-arm64.dmg       with the Python runtime archive: the first install
#   FixLibrary-<version>-arm64-lite.dmg  with only the runtime's manifest: for an update that
#                                        keeps the runtime version (T-043 fetches the archive
#                                        when it changed)
# Both are signed ad hoc, without the hardened runtime, as no Apple Developer ID is used.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
# GitHub Releases refuses a file of 2 GiB or more.
MAX_DMG_BYTES=$((2 * 1024 * 1024 * 1024))

./scripts/fetch-binaries.sh --verify
./scripts/build-python.sh
npm run build

VERSION="$(node -p 'require("./package.json").version')"
FULL="release/FixLibrary-${VERSION}-arm64.dmg"
LITE="release/FixLibrary-${VERSION}-arm64-lite.dmg"
rm -f "${FULL}" "${LITE}"

echo "Building ${FULL}"
npx electron-builder --mac

SIZE="$(stat -f %z "${FULL}")"
echo "  $((SIZE / 1024 / 1024)) MiB"
if (( SIZE >= MAX_DMG_BYTES )); then
  echo "error: ${FULL} is 2 GiB or more, which GitHub Releases does not accept" >&2
  exit 1
fi

echo "Building ${LITE}"
# The archive is put aside for the lite build, so only the manifest is packaged.
ASIDE="$(mktemp -d)"
ARCHIVES=(build/python-runtime-*.tar.gz)
restore() { mv "${ASIDE}"/python-runtime-*.tar.gz build/ 2>/dev/null || true; rmdir "${ASIDE}"; }
trap restore EXIT
mv "${ARCHIVES[@]}" "${ASIDE}/"
npx electron-builder --mac "-c.dmg.artifactName=\${productName}-\${version}-\${arch}-lite.\${ext}"
echo "  $(( $(stat -f %z "${LITE}") / 1024 / 1024 )) MiB"

codesign -dv "release/mac-arm64/FixLibrary.app" 2>&1 | grep -E '^(Signature|Identifier|CodeDirectory)'
echo "Done: ${FULL} and ${LITE}"
