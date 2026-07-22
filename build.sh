#!/usr/bin/env bash
#
# Mai Pico - compilation du firmware (.uf2)
#
# Usage :
#   ./build.sh          # compilation (incrémentale)
#   ./build.sh clean    # supprime build/ puis recompile à neuf
#
# À LANCER DANS UN SHELL UNIX (WSL ou MSYS2/Git Bash) : le CMake du projet
# appelle les commandes Unix `cp` et `touch`, indisponibles en cmd/PowerShell pur.
#
# Prérequis (voir CLAUDE.md) :
#   - Pico SDK            : variable PICO_SDK_PATH (ou PICO_SDK_FETCH_FROM_GIT=ON)
#   - Toolchain           : arm-none-eabi-gcc, cmake, make ou ninja
#   - Sous-module aic_pico: firmware/modules/aic_pico/ peuplé
#
set -euo pipefail

# Se placer dans le dossier du script (firmware/), quel que soit l'appelant
cd "$(dirname "$0")"
FIRMWARE_DIR="$(pwd)"
BUILD_DIR="$FIRMWARE_DIR/build"
AIC_DIR="$FIRMWARE_DIR/modules/aic_pico"

# --- Nettoyage optionnel ---
if [ "${1:-}" = "clean" ]; then
    echo ">> Nettoyage de $BUILD_DIR"
    rm -rf "$BUILD_DIR"
fi

# --- Vérif du sous-module aic_pico ---
if [ ! -f "$AIC_DIR/firmware/CMakeLists.txt" ]; then
    echo "ERREUR : sous-module aic_pico absent ($AIC_DIR)."
    echo "         Récupère-le avant de compiler, par exemple :"
    echo "           git clone https://github.com/whowechina/aic_pico \"$AIC_DIR\""
    exit 1
fi

# --- Vérif du Pico SDK ---
if [ -z "${PICO_SDK_PATH:-}" ] && [ "${PICO_SDK_FETCH_FROM_GIT:-}" != "ON" ]; then
    echo "ERREUR : PICO_SDK_PATH n'est pas défini."
    echo "         Exporte le chemin du Pico SDK, par exemple :"
    echo "           export PICO_SDK_PATH=\$HOME/pico/pico-sdk"
    echo "         (ou : export PICO_SDK_FETCH_FROM_GIT=ON pour le télécharger automatiquement)"
    exit 1
fi

# --- Localiser les outils s'ils ne sont pas déjà dans le PATH ---
# (utile quand les installs winget ne sont pas encore reflétés dans la session)

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

# Compilateur HÔTE (MinGW-w64 / WinLibs) pour bâtir pioasm et picotool.
# La toolchain ARM ne cible que le RP2040 ; ces outils tournent sur le PC.
if ! command -v gcc >/dev/null 2>&1; then
    for d in "$HOME"/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.*/mingw64/bin \
             "$HOME"/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.*/mingw32/bin; do
        if [ -x "$d/gcc.exe" ]; then
            PATH="$d:$PATH"
            break
        fi
    done
fi

# --- Vérif des outils ---
if ! command -v cmake >/dev/null 2>&1; then
    echo "ERREUR : cmake introuvable."
    echo "         Installe-le : winget install --id Kitware.CMake -e"
    exit 1
fi
if ! command -v arm-none-eabi-gcc >/dev/null 2>&1 && [ -z "${PICO_TOOLCHAIN_PATH:-}" ]; then
    echo "ERREUR : toolchain ARM introuvable (arm-none-eabi-gcc)."
    echo "         Installe-la : winget install --id Arm.ArmGnuToolchain -e"
    exit 1
fi
if ! command -v gcc >/dev/null 2>&1 && ! command -v cl >/dev/null 2>&1 \
   && ! command -v clang >/dev/null 2>&1; then
    echo "ERREUR : aucun compilateur HÔTE (gcc/cl/clang) pour bâtir pioasm/picotool."
    echo "         Installe MinGW-w64 : winget install --id BrechtSanders.WinLibs.POSIX.UCRT -e"
    exit 1
fi

# --- Choix du générateur (Ninja si dispo, sinon Make) ---
if command -v ninja >/dev/null 2>&1; then
    GENERATOR="Ninja"
else
    GENERATOR="Unix Makefiles"
fi

echo ">> Pico SDK   : ${PICO_SDK_PATH:-<téléchargement git>}"
echo ">> Générateur : $GENERATOR"

# --- Configuration CMake (uniquement si pas déjà configuré) ---
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"
if [ ! -f CMakeCache.txt ]; then
    cmake -G "$GENERATOR" ..
fi

# --- Localiser Python (packaging UF2 de secours, voir plus bas) ---
PYTHON=""
for cand in python python3 py; do
    if command -v "$cand" >/dev/null 2>&1; then
        PYTHON="$cand"
        break
    fi
done

# --- Compilation ---
# Le picotool fourni (v2.2.0) segfault a l'etape 'uf2 convert' sur cette machine.
# objcopy a deja produit un .bin correct juste avant cet appel : on ne laisse donc
# PAS l'echec de cette unique etape faire capoter tout le build, et on packagera le
# .uf2 nous-memes avec tools/bin2uf2.py (autonome, sans dependance).
BIN="$BUILD_DIR/src/mai_pico.bin"
UF2="$BUILD_DIR/src/mai_pico.uf2"
STAMP="$BUILD_DIR/.build-stamp"

touch "$STAMP"
set +e
cmake --build . --parallel
BUILD_RC=$?
set -e

# Si le .bin a ete (re)genere par CE build, la compilation et le link ont reussi ;
# seule l'etape picotool a pu echouer -> on prend le relais pour produire le .uf2.
if [ -f "$BIN" ] && [ "$BIN" -nt "$STAMP" ]; then
    if [ -z "$PYTHON" ]; then
        echo "ERREUR : Python introuvable pour packager le .uf2 (tools/bin2uf2.py)." >&2
        rm -f "$STAMP"
        exit 1
    fi
    "$PYTHON" "$FIRMWARE_DIR/tools/bin2uf2.py" "$BIN" "$UF2" >/dev/null
    cp "$UF2" "$FIRMWARE_DIR/mai_pico.uf2"
elif [ "$BUILD_RC" -ne 0 ]; then
    echo "ERREUR : la compilation a echoue (avant l'etape de packaging UF2)." >&2
    rm -f "$STAMP"
    exit "$BUILD_RC"
fi
rm -f "$STAMP"

# --- Résultat ---
if [ -f "$UF2" ]; then
    echo ""
    echo ">> OK : firmware généré"
    echo "   $UF2"
    echo "   $FIRMWARE_DIR/mai_pico.uf2   (copie automatique)"
    echo ""
    echo "Flash  : maintiens BOOTSEL en branchant l'USB, puis glisse le .uf2 sur le disque RPI-RP2."
    echo "Note   : après flash sur un boîtier déjà configuré, lance 'factory' une fois dans la CLI."
else
    echo "ERREUR : le .uf2 n'a pas été généré." >&2
    exit 1
fi
