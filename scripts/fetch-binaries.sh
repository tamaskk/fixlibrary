#!/usr/bin/env bash
# Builds or downloads the pinned external tools into resources/bin/, for arm64 macOS:
#   ffmpeg   built from source, audio only, LGPL, no network protocols
#   mp3gain  built from source, with a static libmpg123
#   fpcalc   the official Chromaprint release binary
# yt-dlp is not here: it runs as a Python module from the sidecar environment (python/uv.lock).
#
# Every download is compiled or executed later, so nothing is used before its SHA-256 matches.
#
#   ./scripts/fetch-binaries.sh            install, unless resources/bin is already current
#   ./scripts/fetch-binaries.sh --verify   only check that resources/bin is complete and unchanged
set -euo pipefail

# The build must not pick up Homebrew tools or the caller's compiler settings:
# the result has to be the same on a machine that has only the Xcode Command Line Tools.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset CC CFLAGS CPPFLAGS CXXFLAGS LDFLAGS MAKEFLAGS PKG_CONFIG PKG_CONFIG_PATH \
  LIBRARY_PATH CPATH C_INCLUDE_PATH

# Source pins. Each hash equals the one Homebrew publishes for the same URL.
FFMPEG_VERSION="9.0.2"
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_SHA256="8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"

LAME_VERSION="4.0"
LAME_URL="https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz"
LAME_SHA256="3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb"

MP3GAIN_VERSION="1.6.2"
MP3GAIN_URL="https://downloads.sourceforge.net/project/mp3gain/mp3gain/${MP3GAIN_VERSION}/mp3gain-${MP3GAIN_VERSION//./_}-src.zip"
MP3GAIN_SHA256="5cc04732ef32850d5878b28fbd8b85798d979a025990654aceeaa379bcc9596d"

MPG123_VERSION="1.33.7"
MPG123_URL="https://www.mpg123.de/download/mpg123-${MPG123_VERSION}.tar.bz2"
MPG123_SHA256="31d0e35a4ca567ec9b5ebda6c3062bb4435d6d3eacd6ef0d95cadd7854dc03ee"

# Binary pin. The archive hash is the digest GitHub publishes for the release asset;
# the second hash is the fpcalc file inside it.
CHROMAPRINT_VERSION="1.6.1"
CHROMAPRINT_DIR="chromaprint-fpcalc-${CHROMAPRINT_VERSION}-macos-arm64"
CHROMAPRINT_URL="https://github.com/acoustid/chromaprint/releases/download/v${CHROMAPRINT_VERSION}/${CHROMAPRINT_DIR}.tar.gz"
CHROMAPRINT_SHA256="254f23cb2d290069ba1d3d28199414fbf66d2054fc2f6821c2fc62ed39470a95"
FPCALC_SHA256="23046544591f275c6da7b0fa57c1290535eb844df271e186e37af1715040921f"
# The release archive carries no licence file; this is the one at the release tag.
CHROMAPRINT_LICENSE_URL="https://raw.githubusercontent.com/acoustid/chromaprint/v${CHROMAPRINT_VERSION}/LICENSE.md"
CHROMAPRINT_LICENSE_SHA256="562cfe59627e0c4e8e3b066f3ff2e9736f83811ffe4c6c2c7796595aa7595ebd"

TOOLS=(ffmpeg fpcalc mp3gain)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${REPO_ROOT}/resources/bin"
# SHA-256 of every installed file, so a missing or changed tool is noticed before packaging.
MANIFEST_FILE="${BIN_DIR}/.installed-sha256"
# SHA-256 of this script at install time: any change to a pin or to the recipe rebuilds.
RECIPE_FILE="${BIN_DIR}/.recipe-sha256"
RECIPE_SHA256="$(shasum -a 256 "${BASH_SOURCE[0]}" | awk '{print $1}')"

# True when resources/bin holds exactly what the current script would install.
bin_dir_is_current() {
  [[ -f "${RECIPE_FILE}" && -f "${MANIFEST_FILE}" ]] || return 1
  [[ "$(<"${RECIPE_FILE}")" == "${RECIPE_SHA256}" ]] || return 1
  local tool
  for tool in "${TOOLS[@]}"; do
    [[ -x "${BIN_DIR}/${tool}" ]] || return 1
  done
  (cd "${BIN_DIR}" && shasum -a 256 --check --status "${MANIFEST_FILE}")
}

