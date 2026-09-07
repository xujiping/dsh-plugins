#!/usr/bin/env bash
# Rollback: restore the 4 @morlay package.json files from the snapshot created
# by apply.sh. Idempotent: snapshot is kept, so repeated runs are safe.
set -euo pipefail

PROFILE_DIR="$HOME/.dsh/profiles/web"
SNAP_DIR="$PROFILE_DIR/.morlay-peer-fix-snapshot"
PLUGINS=(better-session session-branch session-rdb ui-conversation-message-actions)

if [ ! -d "$SNAP_DIR" ]; then
  echo "NOTHING TO ROLLBACK: no snapshot at $SNAP_DIR (apply never ran or was cleaned)."
  exit 0
fi

for p in "${PLUGINS[@]}"; do
  snap="$SNAP_DIR/@morlay/$p.package.json"
  dst="$PROFILE_DIR/node_modules/@morlay/$p/package.json"
  if [ -f "$snap" ]; then
    cp -p "$snap" "$dst"
    echo "RESTORED: node_modules/@morlay/$p/package.json"
  else
    echo "SKIP: no snapshot entry for @morlay/$p"
  fi
done

echo "DONE: rollback complete (snapshot kept at $SNAP_DIR for repeated rollback)."
