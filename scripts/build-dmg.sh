#!/usr/bin/env bash
# Builds the two DMGs of a release (T-042) into release/:
#   FixLibrary-<version>-arm64.dmg       with the Python runtime archive: the first install
#   FixLibrary-<version>-arm64-lite.dmg  with only the runtime's manifest: an update that keeps
#                                        the runtime version, never a first install (T-043
#                                        fetches the archive when the version changed)
# Both are signed ad hoc, without the hardened runtime, as no Apple Developer ID is used,
# and both are checked: signature, fuses, size.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
# GitHub Releases refuses a file of 2 GiB or more.
MAX_DMG_BYTES=$((2 * 1024 * 1024 * 1024))
APP="release/mac-arm64/FixLibrary.app"

# The signature and the fuses of the app just built; electron-builder reuses its folder.
verify_app() {
  codesign --verify --deep --strict "${APP}"
  local details
  details="$(codesign -dv "${APP}" 2>&1)"
  [[ "${details}" == *"Signature=adhoc"* ]] || { echo "error: ${APP} is not signed ad hoc" >&2; exit 1; }
  local fuses
  fuses="$(npx --no-install @electron/fuses read --app "${APP}")"
  for expected in 'RunAsNode is Disabled' 'EnableNodeOptionsEnvironmentVariable is Disabled' \
    'EnableNodeCliInspectArguments is Disabled' 'EnableEmbeddedAsarIntegrityValidation is Enabled' \
    'OnlyLoadAppFromAsar is Enabled'; do
    [[ "${fuses}" == *"${expected}"* ]] || { echo "error: ${APP}: expected '${expected}'" >&2; exit 1; }
  done
  echo "  signed ad hoc, fuses set"
}

./scripts/fetch-binaries.sh --verify
./scripts/build-python.sh
npm run build

VERSION="$(node -p 'require("./package.json").version')"
FULL="release/FixLibrary-${VERSION}-arm64.dmg"
LITE="release/FixLibrary-${VERSION}-arm64-lite.dmg"
FEED="release/latest-mac.yml"
rm -f "${FULL}" "${LITE}" "${FULL}.blockmap" "${LITE}.blockmap" "${FEED}"

echo "Building ${FULL}"
# Never publishes: on a tag electron-builder would upload to GitHub itself; the workflow drafts the release.
npx electron-builder --mac --publish never
verify_app
SIZE="$(stat -f %z "${FULL}")"
echo "  $((SIZE / 1024 / 1024)) MiB"
if (( SIZE >= MAX_DMG_BYTES )); then
  echo "error: ${FULL} is 2 GiB or more, which GitHub Releases does not accept" >&2
  exit 1
fi
# The feed names the full DMG: the lite build would write its own over it.
FEED_KEPT="$(mktemp)"
cp "${FEED}" "${FEED_KEPT}"

echo "Building ${LITE}"
# The archive is put aside for the lite build, so only the manifest is packaged.
shopt -s nullglob
ARCHIVES=(build/python-runtime-*.tar.gz)
shopt -u nullglob
if (( ${#ARCHIVES[@]} != 1 )); then
  echo "error: expected one runtime archive in build/, found ${#ARCHIVES[@]}" >&2
  exit 1
fi
ASIDE="$(mktemp -d)"
restore() {
  if [[ -e "${ASIDE}/$(basename "${ARCHIVES[0]}")" ]]; then
    mv "${ASIDE}/$(basename "${ARCHIVES[0]}")" build/ ||
      echo "error: the runtime archive is left in ${ASIDE}: move it back to build/" >&2
  fi
  rmdir "${ASIDE}" 2>/dev/null || true
  if [[ -f "${FEED_KEPT}" ]]; then mv "${FEED_KEPT}" "${FEED}"; fi
}
trap restore EXIT
mv "${ARCHIVES[0]}" "${ASIDE}/"
npx electron-builder --mac --publish never "-c.dmg.artifactName=\${productName}-\${version}-\${arch}-lite.\${ext}"
verify_app
echo "  $(( $(stat -f %z "${LITE}") / 1024 / 1024 )) MiB"

echo "Done: ${FULL} and ${LITE}"
shasum -a 256 "${FULL}" "${LITE}"