if [[ "${1:-}" == "--verify" ]]; then
  if bin_dir_is_current; then
    echo "resources/bin is complete and unchanged"
    exit 0
  fi
  echo "error: resources/bin is missing, incomplete or changed; run ./scripts/fetch-binaries.sh" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "error: these tools are fetched and built for macOS arm64 only" >&2
  exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "error: building needs the Xcode Command Line Tools (xcode-select --install)" >&2
  exit 1
fi

# The path ends up unquoted inside the configure and make command lines of the sources.
if [[ ! "${REPO_ROOT}" =~ ^[A-Za-z0-9/._+-]+$ ]]; then
  echo "error: the repository path may only contain letters, digits and / . _ + -" >&2
  echo "  ${REPO_ROOT}" >&2
  exit 1
fi

if bin_dir_is_current; then
  echo "resources/bin already holds the pinned tools"
  exit 0
fi

mkdir -p "${REPO_ROOT}/resources"
# Next to the target, so the final move is a rename on the same volume.
WORK_DIR="$(mktemp -d "${REPO_ROOT}/resources/.bin.XXXXXX")"
cleanup() {
  # An interrupted swap must not leave the project without its previous tools.
  if [[ ! -e "${BIN_DIR}" && -e "${WORK_DIR}/previous" ]]; then
    mv "${WORK_DIR}/previous" "${BIN_DIR}"
  fi
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

NEW_BIN="${WORK_DIR}/bin"
PREFIX="${WORK_DIR}/prefix"
JOBS="$(sysctl -n hw.ncpu)"
mkdir -p "${NEW_BIN}/licenses" "${PREFIX}" "${WORK_DIR}/tools"

# lame's configure refuses to run without pkg-config, although it only uses it to look
# for optional libraries that are not wanted here. This stand-in answers the version
# probe and reports every package as missing.
cat >"${WORK_DIR}/tools/pkg-config" <<'STUB'
#!/bin/sh
case "$1" in --atleast-pkgconfig-version) exit 0 ;; esac
exit 1
STUB
chmod +x "${WORK_DIR}/tools/pkg-config"

# download <url> <sha256> <target file>
download() {
  local url="$1" expected="$2" target="$3" actual
  echo "Downloading ${url##*/}"
  curl --fail --location --silent --show-error \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --max-redirs 5 --max-filesize 209715200 \
    --connect-timeout 20 --max-time 900 --retry 3 \
    --output "${target}" -- "${url}"
  actual="$(shasum -a 256 "${target}" | awk '{print $1}')"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "error: SHA-256 mismatch for ${url##*/}" >&2
    echo "  expected ${expected}" >&2
    echo "  actual   ${actual}" >&2
    exit 1
  fi
}

# run_build <name> <function>: runs the function with its output in a log, and stops
# the script with the end of that log if any step fails.
run_build() {
  local name="$1" build_function="$2" log="${WORK_DIR}/$2.log" status
  echo "Building ${name}"
  # `set -e` has no effect inside a command that is tested by `if` or `||`, so the
  # subshell runs as a plain command and its status is read afterwards.
  set +e
  (
    set -e
    "${build_function}"
  ) >"${log}" 2>&1
  status=$?
  set -e
  if ((status != 0)); then
    echo "error: building ${name} failed; the end of the build log follows" >&2
    tail -n 40 "${log}" >&2
    exit 1
  fi
}

# install_tool <built or downloaded file> <name in resources/bin>
install_tool() {
  local source="$1" name="$2" architectures libraries
  if [[ ! -f "${source}" || -L "${source}" ]]; then
    echo "error: ${name} is not a regular file" >&2
    exit 1
  fi
  install -m 755 "${source}" "${NEW_BIN}/${name}"

  architectures="$(lipo -archs "${NEW_BIN}/${name}")"
  if [[ " ${architectures} " != *" arm64 "* ]]; then
    echo "error: ${name} is not an arm64 binary (${architectures})" >&2
    exit 1
  fi

  # The app must not depend on anything outside the system: a Homebrew library here
  # would work on this machine and fail on the next one. Library lines are indented.
  libraries="$(otool -arch arm64 -L "${NEW_BIN}/${name}")"
  if grep -E '^[[:space:]]' <<<"${libraries}" |
    grep -Ev '^[[:space:]]+(/usr/lib/|/System/Library/)' >&2; then
    echo "error: ${name} links against a library outside the system (listed above)" >&2
    exit 1
  fi
  echo "  ${name}: ${architectures}"
}

