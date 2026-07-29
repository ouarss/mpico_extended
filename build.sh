#!/usr/bin/env bash
#
# mpico_extended - firmware build (.uf2)
#
# Usage:
#   ./build.sh          # incremental build
#   ./build.sh clean    # wipe build/ then rebuild from scratch
#
# RUN THIS FROM A UNIX SHELL (WSL or MSYS2/Git Bash): the project CMake calls
# the Unix commands `cp` and `touch`, which plain cmd/PowerShell do not provide.
#
# Requirements (see README.md):
#   - Pico SDK        : PICO_SDK_PATH variable (or PICO_SDK_FETCH_FROM_GIT=ON)
#   - Toolchain       : arm-none-eabi-gcc, cmake, make or ninja
#   - aic_pico module : modules/aic_pico/ populated (see AIC_PICO_REV below)
#
set -euo pipefail

# Revision of aic_pico this firmware is built against. Pinned so that a fresh
# clone reproduces the same binary; bump it deliberately, never by accident.
AIC_PICO_REV="5a0dbc9d132218c67f2a3b500e4251c96fcaf2df"

# Move to the script directory, whatever the caller's cwd is
cd "$(dirname "$0")"
FIRMWARE_DIR="$(pwd)"
BUILD_DIR="$FIRMWARE_DIR/build"
AIC_DIR="$FIRMWARE_DIR/modules/aic_pico"

# --- Optional clean ---
if [ "${1:-}" = "clean" ]; then
    echo ">> Cleaning $BUILD_DIR"
    rm -rf "$BUILD_DIR"
fi

# --- aic_pico module check ---
if [ ! -f "$AIC_DIR/firmware/CMakeLists.txt" ]; then
    echo "ERROR: aic_pico module missing ($AIC_DIR)."
    echo "       Fetch it before building:"
    echo "         git clone https://github.com/whowechina/aic_pico \"$AIC_DIR\""
    echo "         git -C \"$AIC_DIR\" checkout $AIC_PICO_REV"
    exit 1
fi

# --- Pico SDK check ---
if [ -z "${PICO_SDK_PATH:-}" ] && [ "${PICO_SDK_FETCH_FROM_GIT:-}" != "ON" ]; then
    echo "ERROR: PICO_SDK_PATH is not set."
    echo "       Export the Pico SDK path, for example:"
    echo "         export PICO_SDK_PATH=\$HOME/pico/pico-sdk"
    echo "       (or: export PICO_SDK_FETCH_FROM_GIT=ON to download it automatically)"
    exit 1
fi

# --- Locate the tools when they are not already in PATH ---
# (useful when winget installs are not yet reflected in the current session)

if ! command -v cmake >/dev/null 2>&1 && [ -x "/c/Program Files/CMake/bin/cmake.exe" ]; then
    PATH="/c/Program Files/CMake/bin:$PATH"
fi

if ! command -v ninja >/dev/null 2>&1; then
    for d in "$HOME"/AppData/Local/Microsoft/WinGet/Packages/Ninja-build.Ninja_*; do
        if [ -x "$d/ninja.exe" ]; then
            PATH="$d:$PATH"
            break
        fi
    done
fi

if ! command -v arm-none-eabi-gcc >/dev/null 2>&1 && [ -z "${PICO_TOOLCHAIN_PATH:-}" ]; then
    for d in "/c/Program Files (x86)/Arm GNU Toolchain arm-none-eabi/"*/bin \
             "/c/Program Files/Arm GNU Toolchain arm-none-eabi/"*/bin; do
        if [ -x "$d/arm-none-eabi-gcc.exe" ]; then
            export PICO_TOOLCHAIN_PATH="$d"
            PATH="$d:$PATH"
            break
        fi
    done
fi

# HOST compiler (MinGW-w64 / WinLibs) to build pioasm and picotool.
# The ARM toolchain only targets the RP2040; these tools run on the PC.
if ! command -v gcc >/dev/null 2>&1; then
    for d in "$HOME"/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.*/mingw64/bin \
             "$HOME"/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.*/mingw32/bin; do
        if [ -x "$d/gcc.exe" ]; then
            PATH="$d:$PATH"
            break
        fi
    done
