#!/usr/bin/env bash
# Post-merge setup: runs automatically after every task merge.
# Installs workspace dependencies and applies any pending DB migrations.
#
# artifacts/desktop is excluded from the pnpm workspace because electron-builder
# pulls packages blocked by Replit's firewall. It is installed only on
# GitHub Actions runners during the desktop release workflow.

set -euo pipefail

echo "=== Installing workspace dependencies ==="
pnpm install --frozen-lockfile

echo "=== Applying pending database schema changes ==="
pnpm --filter @workspace/db run push

echo "=== Post-merge setup complete ==="