build_lame() {
  mkdir "${WORK_DIR}/lame"
  tar -xzf "${WORK_DIR}/lame.tar.gz" -C "${WORK_DIR}/lame" --strip-components 1
  cd "${WORK_DIR}/lame"
  # The library only: no command-line front end, no decoder.
  PKG_CONFIG="${WORK_DIR}/tools/pkg-config" ./configure --prefix="${PREFIX}" \
    --disable-shared --enable-static --disable-frontend --disable-decoder
  make -j"${JOBS}"
  make install
}

build_ffmpeg() {
  mkdir "${WORK_DIR}/ffmpeg"
  tar -xJf "${WORK_DIR}/ffmpeg.tar.xz" -C "${WORK_DIR}/ffmpeg" --strip-components 1
  cd "${WORK_DIR}/ffmpeg"
  # Audio only, and only what the app converts between. Without --enable-gpl and
  # --enable-nonfree the result is LGPL 2.1 or later and may be redistributed.
  # No network protocols: ffmpeg reads untrusted files, and must not be talked
  # into opening a URL by one.
  ./configure --prefix="${PREFIX}" \
    --disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug \
    --disable-ffplay --disable-ffprobe --disable-avdevice --disable-swscale \
    --enable-static --disable-shared \
    --enable-protocol=file,pipe \
    --enable-demuxer=mp3,wav,aiff,flac,ogg,matroska,mov,aac \
    --enable-muxer=mp3,wav,aiff,flac,null \
    --enable-decoder=mp3,mp3float,flac,aac,opus,vorbis,alac,pcm_u8,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_s16be,pcm_s24be,pcm_s32be \
    --enable-encoder=libmp3lame,flac,pcm_s16le,pcm_s24le,pcm_s16be,pcm_s24be \
    --enable-parser=mpegaudio,aac,flac,opus,vorbis \
    --enable-filter=aresample,aformat,anull,volume,loudnorm,ebur128 \
    --enable-libmp3lame --extra-cflags="-I${PREFIX}/include" --extra-ldflags="-L${PREFIX}/lib"
  make -j"${JOBS}"
}

build_mpg123() {
  mkdir "${WORK_DIR}/mpg123"
  tar -xjf "${WORK_DIR}/mpg123.tar.bz2" -C "${WORK_DIR}/mpg123" --strip-components 1
  cd "${WORK_DIR}/mpg123"
  # Only the decoder library: no player, no audio output modules.
  ./configure --prefix="${PREFIX}" --disable-shared --enable-static \
    --disable-components --enable-libmpg123 --with-cpu=aarch64
  make -j"${JOBS}"
  make install
}

build_mp3gain() {
  mkdir "${WORK_DIR}/mp3gain"
  unzip -q "${WORK_DIR}/mp3gain.zip" -d "${WORK_DIR}/mp3gain"
  cd "${WORK_DIR}/mp3gain"
  # libmpg123 is linked statically, so the binary runs on a machine without Homebrew.
  make CC=cc CFLAGS="-O2 -I${PREFIX}/include" LDFLAGS="-L${PREFIX}/lib"
}

download "${LAME_URL}" "${LAME_SHA256}" "${WORK_DIR}/lame.tar.gz"
download "${FFMPEG_URL}" "${FFMPEG_SHA256}" "${WORK_DIR}/ffmpeg.tar.xz"
download "${MPG123_URL}" "${MPG123_SHA256}" "${WORK_DIR}/mpg123.tar.bz2"
download "${MP3GAIN_URL}" "${MP3GAIN_SHA256}" "${WORK_DIR}/mp3gain.zip"
download "${CHROMAPRINT_URL}" "${CHROMAPRINT_SHA256}" "${WORK_DIR}/chromaprint.tar.gz"
download "${CHROMAPRINT_LICENSE_URL}" "${CHROMAPRINT_LICENSE_SHA256}" \
  "${NEW_BIN}/licenses/chromaprint.md"

