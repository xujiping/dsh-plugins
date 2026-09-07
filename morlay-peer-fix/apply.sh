#!/usr/bin/env bash
# Fix: widen @morlay/* peerDependencies ^0.1.1-rc.2 -> ^0.1.0-rc.6 (declared lower
# bound above the actually installed dsh core 0.1.0-rc.6).
# Idempotent: creates snapshot ONLY if none exists; refuses to overwrite one.
set -euo pipefail

PROFILE_DIR="$HOME/.dsh/profiles/web"
SNAP_DIR="$PROFILE_DIR/.morlay-peer-fix-snapshot"
PLUGINS=(better-session session-branch session-rdb ui-conversation-message-actions)
OLD='^0.1.1-rc.2'
NEW='^0.1.0-rc.6'

[ -d "$PROFILE_DIR" ] || { echo "ERROR: profile dir not found: $PROFILE_DIR"; exit 1; }

# --- snapshot (only if absent) ---
if [ -e "$SNAP_DIR" ]; then
  echo "SKIP: snapshot already exists at $SNAP_DIR"
  echo "      apply has run before (maybe partially). Rollback first, or remove"
  echo "      the snapshot dir deliberately, then re-run."
  exit 0
fi
mkdir -p "$SNAP_DIR/@morlay"
for p in "${PLUGINS[@]}"; do
  src="$PROFILE_DIR/node_modules/@morlay/$p/package.json"
  if [ ! -f "$src" ]; then
    echo "ERROR: missing $src — aborting before any modification."
    exit 1
  fi
  cp -p "$src" "$SNAP_DIR/@morlay/$p.package.json"
done
echo "OK: snapshot created at $SNAP_DIR"

# --- patch ---
changed=0
for p in "${PLUGINS[@]}"; do
  f="$PROFILE_DIR/node_modules/@morlay/$p/package.json"
  if grep -qF "\"$OLD\"" "$f"; then
    sed -i.bak "s/\^0\.1\.1-rc\.2/^0.1.0-rc.6/g" "$f" && rm -f "$f.bak"
    node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" \
      || { echo "ERROR: $f is not valid JSON after patch — run rollback.sh"; exit 1; }
    echo "PATCHED: @morlay/$p/package.json ($OLD -> $NEW)"
    changed=$((changed+1))
  else
    echo "UNCHANGED (no '$OLD' found): @morlay/$p/package.json"
  fi
done

echo "DONE: $changed file(s) patched. Restart dsh web (externally) to re-run checks."
