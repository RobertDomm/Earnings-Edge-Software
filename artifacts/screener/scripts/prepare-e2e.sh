#!/usr/bin/env bash
# prepare-e2e.sh — called automatically via the `pretest:e2e` npm lifecycle hook.
#
# 1. Recompile e2e-libs/libgbm.so.1 from source so the stub always matches
#    the symbols expected by the current Playwright / Chromium revision.
# 2. Locate the Playwright chromium-headless-shell binary and apply patchelf
#    to add our e2e-libs directory to its RPATH (if not already present).
#
# Both gcc and patchelf are available in the Replit NixOS sandbox.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
E2E_LIBS="$ARTIFACT_DIR/e2e-libs"
STUB_SRC="$E2E_LIBS/libgbm_stub.c"
STUB_OUT="$E2E_LIBS/libgbm.so.1"

# ── 1. Compile the stub ───────────────────────────────────────────────────────
echo "[prepare-e2e] Compiling libgbm stub..."
gcc -shared -fPIC \
    -Wl,-soname,libgbm.so.1 \
    -o "$STUB_OUT" \
    "$STUB_SRC" \
    -nostartfiles
echo "[prepare-e2e] libgbm.so.1 written to $STUB_OUT"

# ── 2. Patch the Playwright chromium-headless-shell RPATH ────────────────────
# Playwright stores its browsers under the workspace .cache directory.
# The version subfolder name changes with each Playwright release, so we
# search for all chrome-headless-shell binaries and patch any that don't
# already reference our e2e-libs path.
PLAYWRIGHT_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-$ARTIFACT_DIR/../../.cache/ms-playwright}"

if [ ! -d "$PLAYWRIGHT_CACHE" ]; then
    echo "[prepare-e2e] Playwright browser cache not found at $PLAYWRIGHT_CACHE — skipping patchelf."
    echo "[prepare-e2e] Run 'pnpm exec playwright install chromium' first if tests fail."
    exit 0
fi

BINARIES=$(find "$PLAYWRIGHT_CACHE" -name "chrome-headless-shell" -type f 2>/dev/null || true)

if [ -z "$BINARIES" ]; then
    echo "[prepare-e2e] No chrome-headless-shell binaries found in $PLAYWRIGHT_CACHE — skipping patchelf."
    echo "[prepare-e2e] Run 'pnpm exec playwright install chromium' first if tests fail."
    exit 0
fi

for BIN in $BINARIES; do
    CURRENT_RPATH=$(patchelf --print-rpath "$BIN" 2>/dev/null || true)
    if echo "$CURRENT_RPATH" | grep -qF "$E2E_LIBS"; then
        echo "[prepare-e2e] $BIN already patched — skipping."
    else
        echo "[prepare-e2e] Patching RPATH of $BIN ..."
        patchelf --add-rpath "$E2E_LIBS" "$BIN"
        echo "[prepare-e2e] Done."
    fi
done

echo "[prepare-e2e] All done."