run_build "lame ${LAME_VERSION}" build_lame
run_build "ffmpeg ${FFMPEG_VERSION}" build_ffmpeg
install_tool "${WORK_DIR}/ffmpeg/ffmpeg" ffmpeg
cp "${WORK_DIR}/ffmpeg/COPYING.LGPLv2.1" "${NEW_BIN}/licenses/ffmpeg-LGPL-2.1.txt"
cp "${WORK_DIR}/ffmpeg/LICENSE.md" "${NEW_BIN}/licenses/ffmpeg.md"
cp "${WORK_DIR}/lame/COPYING" "${NEW_BIN}/licenses/lame.txt"

run_build "mpg123 ${MPG123_VERSION}" build_mpg123
run_build "mp3gain ${MP3GAIN_VERSION}" build_mp3gain
install_tool "${WORK_DIR}/mp3gain/mp3gain" mp3gain
cp "${WORK_DIR}/mp3gain/lgpl.txt" "${NEW_BIN}/licenses/mp3gain.txt"
cp "${WORK_DIR}/mpg123/COPYING" "${NEW_BIN}/licenses/mpg123.txt"

# Only the one member that is wanted leaves the archive.
mkdir "${WORK_DIR}/chromaprint"
tar -xzf "${WORK_DIR}/chromaprint.tar.gz" -C "${WORK_DIR}/chromaprint" "${CHROMAPRINT_DIR}/fpcalc"
install_tool "${WORK_DIR}/chromaprint/${CHROMAPRINT_DIR}/fpcalc" fpcalc
if [[ "$(shasum -a 256 "${NEW_BIN}/fpcalc" | awk '{print $1}')" != "${FPCALC_SHA256}" ]]; then
  echo "error: fpcalc is not the pinned binary" >&2
  exit 1
fi

cat >"${NEW_BIN}/licenses/NOTICE.txt" <<NOTICE
FixLibrary runs these separate programs. Each keeps its own licence, in this folder.
scripts/fetch-binaries.sh in the FixLibrary source is the complete build recipe.

ffmpeg ${FFMPEG_VERSION}, LGPL 2.1 or later (ffmpeg-LGPL-2.1.txt, ffmpeg.md)
  built from ${FFMPEG_URL}
  linked statically with LAME ${LAME_VERSION}, LGPL (lame.txt)
  built from ${LAME_URL}

mp3gain ${MP3GAIN_VERSION}, LGPL 2.1 or later (mp3gain.txt)
  built from ${MP3GAIN_URL}
  linked statically with libmpg123 ${MPG123_VERSION}, LGPL 2.1 (mpg123.txt)
  built from ${MPG123_URL}

fpcalc (Chromaprint ${CHROMAPRINT_VERSION}), MIT with LGPL 2.1 parts of FFmpeg (chromaprint.md)
  unchanged binary from ${CHROMAPRINT_URL}
  source: https://github.com/acoustid/chromaprint/tree/v${CHROMAPRINT_VERSION}
NOTICE

(cd "${NEW_BIN}" && find . -type f ! -name '.*' -print0 | sort -z | xargs -0 shasum -a 256) \
  >"${WORK_DIR}/installed-sha256"
mv "${WORK_DIR}/installed-sha256" "${NEW_BIN}/.installed-sha256"
printf '%s\n' "${RECIPE_SHA256}" >"${NEW_BIN}/.recipe-sha256"

if [[ -e "${BIN_DIR}" ]]; then
  mv "${BIN_DIR}" "${WORK_DIR}/previous"
fi
mv "${NEW_BIN}" "${BIN_DIR}"

echo "Installed into resources/bin:"
"${BIN_DIR}/ffmpeg" -version | head -n 1
"${BIN_DIR}/fpcalc" -version
"${BIN_DIR}/mp3gain" -v 2>&1 | head -n 1