fi

# --- Tool checks ---
if ! command -v cmake >/dev/null 2>&1; then
    echo "ERROR: cmake not found."
    echo "       Install it: winget install --id Kitware.CMake -e"
    exit 1
fi
if ! command -v arm-none-eabi-gcc >/dev/null 2>&1 && [ -z "${PICO_TOOLCHAIN_PATH:-}" ]; then
    echo "ERROR: ARM toolchain not found (arm-none-eabi-gcc)."
    echo "       Install it: winget install --id Arm.ArmGnuToolchain -e"
    exit 1
fi
if ! command -v gcc >/dev/null 2>&1 && ! command -v cl >/dev/null 2>&1 \
   && ! command -v clang >/dev/null 2>&1; then
    echo "ERROR: no HOST compiler (gcc/cl/clang) to build pioasm/picotool."
    echo "       Install MinGW-w64: winget install --id BrechtSanders.WinLibs.POSIX.UCRT -e"
    exit 1
fi

# --- Generator choice (Ninja when available, Make otherwise) ---
if command -v ninja >/dev/null 2>&1; then
    GENERATOR="Ninja"
else
    GENERATOR="Unix Makefiles"
fi

echo ">> Pico SDK : ${PICO_SDK_PATH:-<git download>}"
echo ">> Generator: $GENERATOR"

# --- CMake configuration (only when not configured yet) ---
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"
if [ ! -f CMakeCache.txt ]; then
    cmake -G "$GENERATOR" ..
fi

# --- Locate Python (fallback UF2 packaging, see below) ---
PYTHON=""
for cand in python python3 py; do
    if command -v "$cand" >/dev/null 2>&1; then
        PYTHON="$cand"
        break
    fi
done

# --- Build ---
# The bundled picotool (v2.2.0) segfaults at the 'uf2 convert' step on this
# machine. objcopy has already produced a correct .bin right before that call,
# so we do NOT let this single failing step break the whole build, and we
# package the .uf2 ourselves with tools/bin2uf2.py (standalone, no dependency).
BIN="$BUILD_DIR/src/mpico_extended.bin"
UF2="$BUILD_DIR/src/mpico_extended.uf2"
STAMP="$BUILD_DIR/.build-stamp"

touch "$STAMP"
set +e
cmake --build . --parallel
BUILD_RC=$?
set -e

# If the .bin was (re)generated by THIS build, compiling and linking succeeded;
# only the picotool step may have failed -> take over and produce the .uf2.
if [ -f "$BIN" ] && [ "$BIN" -nt "$STAMP" ]; then
    if [ -z "$PYTHON" ]; then
        echo "ERROR: Python not found to package the .uf2 (tools/bin2uf2.py)." >&2
        rm -f "$STAMP"
        exit 1
    fi
    "$PYTHON" "$FIRMWARE_DIR/tools/bin2uf2.py" "$BIN" "$UF2" >/dev/null
    cp "$UF2" "$FIRMWARE_DIR/mpico_extended.uf2"
elif [ "$BUILD_RC" -ne 0 ]; then
    echo "ERROR: the build failed (before the UF2 packaging step)." >&2
    rm -f "$STAMP"
    exit "$BUILD_RC"
fi
rm -f "$STAMP"

# --- Result ---
if [ -f "$UF2" ]; then
    echo ""
    echo ">> OK: firmware built"
    echo "   $UF2"
    echo "   $FIRMWARE_DIR/mpico_extended.uf2   (automatic copy)"
    echo ""
    echo "Flash   : hold BOOTSEL while plugging the USB cable, then drop the .uf2 on the RPI-RP2 drive."
    echo "Note    : after flashing an already configured board, run 'factory' once in the CLI."
    echo "Release : attach this .uf2 to a GitHub release so the monitor download link stays valid."
else
    echo "ERROR: the .uf2 was not generated." >&2
    exit 1
fi
