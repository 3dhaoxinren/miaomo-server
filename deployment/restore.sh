#!/bin/sh
set -eu
# Run from the installed project: sh deployment/restore.sh /absolute/backup.zip
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ARCHIVE=${1:?Provide an absolute backup ZIP path}
case "$ARCHIVE" in /*) ;; *) echo 'Backup path must be absolute' >&2; exit 2;; esac
test -f "$ARCHIVE"
cd "$ROOT"
docker compose -f compose.yml stop web backend
trap 'docker compose -f compose.yml up -d' EXIT
docker compose -f compose.yml run --rm --no-deps \
  -v "$ARCHIVE:/restore-input.zip:ro" \
  -v "$ROOT/deployment/restore_backup.py:/restore_backup.py:ro" \
  backend python /restore_backup.py /restore-input.zip --data-dir /data --service-stopped
