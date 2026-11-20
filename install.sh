#!/usr/bin/env sh
set -eu

REPO='github:zonsunny/magpie-agent-dbx'

if command -v magpie >/dev/null 2>&1; then
  MAGPIE='magpie'
elif [ -x '/Applications/magpie.app/Contents/MacOS/magpie' ]; then
  MAGPIE='/Applications/magpie.app/Contents/MacOS/magpie'
else
  echo 'magpie not found on PATH (nor /Applications/magpie.app).' >&2
  echo "Install Magpie first, then run: magpie plugin add $REPO" >&2
  exit 1
fi

echo "Installing $REPO ..."
"$MAGPIE" plugin add "$REPO"
echo 'Done. Open Magpie Agents page (or run `magpie ls`) and pick a model for DBX.'
